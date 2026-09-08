// emu-composer — server.
//
// Point at a UI element on a running Android emulator and get a prompt-ready reference:
// element attrs, the source that renders it, where it sits, and the state of the
// device/build/repo. Drive the emulator from the same page. Dictate into the prompt.
//
// Fast path: the on-device agent (agent.mjs) — dumps in ~0.2 s, frames in ~0.05 s, Unicode
// input. Slow path when the agent is unavailable: `uiautomator dump` (2.5 s) + screencap.
// No npm dependencies.
import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from './agent.mjs'
import { StringIndex, buildTree, tapTarget, siblingPosition, region, role, article, anchorText, normalise, firstText, countTexts, rankKeys, siblingHints } from './resolve.mjs'
import { HOME } from './config.mjs'

const execFileP = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

export async function start(cfg) {
const REPO = cfg.root
const OUT = path.join(REPO, '.emu-composer')
const PORT = Number(process.env.EMU_COMPOSER_PORT || cfg.port || 7788)
const ADB = cfg.adbPath
const PKG = cfg.package
const APP = cfg.appName
const JAR = process.env.EMU_COMPOSER_U2_JAR || path.join(HOME, 'u2.jar')

// ---------------------------------------------------------------- devices ---
// Several emulators may run at once; the page picks which one the composer mirrors. Every
// adb call reads the ACTIVE serial at call time, and each device keeps its own agent.
const state = { serial: process.env.ANDROID_SERIAL || '' }
const adb = (args, opts = {}) =>
  execFileP(ADB, state.serial ? ['-s', state.serial, ...args] : args, { maxBuffer: 64 << 20, encoding: 'buffer', ...opts })
const adbText = async args => (await adb(args)).stdout.toString('utf8')
const sh = cmd => execFileP('/bin/sh', ['-c', cmd], { cwd: REPO, maxBuffer: 8 << 20 })
  .then(r => r.stdout).catch(e => e.stdout || '')

const agents = new Map()
let agent = null
function agentFor(serial) {
  if (!agents.has(serial)) agents.set(serial, new Agent({ adb: ADB, serial, jar: JAR, log: (...a) => log(`[${serial}]`, ...a) }))
  return agents.get(serial)
}

// AVD names are cached per serial: `emu avd name` costs up to 3 s against an emulator
// that is dying, and it was asked twice per switch (16 s to move away from a dead one).
const avdNames = new Map()
async function listDevices() {
  const out = await execFileP(ADB, ['devices', '-l'], { encoding: 'utf8', timeout: 3000 }).then(r => r.stdout).catch(() => '')
  const rows = out.split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('*'))
  const devices = await Promise.all(rows.map(async l => {
    const [serial, st, ...rest] = l.split(/\s+/)
    const kv = Object.fromEntries(rest.map(x => x.split(':')).filter(x => x.length === 2))
    let avd = avdNames.get(serial) || ''
    if (!avd && /^emulator-\d+$/.test(serial) && st === 'device') {
      avd = await execFileP(ADB, ['-s', serial, 'emu', 'avd', 'name'], { encoding: 'utf8', timeout: 1500 })
        .then(r => r.stdout.split('\n')[0].trim()).catch(() => '')
      if (avd && !/^(OK|KO)/.test(avd)) avdNames.set(serial, avd); else avd = ''
    }
    return { serial, state: st, model: kv.model || kv.product || '', avd, active: serial === state.serial }
  }))
  return devices
}

async function pickDefaultSerial() {
  const devices = (await listDevices()).filter(d => d.state === 'device')
  if (state.serial && devices.some(d => d.serial === state.serial)) return state.serial
  const pick = devices.find(d => /^emulator-/.test(d.serial)) || devices[0]
  return pick ? pick.serial : ''
}

async function switchDevice(serial, why = '') {
  if (serial === state.serial && agent) return
  const old = agent
  state.serial = serial
  staticCtx = null; captures.clear()
  agent = serial ? agentFor(serial) : null
  log(`device → ${serial || '(none)'}${why ? ` (${why})` : ''}`)
  if (old && old !== agent) await old.stop().catch(() => {})
  if (agent) agent.start().catch(() => {})
  broadcast({ type: 'device', serial: state.serial, devices: await listDevices() })
}

// ---- live device tracking ---------------------------------------------------------------
// `adb track-devices` streams the device list on every change, so an emulator that boots,
// dies or comes back is noticed within a second — no polling, in either mode. When the
// active device goes away the composer moves to the best remaining one; when the first
// device appears it is adopted; a device that comes back is preferred if it was the last
// choice.
let lastChosen = ''
const sseClients = new Set()
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of sseClients) { try { res.write(line) } catch {} }
}
function trackDevices() {
  const p = spawn(ADB, ['track-devices'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  let timer = null
  p.stdout.on('data', d => {
    buf += d.toString()
    // frames: 4 hex length + payload; we only need "something changed"
    clearTimeout(timer); timer = setTimeout(onDevicesChanged, 400)
    if (buf.length > 65536) buf = ''
  })
  p.on('exit', () => setTimeout(trackDevices, 2000))
}
async function onDevicesChanged() {
  const devices = await listDevices()
  const usable = devices.filter(d => d.state === 'device')
  const activeOk = usable.some(d => d.serial === state.serial)
  if (!activeOk) {
    const back = usable.find(d => d.serial === lastChosen)
    const pick = back || usable.find(d => /^emulator-/.test(d.serial)) || usable[0]
    if (pick) await switchDevice(pick.serial, state.serial ? 'previous device went away' : 'device appeared')
    else if (state.serial) { await switchDevice('', 'no device left') }
    else broadcast({ type: 'device', serial: '', devices })
  } else broadcast({ type: 'device', serial: state.serial, devices })
}

const index = new StringIndex(cfg)

// ---------------------------------------------------------------- capture ---

// Slow path only. Retries because uiautomator refuses to dump while the screen animates.
async function slowDump() {
  let lastErr = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await adbText(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'])
      if (/dumped to/i.test(out)) {
        const xml = (await adb(['exec-out', 'cat', '/sdcard/window_dump.xml'])).stdout.toString('utf8')
        if (xml.includes('<hierarchy')) return xml
      }
      lastErr = out.trim()
    } catch (e) { lastErr = String(e.stderr || e.message) }
    await new Promise(r => setTimeout(r, 600))
  }
  throw new Error(`uiautomator dump failed after 4 attempts: ${lastErr || 'unknown'}`)
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const unescapeXml = s => s.replace(/&(amp|lt|gt|quot|apos);/g, m => ENTITIES[m])
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))

function parseNodes(xml) {
  const nodes = []
  const attrRe = /([\w-]+)="([^"]*)"/g
  let depth = 0
  const parts = xml.split(/(<node\b[^>]*?\/>|<node\b[^>]*?>|<\/node>)/g)
  for (const part of parts) {
    if (part === '</node>') { depth--; continue }
    if (!part.startsWith('<node')) continue
    const selfClosing = part.endsWith('/>')
    const attrs = {}
    attrRe.lastIndex = 0
    let a
    while ((a = attrRe.exec(part))) attrs[a[1]] = unescapeXml(a[2])
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds || '')
    if (b) {
      const [x1, y1, x2, y2] = b.slice(1).map(Number)
      nodes.push({
        i: nodes.length, depth,
        cls: attrs['class'] || '', pkg: attrs['package'] || '',
        text: attrs['text'] || '', desc: attrs['content-desc'] || '', rid: attrs['resource-id'] || '',
        clickable: attrs['clickable'] === 'true', longClickable: attrs['long-clickable'] === 'true',
        scrollable: attrs['scrollable'] === 'true', checkable: attrs['checkable'] === 'true',
        checked: attrs['checked'] === 'true', enabled: attrs['enabled'] !== 'false',
        selected: attrs['selected'] === 'true', focused: attrs['focused'] === 'true',
        password: attrs['password'] === 'true',
        x: x1, y: y1, w: x2 - x1, h: y2 - y1,
      })
    }
    if (!selfClosing) depth++
  }
  return buildTree(nodes)
}

// Captures are kept so /api/resolve can reason over the TREE the click came from, not a
// bare node the browser sent back.
const captures = new Map()
let captureSeq = 0

async function capture() {
  const t0 = Date.now()
  let xml, image, source
  // `dumpsys window windows` prints no mCurrentFocus on API 34; the unfiltered dump does.
  const focusP = adbText(['shell', 'dumpsys window | grep -m1 mCurrentFocus']).catch(() => '')
  // Give a starting/restarting agent a bounded chance (8 s) before taking the slow path —
  // never wait on it indefinitely: a hung restart once queued every capture for a minute.
  if (!agent && await pickDefaultSerial()) await switchDevice(await pickDefaultSerial())
  if (!state.serial) throw userError('no device attached — start an emulator, then pick it in the device menu')
  if (agent && await agent.ensureReady(agent._starting ? 4000 : 1500)) {
    try {
      const [x, jpg] = await Promise.all([agent.dump(), agent.screenshotJpegB64(85)])
      xml = x; image = { mime: 'image/jpeg', b64: jpg }; source = 'agent'
    } catch (e) { log('agent capture failed, falling back:', e.message) }
  }
  if (!xml) {
    // The agent holds the only UiAutomation slot: it must be gone during the slow dump, and
    // it comes back on its own 2 s after (scheduleRestart), so one bad moment is not a
    // permanent downgrade.
    await agent?.stop().catch(() => {})
    try {
      const [png, x] = await Promise.all([adb(['exec-out', 'screencap', '-p']).then(r => r.stdout), slowDump()])
      xml = x; image = { mime: 'image/png', b64: png.toString('base64') }; source = 'uiautomator'
    } finally {
      if (agent && await agent.available()) { agent.stopped = false; agent.scheduleRestart('after slow path', 2000) }
    }
  }
  const nodes = parseNodes(xml)
  const activity = (/mCurrentFocus=Window\{[^}]*?\s(\S+\/\S+)\}/.exec(await focusP) || [])[1] || ''
  const id = ++captureSeq
  const ctx = await gatherContext(nodes, activity)
  const cap = { id, nodes, activity, ctx, at: Date.now() }
  captures.set(id, cap)
  for (const k of [...captures.keys()].slice(0, -6)) captures.delete(k)
  const ms = Date.now() - t0
  log(`capture #${id} via ${source}: ${nodes.length} nodes in ${ms} ms`)
  return { id, image, nodes: nodes.map(publicNode), activity, context: ctx, source, ms }
}
const publicNode = n => ({ ...n, children: undefined, parent: undefined })

// ----------------------------------------------------------------- frames ---

let framing = false
async function frame() {
  if (framing) return null
  framing = true
  try {
    if (agent?.ready) {
      try { return { mime: 'image/jpeg', bytes: Buffer.from(await agent.screenshotJpegB64(70), 'base64') } }
      catch (e) { log('agent frame failed:', e.message) }   // rpc() already scheduled the restart
    }
    return { mime: 'image/png', bytes: (await adb(['exec-out', 'screencap', '-p'], { timeout: 8000 })).stdout }
  } finally { framing = false }
}

// ------------------------------------------------------------------ input ---

const deviceArg = s => `'${String(s).replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`
const userError = msg => { const e = new Error(msg); e.userFacing = true; return e }

async function doInput(cmd) {
  const r = v => String(Math.round(v))
  if (agent?.ready) {
    switch (cmd.type) {
      case 'tap': return agent.click(cmd.x, cmd.y)
      case 'swipe': return agent.swipe(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.ms || 200)
      case 'key': return agent.key(Number(cmd.code))
      case 'text': return agent.type(String(cmd.s))
    }
  }
  switch (cmd.type) {
    case 'tap': return adb(['shell', 'input', 'tap', r(cmd.x), r(cmd.y)])
    case 'swipe': return adb(['shell', 'input', 'swipe', r(cmd.x1), r(cmd.y1), r(cmd.x2), r(cmd.y2), r(Math.max(40, cmd.ms || 200))])
    case 'key': return adb(['shell', 'input', 'keyevent', String(cmd.code)])
    case 'text':
      if (/[^\x20-\x7e]/.test(cmd.s)) throw userError('non-ASCII text needs the on-device agent (`emu-composer setup-agent`)')
      return adb(['shell', `input text ${deviceArg(cmd.s)}`])
  }
  throw new Error(`unknown input type: ${cmd.type}`)
}

// ---------------------------------------------------------------- context ---

// Static facts are cached: device props and the installed package do not change between
// captures, and reading them cost ~0.3 s per capture before.
let staticCtx = null, staticAt = 0
async function staticContext() {
  if (staticCtx && Date.now() - staticAt < 120000) return staticCtx
  const [props, pkgInfo, gradle] = await Promise.all([
    adbText(['shell', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; ' +
      'getprop persist.sys.locale; getprop ro.product.locale; wm size; wm density']).catch(() => ''),
    adbText(['shell', 'dumpsys', 'package', PKG]).catch(() => ''),
    cfg.versionFile ? sh(`sed -n '1,120p' ${JSON.stringify(cfg.versionFile)}`) : Promise.resolve(''),
  ])
  const L = props.split('\n').map(l => l.trim())
  staticCtx = {
    model: L[0] || '?', release: L[1] || '?', sdk: L[2] || '?', locale: L[3] || L[4] || '?',
    size: (/Physical size:\s*(\S+)/.exec(props) || [])[1] || '',
    density: (/Physical density:\s*(\S+)/.exec(props) || [])[1] || '',
    installedVer: (/versionName=(\S+)/.exec(pkgInfo) || [])[1] || '',
    installedCode: (/versionCode=(\d+)/.exec(pkgInfo) || [])[1] || '',
    debuggable: /DEBUGGABLE/.test(pkgInfo),
    repoVer: (/versionName\s*=\s*"([^"]+)"/.exec(gradle) || [])[1] || '',
    repoCode: (/versionCode\s*=\s*(\d+)/.exec(gradle) || [])[1] || '',
  }
  staticAt = Date.now()
  return staticCtx
}

async function gatherContext(nodes, activity) {
  const [s, branch, head, dirty] = await Promise.all([
    staticContext(),
    sh('git rev-parse --abbrev-ref HEAD').then(t => t.trim()),
    sh('git rev-parse --short HEAD').then(t => t.trim()),
    sh('git status --porcelain | wc -l').then(t => Number(t.trim())),
  ])
  const appNodes = nodes.filter(n => n.pkg === PKG)
  const focused = appNodes.find(n => n.focused && /EditText/.test(n.cls))
  // Screen title = the largest static text near the top. Editable text is excluded, or a
  // search query would be reported as the screen's name (it was: screen "שלום ab").
  const isLabel = t => /\p{L}{2,}/u.test(t) && !/^[\s\d$€£₪.,:%+-]+$/.test(t)   // "$0", "15:00" are not titles
  const top = appNodes.filter(n => n.text && isLabel(n.text) && n.y < 400 && n.h >= 40 && n.w < 900 && !/EditText/.test(n.cls)
      && !(focused && n.text === focused.text))
    .sort((a, b) => (b.h * b.w) - (a.h * a.w))[0]
  // The selected tab of a bottom bar names the section the screen belongs to.
  const H = Number((/x(\d+)/.exec(s.size) || [])[1]) || 2400
  const selTab = appNodes.find(n => n.selected && n.y > H * 0.8 && n.h > 100)
  const selText = selTab ? appNodes.find(m => m.i > selTab.i && m.depth > selTab.depth && m.text && isLabel(m.text)) : null
  const labels = (cfg.signInLabels || []).map(l => normalise(l).toLowerCase())
  const signIn = appNodes.some(n => labels.includes(normalise(n.text || n.desc).toLowerCase()))
  // Foreground from the TREE, not only the focus line: the app's own root fills the screen.
  const foreground = activity.startsWith(PKG) || appNodes.some(n => n.depth <= 2 && n.w >= 1000)
  const mismatch = Boolean(s.installedVer && s.repoVer && s.installedVer !== s.repoVer)
  const ctx = {
    app: `${APP} (${PKG} ${s.installedVer || '?'}${s.installedCode ? `, code ${s.installedCode}` : ''}) — Android, ${s.debuggable ? 'debug' : 'release'} build`,
    screen: [selText?.text, top?.text].filter((t, k, a) => t && a.indexOf(t) === k).join(' › '),
    activity,
    foreground,
    session: !foreground ? `n/a — ${APP} is not the foreground app`
      : signIn ? 'signed-out (derived: a "Sign in" affordance is on screen)'
      : `signed-in (derived: no sign-in affordance; the identity itself is not read${s.debuggable ? '' : ' — release build'})`,
    focusedField: focused ? (focused.text ? `text field focused, contains "${focused.text.slice(0, 60)}"` : 'empty text field focused') : '',
    device: `${s.model} · Android ${s.release} (API ${s.sdk}) · ${s.size} @ ${s.density}dpi · locale ${s.locale}`,
    repo: `${branch || '?'} @ ${head || '?'}${dirty ? ` (${dirty} uncommitted)` : ''}${s.repoVer ? ` · declares ${s.repoVer} (${s.repoCode})${mismatch ? '' : ' — matches the installed build'}` : ''}`,
    versionMismatch: mismatch,
  }
  ctx.block = renderScreenBlock(ctx)
  return ctx
}

function renderScreenBlock(c) {
  const L = ['# Screen',
    `app:      ${c.app}`,
    `screen:   ${c.screen || '?'}${c.activity ? `  ·  ${c.activity}` : ''}`,
    `session:  ${c.session}`]
  if (c.focusedField) L.push(`input:    ${c.focusedField}`)
  L.push(`device:   ${c.device}`, `repo:     ${c.repo}`)
  if (c.versionMismatch) L.push('WARNING:  the installed build is NOT the version the repo declares — the running app may not contain HEAD\'s changes')
  return L.join('\n')
}

// ------------------------------------------------------------- reference ---

const q = s => JSON.stringify(String(s))
const short = f => { for (const r of cfg.sourceRoots) if (f.startsWith(r + '/')) return f.slice(r.length + 1); return f }

function stateWords(n) {
  const w = []
  if (n.selected) w.push('selected'); if (n.checked) w.push('checked'); if (n.focused) w.push('focused')
  if (!n.enabled) w.push('DISABLED'); if (n.password) w.push('password')
  return w
}

// Rank candidate keys by how the node presents the text: an icon's content-desc is more
// likely the key whose call sites pass `contentDescription`; visible text prefers `Text(`.
let debugHints = null
async function referenceFor(cap, i) {
  await index.ensure()
  debugHints = null
  const nodes = cap.nodes, n = nodes[i]
  // The first node is whichever WINDOW the dump lists first (often the status bar), so its
  // height is not the screen's — every element read "bottom bar" once. Use the display.
  const sz = /(\d+)x(\d+)/.exec((await staticContext()).size || '')
  const W = sz ? Number(sz[1]) : Math.max(...nodes.map(x => x.x + x.w)), H = sz ? Number(sz[2]) : Math.max(...nodes.map(x => x.y + x.h))
  const target = tapTarget(nodes, i)
  const pos = siblingPosition(nodes, target)
  const what = role(n, target, pos)
  const hint = (cap.ctx?.screen || '').split(/\s/)[0]
  // A textless container is titled after the first text inside it, and the block says so.
  const inner = !n.text && !n.desc ? firstText(nodes, i) : null
  const title = n.text || n.desc || (inner ? inner.text || inner.desc : '') || (n.rid ? n.rid.split('/').pop() : '') || n.cls.split('.').pop()

  const L = []
  L.push(`what:     ${what} · ${n.cls.split('.').pop()} · ${region(n, W, H)}${pos ? ` · ${pos.index} of ${pos.of} in its ${pos.axis}` : ''}`)
  if (cap.ctx?.screen) L.push(`screen:   ${cap.ctx.screen}`)
  if (inner) L.push(`contains: ${q(inner.text || inner.desc)}${countTexts(nodes, i) > 1 ? ` (+${countTexts(nodes, i) - 1} more text nodes)` : ''} — the container itself has no text`)
  L.push(`bounds:   [${n.x},${n.y}]→[${n.x + n.w},${n.y + n.h}] (${n.w}×${n.h}px)`)
  if (n.desc && n.desc !== n.text) L.push(`a11y:     ${q(n.desc)}`)
  if (n.rid) L.push(`id:       ${n.rid}`)
  const st = [...new Set([...stateWords(n), ...(target && target !== n ? stateWords(target) : [])])]
  if (st.length) L.push(`state:    ${st.join(', ')}${target && target !== n && target.selected ? ' (the container is the selected one)' : ''}`)
  if (target && target !== n) {
    const tw = [target.desc && `desc=${q(target.desc)}`, target.rid && `id=${target.rid}`].filter(Boolean).join(' ')
    L.push(`tap:      its container ${target.cls.split('.').pop()} [${target.x},${target.y}]→[${target.x + target.w},${target.y + target.h}]${tw ? ' ' + tw : ''}${target.selected && !target.clickable ? ' — currently selected, so it has no click action' : ''}`)
  } else if (!target) {
    L.push('tap:      not tappable (no interactive ancestor)')
  }

  // Copy → key → composable. A textless container resolves through its first inner text.
  const primary = n.text ? { text: n.text, viaDesc: false } : n.desc ? { text: n.desc, viaDesc: true }
    : inner ? { text: inner.text || inner.desc, viaDesc: !inner.text } : null
  let resolved = false
  if (primary) {
    const r = index.lookup(primary.text, hint)
    const hints = siblingHints(index, nodes, target, hint)
    debugHints = hints
    const keys = rankKeys(r.keys, n, primary.viaDesc, hints)
    // Rendered-file order follows the row too: the tab's own RootScreen line over a screen title.
    if (keys.length) keys[0].usedBy = [...(keys[0].usedBy || [])].sort((a, b) => hints.files.includes(b.file) - hints.files.includes(a.file))
    if (keys.length) {
      resolved = true
      const k = keys[0]
      const tri = Object.entries(k.values).map(([l, v]) => `${l} ${q(v)}`).join(' · ')
      L.push(`copy:     ${k.key}${r.lang ? ` (on screen: ${r.lang})` : ' (template match — the on-screen text is filled in at runtime)'}`)
      L.push(`          ${tri}`)
      L.push(`          defined ${k.file}:${k.line}`)
      const uses = k.usedBy || []
      if (uses.length) {
        L.push(`rendered: ${uses[0].file}:${uses[0].line}`)
        L.push(`          ${uses[0].code}`)
        const more = uses.slice(1, 5).map(u => `${short(u.file)}:${u.line}`)
        if (more.length) L.push(`also:     ${more.join(', ')}${uses.length > 5 ? ` (+${uses.length - 5})` : ''}`)
      } else L.push('rendered: no call site found for this key (unused, or referenced indirectly)')
      if (keys.length > 1) L.push(`note:     ${keys.length} keys share this copy — also ${keys.slice(1).map(x => x.key).join(', ')}; the first fits ${article(what)} best`)
    } else if (r.literals.length) {
      resolved = true
      L.push(`copy:     hardcoded literal (not in the l10n registry)`)
      for (const l of r.literals.slice(0, 3)) L.push(`          ${l.file}:${l.line}   ${l.code}`)
    }
  }
  if (!resolved) {
    if (primary) L.push(`copy:     ${q(primary.text)} — dynamic; not a literal in the sources (data-driven or formatted at runtime)`)
    else L.push('copy:     none (no text or content-description)')
    // Anchor on the nearest text that DOES resolve, so the agent can still find the screen.
    const anchor = anchorText(nodes, i, t => index.lookup(t).keys.length > 0)
    if (anchor) {
      const k = index.lookup(anchor.text, hint).keys[0]
      const u = (k.usedBy || [])[0]
      L.push(`near:     ${q(anchor.text)} → ${k.key}${u ? ` (rendered ${short(u.file)}:${u.line})` : ''} — use as an anchor`)
    }
  }
  if (n.desc && n.text && n.desc !== n.text && primary && !primary.viaDesc) {
    const rd = index.lookup(n.desc)
    if (rd.keys.length) L.push(`a11y key: ${rd.keys[0].key} (${short(rd.keys[0].file)}:${rd.keys[0].line})`)
  }
  return { title, what, screen: cap.ctx?.screen || '', lines: L, block: L.join('\n'), _hints: debugHints }
}

function agentNotes(size) {
  if (Array.isArray(cfg.notes)) return ['# Notes for the agent', ...cfg.notes].join('\n')
  const res = cfg.strings.resolver
  const strings = res === 'lkey'
    ? `Copy lives as LKey(${(cfg.strings.langs || []).join('/')}) objects and is rendered via l(...): to change wording, edit the LKey, not the composable.`
    : res === 'android-xml'
      ? 'Copy lives in res/values*/strings.xml as <string name>: to change wording, edit the resource (every locale), not the code.'
      : 'On-screen copy did not resolve to a string registry; search the sources for the literal.'
  return ['# Notes for the agent',
    `- Platform: Android only — this prompt was composed against the Android emulator. Code: ${cfg.sourceRoots.join(', ') || '(see repo)'}.`,
    `- ${strings}`,
    `- bounds are display px on a ${size || '?'} screen, [x1,y1]→[x2,y2]. "tap:" names the actually-clickable node when the picked one is only a label inside it.`,
  ].join('\n')
}

// ------------------------------------------------------- transcription -----

async function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim()
  for (const f of [path.join(HOME, 'openai-key'), path.join(process.env.HOME, '.config/openai/key')]) {
    try { const k = (await fs.readFile(f, 'utf8')).trim(); if (k) return k } catch {}
  }
  return ''
}

async function transcribe(audioB64, mime, language, prompt) {
  const key = await openaiKey()
  if (!key) throw userError('no OpenAI key — add one with the "מפתח API" button')
  const bytes = Buffer.from(audioB64, 'base64')
  const ext = /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mp4|m4a/.test(mime) ? 'mp4' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), `seg.${ext}`)
  form.append('model', process.env.EMU_COMPOSER_STT_MODEL || cfg.stt.model || 'gpt-4o-transcribe')
  if (language) form.append('language', language)
  // The previous segment's tail primes the model, which is what keeps a sentence that was
  // cut at a pause from restarting with a capital letter or losing its first word.
  if (prompt) form.append('prompt', String(prompt).slice(-400))
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30000),
  })
  const body = await r.text()
  if (!r.ok) {
    let msg = body; try { msg = JSON.parse(body).error?.message || body } catch {}
    throw userError(`OpenAI ${r.status}: ${msg}`)
  }
  return JSON.parse(body).text || ''
}

// ----------------------------------------------------------------- server ---

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
const readBody = req => new Promise((ok, bad) => {
  const c = []
  req.on('data', d => c.push(d)).on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')) } catch (e) { bad(e) } }).on('error', bad)
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    switch (url.pathname) {
      case '/':
        return send(res, 200, await fs.readFile(path.join(HERE, 'ui', 'index.html')), 'text/html; charset=utf-8')
      case '/api/capture':
        return send(res, 200, await capture())
      case '/api/frame': {
        const f = await frame()
        if (!f) return send(res, 429, { error: 'busy' })
        return send(res, 200, f.bytes, f.mime)
      }
      case '/api/input': {
        const body = await readBody(req)
        for (const cmd of body.cmds || [body]) await doInput(cmd)
        return send(res, 200, { ok: true })
      }
      case '/api/resolve': {
        const { captureId, i } = await readBody(req)
        const cap = captures.get(Number(captureId))
        if (!cap || !cap.nodes[i]) throw userError('that capture is gone — refresh and pick again')
        return send(res, 200, await referenceFor(cap, Number(i)))
      }
      case '/api/open':
        execFile('open', [`http://localhost:${PORT}`], () => {})
        return send(res, 200, { ok: true })
      case '/api/notes':
        return send(res, 200, { notes: agentNotes((await staticContext()).size) })
      case '/api/events': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify({ type: 'device', serial: state.serial, devices: await listDevices(), agent: Boolean(agent?.ready) })}\n\n`)
        sseClients.add(res)
        const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
        req.on('close', () => { sseClients.delete(res); clearInterval(ping) })
        return
      }
      case '/api/devices':
        return send(res, 200, { devices: await listDevices(), active: state.serial })
      case '/api/device': {
        const { serial } = await readBody(req)
        const devices = await listDevices()
        if (!devices.some(d => d.serial === serial && d.state === 'device')) throw userError(`device ${serial} is not attached`)
        lastChosen = serial
        await switchDevice(serial, 'chosen')
        return send(res, 200, { ok: true, active: state.serial })
      }
      case '/api/health': {
        const k = await openaiKey()
        return send(res, 200, {
          stt: Boolean(k), hint: k ? `…${k.slice(-4)}` : '', language: cfg.stt.language || '', app: APP,
          serial: state.serial, devices: await listDevices(),
          agent: Boolean(agent?.ready), agentReason: agent?.reason || (state.serial ? '' : 'no device'),
          index: index.stats || null,
          device: state.serial ? await adbText(['get-state']).then(t => t.trim()).catch(() => 'offline') : 'none',
        })
      }
      case '/api/agent/restart':
        if (!agent) throw userError('no device selected')
        return send(res, 200, { ok: await agent.restart('requested'), reason: agent.reason })
      case '/api/key': {
        const { key } = await readBody(req)
        const k = String(key || '').trim()
        if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(k)) throw userError('that does not look like an OpenAI key (expected sk-…)')
        await fs.mkdir(HOME, { recursive: true })
        await fs.writeFile(path.join(HOME, 'openai-key'), k + '\n', { mode: 0o600 })
        return send(res, 200, { ok: true, hint: `…${k.slice(-4)}` })
      }
      case '/api/transcribe': {
        const { audio, mime, language, prompt } = await readBody(req)
        return send(res, 200, { text: await transcribe(audio, mime, language, prompt) })
      }
      case '/api/save': {
        // Crops + full screenshot + the assembled prompt, for a reference that outlives the tab.
        const { text, crops, screen } = await readBody(req)
        await fs.mkdir(OUT, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const files = []
        for (const [n, c] of (crops || []).entries()) {
          if (!c) continue
          const rel = `.emu-composer/${stamp}-ui${n + 1}.png`
          await fs.writeFile(path.join(REPO, rel), Buffer.from(c.split(',')[1], 'base64'))
          files.push(rel)
        }
        let shot = ''
        if (screen) { shot = `.emu-composer/${stamp}-screen.${/jpeg/.test(screen.slice(0, 30)) ? 'jpg' : 'png'}`; await fs.writeFile(path.join(REPO, shot), Buffer.from(screen.split(',')[1], 'base64')) }
        const full = (text || '') + (files.length || shot ? `\n\n# Files\n${shot ? `screenshot: ${shot}\n` : ''}${files.map((f, n) => `@ui${n + 1} crop: ${f}`).join('\n')}\n` : '')
        await fs.writeFile(path.join(OUT, `${stamp}.md`), full)
        await fs.writeFile(path.join(OUT, 'latest.md'), full)
        return send(res, 200, { file: `.emu-composer/${stamp}.md`, text: full })
      }
    }
    send(res, 404, { error: 'not found' })
  } catch (e) {
    if (!e.userFacing) log('ERROR', url.pathname, e.stack || e)
    send(res, e.userFacing ? 400 : 500, { error: String(e.message || e) })
  }
})

// A restart races the previous instance's shutdown (its SIGTERM handler releases the agent
// first), so the bind is retried for a few seconds instead of dying with EADDRINUSE.
let bindTries = 0
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && bindTries++ < 20) { log(`port ${PORT} busy, retrying…`); return setTimeout(() => server.listen(PORT, '127.0.0.1'), 400) }
  log('FATAL', e.message); process.exit(1)
})
server.on('listening', async () => {
  log(`emu-composer → http://localhost:${PORT}  (${APP} · ${PKG} · adb ${ADB})`)
  const st = await index.build()
  log(`string index (${st.resolver}): ${st.keys} keys from ${st.files} files in ${st.ms} ms`)
  index.watch(() => index.build().then(s => log(`string index rebuilt: ${s.keys} keys`)))
  const serial = await pickDefaultSerial()
  if (!serial) { log('no device attached — waiting for one to be picked'); return }
  state.serial = serial; agent = agentFor(serial)
  const devices = await listDevices()
  log(`devices: ${devices.map(d => `${d.serial}${d.avd ? ` (${d.avd})` : ''}${d.serial === serial ? ' ←' : ''}`).join(', ')}`)
  const ok = await agent.start()
  log(ok ? 'fast path: on-device agent' : `slow path: ${agent.reason}`)
})
// The page learns about the agent flipping without waiting for its next health poll.
let lastAgentState = null
setInterval(() => { const st = Boolean(agent?.ready); if (st !== lastAgentState) { lastAgentState = st; broadcast({ type: 'agent', ready: st, reason: agent?.reason || '' }) } }, 1000)
trackDevices()
server.listen(PORT, '127.0.0.1')
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { for (const a of agents.values()) await a.release().catch(() => {}); process.exit(0) })
return { server, agent, index, port: PORT }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { findConfig, loadConfig } = await import('./config.mjs')
  const p = process.env.EMU_COMPOSER_CONFIG || findConfig()
  if (!p) { console.error('no emu-composer.json found — run `emu-composer init` in the project'); process.exit(2) }
  await start(await loadConfig(p))
}
