# 08 — History / bulk ops / reports / backlinks / final hardening

Base accepted Stage 07. Branch \`feat/carnet-history-reports\`.

Read CONTEXT, TESTS, HANDOFF.

Version history behind overflow. Avoid snapshot-per-keystroke explosion; meaningful consolidated checkpoints/events. Restore creates new current revision and retains later history.

Reusable bulk flow:
scope → affected count → preview → confirm → revision-aware apply → Undo → one logical history event.
Use for multi-note replace, context moves, source migration, archive/trash, linked-file replacement. Partial failure must be explicit.

Backlinks: show \`Liée depuis…\`; avoid expensive rebuild every input.

Optional QR: note/project safe HQ reference only; never PIN/session/secret; scan still authenticates normally.

Report assembly: select project notes/measurements/photos/decisions/sources; ordered Markdown + print/PDF. Preserve citations/source content. Never auto-author engineering conclusions.

Final profile/audit:
- input latency
- near-limit search
- many citations/images
- WebKit memory
- viewer transitions
- accessibility/reduced-motion/keyboard/touch
- local-draft privacy
- backup/recovery
- logs/path/CSP/CSRF

Stress-ish tests at 128 pages, near 1 MiB text, many contexts/citations/images, history policy, bulk replace/undo, report, backlinks, QR secret absence.

Final report separates automation, desktop, WebKit, physical iPhone/iPad, remaining risks.

Compact HANDOFF.
