// Source resolution: an in-memory index from on-screen text to the string resource that
// produced it and every call site that renders it, plus a tree over the uiautomator nodes so
// a reference can say WHERE an element sits.
//
// Two registries are understood:
//   android-xml  res/values*/strings.xml  <string name="k">…</string>   → R.string.k
//   lkey         Kotlin `val k = LKey(he = "…", en = "…")` objects        → LObject.k
// Built once at startup (milliseconds), rebuilt when a source root changes. Exact-value
// lookup, with a printf-shaped template fallback ("Error (404)" ↔ "Error (%d)").
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

export class StringIndex {
  constructor(cfg) {
    this.cfg = cfg
    this.root = cfg.root
    this.byValue = new Map()   // "Schedule" -> [{ key, file, line, values:{lang:text} }]
    this.byKey = new Map()
    this.usage = new Map()     // key -> [{ file, line, code }]
    this.literal = new Map()   // "hardcoded" -> [{ file, line, code }]
    this.dirty = true
    this._watchers = []
  }

  async ensure() { if (this.dirty) await this.build() }

  async build() {
    const t0 = Date.now()
    this.byValue.clear(); this.byKey.clear(); this.usage.clear(); this.literal.clear()
    let files = []
    for (const r of this.cfg.sourceRoots) files.push(...await walk(path.join(this.root, r), /\.(kt|java)$/))
    const s = this.cfg.strings
    if (s.resolver === 'lkey') {
      const re = new RegExp(s.files || '/l10n/|Strings\\.kt$')
      for (const f of files) { const rel = path.relative(this.root, f); if (re.test(rel)) this._indexLKey(rel, await fs.readFile(f, 'utf8'), s.langs || ['en']) }
    } else if (s.resolver === 'android-xml') {
      for (const r of s.resDirs || []) {
        for (const f of await walk(path.join(this.root, r), /\.xml$/)) {
          const rel = path.relative(this.root, f)
          const m = /(^|\/)values(?:-([\w+-]+))?\/[^/]+\.xml$/.exec(rel)
          if (m) this._indexAndroidXml(rel, await fs.readFile(f, 'utf8'), m[2] || 'default')
        }
      }
      // Layout XML also references strings.
      for (const r of s.resDirs || []) for (const f of await walk(path.join(this.root, r), /\/layout[^/]*\/[^/]+\.xml$/)) files.push(f)
    }
    for (const f of files) {
      const rel = path.relative(this.root, f)
      const src = await fs.readFile(f, 'utf8')
      this._indexUsages(rel, src)
      if (/\.(kt|java)$/.test(rel)) this._indexLiterals(rel, src)
    }
    this.dirty = false
    this.stats = { files: files.length, keys: this.byKey.size, ms: Date.now() - t0, resolver: s.resolver }
    return this.stats
  }

  _add(entry, lang, value) {
    if (!value) return
    this.byKey.set(entry.key, entry)
    entry.values[lang] = value
    const list = this.byValue.get(value) || []
    if (!list.some(e => e.key === entry.key)) list.push(entry)
    this.byValue.set(value, list)
  }

  // `object LShell { val tabSchedule = LKey(he = "לוז", en = "Schedule") … }` — the call may
  // span several lines; scan from the `val` to the matching `)`.
  _indexLKey(rel, src, langs) {
    const lines = src.split('\n')
    let object = ''
    for (let i = 0; i < lines.length; i++) {
      const om = /^\s*(?:private\s+)?object\s+(\w+)/.exec(lines[i])
      if (om) { object = om[1]; continue }
      const vm = /^\s*val\s+(\w+)\s*=\s*LKey\s*\(/.exec(lines[i])
      if (!vm || !object) continue
      let buf = lines[i]; let j = i
      while (!balanced(buf) && j < lines.length - 1) buf += '\n' + lines[++j]
      const key = `${object}.${vm[1]}`
      const entry = this.byKey.get(key) || { key, file: rel, line: i + 1, values: {} }
      for (const m of buf.matchAll(/\b(\w{2,5})\s*=\s*"((?:[^"\\]|\\.)*)"/g)) if (langs.includes(m[1])) this._add(entry, m[1], unescapeKt(m[2]))
      i = j
    }
  }

  // <string name="k">Hello, <xliff:g id="n">%1$s</xliff:g>!</string>
  _indexAndroidXml(rel, src, lang) {
    const lines = src.split('\n')
    const re = /<string\s+name="([\w.]+)"[^>]*>([\s\S]*?)<\/string>/g
    let m
    while ((m = re.exec(src))) {
      const key = `R.string.${m[1]}`
      const line = src.slice(0, m.index).split('\n').length
      const entry = this.byKey.get(key) || { key, file: rel, line, values: {} }
      if (lang === 'default') { entry.file = rel; entry.line = line }
      this._add(entry, lang, unescapeXml(m[2]))
    }
    void lines
  }

  // R.string.k · stringResource(R.string.k) · getString(R.string.k) · @string/k · LFoo.bar
  _indexUsages(rel, src) {
    const lines = src.split('\n')
    const res = this.cfg.strings.resolver
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      const keys = []
      if (res === 'android-xml') {
        for (const m of line.matchAll(/R\.string\.(\w+)/g)) keys.push(`R.string.${m[1]}`)
        for (const m of line.matchAll(/@string\/(\w+)/g)) keys.push(`R.string.${m[1]}`)
      } else if (res === 'lkey') {
        if (new RegExp(this.cfg.strings.files || '/l10n/|Strings\\.kt$').test(rel)) continue
        for (const m of line.matchAll(/\b(L[A-Z][A-Za-z]+)\.([a-z][A-Za-z0-9]*)\b/g)) keys.push(`${m[1]}.${m[2]}`)
      }
      for (const key of keys) {
        const list = this.usage.get(key) || []
        if (list.length < 40) list.push({ file: rel, line: i + 1, code: line.trim().slice(0, 160) })
        this.usage.set(key, list)
      }
    }
  }

  // Hardcoded string literals in code — a real hit when present.
  _indexLiterals(rel, src) {
    if (this.cfg.strings.resolver === 'lkey' && new RegExp(this.cfg.strings.files || '/l10n/|Strings\\.kt$').test(rel)) return
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      for (const m of line.matchAll(/"((?:[^"\\]|\\.){2,120})"/g)) {
        const v = unescapeKt(m[1])
        if (!/\p{L}/u.test(v) || /^[\w.\-/:]+$/.test(v)) continue // ids, paths, urls
        const list = this.literal.get(v) || []
        if (list.length < 8) list.push({ file: rel, line: i + 1, code: line.trim().slice(0, 160) })
        this.literal.set(v, list)
      }
    }
  }

  lookup(text, hint = '') {
    const t = normalise(text)
    if (!t) return { keys: [], literals: [], lang: '' }
    let entries = this.byValue.get(t) || this.byValue.get(text.trim()) || []
    if (!entries.length) entries = this._templateMatch(t)
    const lang = entries.length ? (Object.keys(entries[0].values).find(l => entries[0].values[l] === t) || '') : ''
    return {
      keys: entries.map(e => ({ ...e, usedBy: rankUsages(this.usage.get(e.key) || [], hint) })),
      literals: this.literal.get(t) || [],
      lang,
    }
  }

  _templateMatch(t) {
    if (t.length > 80) return []
    const out = []
    for (const [v, entries] of this.byValue) {
      if (!/%\d?\$?[sd]|%[sd]/.test(v)) continue
      const re = new RegExp('^' + v.split(/%\d?\$?[sd]/).map(escapeRe).join('.+?') + '$')
      if (re.test(t)) out.push(...entries)
      if (out.length >= 3) break
    }
    return out
  }

  // Watchers are released when the project is switched away from: one daemon serves many
  // projects, and a recursive watch per project would hold file descriptors for repos
  // nobody is looking at.
  unwatch() { for (const w of this._watchers) { try { w.close() } catch {} } this._watchers = [] }

  watch(onChange) {
    const dirs = [...this.cfg.sourceRoots, ...(this.cfg.strings.resDirs || [])].map(r => path.join(this.root, r))
    let timer = null
    for (const dir of dirs) {
      try {
        this._watchers.push(fsSync.watch(dir, { recursive: true }, () => {
          this.dirty = true
          clearTimeout(timer); timer = setTimeout(() => onChange?.(), 400)
        }))
      } catch { /* recursive watch unsupported here: the index rebuilds on the next request */ }
    }
  }
}

// Call sites that render the copy rank above ones that only map it (error tables, enums);
// a file named after the current screen ranks above all.
export function rankUsages(list, hint = '') {
  const clean = String(hint || '').replace(/[^A-Za-z]/g, '')
  const h = clean.length >= 4 ? new RegExp(clean, 'i') : null
  const score = u => (/\b(Text|contentDescription|label|title|placeholder|setText|hint)\b/.test(u.code) ? 2 : 0)
    + (/\/ui\//.test(u.file) ? 1 : 0) - (/UsageGuide|Guest|Test/.test(u.file) ? 1 : 0)
    + (h && h.test(u.file.split('/').pop()) ? 3 : 0)
  return [...list].sort((a, b) => score(b) - score(a))
}

const balanced = s => { let d = 0; for (const c of s) { if (c === '(') d++; else if (c === ')') d-- } return d <= 0 }
const unescapeKt = s => s.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/\\\$/g, '$')
const unescapeXml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\@/g, '@').replace(/\\\?/g, '?')
  .replace(/\s+/g, ' ').trim()
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Bidi isolates and NBSP show up in on-screen text that the source never contains.
export const normalise = s => String(s || '').replace(/[⁦-⁩‎‏]/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

async function walk(dir, re, out = []) {
  let entries = []
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'build' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, re, out)
    else if (re.test(p)) out.push(p)
  }
  return out
}


// ------------------------------------------------------------ ranking -----

// An element on the phone screen is never rendered by CarPlay / widget / AI / notification
// code — those keys lose, however well their copy matches.
export const OFF_PHONE = /^(LCarPlay|LCar|LWidget|LAi|LNotify|LWatch|LWear)\b|\/(car|widget|notify|watch|wear)\//

export function firstText(nodes, i) {
  for (let j = i + 1; j < nodes.length && nodes[j].depth > nodes[i].depth; j++) if (nodes[j].text || nodes[j].desc) return nodes[j]
  return null
}
export function countTexts(nodes, i) {
  let c = 0
  for (let j = i + 1; j < nodes.length && nodes[j].depth > nodes[i].depth; j++) if (nodes[j].text) c++
  return c
}

// Rank candidate keys by how the node presents the text, by surface, and by ROW
// CONSISTENCY: when four sibling tabs resolved to LShell.* rendered in RootScreen.kt, the
// fifth is theirs too — "מקומות" once went to LCarPlay.tabPlaces and "הגדרות" to the
// settings screen's title while their neighbours pointed at RootScreen.kt.
export function rankKeys(entries, node, viaDesc, hints = { objects: [], files: [] }) {
  const score = e => {
    const codes = (e.usedBy || []).map(u => u.code).join(' ')
    let s = 0
    if (viaDesc && /contentDescription/.test(codes)) s += 2
    if (!viaDesc && /\bText\(|label|title/.test(codes)) s += 2
    if (/A11y$/.test(e.key) === viaDesc) s += 1
    if (OFF_PHONE.test(e.key) || OFF_PHONE.test(e.file)) s -= 4
    if (hints.objects.includes(e.key.split('.')[0])) s += 3
    if ((e.usedBy || []).some(u => hints.files.includes(u.file))) s += 2
    return s
  }
  const ranked = [...entries].sort((a, b) => score(b) - score(a))
  // The rendered line follows the row too: the tab's RootScreen call over a screen title.
  for (const k of ranked) k.usedBy = [...(k.usedBy || [])].sort((a, b) => Number(hints.files.includes(b.file)) - Number(hints.files.includes(a.file)))
  return ranked
}

// What the interactive SIBLINGS of this element's tap target resolved to: their key
// objects and their rendered files.
export function siblingHints(index, nodes, target, hint = '') {
  const out = { objects: [], files: [] }
  if (!target || target.parent < 0) return out
  const sibs = nodes[target.parent].children.map(c => nodes[c]).filter(c => c !== target && (c.clickable || c.selected || c.checkable))
  for (const c of sibs.slice(0, 8)) {
    const t = c.text || c.desc || (firstText(nodes, c.i) || {}).text
    if (!t) continue
    for (const k of index.lookup(t, hint).keys.filter(k => !OFF_PHONE.test(k.key) && !OFF_PHONE.test(k.file))) {
      out.objects.push(k.key.split('.')[0])
      for (const u of (k.usedBy || []).slice(0, 3)) out.files.push(u.file)
    }
  }
  return out
}

// ------------------------------------------------------------------ tree ----

// uiautomator's flat dump carries depth; rebuild parent links so a reference can name the
// tappable ancestor of a label, its position among siblings, and an anchor text nearby.
export function buildTree(nodes) {
  const stack = []
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop()
    n.parent = stack.length ? stack[stack.length - 1].i : -1
    n.children = []
    if (n.parent >= 0) nodes[n.parent].children.push(n.i)
    stack.push(n)
  }
  return nodes
}

export function ancestors(nodes, i) {
  const out = []
  for (let p = nodes[i]?.parent; p >= 0; p = nodes[p].parent) out.push(nodes[p])
  return out
}

// "Interactive" includes `selected`: Compose drops the click action from the CURRENTLY
// selected tab (clickable=false, selected=true), which would otherwise read "not tappable".
const interactive = n => n.clickable || n.selected || n.checkable || n.longClickable
export function tapTarget(nodes, i) {
  const n = nodes[i]
  if (interactive(n)) return n
  return ancestors(nodes, i).find(interactive) || null
}

// "3 of 5" among the interactive siblings that share the target's ROW (or column). Geometry
// is required: a FAB's siblings under the screen root are unrelated clickables.
export function siblingPosition(nodes, target) {
  if (!target || target.parent < 0) return null
  const all = nodes[target.parent].children.map(c => nodes[c]).filter(interactive)
  if (all.length < 2 || all.length > 12) return null
  const cy = target.y + target.h / 2, cx = target.x + target.w / 2
  const similar = c => c.h < target.h * 1.6 && c.h > target.h / 1.6 && c.w < target.w * 1.6 && c.w > target.w / 1.6
  const row = all.filter(c => similar(c) && Math.abs(c.y + c.h / 2 - cy) < target.h / 2)
  if (row.length >= 2) return { index: row.sort((a, b) => a.x - b.x).indexOf(target) + 1, of: row.length, axis: 'row' }
  const col = all.filter(c => similar(c) && Math.abs(c.x + c.w / 2 - cx) < target.w / 2)
  if (col.length >= 2) return { index: col.sort((a, b) => a.y - b.y).indexOf(target) + 1, of: col.length, axis: 'column' }
  return null
}

export function region(n, W, H) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2
  const v = cy < H * 0.12 ? 'top bar' : cy > H * 0.88 ? 'bottom bar' : cy < H / 3 ? 'upper' : cy > H * 2 / 3 ? 'lower' : 'middle'
  const h = n.w > W * 0.8 ? 'full-width' : cx < W / 3 ? 'left' : cx > W * 2 / 3 ? 'right' : 'centre'
  return `${v}, ${h}`
}

export function role(n, target, pos) {
  const cls = n.cls.split('.').pop()
  if (n.checkable) return n.cls.includes('Switch') ? 'switch' : /CheckBox|RadioButton/.test(cls) ? cls.toLowerCase() : 'selectable chip'
  if (/EditText/.test(cls)) return 'text field'
  if (/Button/.test(cls)) return 'button'
  if (target && target.selected && target !== n) return 'label of the selected tab'
  if (target && pos && pos.axis === 'row' && /TextView/.test(cls)) return 'tab label'
  if (target === n && pos && pos.axis === 'row' && !n.text && !n.desc) return n.selected ? 'selected tab' : 'tab'
  if (/ImageView|Image/.test(cls) && (n.desc || target)) return 'icon button'
  if (!n.text && n.desc && n.w <= 200 && n.h <= 200 && target) return 'icon button'
  if (n.scrollable) return 'scrollable list'
  if (/TextView/.test(cls)) return target && target !== n ? 'label inside a tappable container' : n.clickable ? 'tappable text' : 'text'
  if (n.clickable) return 'tappable view'
  return 'view'
}
export const article = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w

// Nearest text near a node that resolves — an anchor for elements with dynamic text.
export function anchorText(nodes, i, resolves, maxUp = 4) {
  let up = 0
  for (let p = nodes[i].parent; p >= 0 && up < maxUp; p = nodes[p].parent, up++) {
    for (const c of descendants(nodes, p, 3)) {
      if (c.i === i || !c.text) continue
      if (resolves(c.text)) return c
    }
  }
  return null
}
function descendants(nodes, i, depth, out = []) {
  if (depth < 0) return out
  for (const c of nodes[i].children || []) { out.push(nodes[c]); descendants(nodes, c, depth - 1, out) }
  return out
}

// The screen's NAME, from the tree alone — no adb, no git — so the trail can be kept from
// the cheap watch dump as well as from a full capture.
//   selected bottom tab  ›  the largest static text near the top
// Editable text is excluded, or a search query becomes the screen's name (it did: "שלום ab"),
// and so are bare amounts and clock times ("$0", "15:00" are not titles).
export const isLabel = t => /\p{L}{2,}/u.test(t) && !/^[\s\d$€£₪.,:%+-]+$/.test(t)
export function screenTitleOf(nodes, H = 2400, pkg = '') {
  const app = pkg ? nodes.filter(n => n.pkg === pkg) : nodes
  const focused = app.find(n => n.focused && /EditText/.test(n.cls))
  const top = app.filter(n => n.text && isLabel(n.text) && n.y < 400 && n.h >= 40 && n.w < 900 && !/EditText/.test(n.cls)
      && !(focused && n.text === focused.text))
    .sort((a, b) => (b.h * b.w) - (a.h * a.w))[0]
  const selTab = app.find(n => n.selected && n.y > H * 0.8 && n.h > 100)
  const selText = selTab ? app.find(m => m.i > selTab.i && m.depth > selTab.depth && m.text && isLabel(m.text)) : null
  const strict = [selText?.text, top?.text].filter((t, k, a) => t && a.indexOf(t) === k).join(' › ')
  if (strict) return strict
  // No header and no tab — a wizard page, a full-screen cover, an onboarding step. Rather
  // than call it "?", name it after its biggest line of copy: a screen with no name is a
  // hole in the path, and a hole is exactly what an agent cannot walk.
  // Ranked by READING ORDER and shortness, not by area: a heading is a short line near the
  // top, while the biggest block of text on a screen is usually a paragraph or a banner
  // ("10 tasks the organizers prepared for attendees · tap to import" is not a screen name).
  const hero = app.filter(n => n.text && isLabel(n.text) && n.y < H * 0.7 && n.w < 900 && !/EditText/.test(n.cls)
      && !(focused && n.text === focused.text))
    .sort((a, b) => (a.text.length > 40) - (b.text.length > 40) || a.y - b.y)[0]
  return hero ? hero.text.trim().slice(0, 60) : ''
}
