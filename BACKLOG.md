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
