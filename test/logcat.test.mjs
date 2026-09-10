import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterLog, errorBlock } from '../src/logcat.mjs'

const MAIN = [
  '--------- beginning of main',
  '09-10 14:05:22.100 E/OtherApp( 9999): not mine',
  '09-10 14:05:22.101 E/MyTag( 1234): something failed',
  '09-10 14:05:22.102 E/MyTag( 1234): something failed',
  '09-10 14:05:22.103 E/Volley( 4321): com.example.app cannot reach the server',
].join('\n')

const CRASH = [
  '09-10 14:05:30.000 E/AndroidRuntime( 1234): FATAL EXCEPTION: main',
  '09-10 14:05:30.001 E/AndroidRuntime( 1234): java.lang.NullPointerException: name is null',
  '09-10 14:05:30.002 E/AndroidRuntime( 1234): 	at com.example.app.Screen.render(Screen.kt:42)',
  '09-10 14:05:30.003 E/AndroidRuntime( 1234): 	at com.example.app.Root.main(Root.kt:9)',
  '09-10 14:05:31.000 I/Chatter( 5555): unrelated info line',
].join('\n')

test('keeps the app\'s errors by pid, by package name and by crash tag', () => {
  const { lines } = filterLog({ main: MAIN, crash: CRASH, pkg: 'com.example.app', pid: '1234' })
  const joined = lines.join('\n')
  assert.ok(joined.includes('something failed'))
  assert.ok(joined.includes('cannot reach the server'), 'a line naming the package counts even under another pid')
  assert.ok(!joined.includes('not mine'))
  assert.ok(!joined.includes('unrelated info line'))
})

test('a stack trace keeps its frames, and the beginning-of-buffer marker is dropped', () => {
  const { lines } = filterLog({ main: MAIN, crash: CRASH, pkg: 'com.example.app', pid: '1234' })
  const joined = lines.join('\n')
  assert.ok(joined.includes('FATAL EXCEPTION'))
  assert.ok(joined.includes('at com.example.app.Screen.render(Screen.kt:42)'), 'frames follow their header')
  assert.ok(!joined.includes('beginning of main'))
})

test('identical repeats collapse to one line with a count', () => {
  const { lines, count } = filterLog({ main: MAIN, crash: '', pkg: 'com.example.app', pid: '1234' })
  const repeated = lines.find(l => l.includes('something failed'))
  assert.match(repeated, /\(x2\)$/)
  assert.equal(count, lines.length)
})

test('no pid (app not running) still finds lines that name the package, and says so', () => {
  const { lines } = filterLog({ main: MAIN, crash: '', pkg: 'com.example.app', pid: '' })
  assert.equal(lines.length, 1)
  assert.match(errorBlock({ lines, pkg: 'com.example.app', pid: '' }), /the app is not running/)
})

test('nothing to report renders no block at all', () => {
  const { lines, count } = filterLog({ main: '', crash: '', pkg: 'com.example.app', pid: '1' })
  assert.equal(count, 0)
  assert.equal(errorBlock({ lines, pkg: 'x', pid: '' }), '')
})
