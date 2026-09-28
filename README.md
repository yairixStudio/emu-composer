# emu-composer

> Point at the button. Get the line of code. Say what's wrong. Paste.

Coding agents are good at changing an Android app once they know *which* element you mean.
Telling them is the slow part: you describe a button in words, they grep for it, you correct
them. emu-composer removes that round trip. It puts a prompt box next to a live Android
emulator; every click on the screen drops an `@reference` into your text that carries the
element's role and position, the **string resource and the source line that render it**, and
the state of the device, build and repo. You write around the references — or dictate — and
copy one prompt that an agent can act on without asking where anything is.

```
npx emu-composer init          # in your Android project: detects package, sources, strings
npx emu-composer               # boots an AVD if needed, starts the server, opens the page
```

<img src="docs/composer.png" width="900" alt="The composer: a live emulator on the left with an element highlighted, a prompt on the right with two @reference chips inline">

*Left: the emulator, live. Right: the prompt. The chips are references; the block each one
expands to is below.*

## What a reference looks like

```
### @ui1 — "Schedule"  (label of the selected tab)
what:     label of the selected tab · TextView · bottom bar, centre · 3 of 5 in its row
screen:   Schedule
bounds:   [485,2259]→[595,2289] (110×30px)
state:    selected (the container is the selected one)
tap:      its container View [441,2127]→[640,2337] — currently selected, so it has no click action
copy:     R.string.tab_schedule (on screen: default)
          default "Schedule" · he "לוז" · es "Agenda"
          defined app/src/main/res/values/strings.xml:14
rendered: app/src/main/java/com/example/ui/RootScreen.kt:401
          Text(stringResource(R.string.tab_schedule))
also:     ui/guest/GuestShell.kt:601, ui/UsageGuideScreen.kt:278
```

The full prompt is `# Task` (your text, with `@ui1`… inline) → `# Elements` (one block per
chip) → `# Screen` (**project, path on disk and which agent-rule files the repo carries**,
then app, build, device, repo, session — nothing guessed; derived facts say so) → optionally
`# Path` and `# Errors` → `# Notes for the agent` (three lines of project convention,
generated from your config). Copy it with `⌘↩`.

Text the app builds at runtime resolves to nothing; the block says so and names the nearest
text that *does* resolve as an anchor. Printf-shaped copy template-matches (`"Error (404)"`
→ `error_with_status`). A label inside a button reports the button as its `tap:` target.
Compose's selected tab has no click action — the block says that too, rather than "not
tappable". Keys that share the same copy are ranked by the row they sit in: when four
sibling tabs resolved to `LShell.*` in `RootScreen.kt`, the fifth is theirs too — never the
CarPlay or widget variant. Each block names the screen it was picked on, and the prompt says
when elements come from several screens.

## Every project you have open, one daemon

The server is not tied to the repo it was started from. `npx emu-composer` in a second
project **registers** that project with the one already running and switches to it: the page
keeps its draft, its history and its device, while the sources a reference resolves against,
the string registry, the version file and the agent notes all change together. The project
is switched **by hand**, from a dropdown beside the device menu — pointing at app A while
thinking about repo B is normal, so nothing is guessed from what happens to be in front.

Registered projects are remembered in `~/.config/emu-composer/projects.json` and are back in
the dropdown the next time the daemon starts. `emu-composer` from a directory with no config
at all opens whatever is active instead of refusing.

## When something is wrong, it says so

A composer that cannot reach the app looks exactly like one waiting for you: a still image.
A bar above the screen names the problem instead, with the button that fixes it — the app is
not installed on this device; it is not the app in front (**Launch**); the installed build is
not the version the repo declares; adb has no device; the agent is off, so captures take
2.5 s (**Start agent**). `emu-composer doctor` prints the same list.

## Two optional sections in the prompt

Two checkboxes beside the prompt, off by default, because each is noise on a prompt about a
colour and gold on a prompt about a bug:

- **Errors** — the device's own account of what went wrong: error-level logcat and the crash
  buffer, filtered to this app by pid, with stack frames kept and identical repeats collapsed
  to one line and a count. Fetched only while the box is ticked.
- **Path** — the screens walked in this session (`Places › Wallet › Expense details`), so an
  agent can reproduce the state rather than guess at it. A screen with no header and no
  selected tab is named after its heading rather than left out.

## The iOS Simulator, too

The same page, the same chips, the same prompt — against a booted iOS Simulator. Add an
`ios` block to `emu-composer.json` (`init` writes one when it finds an XcodeGen `project.yml`
beside the Android project):

```jsonc
"ios": {
  "bundleId": "com.example.app",
  "sourceRoots": ["ios/Sources/App"],
  "strings": { "resolver": "lkey", "langs": ["he","en","es"], "files": "/Localization/" },
  // or, for Apple's own formats:  { "resolver": "xcstrings" }   — String Catalogs + <lang>.lproj/*.strings
  "versionFile": "ios/project.yml"           // MARKETING_VERSION vs the installed Info.plist
}
```

Booted simulators appear in the device menu beside the emulators. Picking one switches the
sources a reference resolves against to the Swift side: the `lkey` resolver reads
`extension LStr { enum Shell { static let tabSchedule = LKey(he: …, en: …) } }` and finds the
`L(LStr.Shell.tabSchedule)` call site, so a chip on a simulator lands on `TabModel.swift:24`
the way a chip on an emulator lands on `RootScreen.kt:401`. Apps without a registry use the
`xcstrings` resolver: it reads String Catalogs (`Localizable.xcstrings`, every language and
plural branch) and legacy `.lproj/*.strings` tables, where the key is usually the English copy
itself — so `Text("Welcome back")` is the call site and the Hebrew on screen resolves to it.
`# Screen` says `iOS, simulator`,
`# Errors` reads the unified log (`log show`, error and fault levels, this app's process), and
the version warning compares `MARKETING_VERSION` with the installed build.

**The tree needs an agent, like Android's.** `simctl` has screenshots but no accessibility
tree, so the tree comes from a UI-test bundle (`ios/agent/`) that attaches to any app by
bundle id and serves its `XCUIElementSnapshot` over HTTP for as long as
`xcodebuild test-without-building` keeps it alive — the simulator twin of `u2.jar`. Built once:

```
npx emu-composer setup-ios-agent   # Xcode + XcodeGen (brew install xcodegen); a few minutes
```

**The screen and the touch skip XCUITest: `simbridge`.** A small Objective-C helper
(`ios/simbridge/simbridge.m`, built with `clang` on first use and cached per Xcode build) talks
to CoreSimulator directly, the way Meta's idb does:

- **Screen** — it registers for the simulator's own framebuffer (an IOSurface, one callback per
  presented frame, nothing when the screen is still), scales it on the GPU and encodes it with
  VideoToolbox as low-latency H.264. The page decodes it with WebCodecs — the path Android
  emulators already use. A still (capture, the crisp frame after motion) is the framebuffer as
  JPEG: ~10-30 ms, where `simctl io screenshot` took ~400.
- **Touch** — it connects to the guest's `dtuhidd` digitizer over XPC and sends start /
  position / end contacts. `use` mode streams the pointer as it moves, so a drag is a real drag
  and a list keeps its momentum; a press that starts on the screen's edge carries that edge, so
  the system gestures (back from the left, home from the bottom) work too.
  Touch to first changed frame measured 29-50 ms; through the XCUITest runner it was hundreds.
- HOME is the hardware button, BACK the left-edge swipe, RECENTS a double HOME press (the
  switcher, as in Simulator.app).
- **Jem** keeps a click for anchor-then-tap; once the pointer travels like a drag, the finger
  goes down where the press began and follows it, over the live picture.

Typing, ENTER/DEL/ESC and the element tree stay with the runner. When `simbridge` cannot start
(an Xcode whose private interfaces moved), everything falls back to the runner and `simctl`: a
swipe is a press-and-drag whose speed follows the gesture, BACK the interactive-pop drag from
the leading edge. Frames arrive in points and are scaled to the screenshot's pixels, so bounds
in the prompt are pixels on both platforms.

## One screen, two platforms, one prompt

The reason the simulator is here at all. Pick elements on the simulator, switch the device
menu to the emulator, pick the same elements there, write the task once: the prompt comes out
with `@ios1 @ios2 …` and `@android1 @android2 …` (never a shared `@ui` numbering), an
`# Elements` section split into `## iOS` and `## Android` — each chip resolved against ITS
platform's sources, `TabModel.swift:24` beside `RootScreen.kt:401` — a `# Screen (iOS)` and a
`# Screen (Android)` block, and agent notes that name both code roots and both string
registries and say to keep the two implementations in step. Chips in the editor show which
device they came from the moment a second platform appears; a single-platform prompt is
exactly what it was before.

## Two modes, one toggle (`⌘E`)

| | a click… | also |
|---|---|---|
| **collect** | inserts a chip for the element under the cursor | right-click taps the device without leaving collect · ⇧wheel scrolls it |
| **use** | goes to the device — taps, drags, wheel, keyboard | any character, including RTL scripts |

Collect mode is not a still: while the page is in collect, the server polls the UI tree
through the agent and the page re-captures the moment the screen changes — drive the
emulator window itself and the composer follows.

**Marks.** Pen, box or arrow, in three colours, drawn over the screen in collect mode. A
drawing is a reference like an element: it enters the prompt as `@mark1` and expands to its
bounds, the elements it covers (an arrow: what it points from and to) and the path of the
screenshot with the numbered marks burned in, saved under `.emu-composer/marks/` — so the
agent can open the picture. A line of dashes (`--`) between paragraphs turns the prompt
into numbered items (`## 1`, `## 2`…).

Several emulators running? The menu above the screen picks the one to mirror; each keeps
its own agent. Devices that boot, die or return are noticed within a second (adb
`track-devices` behind a server-sent-events feed) in either mode, and the composer moves to
the best remaining one on its own. The ⚙ panel holds the interface language (Hebrew /
English), the dictation language, the OpenAI key, agent notes and text direction.

The prompt box is a normal rich-text field: select, cut, paste, undo, RTL/LTR. A chip is one
reference — click it to copy that reference alone, hover it to see the element, delete it
and its block leaves the prompt. Drafts survive a reload; every copied prompt goes to a
history.

**Dictation** (`⌘⇧R`): segments are cut at pauses, not on a timer, so words are not split;
an interim marker goes in at the caret the moment a segment is cut and the transcript
replaces it, so text lands where the caret *was* even if you kept typing. Needs an OpenAI
key, entered once in the page and stored at `~/.config/emu-composer/openai-key` (mode 600) —
the page never receives it back.

## Why it is fast: the on-device agent

`uiautomator dump` costs **2.5 s per call** — a fresh JVM every time, a fixed cost no screen
state changes. The optional agent (uiautomator2's `u2.jar`, run with `app_process` and spoken
to over JSON-RPC through an adb forward) changes the numbers:

| | `uiautomator dump` | agent |
|---|---|---|
| tree dump | 2.5 s | 0.2 s |
| frame | 0.13 s PNG | 0.05 s JPEG |
| tap / swipe / key | ~0.1 s each | ~50 ms |
| text | ASCII only | any Unicode (clipboard + paste) |

```
npx emu-composer setup-agent   # once; pip-installs uiautomator2 into an isolated venv and
                               # copies the jar out. Nothing else is downloaded, ever.
```

Without the jar everything works on the slow path and the **AGENT** pill says so. With it,
the lifecycle is self-healing — drilled, not assumed: a wedged agent (`kill -STOP`) costs one
slow capture and then comes back by itself; a killed one (`kill -9`) is back in seconds with
no request in flight; three server restarts in a row all land on the fast path. Teardown is
SIGTERM first, SIGKILL after 1.5 s: a storm of SIGKILLed UiAutomation clients once left an
emulator's AccessibilityManagerService dead, and only a reboot fixed it.

## Opening it later

- `npx emu-composer` from the project. Idempotent: a running server is reused, so an open
  composer keeps its draft.
- **macOS:** `emu-composer install-app` writes *"<App> Composer.app"* to `~/Applications` —
  Spotlight finds it, the Dock can hold it, and it boots the AVD when none is running.
- **macOS:** `emu-composer bar` builds and starts a small floating bar that docks itself to
  the emulator window (the standalone emulator's `qemu-system-*` window) and follows it: one
  button, a status dot, a menu-bar icon to hide/show it. `--login` adds it to Login Items.

## Configuration — `emu-composer.json`

`init` detects the usual layout. Everything is overridable:

```jsonc
{
  "package": "com.example.app",            // applicationId (required)
  "appName": "Example",
  "sourceRoots": ["app/src/main/java/com/example"],
  "strings": { "resolver": "android-xml", "resDirs": ["app/src/main/res"] },
  // or, for a Kotlin string registry:  { "resolver": "lkey", "langs": ["he","en","es"], "files": "/l10n/|Strings\\.kt$" }
  "versionFile": "app/build.gradle.kts",   // declared version vs. installed — mismatch is a WARNING line
  "signInLabels": ["sign in", "log in"],   // how the session line is derived
  "notes": null,                           // agent notes; null = generated from this file
  "port": 7788, "adb": "auto", "avd": "",
  "stt": { "model": "gpt-4o-transcribe", "language": "" }
}
```

Two string registries are understood today: standard `res/values*/strings.xml` (keys become
`R.string.x`; `@string/x` in layouts counts as a call site) and Kotlin objects of
`LKey(lang = "…")` values. Adding another is one class in `src/resolve.mjs`.

## Status

0.1.0 — extracted from a project-internal tool after daily use; see the
[changelog](CHANGELOG.md).

- [x] Collect / use modes, chips, full prompt, history, drafts
- [x] android-xml, lkey and xcstrings (String Catalogs / .strings) resolvers with tests
- [x] On-device agent with a drilled self-healing lifecycle
- [x] Dictation (OpenAI) with pause segmentation and caret anchoring
- [x] macOS launcher app and floating bar
- [x] Many projects in one daemon, switched by hand
- [x] Optional `# Errors` (logcat + crashes) and `# Path` (screens walked) sections
- [x] A problem bar that names what is wrong, with the button that fixes it
- [x] iOS Simulator — collect, tap, type, swipe and keys through a UI-test agent
- [x] iOS live screen (framebuffer → H.264) and direct touch (dtuhidd), no XCUITest in the loop
- [x] One prompt for the same screen on both platforms (@ios*/@android*, two `# Screen` blocks)
- [ ] Android Studio plugin for the embedded emulator
- [ ] Linux launcher (the server and page already run there)

## Requirements

Node ≥ 20, `adb` (found via `ANDROID_HOME`, `PATH`, or the usual SDK locations), an AVD or a
device. `setup-agent` needs `python3` once. The macOS extras need the Xcode command line
tools (`swiftc`).

## How it works, briefly

`adb` + the accessibility tree give every on-screen node with bounds, text, content-desc and
flags. The tree is rebuilt with parent links so a reference can name the tappable ancestor
and "3 of 5 in its row". On-screen text is looked up by exact value in an in-memory index of
the project's string resources, then followed to every call site of that key, ranked
(renders > maps; a file named after the current screen wins). Frames are polled one at a
time; input goes through one ordered queue and typed characters coalesce into one paste per
burst. No npm dependencies; the page is one HTML file.

## License

MIT. `ios/simbridge/` follows the approach of Meta's idb (FBSimulatorControl), also MIT — its
license is in `ios/simbridge/LICENSE-idb.txt`.
