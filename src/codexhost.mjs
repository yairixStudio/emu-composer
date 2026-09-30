// Codex runs opened in the Codex desktop app (ChatGPT.app, bundle id com.openai.codex).
//
// Unlike Claude Code, a session the Codex CLI runs cannot be shown live in the app: the thread
// has one writer, and while the CLI holds it the app only shows a read-only copy ("This is open
// in another app"). What the app CAN do is start the thread itself: codex://threads/new with
// the project folder and the prompt opens a new thread in that project with the prompt typed
// into the composer — NOT sent (verified in the app's code, 26.908). The owner presses Enter,
// and from then on the thread is the app's own: live, and typed into there.
//
// So once the link is opened, nothing may fall back to Terminal: the prompt is waiting in the
// app, and a second copy would run it twice. The thread's creation is noticed by reading the
// app's thread table (read-only) and reported, nothing more.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)
const APP_ID = 'com.openai.codex'
const STATE_DB = path.join(os.homedir(), '.codex', 'state_5.sqlite')
const sleep = ms => new Promise(ok => setTimeout(ok, ms))
// Long prompts become long links; beyond this the Terminal is the safer host.
export const MAX_URL = 200000

let appCache = null, appAt = 0
export async function codexAppRoute() {
  if (process.platform !== 'darwin') return { ok: false, why: 'not a Mac' }
  if (appCache === null || Date.now() - appAt > 60000) { appCache = await appPath(); appAt = Date.now() }
  return appCache ? { ok: true, app: appCache } : { ok: false, why: 'the Codex app is not installed' }
}
async function appPath() {
  const found = await execFileP('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${APP_ID}'`], { encoding: 'utf8', timeout: 5000 })
    .then(r => r.stdout.split('\n').map(s => s.trim()).find(s => s.endsWith('.app')) || '').catch(() => '')
  if (found) return found
  // Spotlight may be off. The Codex app ships as ChatGPT.app (older builds: Codex.app).
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    for (const name of ['ChatGPT.app', 'Codex.app']) {
      const p = path.join(dir, name)
      const id = await execFileP('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(p, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 3000 })
        .then(r => r.stdout.trim()).catch(() => '')
      if (id === APP_ID) return p
    }
  }
  return ''
}

// The app takes `path` (an existing folder, absolute — a new one becomes a project in its
// sidebar), `prompt` (typed into the composer, not sent) and `mode` (exactly once: chat|work|codex).
// It has no model parameter: the model is the one selected in the app.
export const newThreadUrl = (root, prompt) =>
  `codex://threads/new?path=${encodeURIComponent(root)}&prompt=${encodeURIComponent(prompt)}&mode=codex`

export async function openNewThread(root, prompt) {
  const url = newThreadUrl(root, prompt)
  if (url.length > MAX_URL) throw new Error(`the prompt is too long for a codex:// link (${url.length} chars)`)
  await execFileP('open', ['-b', APP_ID, url], { timeout: 15000 })
}

// Threads created in `root` since `since` (ms), newest first, from the app's own table, opened
// read-only. The table is in WAL mode and a new thread sits in the -wal file for a while, so it
// is read with node:sqlite (Node ≥ 22.5), which reads the WAL — the sqlite3 CLI's `immutable`
// mode skips it and saw nothing (2026-09-30). null when node:sqlite is not there.
let sqliteMod
export async function threadsSince(root, since, db = STATE_DB) {
  if (sqliteMod === undefined) sqliteMod = await import('node:sqlite').catch(() => null)
  if (!sqliteMod) return null
  let conn = null
  try {
    conn = new sqliteMod.DatabaseSync(db, { readOnly: true })
    return conn.prepare('select id, cwd, created_at_ms, first_user_message from threads where created_at_ms > ? and cwd = ? order by created_at_ms desc limit 20')
      .all(Math.floor(since), root)
  } catch { return [] }
  finally { try { conn?.close() } catch {} }
}

// After openNewThread: wait (default an hour) for the owner to send it. The first thread in
// `root` whose first message starts like the prompt — else the first thread in `root` at all.
// → { outcome: 'sent', thread, ms } | { outcome: 'unsent', ms } | { outcome: 'unknown', ms }
export async function waitForThread({ root, prompt, since, timeoutMs = 3600000, everyMs = 3000, db = STATE_DB }) {
  const t0 = Date.now()
  const flat = s => String(s || '').replace(/\s+/g, ' ').trim()
  const head = flat(prompt).slice(0, 40)
  while (Date.now() - t0 < timeoutMs) {
    await sleep(everyMs)
    const rows = await threadsSince(root, since - 2000, db)
    if (rows === null) return { outcome: 'unknown', ms: Date.now() - t0 }
    const hit = rows.find(t => flat(t.first_user_message).startsWith(head)) || rows[0]
    if (hit) return { outcome: 'sent', thread: hit.id, ms: Date.now() - t0 }
  }
  return { outcome: 'unsent', ms: Date.now() - t0 }
}
