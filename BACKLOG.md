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
- status: dropped
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90k
- details: README.md's "Two modes, one toggle (⌘E)" section (~line 162) and the "Jem" callout (~line 141) describe a 3-way collect/use/jem mode switcher and a single ⌘E toggle. src/ui/index.html now exposes two independent on/off switches ("Use" / "Collect", both can be on together at once; at least one is always on) instead — internally still the same collect/use/jem behaviour (both-on = the old "jem"), just no longer a single named "mode" or a UI-visible "Jem" label. Update README's description of the control surface (mode buttons → the two switches; ⌘E's role; drop "Jem" as a UI name, keep it only if referring to the combined behaviour) to match. The underlying behaviour descriptions (what collect/use/both do) are still accurate and don't need to change. Done when README no longer shows a 3-button mode selector or implies ⌘E is *the* way to switch, and matches the two-switch UI in src/ui/index.html.
- result: 2026-09-29 · backlog/readme-mode-terminology-stale-after-the · ה-README מתאר עכשיו את שני המתגים הנפרדים (שימוש/איסוף) שקיימים ב-UI במקום בורר תלת-מצבי ישן וכפתור ⌘E יחיד; "Jem" נשאר רק כשם להתנהגות המשולבת. · 47k

## Fix t-shadowing bug in sendSegment() status message
- status: done
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90000
- details: src/ui/index.html, dictation section, sendSegment(): const t = (d.text || '').trim() shadows the outer i18n function t(k,...) within the same try block. The success-path line 'if (recOn) setStatus(t("st_rec"), "busy")' then calls the local string as a function, throws, and is swallowed by the catch block (whose own setStatus(t("st_stt_fail", e.message), "err") reads the correct outer t since it's a separate block) — so after every segment that transcribes fine WHILE STILL RECORDING, the status line wrongly flashes a transcription-failed message even though the text was inserted correctly. Fix: rename the local const t to something like txt (and update its few uses in that block: the empty check, lastTranscript concat, the uilog('transcript',...) call, and placeTranscript's second argument). Done when: dictation while recOn=true no longer shows a spurious failure status after a successful segment, and npm run check && npm test stay green.
- result: 2026-09-29 · תוקן בתוך שכתוב ההכתבה (ספקי תמלול + תמלול חי) — המשתנה המקומי שונה ל-text, ההודעה המזויפת "תמלול נכשל" נעלמה

## Fix 'emu-composer help' crash (TypeError on undefined.catch)
- status: dropped
- added: 2026-09-29
- priority: 3
- complexity: low
- tokens: 90000
- details: bin/emu-composer.js: commands.help is a plain (non-async) arrow function '() => say(...)', which returns undefined (console.log's return value). The CLI dispatcher always does commands[cmd]().catch(e => die(e.message)), and calling .catch on undefined throws 'Cannot read properties of undefined (reading catch)', so 'emu-composer help' crashes with a stack trace instead of printing usage. Reproduces on a clean checkout (verified with git stash before any other change), unrelated to any other work. Fix: either make help return Promise.resolve() (e.g. 'async () => say(...)'), or change the dispatcher's last line to Promise.resolve(commands[cmd]()).catch(e => die(e.message)) so every command handler works whether or not it's async. Done when: 'node bin/emu-composer.js help' prints the usage block and exits 0, and npm run check && npm test stay green.
- result: 2026-09-29 · backlog/fix-emu-composer-help-crash-typeerror-on · הפקודה emu-composer help כבר לא קורסת: היא מדפיסה את מסך העזרה ויוצאת תקין. התיקון מגן גם על פקודות סינכרוניות שיתווספו בעתיד. הבדיקות עוברות. · 37k

## Live dictation: measure streaming, consider gpt-live-transcribe
- status: dropped
- added: 2026-09-29
- priority: 2
- complexity: medium
- tokens: 200k
- details: The realtime provider (src/ui/index.html rtConnect/rtEvent, src/server.mjs sttSession) uses gpt-4o-transcribe with server VAD. Whether its deltas arrive WHILE speaking or only after each pause closes the utterance was not measured (headless test had no mint budget left). After a few real recordings read the journal: `emu-composer log --grep rt_utterance` → field `beforeCommit` (true = words streamed mid-speech) and `firstDeltaMs`/`finalMs`. If beforeCommit is always false, evaluate OpenAI's gpt-live-transcribe (docs: turn_detection must be null, client commits turns, `languages`/`delay` params) as a realtime model: commit on the meter's own pause detection (SILENCE_MS) instead of server VAD; today sttSession refuses any model outside gpt-4o-transcribe / gpt-4o-mini-transcribe / whisper-1 and the page falls back to per-pause. Also unverified: whether a manual `input_audio_buffer.commit` under server_vad is accepted (rtBreak journals `seg-break … commit:true` and any refusal as `rt_error`). Done when the measurement is recorded here and, if worth it, live-transcribe is selectable with text appearing mid-sentence.
- result: 2026-09-29 · אפשר לעשות כמה הקלטות אמיתיות קצרות עם השרת המעודכן (gpt-live-transcribe) ואז להריץ emu-composer log --grep rt_utterance? צריך לבדוק שמופיע beforeCommit:true ושאין rt_error, ואז לסגור את המשימה.

## Local server accepts cross-origin POSTs (no Origin/Host check)
- status: dropped
- added: 2026-09-29
- priority: 2
- complexity: low
- tokens: ~100k
- details: src/server.mjs listens on 127.0.0.1 but never checks the Origin/Host header, so any website open in the same browser can blindly POST to http://127.0.0.1:<port>/api/* (tap/type on the device, run, mint an STT session, spend the OpenAI key). Responses are not readable cross-origin (no CORS headers), but the side effects happen. Reject requests whose Origin is present and not the server's own origin, and whose Host is not 127.0.0.1/localhost:<port> (DNS-rebinding). Done = a test that a foreign Origin gets 403 on POST /api/input and /api/stt/session.
- result: 2026-09-29 · backlog/local-server-accepts-cross-origin-posts · השרת המקומי דוחה עכשיו (403) בקשות עם Origin זר או עם Host שאינו מקומי, כך שאתר אחר בדפדפן כבר לא יכול להפעיל הקשות, הרצות או סשני STT. ה-UI וה-CLI ממשיכים לעבוד. כדאי לפתוח פעם אחת את ה-UI בדפדפן ולוודא שהוא עובד. · 45k

## Hosted Claude run: live status in the activity log
- status: proposed
- added: 2026-09-30
- priority: 2
- complexity: medium
- tokens: 150000
- details: src/server.mjs followHosted() (added with src/claudehost.mjs) stops watching a hosted Claude Code run once the Claude app opens it. Keep watching each hosted session (tmux socket claude-sessions, session cc-<id>) while its tmux session lives: read the registry entry ~/.claude/sessions/<pid>.json matched by sessionId (field status: busy/idle/waiting…) every ~2 s and broadcast({type:'run', session, stage:'busy'|'idle'|'waiting'|'closed'}) so runHostEvent() in src/ui/index.html updates the same activity-log row (working… / waiting for you / done / closed). On daemon start, rediscover live sessions with tmux -L claude-sessions list-sessions -F '#{session_name}' and resume watching them. Unit-test the status mapping with fixture registry JSON in test/claudehost.test.mjs. Done when npm test and npm run check pass and a hosted run's row changes from working to done without reloading the page.
- result:

## Run: permission-mode picker for Claude Code
- status: proposed
- added: 2026-09-30
- priority: 3
- complexity: low
- tokens: 60000
- details: Settings > Models in src/ui/index.html has 'Where Claude Code opens' (#mHost). Add a sibling select 'Claude Code permission mode' (#mPerm, enhanceSelect like #mHost): options default (empty = the CLI's own default, sends nothing), plan, acceptEdits, auto; stored in localStorage emucomposer.agent.perm, sent with /api/run as perm. In src/server.mjs runInAgent(), for agent 'claude' only and only when perm is one of those values, add --permission-mode <perm> to the claude command line for BOTH the Terminal script and hostedExec's extra args (before the prompt argument, never directly after a multi-value flag). he+en strings. Done when npm run check and npm test pass and a dryRun /api/run with perm=plan returns a script containing --permission-mode 'plan' before "$(cat …)".
- result:

## Run: send a follow-up into the running Claude session
- status: proposed
- added: 2026-09-30
- priority: 2
- complexity: medium
- tokens: 200000
- details: Needs the owner watching (it types into live sessions shown in the Claude app and on the phone). Next to Run, a 'send to the open session' action that pastes the composed prompt into the last hosted session (tmux -L claude-sessions, cc-<id>, see src/claudehost.mjs) with load-buffer + paste-buffer -p, then Enter. Verify first, live: Hebrew intact after paste; a long paste is submitted, not left as a collapsed placeholder; input sent while Claude is mid-turn is queued not dropped; what happens if the owner types in the app at the same moment; a double click never sends twice. Done when those five checks are written down with results and the action works on a hosted session.
- result:

## Hosted Claude sessions: close idle ones, keep them in the app
- status: proposed
- added: 2026-09-30
- priority: 3
- complexity: medium
- tokens: 150000
- details: Needs a decision from the owner (after how long, and whether to close at all). Hosted runs (src/claudehost.mjs) stay alive until someone types /exit, so each Run leaves a claude process in tmux -L claude-sessions. Option: after N minutes without a transcript write (~/.claude/projects/<slug>/<id>.jsonl, see transcriptPath) and status idle, send /exit then Enter through tmux send-keys; afterwards import it into the app with open claude://resume?session=<id> and ~2 s later open claude://claude.ai/epitaxy/local_<id>. Done when the owner has chosen N and an idle hosted session is closed and still readable in the Claude app.
- result:

## Emulator tools for the Claude session (MCP)
- status: proposed
- added: 2026-09-30
- priority: 3
- complexity: high
- tokens: 400000
- details: Product decision for the owner. Expose the daemon's device abilities (screenshot, UI tree via the agent, tap/type) as an MCP server (HTTP on the daemon's port, or stdio) and pass it to hosted Claude Code runs with --mcp-config, so the session can check its own change on the live emulator. Nothing MCP-shaped exists in the repo yet. Done when a hosted run can call a screenshot tool and gets the current emulator screen.
- result:
