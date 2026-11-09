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
| `plus` | Plus / Système | — | status / settings chrome; Mini-Quêtes section `#system-mini-quests` | inline + `hq-mini-quests.js` | — |

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
