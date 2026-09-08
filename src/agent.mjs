// On-device accessibility agent: uiautomator2's `u2.jar`, run through `app_process` and
// spoken to over JSON-RPC via an adb port forward. It is what makes the composer fast:
//
//   uiautomator dump      2.5 s per call (a fresh JVM every time — measured, fixed cost)
//   agent dump            0.2 s, screenshots 0.05 s as JPEG, taps/swipes/keys ~50 ms
//
// It also carries the device clipboard, which is the ONLY Unicode input path this emulator
// has (`input text` is ASCII-only; `cmd clipboard` is absent; host→guest sync is off).
//
// One UiAutomation client is allowed per device: while the agent runs, `uiautomator dump`
// FAILS, so every consumer goes through here. If the jar is missing the module reports it
// and the server falls back to the slow path — nothing is downloaded on its own.
//
// Lifecycle is defensive by scar: on 2026-09-08 the agent WEDGED mid-session (alive but
// answering nothing), the restart hung, and every capture queued behind it for a minute.
// So: every adb call here is time-boxed, a wedge is killed with SIGKILL (SIGTERM is not
// delivered to a stopped process), restarts are serialized with a cooldown, an unexpected
// exit schedules its own restart with backoff, and forwards are tracked and removed.
//
// Jar provenance: uiautomator2 3.7.0 (pip), assets/u2.jar, version.json u2.jar=0.4.0.
// `emu-composer setup-agent` copies it into ~/.config/emu-composer/u2.jar.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'

const execFileP = promisify(execFile)
const PATTERN = 'com.wetest.uia2.Main'
// For pkill/pgrep: a regex that matches the agent's cmdline but NOT the `sh -c "pkill … "`
// wrapper that carries the pattern text itself — otherwise pgrep always finds one.
const PATTERN_RE = 'app_process / com[.]wetest[.]uia2'
// Everything above 0x7f, built from a string so the source holds no control characters.
const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g')

export class Agent {
  constructor({ adb, serial, jar, devicePort = 9008, log = () => {} }) {
    this.adb = adb; this.serial = serial; this.jar = jar
    this.devicePort = devicePort
    this.hostPort = 0
    this.proc = null
    this.ready = false
    this.reason = ''
    this.log = log
    this._id = 0
    this._starting = null
    this._forwards = new Set()
    this._lastRestart = 0
    this._backoff = 1000
    this._retryTimer = null
    this.stopped = false          // true only after an explicit stop(); suppresses auto-restart
  }

  _adbArgs(args) { return this.serial ? ['-s', this.serial, ...args] : args }
  // Every lifecycle adb call is time-boxed: a hung adb must never hang a restart.
  _adb(args, timeout = 5000) {
    return execFileP(this.adb, this._adbArgs(args), { maxBuffer: 64 << 20, encoding: 'buffer', timeout })
  }

  // ---- lifecycle -----------------------------------------------------------------------

  start() {
    this.stopped = false
    if (this._starting) return this._starting
    this._starting = this._start().catch(e => { this.reason = e.message; return false })
      .finally(() => { this._starting = null })
    return this._starting
  }

  // Serialized restart with a cooldown, so a storm of timeouts cannot restart in a loop.
  async restart(why = '') {
    if (this._starting) return this._starting
    const since = Date.now() - this._lastRestart
    if (since < 3000) await new Promise(r => setTimeout(r, 3000 - since))
    this._lastRestart = Date.now()
    if (why) this.log(`agent restart: ${why}`)
    await this._teardown()
    return this.start()
  }

  // Wait until ready or until `ms` elapses; kicks a restart if nothing is in flight.
  async ensureReady(ms = 8000) {
    if (this.ready) return true
    if (this.stopped || !(await this.available())) return false
    const p = this._starting || this.restart('not ready')
    if (!ms) return false
    return Promise.race([p, new Promise(r => setTimeout(() => r(false), ms))]).then(() => this.ready)
  }

  async available() { try { await fs.access(this.jar); return true } catch { return false } }

  scheduleRestart(why, delay = this._backoff) {
    if (this.stopped || this._retryTimer) return
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null
      const ok = await this.restart(why)
      this._backoff = ok ? 1000 : Math.min(30000, this._backoff * 2)
      if (!ok) this.scheduleRestart(`retry (${this.reason})`)
    }, delay)
  }

  async _start() {
    this.ready = false
    if (!(await this.available())) { this.reason = `agent jar not found at ${this.jar} — run emu-composer setup-agent`; return false }

    await this._teardown({ sweep: !this._everStarted })
    this._everStarted = true

    // Push only when the device copy differs in size (3.7 MB; pushing every start would
    // add a second for nothing).
    const local = (await fs.stat(this.jar)).size
    const remote = (await this._adb(['shell', 'stat', '-c', '%s', '/data/local/tmp/u2.jar']).catch(() => ({ stdout: Buffer.from('') }))).stdout.toString().trim()
    if (String(local) !== remote) {
      this.log(`pushing u2.jar (${local} bytes)`)
      await this._adb(['push', this.jar, '/data/local/tmp/u2.jar'], 30000)
    }

    this.hostPort = await freePort()
    await this._adb(['forward', `tcp:${this.hostPort}`, `tcp:${this.devicePort}`])
    this._forwards.add(this.hostPort)

    // `exec` keeps the shell's pid for app_process, so the first line tells us which device
    // process is OURS — teardown then kills that pid, never a sibling server's agent.
    const proc = spawn(this.adb, this._adbArgs(['shell',
      `echo EMU_PID=$$; CLASSPATH=/data/local/tmp/u2.jar exec app_process / ${PATTERN} -p ${this.devicePort}`]),
      { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    this.devicePid = 0
    proc.stdout.on('data', d => {
      const m = /EMU_PID=(\d+)/.exec(String(d))
      if (m) this.devicePid = Number(m[1])
      const rest = String(d).replace(/EMU_PID=\d+\s*/, '').trim()
      if (rest) this.log(`[agent] ${rest}`)
    })
    proc.stderr.on('data', d => this.log(`[agent] ${String(d).trim()}`))
    proc.on('exit', code => {
      if (this.proc !== proc) return                   // an older instance; ignore
      this.ready = false
      this.reason = `agent exited (${code})`
      this.log(this.reason)
      if (!this.stopped) this.scheduleRestart(this.reason)
    })

    // Ready when /ping answers; the JVM takes ~0.3-1.5 s. A process that dies meanwhile
    // ends the wait at once instead of polling a corpse for 15 s.
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      if (proc.exitCode !== null) { this.reason = `agent exited during startup (${proc.exitCode})`; return false }
      if (await this.ping()) {
        this.ready = true; this.reason = ''; this._backoff = 1000
        this.log(`agent ready on :${this.hostPort} in ${Date.now() - t0} ms`)
        return true
      }
      await new Promise(r => setTimeout(r, 200))
    }
    this.reason = 'agent did not answer /ping within 15 s'
    await this._teardown()
    return false
  }

  // Kill host child, SIGKILL any device instance (a wedged one ignores SIGTERM), then WAIT
  // until none is left — a spawn that races an orphan still holding :9008 exits 1 — and drop
  // every forward aimed at the device port, including ones a previous server left behind.
  async _teardown({ sweep = false } = {}) {
    this.ready = false
    const proc = this.proc; this.proc = null
    const pid = this.devicePid; this.devicePid = 0
    // A device that is GONE (emulator closed) must not cost a chain of 5 s adb timeouts:
    // one 1.5 s probe, then host-side cleanup only. (Switching away from a dead emulator
    // took 15 s before this.)
    const present = await this._adb(['get-state'], 800).then(r => r.stdout.toString().trim() === 'device').catch(() => false)
    if (!present) {
      try { proc?.kill('SIGKILL') } catch {}
      for (const p of this._forwards) await this._adb(['forward', '--remove', `tcp:${p}`], 1500).catch(() => {})
      this._forwards.clear()
      return
    }
    // Graceful first: SIGTERM lets the JVM disconnect its UiAutomation session. Killing
    // clients with -9 over and over left the emulator's AccessibilityManagerService dead
    // (load 17, `IAccessibilityManager` null, 54 s JVM starts) — 2026-09-08. SIGKILL only if
    // it is still there after 1.5 s (a wedged/stopped process ignores SIGTERM).
    if (pid) {
      await this._adb(['shell', 'kill', String(pid)]).catch(() => {})
      for (let i = 0; i < 6; i++) {
        const alive = await this._adb(['shell', `kill -0 ${pid} 2>/dev/null && echo yes`]).then(r => /yes/.test(r.stdout.toString())).catch(() => false)
        if (!alive) break
        await new Promise(r => setTimeout(r, 250))
        if (i === 5) await this._adb(['shell', 'kill', '-9', String(pid)]).catch(() => {})
      }
    }
    try { proc?.kill('SIGKILL') } catch {}
    // Orphans from a previous server are swept only at a fresh start. A device-wide pkill on
    // every teardown killed a sibling server's agent mid-startup (exit 137) — 2026-09-08.
    for (let i = 0; i < (sweep ? 15 : 5); i++) {
      if (sweep) await this._adb(['shell', `pkill ${i < 4 ? '' : '-9 '}-f '${PATTERN_RE}'`]).catch(() => {})
      const left = await this._adb(['shell', `pgrep -f '${PATTERN_RE}' | wc -l`])
        .then(r => Number(r.stdout.toString().trim())).catch(() => 0)
      if (!left) break
      await new Promise(r => setTimeout(r, 200))
    }
    const list = await this._adb(['forward', '--list']).then(r => r.stdout.toString()).catch(() => '')
    for (const m of list.matchAll(/tcp:(\d+)\s+tcp:(\d+)/g)) {
      if (Number(m[2]) === this.devicePort) await this._adb(['forward', '--remove', `tcp:${m[1]}`]).catch(() => {})
    }
    this._forwards.clear()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this._retryTimer); this._retryTimer = null
    await this._teardown()
  }

  // On process exit: release the host child and our forward, and NOTHING on the device — the
  // next server sweeps at its fresh start, and a dying server's pkill must never race it.
  async release() {
    this.stopped = true
    clearTimeout(this._retryTimer); this._retryTimer = null
    try { this.proc?.kill('SIGKILL') } catch {}
    for (const p of this._forwards) await this._adb(['forward', '--remove', `tcp:${p}`], 2000).catch(() => {})
  }

  async ping() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.hostPort}/ping`, { signal: AbortSignal.timeout(1500) })
      return (await r.text()).trim() === 'pong'
    } catch { return false }
  }

  // ---- rpc -----------------------------------------------------------------------------

  // Non-ASCII arrived mangled until the request carried `charset=utf-8` (probed: the agent
  // then stores Hebrew intact). Everything above 0x7f is ALSO \u-escaped so the wire is pure
  // ASCII and the result cannot depend on how the far side sniffs the body encoding.
  async rpc(method, params = [], timeoutMs = 10000) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method, params })
      .replace(NON_ASCII, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    let r
    try {
      r = await fetch(`http://127.0.0.1:${this.hostPort}/jsonrpc/0`, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json; charset=utf-8', 'accept-encoding': '' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      // A timeout or refused connection is a wedge or a death: mark and self-heal.
      this.ready = false
      this.reason = `agent ${method}: ${e.name === 'TimeoutError' ? 'timed out (wedged?)' : e.message}`
      this.scheduleRestart(this.reason, 0)
      throw new Error(this.reason)
    }
    const j = await r.json()
    if (j.error) { const e = new Error(`agent ${method}: ${j.error.message || JSON.stringify(j.error)}`); e.rpc = j.error; throw e }
    return j.result
  }

  // ---- what the server uses ----
  dump()                    { return this.rpc('dumpWindowHierarchy', [false, 60], 8000) }
  screenshotJpegB64(q = 80) { return this.rpc('takeScreenshot', [1.0, q], 5000) }
  click(x, y)               { return this.rpc('click', [Math.round(x), Math.round(y)], 5000) }
  swipe(x1, y1, x2, y2, ms = 200) {
    // steps ≈ 5 ms each in UiAutomator; clamp so a fling is still a fling.
    return this.rpc('swipe', [x1, y1, x2, y2, Math.max(4, Math.round(ms / 5))].map(Math.round), 6000)
  }
  key(code)                 { return this.rpc('pressKeyCode', [code], 5000) }
  async type(text) {
    // Unicode-safe: clipboard + KEYCODE_PASTE (279). Clobbers the device clipboard, which
    // is acceptable on a dev emulator and is the only path Hebrew has.
    await this.rpc('setClipboard', ['emu-composer', text], 5000)
    await this.rpc('pressKeyCode', [279], 5000)
  }
}

function freePort() {
  return new Promise((ok, bad) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) })
    s.on('error', bad)
  })
}

export const DEFAULT_JAR = path.join(process.env.HOME || '', '.config/emu-composer/u2.jar')
