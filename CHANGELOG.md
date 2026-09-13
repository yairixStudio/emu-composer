# Changelog

## Unreleased
- **iOS Simulator.** Booted simulators join the device menu; picking one mirrors it and
  resolves references against the project's `ios` block (bundle id, Swift sources, string
  registry, version file). Screenshots come from `simctl`; the accessibility tree from a new
  on-device agent, `ios/agent/` — a UI-test bundle that attaches to any app by bundle id and
  serves its `XCUIElementSnapshot` over HTTP while `xcodebuild test-without-building` keeps
  it alive (`emu-composer setup-ios-agent` builds it once; XcodeGen project, the
  `lib_TestingInterop.dylib` embed for Xcode 26 runners included). Frames are scaled from
  points to the screenshot's pixels. Taps and typing work through the agent; swipes and
  hardware keys are refused with a message. `# Screen` reports `iOS, simulator`,
  `MARKETING_VERSION` vs the installed `Info.plist`, and `# Errors` reads the unified log for
  the app's process, minus XCTest's own accessibility chatter.
- The `lkey` resolver reads Swift: `extension LStr { enum X { static let k = LKey(he: …) } }`
  → `LStr.X.k`, colon labels, multi-line calls, and the two-level call sites
  (`L(LStr.X.k)`) — verified on a real app: a tab label on the simulator resolved to its
  Swift definition and its `TabModel.swift` render site. Swift sources are walked for usages
  and literals.
- `init` detects an XcodeGen `project.yml` next to the Android project and writes the `ios`
  block. `doctor` reports the iOS agent build and the booted simulators.
- Fixed: `emu-composer` booted an arbitrary Android AVD ("first in the list") when adb had no
  device — even with an iOS simulator already up. A booted simulator now counts as a device.
- Fixed: a device chosen at startup skipped the switch path, so its kind and caches disagreed
  with its agent (the iOS agent was asked for a uiautomator dump).
- **Many projects, one daemon.** The server holds a registry of projects, each with its own
  config, string index and `.emu-composer/` directory; the active one is picked from a
  dropdown beside the device menu. `emu-composer` in a second project registers it with the
  running server and switches, instead of failing on a busy port — the page keeps its draft.
  The registry lives in `~/.config/emu-composer/projects.json` and survives a restart; a
  config that has since moved is dropped with a line in the log. A bare `emu-composer` from
  a directory with no config opens whatever is active.
- The prompt's `# Screen` block opens with `project:` — name, absolute path, and which
  agent-rule files the repo carries (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …), so an
  agent handed the prompt knows where to work and which conventions apply.
- **`# Errors`** (opt-in checkbox): error-level logcat plus the crash buffer, filtered to the
  app by pid, stack frames kept with their header, identical repeats collapsed to one line
  and a count. Fetched only while the box is ticked. Parsing lives in `src/logcat.mjs` with
  tests — a silent parse failure would read as "no errors", the most misleading possible
  answer.
- **`# Path`** (opt-in checkbox): the screens walked in this session, recorded from captures
  and from the collect-mode watch. A screen with no header and no selected tab is named
  after its heading (ranked by reading order and shortness — the biggest text on a screen is
  usually a banner, not a title), and failing that after its activity, so the path has no
  holes.
- **A problem bar** above the screen: no device, the app not installed on this one, the app
  not in front (with **Launch**), the installed build not matching the repo, the agent off.
  Silence and a stale screenshot used to look identical. `doctor` prints the same list.
- Launching the app asks the package manager for the launcher component (`cmd package
  resolve-activity --brief`) and starts that. `monkey -p …` — the recipe every guide gives —
  exits non-zero on apps whose launcher activity it cannot match; it is now the fallback.
- Fixed: registering the boot project before reading the registry overwrote it, so every
  other project was lost on restart.
- Collect mode follows the device: while a page is in collect, the server polls the UI tree
  through the agent (0.7 s, no screenshot), hashes it without the status bar, and pushes a
  `screen` event over SSE; the page re-captures on its own. Driving the emulator window
  itself used to leave the composer on a stale still until the next manual action.
- Marks: pen, box and arrow (three colours) drawn over the screen in collect mode. Each is a
  `@mark` chip; the prompt gets a `# Marks` section with bounds, the elements the mark
  covers (an arrow: what it points from and to) and the path of the screenshot with the
  numbered marks burned in, written to `.emu-composer/marks/` as marks come and go.
- A line of dashes in the prompt splits it into numbered items (`## 1`, `## 2`…), so an
  agent treats five asks as five.
- Coordinates come from the display size, not the first window in the dump: with a dialog
  open every hit test, bound and crop was 1.28× off. The hit test no longer climbs to a
  node that covers most of the screen (a photo used to resolve to the page around it).
- Several emulators: a device menu above the screen; each device keeps its own agent.
  `adb track-devices` streams changes to the page over SSE, so an emulator that boots, dies
  or comes back is picked up within a second in either mode; the last device chosen by
  hand is preferred when it returns. Switching away from a dead emulator no longer waits on
  adb timeouts (AVD names cached, one 0.8 s probe).
- Settings panel (⚙): interface language Hebrew/English, dictation language, OpenAI key,
  agent notes, text direction. The whole page is translated; the choice persists.
- Region words come from the display size, not the first window in the dump (everything
  read "bottom bar" when the status-bar window came first).
- Row-consistent ranking: keys and call sites are ranked by what the element's siblings
  resolved to; CarPlay/widget/AI/notification surfaces never win for an on-screen element.
- Screen title = selected bottom tab › header; never an amount or a time. Each element
  block carries `screen:`, and the prompt lists the screens when they differ.
- Hit test climbs from a bare icon to the tab that owns it; ⌥ picks the raw node. The
  server's title becomes the chip label (`@מקומות`, not `@View`). Checkable chips are
  "selectable chip", tab containers are "tab" / "selected tab".
- Chips are inline boxes on the sentence's baseline at the sentence's size (they floated
  above the line before), and a Hebrew label no longer pushes the `@` to the wrong side.
- The reference now lives on the chip element (`data-ref`); the in-memory map is a cache
  rebuilt from the DOM. A long prompt once copied as bare text because chips had lost
  their map entries — the copy now warns if any chip has no data instead of dropping it.
- "Copy full prompt" confirms on the button; copy/cut of chips carries full references and
  pastes back as chips.

## 0.1.0 — 2026-09-08
First public release. Extracted from a project-internal tool after a week of daily use.

- Collect / use modes over a live emulator view; `@element` chips resolved to source.
- Two string registries: standard `res/values*/strings.xml` and Kotlin `LKey(...)` objects.
- On-device agent (uiautomator2's `u2.jar`) for 0.2 s dumps, JPEG frames, Unicode input;
  self-healing lifecycle (drilled with SIGSTOP / kill -9 / repeated restarts).
- Dictation with pause-based segmentation and caret-anchored interim markers (OpenAI).
- `emu-composer init | run | setup-agent | install-app | bar | doctor`.
- macOS: Spotlight/Dock launcher app; floating bar that docks to the emulator window.
