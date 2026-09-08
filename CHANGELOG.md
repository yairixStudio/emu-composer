# Changelog

## Unreleased
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
