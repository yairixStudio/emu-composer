#!/usr/bin/env node
// emu-composer CLI.
//
//   emu-composer                 run: boot an AVD if needed, start (or reuse) the server, open the page
//   emu-composer init            detect the project and write emu-composer.json
//   emu-composer setup-agent     fetch the on-device agent (one-time; needs python3)
//   emu-composer setup-ios-agent build the iOS Simulator agent (one-time; needs Xcode + xcodegen)
//   emu-composer install-app     "<App> Composer.app" in ~/Applications (Spotlight / Dock)
//   emu-composer bar             build + launch the floating bar beside the emulator window
//   emu-composer doctor          check node, adb, device, agent jar, key, config
//   emu-composer log [N] [--day YYYY-MM-DD] [--json] [--follow] [--grep REGEX]
//                                 the session journal, last N events (or live-tail with --follow)
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { CONFIG_NAME, HOME, findConfig, loadConfig, detect, renderConfig, findEmulator } from '../src/config.mjs'

const execFileP = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const cmd = args.find(a => !a.startsWith('-')) || 'run'
const flag = (name, def = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : def }
const has = name => args.includes(`--${name}`)
const say = (...a) => console.log(...a)
const die = (m, code = 1) => { console.error(m); process.exit(code) }

async function config({ required = true } = {}) {
  const p = flag('config') || process.env.EMU_COMPOSER_CONFIG || findConfig()
  if (!p) { if (required) die(`no ${CONFIG_NAME} found here or above — run \`emu-composer init\` in the project root`, 2); return null }
  return loadConfig(p)
}

// With a daemon already up, `emu-composer` from anywhere at all (a home directory, another
// repo, a scratch folder) opens the composer on whatever project is active instead of
// refusing — the server, not the working directory, is where a project lives now.
async function openIfDaemonUp() {
  const port = Number(process.env.EMU_COMPOSER_PORT || 7788)
  const h = await health(port)
  if (!h) return false
  openUrl(`http://localhost:${port}`)
  say(`no ${CONFIG_NAME} here — opened the running composer (${h.app}) → http://localhost:${port}`)
  return true
}

async function migrateLegacyHome() {
  // 0.x lived in ~/.config/emu-picker; carry the key and the jar over once.
  const old = path.join(os.homedir(), '.config', 'emu-picker')
  if (fsSync.existsSync(HOME) || !fsSync.existsSync(old)) return
  await fs.mkdir(HOME, { recursive: true })
  for (const f of ['openai-key', 'u2.jar']) { try { await fs.copyFile(path.join(old, f), path.join(HOME, f)) } catch {} }
}

async function health(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null } catch { return null }
}

async function ensureDevice(cfg) {
  const out = execFileSync(cfg.adbPath, ['devices'], { encoding: 'utf8' })
  if (/\tdevice\n/.test(out)) return
  // A booted iOS simulator is a device too: do not boot an Android AVD beside it — that is
  // exactly the machine-wide surprise this once produced ("Mefakeach" booting uninvited).
  if (process.platform === 'darwin') {
    try {
      const sims = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' }))
      if (Object.values(sims.devices || {}).some(l => l.some(d => d.state === 'Booted'))) return
    } catch {}
  }
  const emulator = findEmulator(cfg.adbPath)
  let avd = cfg.avd || flag('avd')
  if (!avd) {
    const list = execFileSync(emulator, ['-list-avds'], { encoding: 'utf8' }).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('INFO'))
    if (!list.length) die('no device attached and no AVD to boot — create one in Android Studio (Device Manager)')
    avd = list[0]
  }
  say(`no device attached — booting AVD "${avd}"…`)
  spawn(emulator, ['-avd', avd, '-netdelay', 'none', '-netspeed', 'full'], { detached: true, stdio: 'ignore' }).unref()
  execFileSync(cfg.adbPath, ['wait-for-device'], { stdio: 'ignore', timeout: 180000 })
  for (let i = 0; i < 120; i++) {
    const b = execFileSync(cfg.adbPath, ['shell', 'getprop', 'sys.boot_completed'], { encoding: 'utf8' }).trim()
    if (b === '1') break
    await new Promise(r => setTimeout(r, 2000))
  }
  await new Promise(r => setTimeout(r, 3000))
  // A cold boot lands on the home screen; bring the app under test to the front. Ask the
  // package manager for the component rather than trusting `monkey -p`, which fails on apps
  // whose launcher activity it cannot match.
  try {
    const brief = execFileSync(cfg.adbPath, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', cfg.package], { encoding: 'utf8' })
    const comp = brief.split('\n').map(l => l.trim()).find(l => l.startsWith(`${cfg.package}/`))
    if (comp) execFileSync(cfg.adbPath, ['shell', 'am', 'start', '-n', comp], { stdio: 'ignore' })
    else execFileSync(cfg.adbPath, ['shell', 'monkey', '-p', cfg.package, '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' })
  } catch {}
}

const openUrl = url => execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {})

async function run() {
  await migrateLegacyHome()
  if (!flag('config') && !process.env.EMU_COMPOSER_CONFIG && !findConfig() && await openIfDaemonUp()) return
  const cfg = await config()
  const port = Number(process.env.EMU_COMPOSER_PORT || cfg.port)
  // ONE daemon, every project. A `run` from a second repo does not start a second server: it
  // REGISTERS this project with the one already running and switches to it, so the open
  // composer keeps its draft and its history while the sources it resolves against change.
  const up = await health(port)
  if (up) {
    const known = (up.projects || []).some(p => p.id === cfg.configPath)
    await fetch(`http://127.0.0.1:${port}/api/project`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configPath: cfg.configPath }),
    }).catch(() => {})
    openUrl(`http://localhost:${port}`)
    say(`${known ? 'switched to' : 'added'} ${cfg.appName} → http://localhost:${port}`)
    return
  }
  await ensureDevice(cfg)
  if (!fsSync.existsSync(path.join(HOME, 'u2.jar'))) say('note: no on-device agent yet — `emu-composer setup-agent` gives 10x faster captures and Unicode input')
  const { start } = await import('../src/server.mjs')
  await start(cfg)
  for (let i = 0; i < 40; i++) { if (await health(port)) break; await new Promise(r => setTimeout(r, 250)) }
  if (!has('no-open')) openUrl(`http://localhost:${port}`)
}

async function init() {
  const root = process.cwd()
  const target = path.join(root, CONFIG_NAME)
  if (fsSync.existsSync(target) && !has('force')) die(`${CONFIG_NAME} already exists — use --force to overwrite`)
  const d = await detect(root)
  for (const f of d.findings) say('  •', f)
  if (!d.package) say('  • no applicationId found — set "package" by hand')
  await fs.writeFile(target, renderConfig(d))
  say(`wrote ${target}`)
}

async function sh(script, extraEnv = {}) {
  await new Promise((ok, bad) => {
    const p = spawn('/bin/bash', [path.join(ROOT, 'scripts', script), ...args.slice(1)], { stdio: 'inherit', env: { ...process.env, EMU_COMPOSER_HOME: HOME, EMU_COMPOSER_ROOT: ROOT, ...extraEnv } })
    p.on('exit', c => c === 0 ? ok() : bad(new Error(`${script} exited ${c}`)))
  })
}

async function installApp() {
  const cfg = await config()
  await sh('install-app.sh', { APP_NAME: `${cfg.appName} Composer`, CONFIG_PATH: cfg.configPath, ICON_SRC: flag('icon') })
}

async function bar() {
  const cfg = await config()
  const launch = `node ${JSON.stringify(path.join(ROOT, 'bin', 'emu-composer.js'))} run --config ${JSON.stringify(cfg.configPath)}`
  await sh('build-bar.sh', {})
  const app = path.join(os.homedir(), 'Applications', 'Emu Composer Bar.app')
  const bin = path.join(app, 'Contents', 'MacOS', 'EmuComposerBar')
  if (has('login')) {
    await execFileP('osascript', ['-e', `tell application "System Events" to make login item at end with properties {path:${JSON.stringify(app)}, hidden:true}`]).catch(() => {})
    say('added to Login Items')
  }
  // Re-launch so a changed --launch/--port takes effect.
  await execFileP('pkill', ['-f', 'EmuComposerBar']).catch(() => {})
  spawn(bin, ['--launch', launch, '--port', String(cfg.port), '--title', `${cfg.appName} Composer`, '--owner', flag('owner', 'qemu-system')], { detached: true, stdio: 'ignore' }).unref()
  say(`floating bar running (menu bar icon ◧). It docks to the emulator window; --login adds it to Login Items.`)
}

async function doctor() {
  const cfg = await config({ required: false })
  const row = (ok, label, detail = '') => say(`  ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`)
  row(Number(process.versions.node.split('.')[0]) >= 20, `node ${process.versions.node}`, '(>= 20 required)')
  const adb = cfg?.adbPath || (await import('../src/config.mjs')).findAdb()
  row(fsSync.existsSync(adb) || adb !== 'adb', `adb`, adb)
  try { const d = execFileSync(adb, ['devices'], { encoding: 'utf8' }); row(/\tdevice\n/.test(d), 'device attached', d.split('\n')[1] || '(none — `emu-composer` boots an AVD)') } catch { row(false, 'adb devices', 'adb not runnable') }
  row(fsSync.existsSync(path.join(HOME, 'u2.jar')), 'on-device agent jar', path.join(HOME, 'u2.jar') + (fsSync.existsSync(path.join(HOME, 'u2.jar')) ? '' : '  → emu-composer setup-agent'))
  if (process.platform === 'darwin') {
    const dd = path.join(HOME, 'ios-agent-dd', 'Build', 'Products')
    const built = fsSync.existsSync(dd) && fsSync.readdirSync(dd).some(f => f.endsWith('.xctestrun'))
    row(built, 'iOS Simulator agent', built ? dd : '(optional) → emu-composer setup-ios-agent')
    try {
      const sims = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' }))
      const booted = Object.values(sims.devices || {}).flat().filter(d => d.state === 'Booted').map(d => d.name)
      row(true, 'iOS simulators booted', booted.length ? booted.join(', ') : '(none)')
    } catch {}
  }
  row(fsSync.existsSync(path.join(HOME, 'openai-key')) || Boolean(process.env.OPENAI_API_KEY), 'OpenAI key (dictation)', '(optional — set in the page)')
  row(Boolean(cfg), `${CONFIG_NAME}`, cfg ? `${cfg.configPath} · ${cfg.package} · strings: ${cfg.strings.resolver}` : '→ emu-composer init')
  if (cfg) {
    const h = await health(cfg.port)
    row(Boolean(h), `server on :${cfg.port}`, h ? `agent ${h.agent ? 'on' : 'off'} · stt ${h.stt ? 'on' : 'off'}` : '(not running)')
    if (h?.projects?.length) say(`    projects: ${h.projects.map(p => `${p.name}${p.id === h.active ? ' ←' : ''}`).join(', ')}`)
    for (const p of h?.problems || []) say(`    ${p.level === 'error' ? '✘' : p.level === 'warn' ? '!' : 'i'} ${p.text}`)
  }
}

// The session journal (~/.config/emu-composer/logs/<day>.jsonl), readable: time, event, the
// fields that matter. --json passes the raw lines through for a script or an agent. --follow
// tails the file like `tail -f` (for watching a live session); --grep REGEX keeps only matching
// lines, checked against the raw JSON so it can match the event name or any field.
async function journal() {
  const dayFlag = flag('day')
  // A bare numeric arg is N — unless it is actually a flag's own value (a numeric --grep pattern
  // would otherwise be mistaken for N); --day's value always has dashes, so it never collides.
  const flagVals = new Set(['day', 'grep'].map(f => flag(f)).filter(v => typeof v === 'string'))
  const n = Number(args.find(a => /^\d+$/.test(a) && !flagVals.has(a))) || 60
  const grep = flag('grep') ? new RegExp(String(flag('grep')), 'i') : null
  const fileFor = d => path.join(HOME, 'logs', `${d}.jsonl`)
  let day = dayFlag || new Date().toISOString().slice(0, 10)
  let file = fileFor(day)
  const printRaw = raw => {
    if (grep && !grep.test(raw)) return
    if (has('json')) return say(raw)
    let d; try { d = JSON.parse(raw) } catch { return }
    const { t, ev, at, src, mode, serial, ...rest } = d
    const v = Object.entries(rest).filter(([, x]) => x !== undefined && x !== '').map(([k, x]) => `${k}=${typeof x === 'string' ? JSON.stringify(x.length > 90 ? x.slice(0, 90) + '…' : x) : JSON.stringify(x)}`).join(' ')
    say(`${new Date(t).toLocaleTimeString('en-GB')}  ${(src === 'ui' ? '·' : ' ')}${String(ev).padEnd(13)} ${mode ? `[${mode}] ` : ''}${v}`)
  }
  let size = 0
  if (fsSync.existsSync(file)) {
    const lines = fsSync.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    for (const l of lines.slice(-n)) printRaw(l)
    size = fsSync.statSync(file).size
  } else if (!has('follow')) {
    return say(`no journal for ${day} (${file})`)
  }
  if (!has('follow')) return say(`\n${file}`)
  say(`\n(following ${file}${grep ? `, filter /${grep.source}/` : ''} — ^C to stop)`)
  let tail = ''
  for (;;) {
    await new Promise(r => setTimeout(r, 400))
    // Log filenames are a UTC date, so the file rolls over at UTC midnight — re-resolve it each
    // poll unless --day pinned a specific one.
    const curDay = dayFlag || new Date().toISOString().slice(0, 10)
    if (curDay !== day) { day = curDay; file = fileFor(day); size = 0; tail = ''; say(`\n(new day — now following ${file})`) }
    if (!fsSync.existsSync(file)) continue
    const st = fsSync.statSync(file)
    if (st.size < size) size = 0   // truncated or rotated under us
    if (st.size === size) continue
    const fd = fsSync.openSync(file, 'r')
    const buf = Buffer.alloc(st.size - size)
    fsSync.readSync(fd, buf, 0, buf.length, size)
    fsSync.closeSync(fd)
    size = st.size
    const parts = (tail + buf.toString('utf8')).split('\n')
    tail = parts.pop() || ''   // hold a partial trailing line until it completes
    for (const l of parts) if (l.trim()) printRaw(l)
  }
}

const commands = { log: journal, run, init, 'setup-agent': () => sh('setup-agent.sh'), 'setup-ios-agent': () => sh('setup-ios-agent.sh'), 'install-app': installApp, bar, doctor,
  help: () => say(fsSync.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')) }
if (!commands[cmd]) die(`unknown command "${cmd}"\n` + Object.keys(commands).join(' | '))
Promise.resolve().then(() => commands[cmd]()).catch(e => die(e.message))
