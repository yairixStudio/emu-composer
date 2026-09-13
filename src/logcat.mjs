// Turning `adb logcat` into the few lines worth putting in a prompt.
//
// Pure and separately testable on purpose: the two logcat formats this parses (`-v time`
// for the error level, the crash buffer for stack traces) are Android's, not ours, and a
// silent parse failure would show up as "no errors" — the most misleading possible answer
// on a prompt that asks why something is broken.

// `09-10 14:05:22.123 E/Tag(  1234): message`
const HEAD = /^[\d-]+ [\d:.]+ [A-Z]\/\S*\(\s*\d+\):\s?/
const FRAME = /^\s*(at |Caused by:|\.\.\. |Suppressed: )/

/**
 * @param {object} o
 * @param {string} o.main   `logcat -d -v time -t N *:E`
 * @param {string} o.crash  `logcat -d -b crash -v time -t N`
 * @param {string} o.pkg    the application id
 * @param {string} o.pid    its pid, or '' when the app is not running
 * @param {number} o.max    how many lines to keep
 */
export function filterLog({ main = '', crash = '', pkg = '', pid = '', max = 25 }) {
  // The pid is the only reliable "this is my app" signal: a crash prints under the system's
  // AndroidRuntime tag and a library logs under its own.
  const mine = pid ? new RegExp(`\\(\\s*${pid}\\)`) : null
  const keep = l => Boolean(l.trim()) && !/^-+ beginning of/.test(l) &&
    ((mine && mine.test(l)) || (pkg && l.includes(pkg)) || /FATAL EXCEPTION|AndroidRuntime|ANR in/.test(l))

  // A stack trace's frames carry the same tag as their header, but a `Caused by:` chain can
  // run long — keep up to 12 frames after a kept line, then stop.
  const collect = text => {
    const out = []
    let carry = 0
    for (const raw of String(text).split('\n')) {
      const l = raw.trimEnd()
      if (keep(l)) { out.push(l); carry = 12; continue }
      if (carry > 0 && FRAME.test(l.replace(HEAD, ''))) { out.push(l); carry-- }
      else carry = 0
    }
    return out
  }

  // One bad frame can print the same line hundreds of times; identical messages collapse to
  // one with a count, so 25 lines are 25 distinct facts.
  const seen = new Map()
  for (const l of [...collect(crash), ...collect(main)]) {
    const k = l.replace(/^[\d-]+ [\d:.]+ /, '')
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  const lines = [...seen.entries()].map(([l, n]) => (n > 1 ? `${l}   (x${n})` : l)).slice(-max)
  return { lines, count: lines.length }
}

// Identical lines (after their timestamp) collapse to one with a count — shared by the
// Android path above and the iOS unified-log path.
export function collapseLines(raw, max = 25) {
  const seen = new Map()
  for (const l of raw) { const k = l.replace(/^[\d-]+ [\d:.+-]+ /, ''); seen.set(k, (seen.get(k) || 0) + 1) }
  return [...seen.entries()].map(([l, n]) => (n > 1 ? `${l}   (x${n})` : l)).slice(-max)
}

export function errorBlock({ lines, pkg = '', pid = '', source = '' }) {
  if (!lines.length) return ''
  return ['# Errors',
    `source:   ${source || `adb logcat, error level and the crash buffer, filtered to ${pkg}${pid ? ` (pid ${pid})` : ' — the app is not running, so these are from an earlier run'}`}`,
    '', lines.join('\n').slice(0, 4000)].join('\n')
}
