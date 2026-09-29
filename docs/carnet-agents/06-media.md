# 06 — Note images/media

Base accepted Stage 05. Branch \`feat/carnet-media\`.

Read CONTEXT, TESTS, HANDOFF.

Scope: camera/photos/files, confined media storage, optimized notebook image, inline blocks, resize, caption, export/backup. Full annotation is deferred unless separately approved.

Storage:
\`<ROOT>/.hq-carnet/assets/\`
Binary never in notebook JSON. Page stores generated asset ID/MIME/dimensions/layout/caption.

Initial JPEG/PNG/WebP. HEIC only if proven end-to-end. No client path.
Define/test explicit per-file + total quota; target input cap ~12–16 MiB and notebook long-side downscale ~2560px; total ~250 MiB only if current architecture supports safely.

Upload reuses proven HQ patterns: admin + CSRF, streaming/size guard, magic/signature validation, generated name, atomic finalization, failed-partial cleanup, confined directory.

UI: camera/photos/files. Default inline image between blocks. Resize roughly 30–100% width, preserve aspect ratio. Selection reveals tools. Caption.

Free-position is OPTIONAL and only ships if robust on phone/iPad/desktop/export; use relative coordinates and page bounds. Never default.

Backup/export includes referenced committed assets coherently and excludes temp/partial files. Markdown uses relative asset packaging; print/PDF preserves layout.

Tests: valid types, spoofed MIME/signature, oversize/quota, traversal, interrupted upload, binary absent from JSON, insert/resize/caption/reload/conflict, backup/export, WebKit layout, large-image memory behavior.

STOP before engineering tools/annotation.

Compact HANDOFF.
