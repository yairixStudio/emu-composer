# Backlog

משימות קטנות ולא דחופות של הפרויקט. סוכן "קציר המכסה" (`harvest-quota`) מבצע משימות במצב `open` לפני האיפוס השבועי של מכסת קלוד, על ענף `backlog/*` נפרד, בלי push — ומחכה לאישור שלך למיזוג. הצעות (`proposed`) לא רצות בלי "כן" ממך.

<!--
Format: one task per "##" section, one "- key: value" per line. Keys in English, values in any language.
status:     open · proposed · blocked · done · dropped
added:      YYYY-MM-DD
priority:   1 high · 2 normal · 3 low
complexity: low · medium · high   (picks the model: low→Sonnet, medium→Opus, high→Fable)
tokens:     rough estimate of total agent tokens incl. ~60k fixed overhead (low ≈ 100k, medium ≈ 200k, high ≈ 400k)
details:    what to do and what counts as done; name files/areas
result:     filled by the agent — date · branch · what changed (Hebrew, for the owner) · actual tokens
-->

## README: mode terminology stale after the toggle-switch UI change
- status: open
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90k
- details: README.md's "Two modes, one toggle (⌘E)" section (~line 162) and the "Jem" callout (~line 141) describe a 3-way collect/use/jem mode switcher and a single ⌘E toggle. src/ui/index.html now exposes two independent on/off switches ("Use" / "Collect", both can be on together at once; at least one is always on) instead — internally still the same collect/use/jem behaviour (both-on = the old "jem"), just no longer a single named "mode" or a UI-visible "Jem" label. Update README's description of the control surface (mode buttons → the two switches; ⌘E's role; drop "Jem" as a UI name, keep it only if referring to the combined behaviour) to match. The underlying behaviour descriptions (what collect/use/both do) are still accurate and don't need to change. Done when README no longer shows a 3-button mode selector or implies ⌘E is *the* way to switch, and matches the two-switch UI in src/ui/index.html.
- result:

## Fix t-shadowing bug in sendSegment() status message
- status: proposed
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90000
- details: src/ui/index.html, dictation section, sendSegment(): const t = (d.text || '').trim() shadows the outer i18n function t(k,...) within the same try block. The success-path line 'if (recOn) setStatus(t("st_rec"), "busy")' then calls the local string as a function, throws, and is swallowed by the catch block (whose own setStatus(t("st_stt_fail", e.message), "err") reads the correct outer t since it's a separate block) — so after every segment that transcribes fine WHILE STILL RECORDING, the status line wrongly flashes a transcription-failed message even though the text was inserted correctly. Fix: rename the local const t to something like txt (and update its few uses in that block: the empty check, lastTranscript concat, the uilog('transcript',...) call, and placeTranscript's second argument). Done when: dictation while recOn=true no longer shows a spurious failure status after a successful segment, and npm run check && npm test stay green.
- result:

## Fix 'emu-composer help' crash (TypeError on undefined.catch)
- status: proposed
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90000
- details: bin/emu-composer.js: commands.help is a plain (non-async) arrow function '() => say(...)', which returns undefined (console.log's return value). The CLI dispatcher always does commands[cmd]().catch(e => die(e.message)), and calling .catch on undefined throws 'Cannot read properties of undefined (reading catch)', so 'emu-composer help' crashes with a stack trace instead of printing usage. Reproduces on a clean checkout (verified with git stash before any other change), unrelated to any other work. Fix: either make help return Promise.resolve() (e.g. 'async () => say(...)'), or change the dispatcher's last line to Promise.resolve(commands[cmd]()).catch(e => die(e.message)) so every command handler works whether or not it's async. Done when: 'node bin/emu-composer.js help' prints the usage block and exits 0, and npm run check && npm test stay green.
- result:
