// One persistent `adb shell` per device for input. A tap through the on-device agent costs
// ~250 ms (HTTP + UiAutomation, and it queues behind a slow tree dump); a fresh
// `adb shell input tap` ~105 ms; the same command written to a shell that is already open
// ~40 ms (measured on an API 34 emulator). Commands run in order; each ends with a unique
// marker so its completion is known without parsing its output.
import { spawn } from 'node:child_process'

export class DeviceShell {
  constructor(adbPath, serial, log = () => {}) {
    this.adb = adbPath; this.serial = serial; this.log = log
    this.p = null; this.buf = ''; this.pending = new Map(); this.n = 0
  }
  _spawn() {
    const p = this.p = spawn(this.adb, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.buf = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', d => {
      this.buf += d
      // The marker's status is digits, so an echoed command line ("…_$?__") never matches.
      let end = 0
      for (const m of this.buf.matchAll(/__emuc_(\d+)_(\d+)__/g)) {
        end = m.index + m[0].length
        const w = this.pending.get(Number(m[1])); if (!w) continue
        this.pending.delete(Number(m[1])); clearTimeout(w.timer)
        Number(m[2]) === 0 ? w.ok() : w.bad(new Error(`shell: ${w.cmd} exited ${m[2]}`))
      }
      this.buf = this.buf.slice(end)
      if (this.buf.length > 65536) this.buf = this.buf.slice(-256)
    })
    p.stderr.on('data', () => {})
    const gone = why => {
      if (this.p !== p) return
      this.p = null
      for (const w of this.pending.values()) { clearTimeout(w.timer); w.bad(new Error(`shell closed (${why})`)) }
      this.pending.clear()
    }
    p.on('exit', c => gone(`exit ${c}`)); p.on('error', e => gone(e.message))
    p.stdin.on('error', () => gone('stdin'))
  }
  run(cmd, timeoutMs = 8000) {
    if (!this.p) this._spawn()
    const id = ++this.n
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => { this.pending.delete(id); bad(new Error(`shell: ${cmd} timed out`)); this.close() }, timeoutMs)
      this.pending.set(id, { ok, bad, timer, cmd })
      this.p.stdin.write(`${cmd}; echo "__emuc_${id}_$?__"\n`)
    })
  }
  close() { try { this.p?.kill() } catch {} this.p = null }
}
