// The iOS simulator's screen and touch without XCUITest: ios/simbridge/simbridge.m, built with
// clang on first use (cached per source + Xcode build) and run once per booted simulator.
// It reads the simulator's framebuffer on every presented frame, encodes it with VideoToolbox
// as low-latency H.264, and drives the guest's digitizer directly — a tap lands in ~1 ms and a
// drag is a real drag. The XCUITest agent keeps the element tree and typing.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'simbridge', 'simbridge.m')
const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'emu-composer')
const FRAMEWORKS = ['Foundation', 'IOSurface', 'CoreImage', 'CoreVideo', 'CoreMedia', 'VideoToolbox', 'CoreGraphics', 'ImageIO']

let building = null
// The binary is keyed on its source AND the Xcode build: private CoreSimulator interfaces move
// between Xcode releases, so an Xcode update rebuilds it.
export function buildBridge(log = () => {}) {
  building ||= (async () => {
    const [src, xc, dev] = await Promise.all([
      fs.readFile(SRC),
      execFileP('xcodebuild', ['-version'], { encoding: 'utf8', timeout: 20000 }).then(r => r.stdout).catch(() => ''),
      execFileP('xcode-select', ['-p'], { encoding: 'utf8' }).then(r => r.stdout.trim()).catch(() => '/Applications/Xcode.app/Contents/Developer'),
    ])
    const hash = crypto.createHash('sha256').update(src).update(xc).digest('hex').slice(0, 16)
    const bin = path.join(CACHE, `simbridge-${hash}`)
    try { await fs.access(bin); return { bin, dev } } catch {}
    await fs.mkdir(CACHE, { recursive: true })
    const t0 = Date.now()
    const tmp = `${bin}.${process.pid}.tmp`
    await execFileP('xcrun', ['clang', '-fobjc-arc', '-O2', ...FRAMEWORKS.flatMap(f => ['-framework', f]), SRC, '-o', tmp], { timeout: 180000 })
    await fs.rename(tmp, bin)
    log(`simbridge built in ${Date.now() - t0} ms`)
    return { bin, dev }
  })()
  building.catch(() => { building = null })
  return building
}

export class SimBridge {
  constructor(udid, { log = () => {} } = {}) {
    this.udid = udid; this.log = log
    this.screen = null          // { w, h } in pixels
    this.touch = false          // the digitizer answered
    this.video = null           // { w, h, fps } while encoding
    this.viewers = new Set()
    this.waiters = []           // jpeg requests, answered in order
    this.dead = false
    this.error = ''
    this.touchReady = new Promise(ok => { this.touchOk = ok })
    this.ready = this.#start()
    this.ready.catch(e => { this.dead = true; this.error = e.message })
  }

  async #start() {
    const { bin, dev } = await buildBridge(this.log)
    const p = this.p = spawn(bin, [this.udid, dev], { stdio: ['pipe', 'pipe', 'pipe'] })
    p.stderr.on('data', d => this.log('simbridge:', d.toString().trim()))
    let buf = Buffer.alloc(0)
    let readyOk, readyBad
    const ready = new Promise((ok, bad) => { readyOk = ok; readyBad = bad })
    p.stdout.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(0)
        if (buf.length < 5 + n) break
        const kind = buf[4], body = buf.subarray(5, 5 + n)
        buf = buf.subarray(5 + n)
        if (kind === 0x76) for (const v of this.viewers) v.onAU(body)          // 'v'
        else if (kind === 0x6a) this.waiters.shift()?.ok(Buffer.from(body))    // 'j'
        else this.#event(kind === 0x65, body.toString('utf8'), readyOk)
      }
    })
    p.on('exit', code => {
      this.dead = true
      this.error ||= `simbridge exited (${code})`
      readyBad(new Error(this.error))
      for (const w of this.waiters.splice(0)) w.bad(new Error(this.error))
      for (const v of this.viewers) v.onEnd?.()
      this.viewers.clear()
    })
    p.stdin.on('error', () => {})
    const t = setTimeout(() => readyBad(new Error('simbridge did not start in 15 s')), 15000)
    await ready.finally(() => clearTimeout(t))
  }

  #event(isError, text, readyOk) {
    let m = {}
    try { m = JSON.parse(text) } catch { return }
    if (isError) {
      this.error = m.error || text; this.log('simbridge error:', this.error)
      if (/jpeg|framebuffer/.test(this.error)) this.waiters.shift()?.bad(new Error(this.error))
      return
    }
    if (m.screen) this.screen = m.screen
    if (m.touch) { this.touch = true; this.touchOk(); this.log(`simbridge touch ready (${m.ms} ms)`) }
    if (m.video) this.video = { w: m.w, h: m.h, fps: m.fps }
    if (m.ready) readyOk()
  }

  #send(line) { if (!this.dead) this.p?.stdin.write(line + '\n') }
  // Coordinates in screen pixels (what the page and the tree use), sent as 0..1.
  #rx(x) { return (x / (this.screen?.w || 1)).toFixed(5) }
  #ry(y) { return (y / (this.screen?.h || 1)).toFixed(5) }
  touchEvent(phase, x, y, edge = 0) { this.#send(`${phase === 'down' ? 'd' : phase === 'up' ? 'u' : 'm'} ${this.#rx(x)} ${this.#ry(y)} ${edge | 0}`) }
  tap(x, y) { this.#send(`t ${this.#rx(x)} ${this.#ry(y)}`) }
  swipe(x1, y1, x2, y2, ms = 200, edge = 0) { this.#send(`w ${this.#rx(x1)} ${this.#ry(y1)} ${this.#rx(x2)} ${this.#ry(y2)} ${Math.round(ms)} ${edge | 0}`) }
  button(name) { this.#send(`b ${name}`) }
  key(usage) { this.#send(`K ${usage}`) }

  jpeg(width = 0, quality = 0.85) {
    if (this.dead) return Promise.reject(new Error(this.error || 'simbridge is not running'))
    return new Promise((ok, bad) => {
      const w = { ok, bad }
      this.waiters.push(w)
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); bad(new Error('simbridge screenshot timed out')) } }, 4000)
      this.#send(`j ${Math.round(width)} ${quality}`)
    })
  }

  // One encoder serves every page: the widest request wins, and a page that joins asks for a
  // key frame so it can start decoding at once.
  watch(width, onAU, onEnd) {
    const v = { width, onAU, onEnd }
    this.viewers.add(v)
    this.#retune(true)
    return () => { this.viewers.delete(v); this.#retune(false) }
  }
  #retune(joined) {
    if (!this.viewers.size) { this.#send('x'); this.video = null; return }
    const w = Math.max(...[...this.viewers].map(v => v.width))
    if (!this.video || this.video.w !== (Math.min(w, this.screen?.w || w) & ~1)) this.#send(`s ${w} 60`)
    else if (joined) this.#send('k')
  }

  close() { this.dead = true; try { this.p?.kill() } catch {} }
}
