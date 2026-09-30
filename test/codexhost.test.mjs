import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newThreadUrl } from '../src/codexhost.mjs'

test('the new-thread link carries the folder and the prompt intact, and the mode once', () => {
  const root = '/Users/me/My App & co'
  const prompt = '# Task\nתזיז את @ui1 שמאלה — 50% + "quotes" #hash ?q=1&x=2\n\n# Elements\n### @ui1\n'
  const u = new URL(newThreadUrl(root, prompt))
  assert.equal(u.protocol, 'codex:')
  assert.equal(u.host + u.pathname, 'threads/new')
  assert.equal(u.searchParams.get('path'), root)
  assert.equal(u.searchParams.get('prompt'), prompt)
  assert.deepEqual(u.searchParams.getAll('mode'), ['codex'], 'the app drops a link whose mode is missing or repeated')
  assert.equal(u.hash, '', 'a # in the prompt must not become the fragment')
})

test('a thread still sitting in the WAL is seen (the app writes in WAL mode)', async t => {
  const sqlite = await import('node:sqlite').catch(() => null)
  if (!sqlite) return t.skip('node:sqlite is not available')
  const { threadsSince, waitForThread } = await import('../src/codexhost.mjs')
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhost-')), db = path.join(dir, 'state.sqlite')
  const w = new sqlite.DatabaseSync(db)
  w.exec(`pragma journal_mode = wal; pragma wal_autocheckpoint = 0;
    create table threads (id text primary key, cwd text, created_at_ms integer, first_user_message text);`)
  const since = Date.now()
  w.prepare('insert into threads values (?, ?, ?, ?)').run('other', '/elsewhere', since + 5, '# Task\nx')
  w.prepare('insert into threads values (?, ?, ?, ?)').run('mine', '/p', since + 10, '# Task\n\nתזיז   את הכפתור')
  try {
    assert.ok(fs.statSync(db + '-wal').size > 0, 'the rows are in the WAL, not yet in the main file')
    assert.deepEqual((await threadsSince('/p', since, db)).map(r => r.id), ['mine'])
    const r = await waitForThread({ root: '/p', prompt: '# Task\nתזיז את הכפתור\n', since, everyMs: 1, timeoutMs: 1000, db })
    assert.equal(r.outcome, 'sent'); assert.equal(r.thread, 'mine')
  } finally { w.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
