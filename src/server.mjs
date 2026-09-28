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
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from './agent.mjs'
import { IosAgent, listSimulators, screenshotPng, installedApp, deviceProps, launch as simLaunch, iosNodes } from './ios.mjs'
import { StringIndex, buildTree, tapTarget, siblingPosition, region, role, article, anchorText, normalise, firstText, countTexts, rankKeys, siblingHints, screenTitleOf } from './resolve.mjs'
import { filterLog, errorBlock, collapseLines } from './logcat.mjs'
import { HOME } from './config.mjs'

const execFileP = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

export async function start(bootCfg) {
const PORT = Number(process.env.EMU_COMPOSER_PORT || bootCfg.port || 7788)
// adb is a machine-wide tool: every project on this machine talks to the same server, so the
// path is taken once from whichever project started the daemon.
const ADB = bootCfg.adbPath
const JAR = process.env.EMU_COMPOSER_U2_JAR || path.join(HOME, 'u2.jar')

// --------------------------------------------------------------- projects ---
// ONE daemon serves every project you have open. Each project keeps its own config, its own
// string index and its own `.emu-composer/` output directory; `P` is the active one and is
// switched BY HAND from the page (a dropdown), never guessed from what happens to be in the
// foreground — you often point at app A while thinking about repo B.
const REGISTRY = path.join(HOME, 'projects.json')
const projects = new Map()      // configPath -> { id, cfg, index, rules }
let P = null                    // the active project record
const outDir = () => path.join(P.cfg.root, '.emu-composer')

async function addProject(cfg) {
  const rec = projects.get(cfg.configPath) || { id: cfg.configPath, cfg, index: new StringIndex(cfg), indexIos: null }
  rec.cfg = cfg
  if (cfg.ios && !rec.indexIos) rec.indexIos = new StringIndex({ root: cfg.root, sourceRoots: cfg.ios.sourceRoots, strings: cfg.ios.strings })
  rec.rules = await agentRuleFiles(cfg.root)
  projects.set(cfg.configPath, rec)
  await saveRegistry()
  return rec
}

async function saveRegistry() {
  const rows = [...projects.values()].map(r => ({ configPath: r.cfg.configPath, package: r.cfg.package, appName: r.cfg.appName, root: r.cfg.root }))
  await fs.mkdir(HOME, { recursive: true }).catch(() => {})
  await fs.writeFile(REGISTRY, JSON.stringify(rows, null, 2) + '\n').catch(() => {})
}

// Registered projects are remembered between runs, so the dropdown is populated the moment
// the daemon starts — a project whose config has since been deleted or moved is dropped.
async function loadRegistry(loadConfig) {
  let rows = []
  try { rows = JSON.parse(await fs.readFile(REGISTRY, 'utf8')) } catch { return }
  for (const r of rows) {
    if (projects.has(r.configPath)) continue
    try { await addProject(await loadConfig(r.configPath)) }
    catch (e) { log(`registry: dropping ${r.configPath} (${e.message})`) }
  }
}

// Switching project invalidates everything that was read THROUGH a package: the installed
// version, the screen title, the trail, and every capture whose references were resolved
// against another repo's sources.
async function activate(id, why = '') {
  const rec = projects.get(id)
  if (!rec || rec === P) return rec
  const prev = P
  P = rec
  staticCtx = null; captures.clear(); lastHash = ''; trail.length = 0; lastForeground = null
  prev?.index.unwatch(); prev?.indexIos?.unwatch()
  log(`project → ${rec.cfg.appName} (${rec.cfg.package})${why ? ` (${why})` : ''}`)
  for (const [ix, what] of [[rec.index, 'android'], [rec.indexIos, 'ios']]) {
    if (!ix) continue
    const st = await ix.ensure().then(() => ix.stats)
    if (st) log(`string index ${what} (${st.resolver}): ${st.keys} keys from ${st.files} files in ${st.ms} ms`)
    ix.watch(() => ix.build().then(s => log(`string index ${what} rebuilt: ${s.keys} keys`)))
  }
  broadcast({ type: 'project', ...projectList() })
  refreshAvailability().catch(() => {})
  return rec
}

const projectList = () => ({
  active: P?.id || '',
  projects: [...projects.values()].map(r => ({ id: r.id, name: r.cfg.appName, package: r.cfg.package, root: r.cfg.root, ios: Boolean(r.cfg.ios),
    devices: availability.get(r.id) || [] })),
})

// Which open devices can actually show each project: its app is installed there (Android
// package or iOS bundle). One `pm list packages` per emulator and one app-container lookup
// per simulator and project, refreshed when devices come and go and every 20 s (installs).
// The menus mark these with a green dot, so a repo with nothing running reads as such.
const availability = new Map()   // project id -> [serial, ...]
let availSig = '', availRunning = false
async function refreshAvailability() {
  if (availRunning) return
  availRunning = true
  try {
    const devices = (await listDevices()).filter(d => d.state === 'device')
    const pkgsBy = new Map()
    await Promise.all(devices.filter(d => d.kind === 'android').map(async d => {
      const out = await execFileP(ADB, ['-s', d.serial, 'shell', 'pm list packages'], { encoding: 'utf8', timeout: 5000 }).then(r => r.stdout).catch(() => '')
      pkgsBy.set(d.serial, new Set(out.split('\n').map(l => l.replace(/^package:/, '').trim()).filter(Boolean)))
    }))
    const next = new Map()
    for (const r of projects.values()) {
      const on = []
      for (const d of devices) {
        if (d.kind === 'android') { if (r.cfg.package && pkgsBy.get(d.serial)?.has(r.cfg.package)) on.push(d.serial) }
        else if (r.cfg.ios?.bundleId && (await installedApp(d.serial, r.cfg.ios.bundleId)).installed) on.push(d.serial)
      }
      next.set(r.id, on)
    }
    const sig = JSON.stringify([...next])
    availability.clear(); for (const [k, v] of next) availability.set(k, v)
    if (sig !== availSig) { availSig = sig; broadcast({ type: 'project', ...projectList() }) }
  } finally { availRunning = false }
}

// Which agent-rule files this repo carries, so the prompt can point the agent at them.
async function agentRuleFiles(root) {
  const names = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.cursor/rules', 'GEMINI.md', '.github/copilot-instructions.md']
  const found = []
  for (const n of names) { try { await fs.access(path.join(root, n)); found.push(n) } catch {} }
  return found
}

// ---------------------------------------------------------------- devices ---
// Several emulators may run at once; the page picks which one the composer mirrors. Every
// adb call reads the ACTIVE serial at call time, and each device keeps its own agent.
// `kind` is 'android' (an adb serial) or 'ios' (a simulator udid). Everything that talks to
// a device branches on it once, here; the page and the prompt do not care.
const state = { serial: process.env.ANDROID_SERIAL || '', kind: 'android' }
const isIos = () => state.kind === 'ios'
const IOS_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i
// The package / bundle, sources and string registry the ACTIVE device resolves against.
const activePkg = () => (isIos() ? P.cfg.ios?.bundleId : P.cfg.package) || ''
const activeRoots = () => (isIos() ? P.cfg.ios?.sourceRoots : P.cfg.sourceRoots) || []
const activeStrings = () => (isIos() ? P.cfg.ios?.strings : P.cfg.strings) || { resolver: 'none' }
const activeIndex = () => (isIos() ? P.indexIos : P.index)
const requireIos = () => { if (isIos() && !P.cfg.ios) throw userError(`${P.cfg.appName} has no "ios" block in emu-composer.json — add bundleId, sourceRoots and strings for the simulator`) }
const adb = (args, opts = {}) =>
  execFileP(ADB, state.serial ? ['-s', state.serial, ...args] : args, { maxBuffer: 64 << 20, encoding: 'buffer', ...opts })
const adbText = async args => (await adb(args)).stdout.toString('utf8')
const sh = cmd => execFileP('/bin/sh', ['-c', cmd], { cwd: P.cfg.root, maxBuffer: 8 << 20 })
  .then(r => r.stdout).catch(e => e.stdout || '')

const agents = new Map()
let agent = null
function agentFor(serial) {
  if (!agents.has(serial)) {
    const alog = (...a) => log(`[${serial.slice(0, 13)}]`, ...a)
    // One runner per simulator, each on its own port: a udid is stable across boots.
    const port = 8100 + (Array.from(serial).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 200)
    agents.set(serial, IOS_UDID.test(serial) ? new IosAgent({ udid: serial, port, log: alog }) : new Agent({ adb: ADB, serial, jar: JAR, log: alog }))
  }
  return agents.get(serial)
}

// AVD names are cached per serial: `emu avd name` costs up to 3 s against an emulator
// that is dying, and it was asked twice per switch (16 s to move away from a dead one).
const avdNames = new Map()
async function listDevices() {
  const out = await execFileP(ADB, ['devices', '-l'], { encoding: 'utf8', timeout: 3000 }).then(r => r.stdout).catch(() => '')
  const rows = out.split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('*'))
  // A serial is a PORT, and ports are reused: once emulator-5556 was lumela_ui_a, the next
  // emulator on that port showed up under the old name. Forget a name as soon as its serial
  // is gone or not fully up (a booting emulator is listed "offline" first).
  const up = new Set(rows.map(l => l.split(/\s+/)).filter(([, st]) => st === 'device').map(([sr]) => sr))
  for (const sr of [...avdNames.keys()]) if (!up.has(sr)) avdNames.delete(sr)
  // Emulators started with -no-window (test runners, CI-style boots) are not for mirroring
  // by default: a restart once landed on one while the visible emulator sat unused.
  const ps = await execFileP('ps', ['-axo', 'command'], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 << 20 }).then(r => r.stdout).catch(() => '')
  const headless = new Set(ps.split('\n').filter(l => /qemu-system/.test(l) && /-no-window|-headless/.test(l)).map(l => (/-avd\s+(\S+)/.exec(l) || [])[1]).filter(Boolean))
  const devices = await Promise.all(rows.map(async l => {
    const [serial, st, ...rest] = l.split(/\s+/)
    const kv = Object.fromEntries(rest.map(x => x.split(':')).filter(x => x.length === 2))
    let avd = avdNames.get(serial) || ''
    if (!avd && /^emulator-\d+$/.test(serial) && st === 'device') {
      avd = await execFileP(ADB, ['-s', serial, 'emu', 'avd', 'name'], { encoding: 'utf8', timeout: 1500 })
        .then(r => r.stdout.split('\n')[0].trim()).catch(() => '')
      if (avd && !/^(OK|KO)/.test(avd)) avdNames.set(serial, avd); else avd = ''
    }
    return { serial, kind: 'android', state: st, model: kv.model || kv.product || '', avd, headless: Boolean(avd && headless.has(avd)), active: serial === state.serial }
  }))
  // Booted iOS simulators sit in the same list; the page shows them in the same menu.
  for (const d of await listSimulators()) devices.push({ ...d, active: d.serial === state.serial })
  return devices
}

async function pickDefaultSerial() {
  const devices = (await listDevices()).filter(d => d.state === 'device')
  if (state.serial && devices.some(d => d.serial === state.serial)) return state.serial
  return choosePreferred(devices)?.serial || ''
}
// The same preference everywhere a device is chosen for the user: an emulator with a window
// that has the active project's app, then any windowed emulator, then anything with the app.
function choosePreferred(usable) {
  const has = new Set(availability.get(P?.id) || [])
  const shown = d => /^emulator-/.test(d.serial) && !d.headless
  return usable.find(d => has.has(d.serial) && shown(d)) || usable.find(d => shown(d))
    || usable.find(d => has.has(d.serial)) || usable.find(d => /^emulator-/.test(d.serial)) || usable[0]
}

async function switchDevice(serial, why = '') {
  if (serial === state.serial && agent) return
  const old = agent
  state.serial = serial
  state.kind = IOS_UDID.test(serial) ? 'ios' : 'android'
  staticCtx = null; captures.clear(); lastHash = ''; trail.length = 0; lastForeground = null; iosScreen = null
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
let simSig = ''
async function pollSimulators() {
  const sig = (await listSimulators()).map(d => d.serial).sort().join('|')
  if (sig !== simSig) { simSig = sig; onDevicesChanged() }
}
function trackDevices() {
  setInterval(() => pollSimulators().catch(() => {}), 3000)
  setInterval(() => refreshAvailability().catch(() => {}), 20000)
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
  await refreshAvailability().catch(() => {})
  const devices = await listDevices()
  const usable = devices.filter(d => d.state === 'device')
  const activeOk = usable.some(d => d.serial === state.serial)
  if (!activeOk) {
    const back = usable.find(d => d.serial === lastChosen)
    const pick = back || choosePreferred(usable)
    if (pick) await switchDevice(pick.serial, state.serial ? 'previous device went away' : 'device appeared')
    else if (state.serial) { await switchDevice('', 'no device left') }
    else broadcast({ type: 'device', serial: '', devices })
  } else broadcast({ type: 'device', serial: state.serial, devices })
}


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

// The iOS Simulator: one screenshot through simctl, one tree through the runner. Frames come
// in POINTS from XCUITest and the screenshot in pixels; the ratio is the scale, remembered so
// input can go the other way. Foreground = the app's own state, which the runner reports.
let iosScreen = null   // { w, h, scale } of the active simulator, from its last screenshot
async function captureIos() {
  requireIos()
  const bundle = activePkg()
  if (!agent || !(await agent.ensureReady(agent._starting ? 30000 : 3000))) throw userError(agent?.reason || 'the iOS agent is not running')
  const [png, tree] = await Promise.all([screenshotPng(state.serial), agent.tree(bundle)])
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20)
  const root = (tree.nodes || [])[0]
  const scale = root && root.w > 0 ? w / root.w : 3
  iosScreen = { w, h, scale }
  const nodes = buildTree(iosNodes(tree, scale, bundle))
  return { nodes, image: { mime: 'image/png', b64: png.toString('base64') }, source: 'ios-agent', activity: tree.state === 4 ? bundle : (tree.state ? `${bundle} (background)` : '') }
}

async function capture() {
  const t0 = Date.now()
  let xml, image, source, nodes, activity
  if (!agent && await pickDefaultSerial()) await switchDevice(await pickDefaultSerial())
  if (!state.serial) throw userError('no device attached — start an emulator or a simulator, then pick it in the device menu')
  if (isIos()) {
    const r = await captureIos()
    nodes = r.nodes; image = r.image; source = r.source; activity = r.activity
    return finishCapture(t0, nodes, image, source, activity)
  }
  // `dumpsys window windows` prints no mCurrentFocus on API 34; the unfiltered dump does.
  const focusP = adbText(['shell', 'dumpsys window | grep -m1 mCurrentFocus']).catch(() => '')
  // Give a starting/restarting agent a bounded chance (8 s) before taking the slow path —
  // never wait on it indefinitely: a hung restart once queued every capture for a minute.
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
  nodes = parseNodes(xml)
  activity = (/mCurrentFocus=Window\{[^}]*?\s(\S+\/\S+)\}/.exec(await focusP) || [])[1] || ''
  return finishCapture(t0, nodes, image, source, activity)
}

async function finishCapture(t0, nodes, image, source, activity) {
  lastActivity = activity
  const id = ++captureSeq
  const ctx = await gatherContext(nodes, activity)
  const cap = { id, nodes, activity, ctx, at: Date.now() }
  captures.set(id, cap)
  for (const k of [...captures.keys()].slice(0, -6)) captures.delete(k)
  const ms = Date.now() - t0
  noteScreen(ctx.screen || activityName(activity))
  lastHash = screenHash(nodes)
  log(`capture #${id} via ${source}: ${nodes.length} nodes in ${ms} ms`)
  return { id, image, nodes: nodes.map(publicNode), activity, context: ctx, source, ms, hash: lastHash }
}
const publicNode = n => ({ ...n, children: undefined, parent: undefined })

// ---- screen watch --------------------------------------------------------------------
// Collect mode shows a still capture, so a screen changed from the emulator window itself
// went unnoticed until the next manual action. While any page is in collect mode the tree
// is polled through the agent (0.2 s, no screenshot) and hashed — the status bar is left
// out, or the clock would fire a capture every minute — and a change is pushed over SSE.
function screenHash(nodes) {
  const h = crypto.createHash('md5')
  for (const n of nodes) {
    if (n.pkg === 'com.android.systemui') continue
    h.update(`${n.cls}|${n.text}|${n.desc}|${n.rid}|${n.x},${n.y},${n.w},${n.h}|${+n.selected}${+n.checked}${+n.focused}${+n.enabled}${+n.scrollable}\n`)
  }
  return h.digest('hex').slice(0, 16)
}
// The PATH through the app: every distinct screen name since the device/project was picked.
// It answers "how do I get there" for an agent that has to reproduce the state.
const trail = []
const activityName = a => String(a || '').split('/').pop().split('.').pop().replace(/Activity$/, '') || ''
function noteScreen(title) {
  if (!title) return
  const last = trail[trail.length - 1]
  if (last && last.title === title) { last.at = Date.now(); return }
  trail.push({ title, at: Date.now(), kind: state.kind })
  if (trail.length > 20) trail.shift()
}
function trailBlock() {
  if (trail.length < 2) return ''
  // One session may walk both platforms; then each step says which one it was on.
  const mixed = new Set(trail.map(x => x.kind)).size > 1
  const names = trail.map(x => mixed ? `${x.title} (${x.kind === 'ios' ? 'iOS' : 'Android'})` : x.title)
  return ['# Path', `walked:   ${names.join('  ›  ')}`,
    '          (the screens visited in this session, oldest first — how to reach the current one)'].join('\n')
}

let lastHash = '', watching = false, lastActivity = ''
const anyWatcher = () => [...sseClients].some(r => r.watch)
async function watchScreen() {
  if (watching) return
  watching = true
  log('screen watch on')
  try {
    while (anyWatcher()) {
      await new Promise(r => setTimeout(r, 700))
      if (!agent?.ready || !anyWatcher()) continue
      try {
        const nodes = isIos() ? buildTree(iosNodes(await agent.tree(activePkg()), iosScreen?.scale || 3, activePkg())) : parseNodes(await agent.dump())
        const h = screenHash(nodes)
        if (h !== lastHash) {
          lastHash = h
          noteScreen(screenTitleOf(nodes, screenH, activePkg()) || activityName(lastActivity))
          log(`screen changed (${h})`)
          broadcast({ type: 'screen', hash: h })
        }
      } catch (e) { log('screen watch:', e.message) }
    }
  } finally { watching = false; log('screen watch off') }
}

// ----------------------------------------------------------------- frames ---

let framing = false
async function frame() {
  if (framing) return null
  framing = true
  try {
    if (isIos()) return { mime: 'image/png', bytes: await screenshotPng(state.serial) }
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
  if (isIos()) {
    requireIos()
    if (!agent?.ready) throw userError(agent?.reason || 'the iOS agent is not running')
    const k = iosScreen?.scale || 3
    switch (cmd.type) {
      case 'tap': return agent.tap(activePkg(), cmd.x / k, cmd.y / k)
      case 'text': return agent.type(activePkg(), String(cmd.s))
      case 'swipe': return agent.swipe(activePkg(), cmd.x1 / k, cmd.y1 / k, cmd.x2 / k, cmd.y2 / k, cmd.ms || 200)
      case 'key': return agent.key(activePkg(), Number(cmd.code))
      default: throw userError(`unknown input type: ${cmd.type}`)
    }
  }
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
let staticCtx = null, staticAt = 0, screenH = 2400
async function staticContext() {
  if (staticCtx && Date.now() - staticAt < 120000) return staticCtx
  if (isIos()) {
    requireIos()
    const [app, props, yml] = await Promise.all([
      installedApp(state.serial, activePkg()), deviceProps(state.serial),
      P.cfg.ios.versionFile ? sh(`sed -n '1,200p' ${JSON.stringify(P.cfg.ios.versionFile)}`) : Promise.resolve(''),
    ])
    if (!iosScreen) { try { const png = await screenshotPng(state.serial); iosScreen = { w: png.readUInt32BE(16), h: png.readUInt32BE(20), scale: 3 } } catch {} }
    staticCtx = {
      model: props.name || 'simulator', release: props.os || 'iOS', sdk: '', locale: '',
      size: iosScreen ? `${iosScreen.w}x${iosScreen.h}` : '', density: iosScreen ? `${iosScreen.scale}x` : '',
      installedVer: app.version, installedCode: app.build, debuggable: true, ios: true,
      repoVer: (/MARKETING_VERSION:\s*["']?([\d.]+)/.exec(yml) || /CFBundleShortVersionString<\/key>\s*<string>([\d.]+)/.exec(yml) || [])[1] || '',
      repoCode: (/CURRENT_PROJECT_VERSION:\s*["']?(\d+)/.exec(yml) || [])[1] || '',
    }
    staticAt = Date.now()
    screenH = iosScreen?.h || 2400
    return staticCtx
  }
  const [props, pkgInfo, gradle] = await Promise.all([
    adbText(['shell', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; ' +
      'getprop persist.sys.locale; getprop ro.product.locale; wm size; wm density']).catch(() => ''),
    adbText(['shell', 'dumpsys', 'package', P.cfg.package]).catch(() => ''),
    P.cfg.versionFile ? sh(`sed -n '1,120p' ${JSON.stringify(P.cfg.versionFile)}`) : Promise.resolve(''),
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
  screenH = Number((/x(\d+)/.exec(staticCtx.size) || [])[1]) || 2400
  return staticCtx
}

async function gatherContext(nodes, activity) {
  const [s, branch, head, dirty] = await Promise.all([
    staticContext(),
    sh('git rev-parse --abbrev-ref HEAD').then(t => t.trim()),
    sh('git rev-parse --short HEAD').then(t => t.trim()),
    sh('git status --porcelain | wc -l').then(t => Number(t.trim())),
  ])
  const pkg = activePkg()
  const appNodes = nodes.filter(n => n.pkg === pkg)
  const focused = appNodes.find(n => n.focused && /EditText|TextField|TextView|SearchField/.test(n.cls))
  const H = Number((/x(\d+)/.exec(s.size) || [])[1]) || 2400
  const labels = (P.cfg.signInLabels || []).map(l => normalise(l).toLowerCase())
  const signIn = appNodes.some(n => labels.includes(normalise(n.text || n.desc).toLowerCase()))
  // Foreground from the TREE, not only the focus line: the app's own root fills the screen.
  const foreground = s.ios ? activity === pkg : (activity.startsWith(pkg) || appNodes.some(n => n.depth <= 2 && n.w >= 1000))
  lastForeground = foreground
  const mismatch = Boolean(s.installedVer && s.repoVer && s.installedVer !== s.repoVer)
  const ctx = {
    project: `${P.cfg.appName}  ·  ${P.cfg.root}${P.rules?.length ? `  ·  agent rules: ${P.rules.join(', ')}` : ''}`,
    app: `${P.cfg.appName} (${pkg} ${s.installedVer || '?'}${s.installedCode ? `, ${s.ios ? 'build' : 'code'} ${s.installedCode}` : ''}) — ${s.ios ? 'iOS, simulator' : `Android, ${s.debuggable ? 'debug' : 'release'} build`}`,
    screen: screenTitleOf(nodes, H, pkg),
    activity,
    foreground,
    session: !foreground ? `n/a — ${P.cfg.appName} is not the foreground app`
      : signIn ? 'signed-out (derived: a "Sign in" affordance is on screen)'
      : `signed-in (derived: no sign-in affordance; the identity itself is not read${s.debuggable ? '' : ' — release build'})`,
    focusedField: focused ? (focused.text ? `text field focused, contains "${focused.text.slice(0, 60)}"` : 'empty text field focused') : '',
    size: s.size,
    device: s.ios ? `${s.model} · ${s.release} (simulator) · ${s.size} @${s.density}` : `${s.model} · Android ${s.release} (API ${s.sdk}) · ${s.size} @ ${s.density}dpi · locale ${s.locale}`,
    repo: `${branch || '?'} @ ${head || '?'}${dirty ? ` (${dirty} uncommitted)` : ''}${s.repoVer ? ` · declares ${s.repoVer} (${s.repoCode})${mismatch ? '' : ' — matches the installed build'}` : ''}`,
    versionMismatch: mismatch,
    platform: s.ios ? 'ios' : 'android',
  }
  ctx.block = renderScreenBlock(ctx)
  return ctx
}

function renderScreenBlock(c) {
  const L = ['# Screen',
    `project:  ${c.project}`,
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
const short = f => { for (const r of activeRoots()) if (f.startsWith(r + '/')) return f.slice(r.length + 1); return f }

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
  requireIos()
  const index = activeIndex()
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

function stringsNote(ios) {
  const st = (ios ? P.cfg.ios?.strings : P.cfg.strings) || { resolver: 'none' }, res = st.resolver
  return res === 'lkey'
    ? `Copy lives as LKey(${(st.langs || []).join('/')}) ${ios ? 'constants in enums (extension LStr { enum X { static let … } }) and is rendered via L(...): edit the LKey, not the view' : 'objects and is rendered via l(...): to change wording, edit the LKey, not the composable'}.`
    : res === 'android-xml'
      ? 'Copy lives in res/values*/strings.xml as <string name>: to change wording, edit the resource (every locale), not the code.'
      : res === 'xcstrings'
        ? 'Copy lives in String Catalogs (.xcstrings) / .lproj .strings tables keyed by the source-language text: to change wording, edit the catalog entry (every language), not the view.'
        : 'On-screen copy did not resolve to a string registry; search the sources for the literal.'
}
function agentNotes(size) {
  if (Array.isArray(P.cfg.notes)) return ['# Notes for the agent', ...P.cfg.notes].join('\n')
  return ['# Notes for the agent',
    `- Platform: ${isIos() ? 'iOS only — this prompt was composed against the iOS Simulator' : 'Android only — this prompt was composed against the Android emulator'}. Code: ${activeRoots().join(', ') || '(see repo)'}.`,
    `- ${stringsNote(isIos())}`,
    `- bounds are display px on a ${size || '?'} screen, [x1,y1]→[x2,y2]. "tap:" names the actually-clickable node when the picked one is only a label inside it.`,
  ].join('\n')
}
// The same screen picked on both devices: one prompt, both platforms named, each with its own
// code roots and string registry. Only offered when the project declares an iOS side.
function bothNotes() {
  if (Array.isArray(P.cfg.notes) || !P.cfg.ios) return ''
  return ['# Notes for the agent',
    `- Platforms: BOTH — this prompt was composed against the iOS Simulator (@ios* elements) and the Android emulator (@android* elements), the same screen on each. iOS code: ${(P.cfg.ios.sourceRoots || []).join(', ') || '(see repo)'} · Android code: ${(P.cfg.sourceRoots || []).join(', ') || '(see repo)'}.`,
    `- iOS: ${stringsNote(true)}`,
    `- Android: ${stringsNote(false)}`,
    '- Each platform has its own "# Screen" block; bounds are display px on THAT device, [x1,y1]→[x2,y2]. "tap:" names the actually-clickable node when the picked one is only a label inside it.',
    '- Keep the two implementations in step: what changes on one platform changes on the other unless the task says which one.',
  ].join('\n')
}

// Bringing the app to the front. `monkey -p` is the recipe everyone writes down and it
// FAILS on apps whose launcher activity it cannot match (verified here: it exits non-zero
// while the launcher activity plainly exists). Ask the package manager which component to
// start, then start it; monkey stays as the fallback.
async function launchApp() {
  if (isIos()) { requireIos(); await simLaunch(state.serial, activePkg()); return activePkg() }
  const brief = await adbText(['shell', 'cmd', 'package', 'resolve-activity', '--brief', P.cfg.package]).catch(() => '')
  const comp = brief.split('\n').map(l => l.trim()).find(l => l.startsWith(`${P.cfg.package}/`))
  if (comp) { await adb(['shell', 'am', 'start', '-n', comp], { timeout: 8000 }); return comp }
  await adb(['shell', 'monkey', '-p', P.cfg.package, '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 8000 })
  return `${P.cfg.package} (via monkey)`
}

// ---------------------------------------------------------------- problems ---
// What is wrong RIGHT NOW, in words, with the one action that fixes it. Every one of these
// used to present as the same thing: a still that never changed, or a spinner.
async function problems() {
  const out = []
  const add = (level, code, text, action = '') => out.push({ level, code, text, action })
  if (!P) { add('error', 'no-project', 'no project registered — run `emu-composer init` in an Android project'); return out }
  const devices = await listDevices()
  const usable = devices.filter(d => d.state === 'device')
  if (!state.serial || !usable.length) {
    add('error', 'no-device', devices.length
      ? `no usable device — adb reports ${devices.map(d => `${d.serial} ${d.state}`).join(', ')}`
      : 'no device attached — start an emulator')
    return out
  }
  const s = await staticContext().catch(() => null)
  if (!s) { add('error', 'adb', 'the device stopped answering adb'); return out }
  if (isIos() && !P.cfg.ios) { add('error', 'no-ios', `${P.cfg.appName} has no "ios" block in emu-composer.json — add bundleId, sourceRoots and strings, or pick an Android device`); return out }
  if (!s.installedVer) {
    add('error', 'not-installed', `${P.cfg.appName} (${activePkg()}) is not installed on ${devices.find(d => d.serial === state.serial)?.avd || state.serial} — install a ${isIos() ? 'simulator' : 'debug'} build, or switch project`)
    return out
  }
  if (lastForeground === null) {
    // No capture since the switch: read the focus rather than repeat the last project's answer.
    if (isIos()) { try { lastForeground = agent?.ready ? (await agent.tree(activePkg())).state === 4 : null } catch { lastForeground = null } }
    else {
      const focus = await adbText(['shell', 'dumpsys window | grep -m1 mCurrentFocus']).catch(() => '')
      lastForeground = focus.includes(activePkg())
    }
  }
  if (lastForeground === false) add('warn', 'not-foreground', `${P.cfg.appName} is not the app in front — every reference will come from whatever is`, 'launch')
  if (s.installedVer && s.repoVer && s.installedVer !== s.repoVer)
    add('warn', 'version', `the installed build is ${s.installedVer}, the repo declares ${s.repoVer} — the running app may not contain your changes`)
  if (!agent?.ready) add(isIos() ? 'error' : 'info', 'agent', isIos() ? `the iOS agent is not running — ${agent?.reason || 'starting'}` : `slow path — ${agent?.reason || 'the on-device agent is off'} (captures take ~2.5 s)`, 'agent')
  return out
}
let lastForeground = null

// ------------------------------------------------------------------ errors ---
// The device's own account of what went wrong, on request. Half of what anyone writes to an
// agent is "why does this not work", and the answer is usually already in the log — but it
// is only fetched when the box is ticked: it is one adb call per capture and it is noise on
// a prompt about a colour.
async function recentErrors() {
  if (!state.serial) return { count: 0, block: '', lines: [] }
  if (isIos()) {
    // The unified log, error and fault levels, for this app's process, last five minutes.
    requireIos()
    const app = await installedApp(state.serial, activePkg())
    const proc = app.exe || activePkg().split('.').pop()
    const out = await execFileP('xcrun', ['simctl', 'spawn', state.serial, 'log', 'show', '--last', '5m', '--style', 'compact',
      '--predicate', `process == "${proc}" AND (messageType == error OR messageType == fault)`], { maxBuffer: 16 << 20, timeout: 20000 }).then(r => r.stdout).catch(() => '')
    // XCTest's own accessibility chatter ("Automation type mismatch…") is logged under the
    // APP's process while the agent snapshots it — it is the agent's noise, not the app's.
    const lines = collapseLines(out.split('\n').filter(l => l.trim() && !/^Timestamp|^Filtering|^Skipping/.test(l) && !/com\.apple\.dt\.xctest|Automation type mismatch/.test(l)).map(l => l.trimEnd()), 25)
    return { count: lines.length, lines, block: errorBlock({ lines, source: `unified log (log show --last 5m), error + fault levels, process "${proc}"` }) }
  }
  const pid = await adbText(['shell', 'pidof', P.cfg.package]).then(t => t.trim().split(/\s+/)[0] || '').catch(() => '')
  const [main, crash] = await Promise.all([
    adbText(['shell', 'logcat -d -v time -t 400 *:E']).catch(() => ''),
    adbText(['shell', 'logcat -d -b crash -v time -t 120']).catch(() => ''),
  ])
  const { lines, count } = filterLog({ main, crash, pkg: P.cfg.package, pid })
  return { count, lines, block: errorBlock({ lines, pkg: P.cfg.package, pid }) }
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
  form.append('model', process.env.EMU_COMPOSER_STT_MODEL || P.cfg.stt.model || 'gpt-4o-transcribe')
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

// ------------------------------------------------------------------- run ---
// "Run in an agent": the finished prompt goes straight to a coding-agent CLI, in a new
// Terminal window, in the active project's root. The prompt is written to a file under
// .emu-composer/prompts/ and a .command script opens it — `open` runs a .command in
// Terminal with no AppleScript/automation permission to grant.
const AGENTS = [
  { id: 'claude', name: 'Claude Code', args: f => `"$(cat ${f})"` },
  { id: 'codex', name: 'Codex', args: f => `"$(cat ${f})"` },
  { id: 'gemini', name: 'Gemini CLI', args: f => `-i "$(cat ${f})"` },
  { id: 'cursor-agent', name: 'Cursor Agent', args: f => `"$(cat ${f})"` },
]
let agentCache = null, agentCacheAt = 0
async function findAgents() {
  if (agentCache && Date.now() - agentCacheAt < 60000) return agentCache
  // A login shell: the daemon may have started without the user's PATH (~/.local/bin, npm).
  const found = await Promise.all(AGENTS.map(async a => {
    const bin = await execFileP('/bin/zsh', ['-lc', `command -v ${a.id}`], { encoding: 'utf8', timeout: 5000 }).then(r => r.stdout.trim()).catch(() => '')
    return bin ? { id: a.id, name: a.name, bin } : null
  }))
  agentCache = found.filter(Boolean); agentCacheAt = Date.now()
  return agentCache
}
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`
async function runInAgent({ agent: id, text, dryRun }) {
  const a = (await findAgents()).find(x => x.id === id)
  if (!a) throw userError(`${id} was not found on this Mac`)
  if (!String(text || '').trim()) throw userError('the prompt is empty')
  const root = P.cfg.root
  const dir = path.join(root, '.emu-composer', 'prompts')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const file = path.join(dir, `${stamp}-${a.id}.md`), cmd = path.join(dir, `${stamp}-${a.id}.command`)
  await fs.writeFile(file, text)
  const spec = AGENTS.find(x => x.id === a.id)
  const script = `#!/bin/zsh -l
# emu-composer: run the composed prompt in ${a.name}, in ${root}
cd ${shq(root)} || exit 1
clear
printf '\\033[2m%s\\033[0m\\n' ${shq(`${a.name} · ${root} · prompt: ${path.relative(root, file)}`)}
exec ${shq(a.bin)} ${spec.args(shq(file))}
`
  await fs.writeFile(cmd, script, { mode: 0o755 })
  if (!dryRun) await execFileP('open', ['-a', 'Terminal', cmd])
  log(`run → ${a.name} in ${root}${dryRun ? ' (dry run)' : ''}`)
  return { ok: true, agent: a.name, file: path.relative(root, file), script: dryRun ? script : undefined }
}

// ----------------------------------------------------------------- refine ---
// The AI levels above plain dictation. The page sends the text with every chip replaced by
// a numbered token ⟦n⟧ and a legend saying what each token is (an element on a screen, a
// drawn mark); the model returns the text edited at the chosen level. The tokens are the
// contract: the answer is refused unless every token comes back exactly once, so an edit
// can move an anchor but never drop, duplicate or invent one.
const REFINE = {
  clean: {
    model: 'gpt-5.4-mini', effort: 'low',
    rules: `Clean up this dictated text lightly. Add punctuation and sentence breaks, fix transcription mistakes that are obvious from context, remove filler words (um, uh, like, אממ, כאילו, בעצם when it is filler) and words repeated by a stumble. Do NOT reorder, summarize, merge or restructure; keep the author's wording and meaning.`,
  },
  full: {
    model: 'gpt-5.4', effort: 'medium',
    rules: `Turn this dictated, spoken text into a clear, well-organized request for a coding agent, as its author would have written it with time to think.
- Understand the whole text first. Merge things said twice into one statement; when the author corrected themself, keep only the correction.
- Order it logically, put each distinct request in its own paragraph, and when there are several unrelated tasks separate them with a line containing only "--".
- Make it precise and unambiguous, but add NOTHING the author did not say or clearly mean: no new requirements, no guesses about implementation, no pleasantries.
- Keep the author's language and first-person voice. Be concise.`,
  },
}
const TOKEN_RE = /⟦\d+⟧/g
async function refine({ text, level, legend, language, images = [] }) {
  const L = REFINE[level]
  if (!L) throw userError(`unknown AI level: ${level}`)
  const key = await openaiKey()
  if (!key) throw userError('no OpenAI key — add one in settings ⚙')
  const want = (text.match(TOKEN_RE) || []).sort()
  const cfg = P.cfg.refine?.[level] || {}
  const system = `${L.rules}

The text is about a mobile app being tested. Tokens like ⟦1⟧ are anchors to things the author pointed at on the screen (the legend below says what each one is). Rules for tokens:
- Every token must appear in your output exactly once, spelled exactly as given.
- Keep each token right next to the words that refer to it ("this button ⟦2⟧"); you may move it together with its sentence.
- Never add a token that is not in the input.
${level !== 'full' ? '' : `Some tokens are MARKS the author drew on the screen (a box, a freehand stroke, an arrow). A box or stroke singles out an area; an arrow means "from here to there" (move, connect, flow). Read each mark together with what the author said around it and state the intent precisely (which elements, which area, which direction); the legend lists what each mark covers or points at${images.length ? ', and the attached screenshots show the marks as numbered badges — look at them to get position, size, spacing and colour right' : ''}. Keep the mark's token next to that description.
`}Write in the same language as the text${language ? ` (${language})` : ''}. Output ONLY the edited text — no preamble, no quotes, no markdown headings.${legend ? `\n\nLegend:\n${legend}` : ''}`
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model || L.model, reasoning_effort: cfg.effort || L.effort,
      messages: [{ role: 'system', content: system }, { role: 'user', content: images.length
        ? [{ type: 'text', text }, ...images.slice(0, 4).flatMap(im => [
            { type: 'text', text: `Screenshot of "${im.screen || '?'}" with marks ${(im.marks || []).join(', ')}:` },
            { type: 'image_url', image_url: { url: im.url, detail: 'high' } }])]
        : text }] }),
    signal: AbortSignal.timeout(60000),
  })
  const body = await r.text()
  if (!r.ok) { let msg = body; try { msg = JSON.parse(body).error?.message || body } catch {} throw userError(`OpenAI ${r.status}: ${msg}`) }
  const out = (JSON.parse(body).choices?.[0]?.message?.content || '').trim()
  const got = (out.match(TOKEN_RE) || []).sort()
  if (!out || got.join() !== want.join()) throw userError(`the AI edit lost or changed an anchor (${want.length} in, ${got.length} out) — the text was left as it was`)
  return out
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
        return send(res, 200, { notes: agentNotes((await staticContext()).size), both: bothNotes(), platform: isIos() ? 'ios' : 'android' })
      case '/api/events': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.clientId = crypto.randomUUID()
        res.watch = url.searchParams.get('watch') === '1'
        res.write(`data: ${JSON.stringify({ type: 'device', serial: state.serial, devices: await listDevices(), agent: Boolean(agent?.ready), client: res.clientId, ...projectList() })}\n\n`)
        sseClients.add(res)
        if (res.watch) watchScreen()
        const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
        req.on('close', () => { sseClients.delete(res); clearInterval(ping) })
        return
      }
      case '/api/watch': {
        const { client, on } = await readBody(req)
        for (const c of sseClients) if (c.clientId === client) c.watch = Boolean(on)
        if (on) watchScreen()
        return send(res, 200, { ok: true })
      }
      case '/api/mark-image': {
        // The screenshot with the marks burned in, drawn by the page; one file per capture,
        // rewritten as marks come and go, so a prompt can point the agent at a picture.
        const { name, png } = await readBody(req)
        if (!/^[\w-]{1,80}$/.test(String(name)) || !/^data:image\/png;base64,/.test(String(png))) throw userError('bad mark image')
        await fs.mkdir(path.join(outDir(), 'marks'), { recursive: true })
        const rel = `.emu-composer/marks/${name}.png`
        await fs.writeFile(path.join(P.cfg.root, rel), Buffer.from(png.split(',')[1], 'base64'))
        return send(res, 200, { file: rel })
      }
      case '/api/projects':
        return send(res, 200, projectList())
      case '/api/project': {
        // Registers (a `run` from another repo) and/or switches. Manual, always.
        const { id, configPath } = await readBody(req)
        if (configPath) {
          const { loadConfig } = await import('./config.mjs')
          const rec = await addProject(await loadConfig(configPath))
          await activate(rec.id, 'registered')
        } else if (id) {
          if (!projects.has(id)) throw userError('unknown project')
          await activate(id, 'chosen')
        }
        return send(res, 200, projectList())
      }
      case '/api/extras': {
        // The opt-in sections, fetched together so the page makes one call per capture.
        const wantErrors = url.searchParams.get('errors') === '1'
        const e = wantErrors ? await recentErrors() : { count: 0, block: '' }
        return send(res, 200, { errors: e.block, errorCount: e.count, path: trailBlock(), pathSteps: trail.length })
      }
      case '/api/problems':
        return send(res, 200, { problems: await problems() })
      case '/api/launch': {
        // The fix for "the app is not in front", from the page.
        if (!state.serial) throw userError('no device')
        return send(res, 200, { ok: true, component: await launchApp() })
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
          stt: Boolean(k), hint: k ? `…${k.slice(-4)}` : '', language: P.cfg.stt.language || '', app: P.cfg.appName,
          ...projectList(), problems: await problems(),
          serial: state.serial, devices: await listDevices(),
          agent: Boolean(agent?.ready), agentReason: agent?.reason || (state.serial ? '' : 'no device'),
          index: P.index.stats || null,
          device: !state.serial ? 'none' : isIos() ? 'device' : await adbText(['get-state']).then(t => t.trim()).catch(() => 'offline'),
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
      case '/api/agents':
        return send(res, 200, { agents: await findAgents() })
      case '/api/run':
        return send(res, 200, await runInAgent(await readBody(req)))
      case '/api/refine':
        return send(res, 200, { text: await refine(await readBody(req)) })
      case '/api/transcribe': {
        const { audio, mime, language, prompt } = await readBody(req)
        return send(res, 200, { text: await transcribe(audio, mime, language, prompt) })
      }
      case '/api/save': {
        // Crops + full screenshot + the assembled prompt, for a reference that outlives the tab.
        const { text, crops, screen } = await readBody(req)
        await fs.mkdir(outDir(), { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const files = []
        for (const [n, c] of (crops || []).entries()) {
          if (!c) continue
          const rel = `.emu-composer/${stamp}-ui${n + 1}.png`
          await fs.writeFile(path.join(P.cfg.root, rel), Buffer.from(c.split(',')[1], 'base64'))
          files.push(rel)
        }
        let shot = ''
        if (screen) { shot = `.emu-composer/${stamp}-screen.${/jpeg/.test(screen.slice(0, 30)) ? 'jpg' : 'png'}`; await fs.writeFile(path.join(P.cfg.root, shot), Buffer.from(screen.split(',')[1], 'base64')) }
        const full = (text || '') + (files.length || shot ? `\n\n# Files\n${shot ? `screenshot: ${shot}\n` : ''}${files.map((f, n) => `@ui${n + 1} crop: ${f}`).join('\n')}\n` : '')
        await fs.writeFile(path.join(outDir(), `${stamp}.md`), full)
        await fs.writeFile(path.join(outDir(), 'latest.md'), full)
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
  const { loadConfig } = await import('./config.mjs')
  // Read the registry BEFORE adding this project: addProject persists the whole map, so
  // registering first wrote a one-entry file over it and every other project was lost.
  await loadRegistry(loadConfig)
  await addProject(bootCfg)
  await activate(bootCfg.configPath, 'started here')
  log(`emu-composer → http://localhost:${PORT}  (adb ${ADB})`)
  log(`projects: ${[...projects.values()].map(r => `${r.cfg.appName}${r.id === P.id ? ' ←' : ''}`).join(', ')}`)
  const serial = await pickDefaultSerial()
  if (!serial) { log('no device attached — waiting for one to be picked'); return }
  // Through the same door as a later switch, so `kind` and every cache agree with the agent.
  state.serial = serial; state.kind = IOS_UDID.test(serial) ? 'ios' : 'android'; agent = agentFor(serial)
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
return { server, agent, projects, port: PORT }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { findConfig, loadConfig } = await import('./config.mjs')
  const p = process.env.EMU_COMPOSER_CONFIG || findConfig()
  if (!p) { console.error('no emu-composer.json found — run `emu-composer init` in the project'); process.exit(2) }
  await start(await loadConfig(p))
}
