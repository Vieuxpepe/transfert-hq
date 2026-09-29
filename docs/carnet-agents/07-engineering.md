# 07 — Engineering tools / HQ deep links

**Working mode:** edit the existing `C:\Transfert` working tree directly. Do not create/switch branches or worktrees. Do not commit/push unless separately authorized. Never run feature tests against live runtime state; use throwaway roots.

Base: accepted Stage 06 state already present in the same current `main` working tree. Stay on `main`.

Read CONTEXT, TESTS, HANDOFF. Tools stay collapsed/contextual; default paper stays quiet.

Deliver only:
- safe calculator
- curated unit conversion
- calculation blocks
- measurement/tolerance blocks
- Engineering Journal / Session
- decision blocks
- task extraction
- strong HQ links
- optional small image annotation subset only if media is mature

Calculator: explicit grammar/parser. Never \`eval\` or \`new Function\`. Start arithmetic/parentheses/power; add functions only with tests and documented angle convention.

Conversions initial:
mm/in, N/lbf, N·m/lb·ft, bar/psi, °C/°F, kg/lb.
Do not manufacture false precision. Prefer insert adjacent result over replacing original.

Calculation block stores expression/input/result/units/time.

Measurement block: label, observed value/unit, optional nominal/tolerance, time, optional source/photo/drawing link. Compute deviation/in/out when appropriate; label as convenience notebook aid, not certified metrology.

Journal/Session remains note-like, not mandatory form; one-tap \`HH:MM — \`.

Decision block:
\`DÉCISION · time\` + text; searchable/filterable.

Task extraction: selected text -> existing HQ task system only if semantics fit; original text remains; backlink when possible. No second task engine.

HQ links: files, Dessiner, Lecteur, notes, project. Optional "Ajouter une note liée" from other surfaces only if it routes to the one Carnet editor.

Optional annotation: arrow/circle/freehand/dimension/text as structured overlay; do not fork Dessiner.

Tests: parser attack cases, conversion constants/affine temp/precision, tolerance boundaries, persistence, sessions/time, decisions, task link, HQ navigation/back, no arbitrary execution/path, collapsed UI/accessibility/perf.

STOP before history/report extras.

Compact HANDOFF; include current HEAD SHA and working-tree diff status.
