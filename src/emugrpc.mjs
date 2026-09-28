// The emulator's own gRPC endpoint (what Android Studio's embedded emulator talks to): the
// screen streamed from the HOST side — no encoder running inside the guest — and input
// injected on the host, bypassing the guest's `input` command. Plain HTTP/2 + a hand-rolled
// protobuf subset, so there is still no dependency.
//
// Measured on an API 34 emulator: PNG frames at 540×1200 ~73 KB, 18+ fps while the screen
// changes, nothing while it is still; screenrecord's in-guest encoder at 1080×2400 used most
// of the guest's CPU and made taps take 1-4 s.
import http2 from 'node:http2'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Each running emulator writes a discovery file with its gRPC port and a local access token.
export function discover(serial) {
  const m = /^emulator-(\d+)$/.exec(serial || ''); if (!m) return null
  const dirs = [path.join(os.homedir(), 'Library/Caches/TemporaryItems/avd/running'),
    process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'avd/running'),
    path.join(os.tmpdir(), `android-${os.userInfo().username}`, 'avd/running')].filter(Boolean)
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(d).filter(f => /^pid_\d+\.ini$/.test(f)) } catch { continue }
    for (const f of files) {
      let kv = {}
      try { kv = Object.fromEntries(fs.readFileSync(path.join(d, f), 'utf8').split('\n').map(l => l.split('=')).filter(x => x.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()])) } catch { continue }
      if (kv['port.serial'] === m[1] && kv['grpc.port']) return { port: Number(kv['grpc.port']), token: kv['grpc.token'] || '' }
    }
  }
  return null
}

// ---- protobuf, the few shapes used here
const varint = n => { const o = []; n = Math.max(0, Math.round(n)); while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128) } o.push(n); return Buffer.from(o) }
const fVar = (f, n) => Buffer.concat([varint((f << 3) | 0), varint(n)])
const fStr = (f, s) => { const b = Buffer.from(s); return Buffer.concat([varint((f << 3) | 2), varint(b.length), b]) }
function fields(buf) {
  const out = {}; let i = 0
  const rv = () => { let r = 0, s = 1, b; do { b = buf[i++]; r += (b & 127) * s; s *= 128 } while (b & 128); return r }
  while (i < buf.length) {
    const key = rv(), f = key >>> 3, wt = key & 7
    if (wt === 0) out[f] = rv()
    else if (wt === 2) { const len = rv(); out[f] = buf.subarray(i, i + len); i += len }
    else if (wt === 1) i += 8
    else if (wt === 5) i += 4
    else break
  }
  return out
}
const frame = msg => { const f = Buffer.alloc(5 + msg.length); f.writeUInt32BE(msg.length, 1); msg.copy(f, 5); return f }

export class EmuGrpc {
  constructor({ port, token }) { this.port = port; this.token = token; this.client = null }
  _client() {
    if (!this.client || this.client.closed || this.client.destroyed) {
      this.client = http2.connect(`http://127.0.0.1:${this.port}`)
      this.client.on('error', () => {}); this.client.unref?.()
    }
    return this.client
  }
  _req(method) {
    return this._client().request({ ':method': 'POST', ':path': `/android.emulation.control.EmulatorController/${method}`,
      'content-type': 'application/grpc', te: 'trailers', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) })
  }
  unary(method, msg, timeoutMs = 3000) {
    return new Promise((ok, bad) => {
      const r = this._req(method); let status = null
      const timer = setTimeout(() => { r.close(); bad(new Error(`grpc ${method} timed out`)) }, timeoutMs)
      r.on('response', h => { if (h['grpc-status'] && h['grpc-status'] !== '0') status = h['grpc-message'] || h['grpc-status'] })
      r.on('trailers', t => { if (t['grpc-status'] && t['grpc-status'] !== '0') status = t['grpc-message'] || t['grpc-status'] })
      r.on('data', () => {}); r.on('error', e => { clearTimeout(timer); bad(e) })
      r.on('end', () => { clearTimeout(timer); status ? bad(new Error(`grpc ${method}: ${status}`)) : ok() })
      r.end(frame(msg))
    })
  }
  // PNG frames scaled on the host to w×h; onImage(pngBytes, width, height) per change.
  stream(w, h, onImage, onEnd) {
    const r = this._req('streamScreenshot')
    let buf = Buffer.alloc(0)
    r.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1); if (buf.length < 5 + len) break
        const img = fields(buf.subarray(5, 5 + len)); buf = buf.subarray(5 + len)
        const fmt = img[1] ? fields(img[1]) : {}
        if (img[4]?.length) onImage(img[4], fmt[3] || w, fmt[4] || h)
      }
    })
    r.on('end', () => onEnd?.()); r.on('error', e => onEnd?.(e))
    r.end(frame(Buffer.concat([fVar(1, 0), fVar(3, w), fVar(4, h)])))   // format PNG, width, height
    return { close: () => { try { r.close() } catch {} } }
  }
  // Mouse on the host: buttons 1 = pressed, 0 = released. Coordinates in device pixels.
  mouse(x, y, buttons) { return this.unary('sendMouse', Buffer.concat([fVar(1, x), fVar(2, y), fVar(3, buttons)])) }
  async tap(x, y) { await this.mouse(x, y, 1); await this.mouse(x, y, 0) }
  async swipe(x1, y1, x2, y2, ms = 200) {
    const steps = Math.max(4, Math.round(ms / 16))
    await this.mouse(x1, y1, 1)
    for (let i = 1; i <= steps; i++) {
      await new Promise(r => setTimeout(r, ms / steps))
      await this.mouse(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, 1)
    }
    await this.mouse(x2, y2, 0)
  }
  close() { try { this.client?.close() } catch {} this.client = null }
}
