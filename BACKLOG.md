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
- status: done
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90000
- details: src/ui/index.html, dictation section, sendSegment(): const t = (d.text || '').trim() shadows the outer i18n function t(k,...) within the same try block. The success-path line 'if (recOn) setStatus(t("st_rec"), "busy")' then calls the local string as a function, throws, and is swallowed by the catch block (whose own setStatus(t("st_stt_fail", e.message), "err") reads the correct outer t since it's a separate block) — so after every segment that transcribes fine WHILE STILL RECORDING, the status line wrongly flashes a transcription-failed message even though the text was inserted correctly. Fix: rename the local const t to something like txt (and update its few uses in that block: the empty check, lastTranscript concat, the uilog('transcript',...) call, and placeTranscript's second argument). Done when: dictation while recOn=true no longer shows a spurious failure status after a successful segment, and npm run check && npm test stay green.
- result: 2026-09-29 · תוקן בתוך שכתוב ההכתבה (ספקי תמלול + תמלול חי) — המשתנה המקומי שונה ל-text, ההודעה המזויפת "תמלול נכשל" נעלמה

## Fix 'emu-composer help' crash (TypeError on undefined.catch)
- status: proposed
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90000
- details: bin/emu-composer.js: commands.help is a plain (non-async) arrow function '() => say(...)', which returns undefined (console.log's return value). The CLI dispatcher always does commands[cmd]().catch(e => die(e.message)), and calling .catch on undefined throws 'Cannot read properties of undefined (reading catch)', so 'emu-composer help' crashes with a stack trace instead of printing usage. Reproduces on a clean checkout (verified with git stash before any other change), unrelated to any other work. Fix: either make help return Promise.resolve() (e.g. 'async () => say(...)'), or change the dispatcher's last line to Promise.resolve(commands[cmd]()).catch(e => die(e.message)) so every command handler works whether or not it's async. Done when: 'node bin/emu-composer.js help' prints the usage block and exits 0, and npm run check && npm test stay green.
- result:

## Live dictation: measure streaming, consider gpt-live-transcribe
- status: proposed
- added: 2026-09-29
- priority: 2
- complexity: medium
- tokens: 200k
- details: The realtime provider (src/ui/index.html rtConnect/rtEvent, src/server.mjs sttSession) uses gpt-4o-transcribe with server VAD. Whether its deltas arrive WHILE speaking or only after each pause closes the utterance was not measured (headless test had no mint budget left). After a few real recordings read the journal: `emu-composer log --grep rt_utterance` → field `beforeCommit` (true = words streamed mid-speech) and `firstDeltaMs`/`finalMs`. If beforeCommit is always false, evaluate OpenAI's gpt-live-transcribe (docs: turn_detection must be null, client commits turns, `languages`/`delay` params) as a realtime model: commit on the meter's own pause detection (SILENCE_MS) instead of server VAD; today sttSession refuses any model outside gpt-4o-transcribe / gpt-4o-mini-transcribe / whisper-1 and the page falls back to per-pause. Also unverified: whether a manual `input_audio_buffer.commit` under server_vad is accepted (rtBreak journals `seg-break … commit:true` and any refusal as `rt_error`). Done when the measurement is recorded here and, if worth it, live-transcribe is selectable with text appearing mid-sentence.
- result: 2026-09-29 measured on the first real recording: beforeCommit false 10/10, firstDeltaMs ≈ durMs (gpt-4o-transcribe streams nothing before the commit). Implemented: gpt-live-transcribe is the default live model, turn_detection null, the page commits (meter pause; anchor → next gap between words); manual commits accepted (seg-break commit:true, no rt_error). Still to confirm on real speech: rt_utterance beforeCommit:true with gpt-live-transcribe, and that audio buffered before the session was up (rt_buffer_flush) is transcribed (an rt_error with event pre_… = appends refused → per-pause recovers it).

## Local server accepts cross-origin POSTs (no Origin/Host check)
- status: proposed
- added: 2026-09-29
- priority: 2
- complexity: low
- tokens: ~100k
- details: src/server.mjs listens on 127.0.0.1 but never checks the Origin/Host header, so any website open in the same browser can blindly POST to http://127.0.0.1:<port>/api/* (tap/type on the device, run, mint an STT session, spend the OpenAI key). Responses are not readable cross-origin (no CORS headers), but the side effects happen. Reject requests whose Origin is present and not the server's own origin, and whose Host is not 127.0.0.1/localhost:<port> (DNS-rebinding). Done = a test that a foreign Origin gets 403 on POST /api/input and /api/stt/session.
