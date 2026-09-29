import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The page is one HTML file; its dictation helpers that touch no DOM sit between two markers
// and are run here on their own.
const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8')
const block = html.match(/\/\/ <dictation-pure>[^\n]*\n([\s\S]*?)\/\/ <\/dictation-pure>/)[1]
const { dictJunk, hasWords } = new Function(`${block}; return { dictJunk, hasWords }`)()

// Pairs from the 2026-09-29 journal (idx 6/7/8 after the anchor taps, idx 2/3).
test('a remainder that repeats the end of the words before the break is dropped', () => {
  const idx6 = 'של העמוד, זאת אומרת. הוא הציג עיצוב כנראה קצת ישן. העיצוב צריך להיות כזה שמשקף את האייטמים בעיצוב החדש שלהם, למשל את האייטם הזה.'
  assert.equal(dictJunk('זה.', idx6), 'dup-tail')            // the other half of "הזה"
  assert.equal(dictJunk('האייטם הזה', idx6), 'dup-tail')     // whole words repeated
})

test('a real short answer after a break stays', () => {
  assert.equal(dictJunk('בסדר.', 'ואז ניסיתי לעבור לעמוד של פלייסר.'), '')
  assert.equal(dictJunk('כן.', 'ואז ניסיתי לעבור לעמוד של פלייסר.'), '')
  assert.equal(dictJunk('או אייטמים אחרים.', 'למשל את האייטם הזה.'), '')
})

test('a short answer with no break before it is never compared', () => {
  assert.equal(dictJunk('כן.', null), '')
  assert.equal(dictJunk('כן.'), '')
})

test('no letters, no digits: dropped', () => {
  assert.equal(dictJunk('.', null), 'no-words')
  assert.equal(dictJunk(' … ', null), 'no-words')
  assert.equal(dictJunk('', null), 'empty')
  assert.equal(dictJunk('3.', null), '')
  assert.equal(hasWords('?!'), false)
  assert.equal(hasWords('ok'), true)
})

test('a remainder longer than a few words is not a duplicate even if it matches', () => {
  const prev = 'אני רוצה שזה יעבוד גם כשהמסך מסתובב וגם כשהוא לא'
  assert.equal(dictJunk('גם כשהמסך מסתובב וגם כשהוא לא', prev), '')
})
