import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../bin/emu-composer.js', import.meta.url))

test('help prints the CLI commands and exits cleanly', () => {
  const result = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /emu-composer CLI/)
  assert.match(result.stdout, /setup-ios-agent/)
  assert.equal(result.stderr, '')
})
