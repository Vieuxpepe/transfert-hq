# 02 — Core editor/autosave/conflicts

Base: accepted Stage 01 SHA. Branch: \`feat/carnet-editor\`.

Read: CONTEXT.md, TESTS.md, prior HANDOFF.

Inspect only anchors:
\`\`\`bash
rg -n "VIEW_LABELS|function setView|async function api|bottom-nav|data-panel=|hq-dessiner|hq-calendar" iphone_bridge.py
rg -n "prefers-reduced-motion|@media|max-width: 899|min-width:900|bottom-nav" iphone_bridge.py assets/*.css
\`\`\`

Create \`assets/hq-carnet.js\`, \`assets/hq-carnet.css\`, focused browser/static tests.

## Deliver

First-class Carnet nav immediately after Accueil where layout remains usable. Add panel + assets + guarded \`hqCarnetShow\` hook. Feature failure gets durable in-panel error/retry and never breaks HQ.

Default screen: ~90% paper; no Save/title/modal. >=16px editor, >=44px controls. CSS ruled paper, margin, subtle texture, system fonts only.

Controls: context pill, pin, library placeholder, overflow, previous/page/next, new, copy.

Navigation:
- Alt+Left/Right
- normal arrow caret preserved
- swipe >=60px and \`abs(dx)>1.4*abs(dy)\`
- vertical scroll/text selection never flips
- page switch does not wait on server

Flip: CSS transform only ~200–240ms; temporary aria-hidden ghost; cleanup; reduced motion disables 3D.

## Local draft/auth

Do not read drafts before \`/api/me\` confirms admin.
Key namespace by non-secret username.
Store map by page ID so several dirty pages survive offline.

Every input:
1. generation++
2. synchronously persist draft
3. dirty=true
4. debounce ~450ms

Draft includes rev/content/project/category/pin/generation/time.

localStorage failure => memory state + exact warning:
\`Sauvegarde locale indisponible — ne ferme pas cette page.\`
Never falsely show saved.

## Save queue

One ordinary in-flight save/page.

Capture exact generation/payload/expected rev. On success adopt returned rev.

Clear dirty/draft ONLY if current generation and current payload still equal sent values. Otherwise immediately send newest state against new rev.

Network fail => keep draft/dirty; show:
\`Hors ligne — conservé sur cet appareil\`.

Flush attempt on debounce, blur, hidden, pagehide, page switch, leave Carnet. Use keepalive when compatible with existing CSRF headers. Local draft is the guarantee.

## Conflict

409 never overwrites local editor.
Pause autosave for page.
Show:
\`Modifié ailleurs. Ta saisie est conservée sur cet appareil.\`
Actions:
- Charger la version distante
- Remplacer avec ma version

Keep-local uses CURRENT local payload + latest remote rev; repeated 409 is allowed.

## Remote metadata refresh

Only while Carnet + document visible, roughly 5–12s; choose/document fixed interval. No duplicate timer.
Clean page may adopt remote change. Dirty page never overwritten.
Coordinate poll with own in-flight save.

## Quick actions

Copy selection else full note. Clipboard API + execCommand fallback; restore focus. \`Copié\` / \`Copie impossible\`.

Collapsible symbols:
\`Ø ± ° µ Δ × → ≤ ≥ ² ³\`
Clock inserts \`HH:MM — \` at cursor.

## Tests

Must explicitly reproduce:
- delayed save A, user types B, A returns: B draft survives and B saves against new rev
- multiple dirty pages while flipping offline
- reload draft recovery
- localStorage exception
- upload role cannot read admin draft
- two contexts same page 409 + both resolution choices
- two contexts different pages
- clean vs dirty polling
- no duplicate intervals/listeners after repeated navigation
- blur/hidden/pagehide
- swipe/vertical/text-selection
- Alt arrows
- clipboard native/fallback
- symbols/time
- reduced motion
- init asset failure
- no pageerror/unexpected console/external request

Chromium iPhone + WebKit iPhone where installed. Run existing relevant UI suites.

STOP before library/search/category-management UI.

Compact HANDOFF report only.
