// A session journal the owner (or an agent helping them) can read afterwards: what was
// done on the page and on the device, and how long each step took. One JSON object per
// line, one file per day, under ~/.config/emu-composer/logs/. Writes are chained so lines
// never interleave; a failed write is dropped, never thrown.
import fs from 'node:fs/promises'
import path from 'node:path'
import { HOME } from './config.mjs'

const DIR = path.join(HOME, 'logs')
let chain = Promise.resolve(), made = false
export const LOG_DIR = DIR
export function slog(ev, data = {}) {
  const now = new Date()
  const line = JSON.stringify({ t: now.toISOString(), ...data, ev }) + '\n'
  const file = path.join(DIR, `${now.toISOString().slice(0, 10)}.jsonl`)
  chain = chain.then(async () => {
    if (!made) { await fs.mkdir(DIR, { recursive: true }); made = true }
    await fs.appendFile(file, line)
  }).catch(() => {})
}
