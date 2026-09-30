import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { trustChoice, sessionTitle, transcriptPath, tmuxName, hostedExec, attachExec } from '../src/claudehost.mjs'

const TRUST = pointerOn => [
  ' Accessing workspace:',
  ' /Users/me/new-folder',
  ' Quick safety check: Is this a project you created or one you trust?',
  ` ${pointerOn === 'no' ? '❯' : ' '} No, exit`,
  ` ${pointerOn === 'yes' ? '❯' : ' '} Yes, I trust this folder`,
  ' Enter to confirm · Esc to cancel',
].join('\n')

test('the trust screen: which option the pointer is on', () => {
  assert.equal(trustChoice(TRUST('no')), 'no')
  assert.equal(trustChoice(TRUST('yes')), 'yes')
  assert.equal(trustChoice('❯ Try "fix the bug"\n'), null, 'the ordinary prompt is not the trust screen')
  assert.equal(trustChoice(''), null)
})

test('the trust screen with numbered options', () => {
  const s = ' Do you trust the files in this folder?\n   1. No, exit\n ❯ 2. Yes, I trust this folder\n'
  assert.equal(trustChoice(s), 'yes')
  assert.equal(trustChoice(s.replace('❯ 2.', '  2.').replace('   1.', ' ❯ 1.')), 'no')
})

test('the session title is the first line of the task, one line, clipped', () => {
  const prompt = '# Task\nתזיז את @ui1 שמאלה\nומשהו נוסף\n\n# Elements\n'
  assert.equal(sessionTitle(prompt), 'emu · תזיז את @ui1 שמאלה')
  assert.equal(sessionTitle('# Task (2 separate items — address each one)\n\n## 1\nfirst\n'), 'emu · first')
  assert.equal(sessionTitle(''), 'emu')
  const long = sessionTitle('# Task\n' + 'x'.repeat(200))
  assert.ok(long.length <= 'emu · '.length + 60 && long.endsWith('…'))
})

test('tmux names hold no dot or colon; transcripts sit under the folder slug', () => {
  const id = '0b7f7c1e-4a4f-4d0e-9d7e-2f1f8b3c9a10'
  assert.equal(tmuxName(id), `cc-${id}`)
  assert.equal(transcriptPath('/Users/me/My App.v2', id), path.join(os.homedir(), '.claude', 'projects', '-Users-me-My-App-v2', `${id}.jsonl`))
})

test('the hosted command clears inherited Claude markers and names Remote Control explicitly', () => {
  const s = hostedExec({ claude: '/u/.local/bin/claude', sessionId: 'abc', title: "it's · בדיקה", extra: "--model 'opus'", promptArg: `"$(cat '/p/f.md')"` })
  assert.match(s, /^unset -m 'CLAUDE\*' 'MCP_\*'; unset ANTHROPIC_BASE_URL$/m)
  assert.ok(s.includes(`--remote-control 'it'\\''s · בדיקה' --model 'opus' "$(cat '/p/f.md')"`), 'the prompt comes last, after an explicit Remote Control name')
  assert.ok(s.includes('--session-id abc --name '))
  assert.equal(attachExec('/opt/homebrew/bin/tmux', 'abc'), `exec '/opt/homebrew/bin/tmux' -u -L claude-sessions attach -t '=cc-abc'`)
})
