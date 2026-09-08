// Project configuration: `emu-composer.json` at the project root (searched upward from the
// working directory), with auto-detection for the common Android layout so `init` can write
// a sensible file in one command.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const CONFIG_NAME = 'emu-composer.json'
export const HOME = process.env.EMU_COMPOSER_HOME || path.join(os.homedir(), '.config', 'emu-composer')

export const DEFAULTS = {
  package: '',                 // applicationId of the app under test (required)
  appName: '',                 // display name; defaults to the last package segment
  sourceRoots: [],             // Kotlin/Java roots indexed for call sites and literals
  strings: { resolver: 'android-xml', resDirs: [] },
  versionFile: '',             // build.gradle(.kts) with versionName/versionCode
  signInLabels: ['sign in', 'log in'],
  notes: null,                 // agent notes; null = generated from this config
  port: 7788,
  adb: 'auto',
  avd: '',                     // AVD to boot when no device is attached ('' = first listed)
  stt: { model: 'gpt-4o-transcribe', language: '' },
}

export function findConfig(from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    const p = path.join(dir, CONFIG_NAME)
    if (fsSync.existsSync(p)) return p
    const up = path.dirname(dir)
    if (up === dir) return ''
    dir = up
  }
}

export async function loadConfig(configPath) {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  const cfg = { ...DEFAULTS, ...raw, strings: { ...DEFAULTS.strings, ...(raw.strings || {}) }, stt: { ...DEFAULTS.stt, ...(raw.stt || {}) } }
  cfg.root = path.dirname(configPath)
  cfg.configPath = configPath
  if (!cfg.package) throw new Error(`${CONFIG_NAME}: "package" is required (the app's applicationId)`)
  cfg.appName ||= cfg.package.split('.').pop()
  cfg.adbPath = cfg.adb === 'auto' ? findAdb() : cfg.adb
  return cfg
}

// adb: explicit → env → ANDROID_HOME/ANDROID_SDK_ROOT → PATH → the usual installs.
export function findAdb() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  const candidates = [
    sdk && path.join(sdk, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    '/opt/homebrew/share/android-commandlinetools/platform-tools/adb',
    '/usr/local/share/android-commandlinetools/platform-tools/adb',
    path.join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
  ].filter(Boolean)
  try { const w = execFileSync('/bin/sh', ['-c', 'command -v adb'], { encoding: 'utf8' }).trim(); if (w) candidates.unshift(w) } catch {}
  return candidates.find(c => fsSync.existsSync(c)) || 'adb'
}

export function findEmulator(adbPath) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.resolve(path.dirname(adbPath), '..')
  const p = path.join(sdk, 'emulator', 'emulator')
  return fsSync.existsSync(p) ? p : 'emulator'
}

// ---------------------------------------------------------------- detect ----

// Walk the project for the pieces the config needs. Heuristics, printed for review.
export async function detect(root) {
  const out = { package: '', appName: '', sourceRoots: [], strings: null, versionFile: '', findings: [] }
  const gradle = await findFiles(root, f => /^build\.gradle(\.kts)?$/.test(f), 4)
  for (const g of gradle) {
    const src = await fs.readFile(g, 'utf8')
    const id = /applicationId\s*[=(]?\s*["']([\w.]+)["']/.exec(src)
    if (id && !out.package) { out.package = id[1]; out.versionFile = path.relative(root, g); out.findings.push(`applicationId ${id[1]} in ${out.versionFile}`) }
  }
  const javaRoots = await findDirs(root, d => /(^|\/)src\/main\/(java|kotlin)$/.test(d), 6)
  for (const r of javaRoots) {
    // Descend to the first directory that has code in it, so the index root is tight.
    let cur = r
    for (let i = 0; i < 6; i++) {
      const entries = await fs.readdir(cur, { withFileTypes: true })
      const files = entries.filter(e => e.isFile() && /\.(kt|java)$/.test(e.name))
      const dirs = entries.filter(e => e.isDirectory())
      if (files.length || dirs.length !== 1) break
      cur = path.join(cur, dirs[0].name)
    }
    out.sourceRoots.push(path.relative(root, cur))
  }
  const res = await findDirs(root, d => /(^|\/)src\/main\/res$/.test(d), 6)
  const lkey = out.sourceRoots.length ? await grepAny(path.join(root, out.sourceRoots[0]), /=\s*LKey\s*\(/) : false
  if (lkey) {
    out.strings = { resolver: 'lkey', langs: ['he', 'en', 'es'], files: '/l10n/|Strings\\.kt$' }
    out.findings.push('LKey(he/en/es) string registry detected → resolver "lkey"')
  } else if (res.length) {
    out.strings = { resolver: 'android-xml', resDirs: res.map(r => path.relative(root, r)) }
    out.findings.push(`res/ with strings.xml → resolver "android-xml" (${res.length} dir${res.length > 1 ? 's' : ''})`)
  } else {
    out.strings = { resolver: 'none' }
    out.findings.push('no string registry found → on-screen text will not resolve to source')
  }
  out.appName = out.package.split('.').pop() || ''
  return out
}

export function renderConfig(d) {
  const cfg = {
    package: d.package || 'com.example.app',
    appName: d.appName || 'App',
    sourceRoots: d.sourceRoots,
    strings: d.strings,
    versionFile: d.versionFile,
    signInLabels: DEFAULTS.signInLabels,
    port: DEFAULTS.port,
    adb: 'auto',
    avd: '',
    stt: { model: 'gpt-4o-transcribe', language: '' },
  }
  return JSON.stringify(cfg, null, 2) + '\n'
}

const SKIP = new Set(['node_modules', 'build', '.git', '.gradle', 'dist', 'out', '.idea'])
async function findFiles(root, pred, depth, out = []) {
  if (depth < 0) return out
  let entries = []
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = path.join(root, e.name)
    if (e.isDirectory()) await findFiles(p, pred, depth - 1, out)
    else if (pred(e.name)) out.push(p)
  }
  return out
}
async function findDirs(root, pred, depth, out = []) {
  if (depth < 0) return out
  let entries = []
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue
    const p = path.join(root, e.name)
    if (pred(p)) out.push(p); else await findDirs(p, pred, depth - 1, out)
  }
  return out
}
async function grepAny(dir, re) {
  const files = await findFiles(dir, f => f.endsWith('.kt'), 8)
  for (const f of files.slice(0, 400)) { try { if (re.test(await fs.readFile(f, 'utf8'))) return true } catch {} }
  return false
}
