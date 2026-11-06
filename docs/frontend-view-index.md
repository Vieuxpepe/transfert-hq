# HQ frontend view index (agents)

Views are **`document.body.dataset.view`** (see **`setView`** in **`iphone_bridge.py`** inline app JS).  
Bottom nav uses **`data-nav`** matching view ids in **`VIEW_LABELS`**.

Use this table before opening large JS files.

| View | Nav label | Lazy load | Show / init hook | Primary assets | Perf marks (subsystem) |
|------|-----------|-----------|------------------|----------------|------------------------|
| `accueil` | Accueil | — | `hqCarnetHome()` (admin summary) | `hq.js`, inline bridge | `bridge boot-ready` |
| `carnet` | Carnet | **`hqCarnetLoad()`** (41 scripts) | **`hqCarnetShow()`** | `assets/hq-carnet*.js` ( **`hq-carnet.js` last** ) | `carnet script-load`, `carnet-show`, `poll`, `nav setView-lazy` |
| `calendrier` | Calendrier | — | **`hqCalendarShow()`** | calendar JS in bridge bundle | — |
| `dessiner` | Dessiner | sketch stack (`SK_SCRIPTS`) | **`hqSketchShow()`** via `hqSketchStart` | `hq-dessiner.js`, sketch core | `dessiner show` |
| `forge` | Forge Studio | **`hqForgeLoad()`** | **`hqForgeShow()`** after load | `hq-forge*.js` | `forge script-load`, `forge-show`, `nav setView-lazy` |
| `fichiers` | Fichiers | — | **`refreshFiles()`** on enter | inline + `/api/list` | `fichiers list` |
| `lecteur` | Lecteur | — | **`hqPlayerView`** | player JS inline | — |
| `projets` | Projets | — | **`hqProjectsShow()`** | projects module | — |
| `inventaire` | Inventaire | — | **`hqInventoryShow()`** | inventory module | — |
| `ops` | Terminal | — | ops tools | `ops` UI (hidden in simple mode) | — |
| `intime` | Tête-à-tête | companion bundle with page | **`HqCompanion`**, admin only | **`assets/hq-companion.js`** | `companion live2d-frame` |
| `plus` | Plus / Système | — | status / settings chrome | inline | — |

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
