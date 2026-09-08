import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringIndex, buildTree, tapTarget, siblingPosition, role, normalise } from '../src/resolve.mjs'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('android-xml: value → R.string key, all locales, call sites, template match', async () => {
  const ix = new StringIndex({ root: path.join(FIX, 'android-xml'), sourceRoots: ['app/src/main/java'], strings: { resolver: 'android-xml', resDirs: ['app/src/main/res'] } })
  const st = await ix.build()
  assert.equal(st.keys, 3)
  const r = ix.lookup('Schedule')
  assert.equal(r.keys[0].key, 'R.string.tab_schedule')
  assert.equal(r.lang, 'default')
  assert.deepEqual(r.keys[0].values, { default: 'Schedule', he: 'לוז' })
  assert.match(r.keys[0].file, /values\/strings\.xml$/)
  assert.equal(r.keys[0].usedBy[0].file, 'app/src/main/java/com/example/MainScreen.kt')
  assert.equal(ix.lookup('לוז').keys[0].key, 'R.string.tab_schedule')
  // printf template
  assert.equal(ix.lookup('Error (404)').keys[0].key, 'R.string.error_with_status')
  // xliff + escapes
  assert.equal(ix.lookup("Don't panic, %1$s").keys[0].key, 'R.string.greeting')
  // layout xml reference counts as a call site
  assert.ok(ix.usage.get('R.string.greeting').some(u => u.file.endsWith('layout/main.xml')))
})

test('lkey: multi-line LKey, object prefix, ranked usages, Hebrew lookup', async () => {
  const ix = new StringIndex({ root: path.join(FIX, 'lkey'), sourceRoots: ['app'], strings: { resolver: 'lkey', langs: ['he', 'en', 'es'], files: '/l10n/' } })
  await ix.build()
  const r = ix.lookup('No internet connection')
  assert.equal(r.keys[0].key, 'LCommon.networkError')
  assert.equal(r.keys[0].values.he, 'אין חיבור')
  assert.equal(r.lang, 'en')
  // the call site that RENDERS ranks above the one that only maps
  assert.match(r.keys[0].usedBy[0].code, /Text\(/)
  // a file named after the screen hint wins
  const h = ix.lookup('Today', 'Schedule')
  assert.match(h.keys[0].usedBy[0].file, /ScheduleScreen/)
})

test('normalise strips bidi isolates and NBSP', () => {
  assert.equal(normalise('Some⁦ text⁩ here'), 'Some text here')
})

test('tree: selected tab counts as the tap target; row position needs geometry', () => {
  const nodes = buildTree([
    { i: 0, depth: 0, cls: 'android.widget.FrameLayout', x: 0, y: 0, w: 1080, h: 2400 },
    { i: 1, depth: 1, cls: 'android.view.View', x: 0, y: 2127, w: 1080, h: 210 },          // tab row
    { i: 2, depth: 2, cls: 'android.view.View', x: 0, y: 2127, w: 200, h: 210, clickable: true },
    { i: 3, depth: 2, cls: 'android.view.View', x: 441, y: 2127, w: 199, h: 210, selected: true },  // current tab: no click action
    { i: 4, depth: 3, cls: 'android.widget.TextView', text: 'Schedule', x: 485, y: 2259, w: 110, h: 30 },
    { i: 5, depth: 2, cls: 'android.view.View', x: 881, y: 2127, w: 199, h: 210, clickable: true },
    { i: 6, depth: 1, cls: 'android.view.View', x: 912, y: 1959, w: 126, h: 126, clickable: true },  // FAB, unrelated sibling of the row
  ].map(n => ({ text: '', desc: '', rid: '', ...n })))
  const target = tapTarget(nodes, 4)
  assert.equal(target.i, 3, 'label resolves to its selected container')
  const pos = siblingPosition(nodes, target)
  assert.deepEqual(pos, { index: 2, of: 3, axis: 'row' })
  assert.equal(role(nodes[4], target, pos), 'label of the selected tab')
  // the FAB's siblings under the root are not a row
  assert.equal(siblingPosition(nodes, nodes[6]), null)
})
