// Claude Code runs shown live in the Claude desktop app.
//
// A CLI session appears in the Claude app only when it is interactive AND has Remote Control
// on (`claude -p` never does). So the session runs interactively in a detached tmux session on
// its own socket — tmux owns the terminal, the session outlives this daemon and can be shown in
// Terminal later without a restart — and once its registry entry (~/.claude/sessions/<pid>.json,
// matched by OUR session id) carries a bridge id, a claude:// link switches the app to it.
//
// Anything that goes wrong AFTER the session started opens Terminal attached to that same
// session: it already has the prompt, and a prompt is never run twice.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)
export const SOCKET = 'claude-sessions'
const APP_ID = 'com.anthropic.claudefordesktop'
const TMUX_BINS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']
const SESSIONS = path.join(os.homedir(), '.claude', 'sessions')
const sleep = ms => new Promise(ok => setTimeout(ok, ms))
const canRun = p => fs.access(p, fs.constants.X_OK).then(() => true, () => false)

// tmux session names cannot hold '.' or ':'; a uuid has neither.
export const tmuxName = sessionId => `cc-${sessionId}`

// Where the session's transcript lands: ~/.claude/projects/<folder, every non-alphanumeric
// character replaced by '-'>/<session id>.jsonl.
export const transcriptPath = (root, sessionId) =>
  path.join(os.homedir(), '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)

// The name the Claude app (and the phone) lists the session under: the first line of the task.
export function sessionTitle(prompt, prefix = 'emu') {
  const line = String(prompt || '').split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#')) || ''
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const cut = clean.length > 60 ? clean.slice(0, 59).trimEnd() + '…' : clean
  return cut ? `${prefix} · ${cut}` : prefix
}

// On Claude Code's "trust this folder?" screen, which option the ❯ pointer is on ("yes"/"no"),
// else null. "No, exit" is preselected, so Enter alone would quit. The options may be numbered
// ("❯ 2. Yes, I trust this folder"): the number is skipped.
export function trustChoice(screen) {
  const flat = String(screen || '').replace(/\s+/g, '').toLowerCase()
  if (!flat.includes('itrustthisfolder')) return null
  const p = flat.lastIndexOf('❯')
  if (p < 0) return 'no'
  return flat.slice(p + 1).replace(/^\d+[.)]?/, '').startsWith('yes') ? 'yes' : 'no'
}

// Can a run go to the Claude app? { ok, tmux, claude } or { ok: false, why }. The owner's CLI
// (~/.local/bin/claude), never the copy inside Claude.app. Absolute paths throughout: a daemon
// started from the Dock or launchd has neither /opt/homebrew/bin nor ~/.local/bin in PATH.
let appCache = null, appAt = 0
export async function desktopRoute(claudeOnPath = '') {
  if (process.platform !== 'darwin') return { ok: false, why: 'not a Mac' }
  if (!appCache || Date.now() - appAt > 60000) { appCache = await appInstalled(); appAt = Date.now() }
  if (!appCache) return { ok: false, why: 'the Claude app is not installed' }
  let tmux = ''
  for (const p of TMUX_BINS) if (await canRun(p)) { tmux = p; break }
  if (!tmux) return { ok: false, why: 'tmux is not installed' }
  const own = path.join(os.homedir(), '.local', 'bin', 'claude')
  const claude = await canRun(own) ? own : (claudeOnPath && !claudeOnPath.includes('/Claude.app/') ? claudeOnPath : '')
  if (!claude) return { ok: false, why: 'the claude CLI was not found' }
  return { ok: true, tmux, claude }
}
async function appInstalled() {
  const found = await execFileP('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${APP_ID}'`], { encoding: 'utf8', timeout: 5000 })
    .then(r => r.stdout.trim()).catch(() => '')
  if (found) return true
  // Spotlight may be off: look where apps usually are.
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const id = await execFileP('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(dir, 'Claude.app', 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 3000 })
      .then(r => r.stdout.trim()).catch(() => '')
    if (id === APP_ID) return true
  }
  return false
}

// tmux -u: ❯ and Hebrew survive capture-pane only in UTF-8 mode. -f /dev/null: the owner's
// ~/.tmux.conf never changes how these sessions run.
const tmuxRun = (tmux, args, timeout = 5000) =>
  execFileP(tmux, ['-u', '-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout, env: { ...process.env, LANG: 'en_US.UTF-8' } })

// Start the session: tmux runs the script in a login + interactive zsh, as Terminal runs a
// .command (same PATH from .zprofile and .zshrc). Arguments go to tmux as separate argv entries,
// so tmux executes them without a shell of its own. LANG is set in the session's own command:
// a daemon started from the Dock has no UTF-8 locale. `remain-on-exit` keeps the pane if
// claude dies at startup, so its last words can be read; it is turned off once the session is
// up, so a normal /exit closes the tmux session with it.
export async function startHosted({ tmux, root, script, sessionId }) {
  const name = tmuxName(sessionId)
  await tmuxRun(tmux, ['new-session', '-d', '-s', name, '-x', '160', '-y', '50', '-c', root,
    '/usr/bin/env', 'LANG=en_US.UTF-8', '/bin/zsh', '-lic', `. ${shq(script)}`,
    ';', 'set-option', '-w', '-t', `=${name}:`, 'remain-on-exit', 'on'])
  return name
}
export const hasSession = (tmux, sessionId) => tmuxRun(tmux, ['has-session', '-t', `=${tmuxName(sessionId)}`]).then(() => true, () => false)
export const shq = s =>`'${String(s).replace(/'/g, `'\\''`)}'`

// The line that starts claude inside the script. A process started from inside another Claude
// session inherits its markers (CLAUDE_CODE_CHILD_SESSION turns transcript saving off: no
// registry entry, no transcript), and so may the tmux server's environment, which comes from
// whichever launch started it — so they are cleared in the session's own shell, right before
// claude. --remote-control always gets its value: bare, it would take the prompt as its name.
export function hostedExec({ claude, sessionId, title, extra = '', promptArg }) {
  return [
    `unset -m 'CLAUDE*' 'MCP_*'; unset ANTHROPIC_BASE_URL`,
    `exec ${shq(claude)} --session-id ${sessionId} --name ${shq(title)} --remote-control ${shq(title)}${extra ? ' ' + extra : ''} ${promptArg}`,
  ].join('\n')
}

// What Terminal runs to show a hosted session.
export const attachExec = (tmux, sessionId) => `exec ${shq(tmux)} -u -L ${SOCKET} attach -t ${shq('=' + tmuxName(sessionId))}`

async function paneState(tmux, name) {
  const r = await tmuxRun(tmux, ['display-message', '-p', '-t', `=${name}:`, '#{pane_dead} #{pane_dead_status}']).catch(() => null)
  if (!r) return { alive: false }
  const [dead, status] = r.stdout.trim().split(' ')
  return { alive: dead !== '1', dead: dead === '1', status }
}
const screen = (tmux, name) => tmuxRun(tmux, ['capture-pane', '-p', '-t', `=${name}:`]).then(r => r.stdout, () => '')
const keys = (tmux, name, ...k) => tmuxRun(tmux, ['send-keys', '-t', `=${name}:`, ...k]).catch(() => {})
const keepOnExit = (tmux, name, on) => tmuxRun(tmux, ['set-option', '-w', '-t', `=${name}:`, 'remain-on-exit', on ? 'on' : 'off']).catch(() => {})

let regFile = new Map()   // session id -> registry file it was found in
async function registryEntry(sessionId) {
  const known = regFile.get(sessionId)
  const files = known ? [known] : (await fs.readdir(SESSIONS).catch(() => [])).filter(f => f.endsWith('.json')).map(f => path.join(SESSIONS, f))
  for (const f of files) {
    let d = null
    try { d = JSON.parse(await fs.readFile(f, 'utf8')) } catch { continue }
    if (d?.sessionId === sessionId) { regFile.set(sessionId, f); return d }
  }
  if (known) regFile.delete(sessionId)
  return null
}

// After startHosted: answer the trust screen, wait for the bridge, switch the app to it.
// → { outcome: 'app', bridge, ms } — the app was told to show the session
//   { outcome: 'terminal', why, ms } — the session runs but the app route failed: show it in Terminal
//   { outcome: 'ended', why, output, ms } — claude exited before it connected; nothing to show
// onStage(stage, data) reports progress: 'trust', 'registered', 'bridge'.
export async function followToApp({ tmux, sessionId, bridgeTimeoutMs = 45000, trustWindowMs = 20000, onStage = () => {} }) {
  const name = tmuxName(sessionId), t0 = Date.now()
  let trust = 'watch', seenAt = 0, moves = 0, registered = false, deadline = t0 + bridgeTimeoutMs
  const done = async (outcome, extra = {}) => {
    if (outcome !== 'ended') await keepOnExit(tmux, name, false)
    return { outcome, ms: Date.now() - t0, ...extra }
  }
  for (;;) {
    const st = await paneState(tmux, name)
    if (!st.alive) {
      const output = st.dead ? (await screen(tmux, name)).trim().split('\n').slice(-12).join('\n') : ''
      if (st.dead) await tmuxRun(tmux, ['kill-session', '-t', `=${name}`]).catch(() => {})
      return done('ended', { why: st.dead ? `claude exited (status ${st.status || '?'}) before it connected` : 'the tmux session is gone', output })
    }
    // "Trust this folder?" (a folder Claude Code has not seen): move ❯ to "Yes", check, confirm.
    // The dialog ignores keys pressed right after it opens, so it is given a moment first.
    if (trust === 'watch' && Date.now() - t0 < trustWindowMs) {
      const c = trustChoice(await screen(tmux, name))
      if (c && !seenAt) { seenAt = Date.now(); await sleep(700); continue }
      if (c === 'yes') { await keys(tmux, name, 'Enter'); trust = 'done'; deadline = Date.now() + bridgeTimeoutMs; onStage('trust', {}); continue }
      if (c === 'no' && moves < 3) { await keys(tmux, name, 'Down'); moves++; await sleep(700); continue }
      if (c === 'no') return done('terminal', { why: 'could not answer the "trust this folder" screen' })
    }
    const reg = await registryEntry(sessionId)
    if (reg && !registered) { registered = true; onStage('registered', { pid: reg.pid, ms: Date.now() - t0 }) }
    const bridge = reg?.bridgeSessionId
    if (bridge && /^[\w-]+$/.test(bridge)) {
      onStage('bridge', { bridge, ms: Date.now() - t0 })
      try { await execFileP('open', [`claude://claude.ai/epitaxy/${bridge}`], { timeout: 10000 }) }
      catch (e) { return done('terminal', { why: `could not open the Claude app: ${String(e.message || e).split('\n')[0]}`, bridge }) }
      return done('app', { bridge })
    }
    if (Date.now() >= deadline) {
      return done('terminal', { why: registered
        ? 'Remote Control did not connect in time (signed in with a claude.ai account? online?)'
        : 'the session did not register in time' })
    }
    await sleep(trust === 'watch' && Date.now() - t0 < trustWindowMs ? 500 : 1000)
  }
}
