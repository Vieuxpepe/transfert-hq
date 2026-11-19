# HQ frontend view index (agents)

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Views are **`document.body.dataset.view`** (see **`setView`** in **`iphone_bridge.py`** inline app JS).  
Bottom nav uses **`data-nav`** matching view ids in **`VIEW_LABELS`**. One nav, two shapes: above 900 px it is a 164 px left rail
(compact icon+label rows, hairlines before `dessiner` and `ops`); below 900 px only `MOBILE_FIRST` — accueil, carnet, calendrier,
fichiers, plus — keeps a tab, and every other space is reached through **Plus** (`hq-more-nav`). `setView` highlights Plus when the
current view has no tab, so a hidden view is never "nowhere".

**One title per page.** The view bar's `#view-label` is the page's `h1` (document title, shape-aware name, focus target).
When the open panel already names the view in one of its top headings — `h1`/`h2` equal to the label, or the label plus a
count or badge such as « Fichiers 0 », « Carnet · 3 » or « Projets (12) » — `assets/hq-nav-plus.js` adds
`body.view-own-title` and the label is visually hidden instead of repeating the heading. The repeated name does not have
to be the first heading: `fichiers` opens on « Recherche globale » and names the space in the next one, so the check scans
the panel's top headings and only the ones actually shown. A heading that adds real words (« Fichiers 3
nouveaux ») is a section, not the page title, so the label stays. A lazy panel renders its heading after the switch: the
script keeps a `MutationObserver` armed on that panel while it is open — no timer, and no disarming on a placeholder
heading — so the label steps aside the moment a heading actually names the view, and comes back if that heading is
replaced or edited away.
`plus` keeps the label and its disclosure « Accès direct » is styled as a control, never as a second heading.

Use this table before opening large JS files.

| View | Nav label | Lazy load | Show / init hook | Primary assets | Perf marks (subsystem) |
|------|-----------|-----------|------------------|----------------|------------------------|
| `accueil` | Accueil | — | `hqCarnetHome()` (admin summary) | `hq.js`, inline bridge | `bridge boot-ready` |
| `accueil` (Musica card) | Accueil › Musica | `hq-home-cards.js` (`paintMusica`) | `GET /api/musica/dj/station` | `hq-home.js` card key `musica`, `hq_home.KEYS` | opens Musique via `sessionStorage hq_music_tab` |
| any non-Musique view (nudges) | — | `hq-musica-moments.js` (deferred, global) | `GET /api/musica/dj/station` every 5 min | `hq-musica-chip.css` (`.hq-musica-moment`) | silent on any API error |
| `carnet` | Carnet | **`hqCarnetLoad()`** (41 scripts) | **`hqCarnetShow()`** | `assets/hq-carnet*.js` ( **`hq-carnet.js` last** ) | `carnet script-load`, `carnet-show`, `poll`, `nav setView-lazy` |
| `calendrier` | Calendrier | — | **`hqCalendarShow()`** | calendar JS in bridge bundle | — |
| `dessiner` | Dessiner | sketch stack (`SK_SCRIPTS`) | **`hqSketchShow()`** via `hqSketchStart` | `hq-dessiner.js`, sketch core | `dessiner show` |
| `forge` | Forge Studio | **`hqForgeLoad()`** | **`hqForgeShow()`** after load | `hq-forge*.js` | `forge script-load`, `forge-show`, `nav setView-lazy` |
| `fichiers` | Fichiers | — | **`refreshFiles()`** on enter | inline + `/api/list` | `fichiers list` |
| `lecteur` | Lecteur | — | **`hqPlayerView`** | player JS inline | — |
| `musique` | Musique | **`hqMusicLoad()`** | **`hqMusicEnsureMounted()`** + **`hqMusicShow()`** (admin) | `assets/hq-music.js`, `hq-music.css` | `nav setView-lazy` |
| `projets` | Projets | — | **`hqProjectsShow()`** | projects module | — |
| `inventaire` | Inventaire | — | **`hqInventoryShow()`** | inventory module | — |
| `robotique` | Robotique | **`hqRoboticsLoad()`** | **`HqRobotics.show/hide`**, admin | `hq-robotics.js`, `hq-robotics.css`, `hq-robotics-assistant.js/css`, `hq-robotics-3d.js` (3D tab, loaded on first open) | `nav setView-lazy` |
| `atelier3d` | Atelier 3D | **`hqPrint3dLoad()`** | **`HqPrint3d.show(host, api, section)/hide`**, admin; Elsea chip `hq-elsea-chip.js/css` always loaded, shown only on this view | `hq-print3d.js`, `hq-print3d.css` | `nav setView-lazy` |
| `playground` | Playground | **`hqPlaygroundLoad()`** | **`HqPlayground.show/hide`** (Échecs vs Else / Transferania) | `assets/hq-playground.js`, `hq-playground.css` | `nav setView-lazy` |
| `ops` | Terminal | — | ops tools | `ops` UI (hidden in simple mode) | — |
| `intime` | Tête-à-tête | companion bundle with page | **`HqCompanion`**, admin only | **`assets/hq-companion.js`** | `companion live2d-frame` |
| `plus` | Plus / Système | — | status / settings chrome; Mini-Quêtes `#system-mini-quests` | inline + `hq-mini-quests.js` | — |

**Système layout.** `#system-session` is an « État » strip (disk, uptime, role, alerts + build line + disk sparkline);
static facts moved to « Pont » (`#system-info`), while « Accès » (`#system-access`) owns the wallboard, QR and PWA block.
Each section carries a `.scope` chip (`ce navigateur` / `ce PC` / `le pont` / `admin`) so browser-local preferences are not
mistaken for server settings. « Brief du jour » now lives on Accueil, where the home summaries already are. The disclosure
lists sections first and actions second, filters by text (`#sys-find`), and its open/closed state is remembered per `<details>`
(`data-open-key`). Sections fetch their data when revealed (details opened or scrolled near), including `hq-users.js`,
`hq-mini-quests.js` and the NVIDIA visit settings through the shared `window.hqWhenRevealed`; `#system-backups` shows the
catalogue summary, a « Faire une sauvegarde » action, and restores require typing the folder name after a safety backup.
`#plus/system-<id>` is addressable (deep link) and `history.replaceState` keeps it current when a jump is used.

### Planned views (PR #30 foundations — not wired)

| View (future) | Nav | Notes |
|---------------|-----|-------|
| `finances` | Finances | Sous-vues: générale, transactions, budgets, factures, objectifs, analyses — [household/07-ui-architecture.md](household/07-ui-architecture.md) |
| `repas` | Repas & Épicerie | Planificateur, circulaires, recettes, liste, garde-manger, historique prix |
| Inventoria FAB | global | Bas-gauche ; ne masque pas Transferania / Else |

---

## Navigation instrumentation

| Hook | File | Marks |
|------|------|--------|
| **`setView(name)`** | `iphone_bridge.py` (inline) | `nav view`, `nav setView-commit`, `nav setView-lazy` |
| **`hqClientLogView(from,to)`** | `assets/hq-debug-panel.js` | client log `kind: view` |
| **`HqTheme.runViewChange`** | theme JS | may defer `commit()` |

---

## Carnet script chain

Defined as **`HQ_CARNET_SCRIPTS`** in `iphone_bridge.py` (order matters). Entry points for agents:

- Load orchestration: **`hqCarnetLoad`**
- UI entry: **`hqCarnetShow`** in **`assets/hq-carnet.js`** (~`startPoll`, editor)
- Anchors: [carnet-agent-anchors.md](carnet-agent-anchors.md)

---

## Debug HUD

When **`client_debug_hud`**: **`assets/hq-debug-panel.js`** — Brief / Packet / Bundle, **`hqPerfMark`**, **`hqClientLog`**.

Symptoms by view: [hq-symptom-index.md](hq-symptom-index.md).
