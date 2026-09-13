// iOS Simulator side: devices through `xcrun simctl`, frames through simctl's screenshot, and
// the accessibility tree through the on-device agent — a UI-test bundle (ios/agent) that
// serves the tree of ANY app over HTTP for as long as `xcodebuild test-without-building`
// keeps it alive. The simulator twin of agent.mjs; same public shape (start/stop/ensureReady/
// ready/reason), so the server treats both kinds of device the same way.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HOME } from './config.mjs'

const execFileP = promisify(execFile)
export const AGENT_DD = path.join(HOME, 'ios-agent-dd')

const simctl = (args, opts = {}) => execFileP('xcrun', ['simctl', ...args], { maxBuffer: 64 << 20, ...opts })

// Booted simulators only — a shut-down one cannot be captured, and listing forty runtimes is
// noise. Serial = udid; the label is what the device menu shows.
export async function listSimulators() {
  let out
  try { out = (await simctl(['list', 'devices', 'booted', '-j'], { timeout: 5000 })).stdout } catch { return [] }
  const j = JSON.parse(out)
  const devices = []
  for (const [runtime, list] of Object.entries(j.devices || {})) {
    const os = runtime.replace(/^.*\.(iOS|tvOS|watchOS|xrOS)-/, '$1 ').replace(/-/g, '.')
    for (const d of list) if (d.state === 'Booted') devices.push({ serial: d.udid, kind: 'ios', state: 'device', model: d.name, avd: `${d.name} · ${os}`, os })
  }
  return devices
}

export async function screenshotPng(udid) {
  const tmp = path.join(os.tmpdir(), `emu-ios-${process.pid}-${Date.now()}.png`)
  try {
    await simctl(['io', udid, 'screenshot', '--type=png', tmp], { timeout: 8000 })
    return await fs.readFile(tmp)
  } finally { fs.unlink(tmp).catch(() => {}) }
}

// Installed version, from the app's own Info.plist inside its container.
export async function installedApp(udid, bundle) {
  try {
    const dir = (await simctl(['get_app_container', udid, bundle, 'app'], { timeout: 5000 })).stdout.trim()
    const plist = path.join(dir, 'Info.plist')
    const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plist], { maxBuffer: 1 << 20 })
    const j = JSON.parse(stdout)
    return { installed: true, version: j.CFBundleShortVersionString || '', build: j.CFBundleVersion || '', exe: j.CFBundleExecutable || '', dir }
  } catch { return { installed: false, version: '', build: '', exe: '', dir: '' } }
}

export async function deviceProps(udid) {
  let name = '', os = ''
  try {
    const j = JSON.parse((await simctl(['list', 'devices', '-j'], { timeout: 5000 })).stdout)
    for (const [runtime, list] of Object.entries(j.devices || {})) for (const d of list) if (d.udid === udid) {
      name = d.name; os = runtime.replace(/^.*\.(iOS|tvOS|watchOS|xrOS)-/, '$1 ').replace(/-/g, '.')
    }
  } catch {}
  return { name, os }
}

export async function launch(udid, bundle) {
  await simctl(['launch', udid, bundle], { timeout: 15000 })
}

// The agent's build products: an .xctestrun the runner can be started from without a
// rebuild. Absent until `emu-composer setup-ios-agent` has run.
export function agentXctestrun() {
  const dir = path.join(AGENT_DD, 'Build', 'Products')
  try { return fsSync.readdirSync(dir).filter(f => f.endsWith('.xctestrun')).map(f => path.join(dir, f))[0] || '' } catch { return '' }
}

export class IosAgent {
  constructor({ udid, port = 8100, log = () => {} }) {
    this.udid = udid; this.port = port; this.log = log
    this.proc = null; this.ready = false; this.reason = ''
    this._starting = null; this.stopped = false
  }

  async available() { return Boolean(agentXctestrun()) }

  start() {
    if (this._starting) return this._starting
    this._starting = this._start().finally(() => { this._starting = null })
    return this._starting
  }

  async _start() {
    const run = agentXctestrun()
    if (!run) { this.reason = 'iOS agent not built — run `emu-composer setup-ios-agent`'; this.ready = false; return false }
    if (await this.ping()) { this.ready = true; this.reason = ''; return true }   // a runner from a previous server
    this.stopped = false
    this.log(`starting the iOS agent on :${this.port}`)
    this.proc = spawn('xcodebuild', ['test-without-building', '-xctestrun', run, '-destination', `platform=iOS Simulator,id=${this.udid}`, '-only-testing:EmuAgentTests/AgentTests/testServe'],
      { env: { ...process.env, TEST_RUNNER_EMU_AGENT_PORT: String(this.port) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const onOut = d => { tail = (tail + d.toString()).slice(-4000) }
    this.proc.stdout.on('data', onOut); this.proc.stderr.on('data', onOut)
    this.proc.on('exit', code => {
      this.ready = false
      if (!this.stopped) { this.reason = `the iOS agent exited (${code}): ${tail.split('\n').filter(l => /error|fail/i.test(l)).slice(-2).join(' · ') || 'see xcodebuild output'}`; this.log(this.reason) }
      this.proc = null
    })
    // A cold start is a runner install + launch: up to ~40 s on a slow machine.
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      if (await this.ping()) { this.ready = true; this.reason = ''; this.log(`iOS agent ready in ${Date.now() - t0} ms`); return true }
      if (!this.proc) break
      await new Promise(r => setTimeout(r, 500))
    }
    this.reason ||= 'the iOS agent did not answer within 60 s'
    this.ready = false
    return false
  }

  // A stopped agent is started again on demand — `stop()` is how a device switch parks it,
  // not a verdict on it; start() resets the flag.
  async ensureReady(ms = 8000) {
    if (this.ready) return true
    await Promise.race([this._starting || this.start(), new Promise(r => setTimeout(r, ms))])
    return this.ready
  }

  async ping() {
    try { const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok } catch { return false }
  }

  async get(pathname, params = {}, timeoutMs = 15000) {
    const u = new URL(`http://127.0.0.1:${this.port}${pathname}`)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
    const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) })
    const j = await r.json()
    if (!r.ok || j.error) throw new Error(j.error || `agent ${r.status}`)
    return j
  }

  tree(bundle) { return this.get('/tree', { bundle }) }
  tap(bundle, x, y) { return this.get('/tap', { bundle, x, y }) }
  type(bundle, text) { return this.get('/type', { bundle, text }) }
  swipe(bundle, x1, y1, x2, y2, ms = 200) { return this.get('/swipe', { bundle, x1, y1, x2, y2, ms }, 20000) }
  key(bundle, code) { return this.get('/key', { bundle, code }, 20000) }

  async stop() { this.stopped = true; this.ready = false; if (this.proc) { this.proc.kill('SIGTERM'); this.proc = null } }
  async release() { return this.stop() }
  async restart(why = '') { await this.stop(); this.stopped = false; this.log(`iOS agent restart${why ? ` (${why})` : ''}`); return this.start() }
}

// The runner's flat list → the composer's node shape (the same one parseNodes builds from a
// uiautomator dump), so everything downstream — hit test, tap target, roles, title, string
// lookup — works unchanged. Frames arrive in points; `scale` turns them into screenshot px.
const NAME_TO_CLS = t => `XCUI.${t}`
const CLICKABLE = new Set(['Button', 'Cell', 'Link', 'Switch', 'Tab', 'MenuItem', 'MenuButton', 'CheckBox', 'RadioButton', 'Toggle', 'SegmentedControl', 'Key'])
const TEXTUAL = new Set(['StaticText', 'TextField', 'SecureTextField', 'TextView', 'SearchField'])
export function iosNodes(tree, scale, bundle) {
  const nodes = []
  for (const n of tree.nodes || []) {
    const textual = TEXTUAL.has(n.type)
    const text = textual ? (n.value || n.label || '') : ''
    const desc = textual ? (n.label && n.label !== text ? n.label : '') : (n.label || n.title || '')
    nodes.push({
      i: nodes.length, depth: n.depth,
      cls: NAME_TO_CLS(n.type), pkg: bundle,
      text, desc, rid: n.id || '',
      clickable: CLICKABLE.has(n.type), longClickable: false,
      scrollable: /ScrollView|Table|CollectionView/.test(n.type), checkable: /Switch|CheckBox|Toggle/.test(n.type),
      checked: /Switch|Toggle/.test(n.type) && /^(1|true|on)$/i.test(n.value || ''),
      enabled: n.enabled !== false, selected: Boolean(n.selected), focused: Boolean(n.focus), password: n.type === 'SecureTextField',
      x: Math.round(n.x * scale), y: Math.round(n.y * scale), w: Math.round(n.w * scale), h: Math.round(n.h * scale),
    })
  }
  return nodes
}
