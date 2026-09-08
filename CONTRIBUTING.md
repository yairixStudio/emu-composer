# Contributing

Issues and pull requests are welcome. A few things that keep this project honest:

- **No dependencies at runtime.** The server is plain Node ≥ 20; the page is one HTML file.
  A PR that adds a framework needs a reason the README can state in one sentence.
- **Measure before optimizing, drill before calling something stable.** The agent lifecycle
  exists because a wedge was reproduced with `kill -STOP`, not because one was imagined.
- **Every rule carries its scar.** A comment that forbids something says what happened when
  it was done (date and symptom). Rules without one get simplified away.
- Run `npm run check && npm test` before pushing. CI runs the same.

To try a change against a real emulator: `node bin/emu-composer.js run` inside a project
with an `emu-composer.json` (`emu-composer init` writes one).
