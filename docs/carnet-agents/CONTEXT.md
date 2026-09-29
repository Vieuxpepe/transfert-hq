# Carnet compact context capsule

This is the shared context every Carnet implementation stage may consume.

## Product targets — IMPORTANT

Carnet is **not an iPhone feature**.

It is one synchronized web notebook with first-class UX on:
- Windows PC — Chrome/Edge-class Chromium browsers, keyboard + mouse;
- iPad — Safari/WebKit, touch + optional hardware keyboard;
- iPhone — Safari/WebKit, touch;
- other modern desktop browsers where HQ already works.

`iphone_bridge.py` is only the historical/current filename of Transfert HQ's shared HTTP server and SPA host. It serves desktop and mobile clients. Never interpret that filename as a mobile-only architecture.

Use one data model, one API and one editor state machine across devices. Responsive presentation may differ:
- phone: paper-first, compact controls, sheets;
- iPad: paper-first with more breathing room, Focus mode, touch/hardware keyboard;
- desktop: centered/wide paper, keyboard/mouse affordances, and later a persistent/collapsible library sidebar.

Cross-device editing between PC ↔ iPad ↔ iPhone is a core acceptance case.

## Repository / architecture

Repo: `Vieuxpepe/transfert-hq`.

Working mode:
- project folder is `C:\\Transfert`;
- stay on the existing `main` branch;
- edit source files directly in that working tree;
- do not create/switch branches, worktrees, or extra clones;
- leave changes uncommitted/unpushed unless the user explicitly authorizes delivery;
- tests must use throwaway ROOTs and must not mutate live runtime data under `C:\\Transfert`.
- **Never run Python tests that import `iphone_bridge` from the live `C:\\Transfert` checkout.** Import side effects and older tests can rewrite runtime files before fixtures redirect ROOT.
- Full/relevant Python suites must run from an isolated temporary source copy outside `C:\\Transfert` (plain file copy is fine; no Git clone/worktree required). Exclude runtime folders/files and `.git`.
- Focused tests may run in-place only if proven not to import/touch live-runtime modules; when uncertain, use the isolated copy.

Design was prepared when main was `d7e7eb3f2a293303ab258c69fda7f104c245022d`; always inspect current refs first.

Hard constraints:
- Python stdlib server only.
- Plain ES2020 browser JS/CSS; no build system/framework.
- No CDN/external fonts/external runtime dependency.
- Preserve CSP, CSRF, roles/auth, nosniff.
- Carnet is admin-only.
- Never add Carnet API to upload-role allowlists.
- Never put secrets or note contents in URLs, argv, logs, diagnostics.
- Never test against live `C:\Transfert`; use throwaway ROOTs.
- Planner/companion/task privilege architecture is out of scope.
- Malformed runtime state is preserved, never silently overwritten.
- No merge/deploy unless explicitly authorized.

Known reusable code:
- `hq_state.path_lock(path)`: per-path RLock.
- `hq_state.write_json_atomic(path,data)`: sibling temp + flush/fsync + replace.
- `hq_calendar.py`: validation/conflict/domain pattern.
- `cc_ext.py`: backup.
- `iphone_bridge.py`: shared PC/mobile auth/CSRF/HTTP/rendered SPA/global `api()`; despite its name, it is not iPhone-only.
- feature JS/CSS patterns: Calendar/Dessiner.
- tests use unittest + Node + Playwright throwaway servers.

Global `api()` currently preserves 401/403 UX but historically throws a plain Error for other non-2xx JSON. Carnet conflict UI needs a backward-compatible `error.status` + `error.data` or equivalent.

New view hooks must be narrow:
```js
if (view === "carnet" && window.hqCarnetShow) {
  try { window.hqCarnetShow(); } catch (e) { console.error(e); }
}
```
A Carnet failure must never abort HQ startup/navigation.

## Frozen foundation decisions

Runtime state:
`<ROOT>/.hq-carnet/notebook.json`

Gitignore:
`.hq-carnet/`

Initial limits:
- 128 active pages
- 24 categories
- 48 KiB UTF-8 text/page
- 1 MiB total active text
- fixed category palette: blue, green, amber, coral, violet, pink, teal, graphite

Server-generated:
- IDs
- revisions
- timestamps

Concurrency:
- per-page optimistic `rev`
- `notebook_rev` for structural mutations
- no silent last-write-wins
- stale mutation returns 409 and current server entity
- different pages should not conflict merely because another page changed

Page metadata:
- project
- category
- pin
- created_at / updated_at
- soft-delete timestamp
- versioned content representation
- no arbitrary persisted HTML

Capture UX:
- no title prompt
- no Save button
- typing starts immediately
- title is derived from first non-empty line
- empty title: `Page sans titre`
- unclassified notes appear under virtual `À classer`

Local durability:
- every input updates a per-user, per-page local draft before network work
- multiple dirty pages may coexist
- localStorage failure shows:
  `Sauvegarde locale indisponible — ne ferme pas cette page.`
- only read drafts after `/api/me` confirms admin
- namespace drafts by non-secret authenticated username
- lifecycle network save is best effort; local draft is the fallback

Save queue invariant:
- one ordinary in-flight save/page
- save captures generation + exact payload + expected rev
- successful old response updates server rev but may clear dirty/draft only if current generation AND payload still match
- otherwise immediately save newer state against returned rev

Conflict message:
`Modifié ailleurs. Ta saisie est conservée sur cet appareil.`
Actions:
- `Charger la version distante`
- `Remplacer avec ma version`

Polling:
- metadata only, only while Carnet + document visible
- no duplicate timers
- dirty local content is never overwritten by polling

Paper/UI:
- phone ≈90% paper
- iPad gives the paper more room and supports touch + hardware keyboard
- desktop is first-class: mouse/keyboard, comfortable centered/wide paper, no forced phone-shaped UI
- editor >=16px
- controls >=44px on touch layouts
- CSS-only paper texture/lines; local/system fonts
- swipe threshold ≈60px with horizontal dominance on touch
- Alt+Left/Right changes page; normal arrows remain caret keys
- page flip uses CSS transforms, no JS animation loop
- reduced motion disables 3D flip

Core retrieval:
- virtual filters: Toutes, Épinglées, Récentes, À classer
- client-side accent/case-insensitive search while notebook is small
- projects answer "what for?"
- categories answer "what type?"
- neither blocks capture

Trash:
- normal delete is soft-delete + Undo
- trashed notes are read-only until restored
- permanent delete is deep/explicit

Backup:
- include persisted Carnet data coherently
- do not alter legacy meaning of backup `folders` count
- expose separate Carnet status
- no live restore UI in foundation

## Long-term product direction

Later stages add structured rich text, links, exports, engineering Sources/citations, exact local-PDF page jumps, media, engineering calculations/measurements, history/reports. These do not belong in earlier stages.

Source philosophy:
- provenance, edition/revision and exact locator matter
- no fake trust score
- "✓ Emplacement vérifié" means locator verified, not information certified true
- never blindly carry page numbers across editions

## Read code by anchors, not whole files

Use `rg -n` first, then inspect small surrounding ranges.

Useful anchors:
```text
iphone_bridge.py:
  "UPLOAD_GET_EXACT|UPLOAD_POST_EXACT|_guard_admin_path|_check_csrf"
  "async function api|VIEW_LABELS|function setView|bottom-nav|data-panel="
  "def _hq_get|def _hq_post|def ensure_hq|def bind_hq"
  "def _send_file|/files/|/media/"

hq_state.py:
  "def path_lock|def write_json_atomic"

cc_ext.py:
  "def run_backup|folders"

hq_calendar.py:
  "Conflict|expected_rev|write_json_atomic|path_lock|def bind"
```

Do not ingest large unrelated server sections unless a referenced function requires it.
