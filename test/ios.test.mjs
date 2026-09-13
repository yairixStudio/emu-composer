import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringIndex } from '../src/resolve.mjs'
import { iosNodes } from '../src/ios.mjs'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('lkey (Swift): extension/enum nesting, colon labels, multi-line, two-level call sites', async () => {
  const ix = new StringIndex({ root: path.join(FIX, 'lkey-swift'), sourceRoots: ['Sources'], strings: { resolver: 'lkey', langs: ['he', 'en', 'es'], files: '/Localization/' } })
  const st = await ix.build()
  assert.equal(st.keys, 3)
  const r = ix.lookup('לוז')
  assert.equal(r.keys[0].key, 'LStr.Shell.tabSchedule')
  assert.deepEqual(r.keys[0].values, { he: 'לוז', en: 'Schedule', es: 'Agenda' })
  assert.match(r.keys[0].usedBy[0].file, /TabModel\.swift$/)
  assert.match(r.keys[0].usedBy[0].code, /L\(LStr\.Shell\.tabSchedule\)/)
  // a multi-line LKey and a Text(...) render site
  const o = ix.lookup('No internet connection')
  assert.equal(o.keys[0].key, 'LStr.Shell.offline')
  assert.equal(o.lang, 'en')
  assert.match(o.keys[0].usedBy[0].code, /Text\(/)
})

test('iOS tree → composer nodes: points scale to px, roles map, text vs label split', () => {
  const tree = { state: 4, nodes: [
    { depth: 0, type: 'Application', id: '', label: 'App', value: '', x: 0, y: 0, w: 402, h: 874, enabled: true, selected: false, focus: false },
    { depth: 1, type: 'Button', id: 'tab_places', label: 'Places', value: '', x: 0, y: 800, w: 80, h: 74, enabled: true, selected: true, focus: false },
    { depth: 1, type: 'StaticText', id: '', label: 'Wallet', value: 'Wallet', x: 20, y: 60, w: 100, h: 24, enabled: true, selected: false, focus: false },
    { depth: 1, type: 'TextField', id: 'search', label: 'Search', value: 'abc', x: 20, y: 120, w: 300, h: 40, enabled: true, selected: false, focus: true },
    { depth: 1, type: 'Switch', id: '', label: 'Share', value: '1', x: 20, y: 200, w: 60, h: 30, enabled: false, selected: false, focus: false },
  ] }
  const n = iosNodes(tree, 3, 'com.example.app')
  assert.equal(n.length, 5)
  assert.equal(n[0].cls, 'XCUI.Application'); assert.equal(n[0].w, 1206); assert.equal(n[0].h, 2622)
  assert.ok(n[1].clickable && n[1].selected); assert.equal(n[1].rid, 'tab_places'); assert.equal(n[1].desc, 'Places'); assert.equal(n[1].text, '')
  assert.equal(n[2].text, 'Wallet'); assert.equal(n[2].desc, '')
  assert.equal(n[3].text, 'abc'); assert.equal(n[3].desc, 'Search'); assert.ok(n[3].focused)
  assert.ok(n[4].checkable && n[4].checked && !n[4].enabled)
  assert.equal(n[1].y, 2400)
  for (const x of n) assert.equal(x.pkg, 'com.example.app')
})

test('xcstrings: String Catalog + .lproj/.strings, keys are literals, plural variations, call sites', async () => {
  const ix = new StringIndex({ root: path.join(FIX, 'xcstrings'), sourceRoots: ['Sources'], strings: { resolver: 'xcstrings' } })
  const st = await ix.build()
  assert.equal(st.keys, 5)
  // the key IS the English copy; Hebrew resolves to it and the call site is Text("Welcome back")
  const he = ix.lookup('ברוך השב')
  assert.equal(he.keys[0].key, 'Welcome back'); assert.equal(he.lang, 'he')
  assert.equal(he.keys[0].values.en, 'Welcome back')
  assert.match(he.keys[0].file, /Localizable\.xcstrings$/); assert.ok(he.keys[0].line > 1)
  assert.match(he.keys[0].usedBy[0].code, /Text\("Welcome back"\)/)
  // a symbolic key, reached through String(localized:)
  const s = ix.lookup('הגדרות')
  assert.equal(s.keys[0].key, 'settings.title')
  assert.match(s.keys[0].usedBy[0].code, /String\(localized: "settings.title"\)/)
  // a plural variation is a value too
  assert.equal(ix.lookup('%lld items').keys[0].key, '%lld items')
  // legacy .strings table, language from the .lproj folder
  const d = ix.lookup('לומלה')
  assert.equal(d.keys[0].key, 'CFBundleDisplayName'); assert.equal(d.lang, 'he')
  // a catalog key is never reported as a hardcoded literal; a real literal still is
  assert.equal(ix.lookup('Welcome back').literals.length, 0)
  assert.equal(ix.lookup('Just a caption').literals.length, 1)
})
