# External agent handoff (GitHub-only)

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


For assistants that read **github.com/Vieuxpepe/transfert-hq** but do **not** have access to a live bridge install or local disk.

Update the **Current focus** section when you push work you want reviewed.

---

## Repository

| Item | Value |
|------|--------|
| Remote | `https://github.com/Vieuxpepe/transfert-hq` |
| Integration branch | `main` (Transferania companion + persona; `transferania-persona` may mirror `main`) |
| Default doc entry | `README.txt` (architecture, security, companions) |
| Local runtime | Not in repo — operator runs `iphone_bridge.py` (~8765) on Windows |

---

## Not on GitHub (gitignored)

Do not assume these exist in the clone:

| Path | Purpose |
|------|---------|
| `.hq-ai/` | Companion memory, personality JSON, prefs, chat state |
| `.hq-ai/companion-memory/<owner-hash>.json` | User-edited personality traits |
| `.hq-ai/prefs/<device>/transferania_prefs.json` | Intensity, address, QC dial, warmth |
| `bridge_config.json` | PIN, bridge secrets |
| `bridge_sessions.json` | Sessions |
| User volumes (`Inbox/`, etc.) | Files |

Agents should reason from **code + committed docs**, not from live `.hq-ai` data.

---

## Product summary (engineering)

**Transfert HQ** is a personal mission-control bridge (Python HTTP server + HQ HTML/JS UI) between Windows PCs and iPhone (LAN/Tailscale). One operator, PIN auth, no SaaS.

**Transferania** (UI alias **Transferina**) is an in-app **companion character**: chat, ambient lines, avatar presence, optional **adult register** (software flag `nsfw=True`), touch/reaction audio, and HQ chrome interactions (e.g. dangling member physics). She is **not** the same product as the separate **Else** persona in `C:\Gemini-Test` (sister canon only — see `docs/companion-family.md`).

---

## Glossary (use in reviews)

| Term | Meaning |
|------|---------|
| Adult register | Chat/ambient mode when `nsfw=True` in `build_transferania_system()` |
| Warm / flirt persona | Non-adult chemistry modes in `hq_companion_presence.py` |
| Dangling member | Fixed UI mount: softbody shaft canvas + PNG, pendulum/carry physics |
| Carry mode | User grabs near mount top (`ptr.moving`, low `hitT`) and moves the mount |
| Mouth gate | Screen anchor for open-profile overlay lips (oral subsystem) |
| Oral engaged | Session flag; avatar collision softened; portrait frozen (`is-oral-session`) |
| Tube axis | Cached unit vector mount → mouth; depth measured by projection |
| Lip constriction | `oralBulgeScale(t)` narrows shaft girth at lip band in `renderCurve()` |
| Flick | One-shot hand animation when mid-shaft nears avatar (`maybeFlick`) |
| Mouth gate overlay | `transferina-head-open-profile-mouth.png`, z-index 375 |

---

## Architecture map

### Bridge & HQ shell

| Path | Role |
|------|------|
| `iphone_bridge.py` | HTTP server, auth, HTML shell, companion API routes |
| `hq_state.py` | Atomic JSON writes |
| `hq_companion.py` | Companion registry / policy controller |
| `assets/hq.js` | HQ UI core |
| `assets/hq-chrome.css` | HQ chrome, companion hooks, dangling/oral CSS |
| `assets/hq-companion.js` | Avatar bubble, modes, editor hooks |
| `assets/hq-companion.css` | Companion layout |

### LLM personality & prompts

| Path | Role |
|------|------|
| `hq_ai.py` | `build_transferania_system()`, `CHARACTER_SHEET`, prefs, NSFW/warm/flirt templates |
| `hq_companion_presence.py` | `character_hint()`, traits, arbitration |
| `hq_companion_context.py` | Context block selection (budgets) |
| `hq_companion_memory.py` | `personality_traits()`, `save_personality()` |
| `hq_companion_growth.py` | Evidence-backed quirk derivation |
| `docs/companion-prompt-assembly.md` | Layer ownership (core vs dynamic vs memory) |
| `docs/companion-memory.md` | Memory + evolution |
| `docs/companion-family.md` | Else ↔ Transferania canon |
| `docs/companion-editor.md` | UI “Éditer Transferania” |
| `docs/companion-presence.md` | Presence / voice notes |

### Interaction physics (HQ chrome)

| Path | Role |
|------|------|
| `assets/hq-dangling-member.js` | Shaft sim, avatar zones, flick, **oral session**, palm hooks |
| `assets/hq-palm-hand.js` | Open-palm + slap overlay (single active gesture, particle cap) |
| `assets/dangling-member.png` | Shaft texture |
| `docs/dangling-vein-paths-viewer.html` | **Open in a browser** — your guide PNG + thick extracted paths (regenerated with extract script) |
| `docs/dangling-vein-paths-overlay.png` | 3× PNG QA snapshot of the same |
| `assets/dangling-member-vein-paths.js` | Browser bundle of vein paths for trace gesture |
| `assets/transferina-head-open-profile-mouth.png` | Oral overlay (transparent mouth cavity) |
| `assets/transferina-hand.png` | Slap / flick hand |
| `assets/transferina-hand-open.png` | Open-palm gestures (pat, hush, wave, …) |
| `assets/transferina-hand-point.png` | Pointing hand — vein trace when shaft rests near her |
| `assets/transferina-hand-grip.png` | Grip hand — `grip_pole` hold on shaft when resting on tit/face |
| `assets/transferina-hand-grip-showcase.png` | Same art on light background (phone preview) |
| `assets/transferina-hand-grip-mobile.html` | **iPhone:** open on bridge — `/assets/transferina-hand-grip-mobile.html` |
| `scripts/punch_oral_mouth.py` | Regenerate mouth alpha in PNG |

### Adult visuals & chat media (content-heavy — review as **code paths**, not scene writing)

| Path | Role |
|------|------|
| `hq_companion_art.py` | Pose registry, generation prompts (adult IDs) |
| `assets/hq-companion-adult-*.css` | Adult face/FX styles |
| `assets/hq-companion-lewd-lines.js` | Recorded reaction lines |

---

## Key functions (dangling + oral)

File: `assets/hq-dangling-member.js`

| Symbol | Role |
|--------|------|
| `initDanglingMember` | Entry |
| `shaftClient(t)` / `tipClient()` | Screen geometry along shaft |
| `avatarZones()` | head / face / tit hit boxes |
| `playSlap()` / `playJiggle()` | Flick contact → `HqDangleAudio` (manifest slap + giggle pools, SFX bus) |
| `HqDangleAudio` | `assets/hq-dangle-audio.js` — zone/tit pull impacts, oral gulp/suction, throb, drag snap |
| `flickBusy()` / `flickBusyUntil` | Blocks oral during hand anim |
| `oralEngaged`, `oralPhase` | Oral state machine |
| `oralMouthAnchorFresh()` | Floater mouth position (left of avatar) |
| `captureOralTube()` | Tube axis on engage |
| `oralInsertAssist()` | Depth assist (no dual mount war — verify in latest commit) |
| `updateOralHead()` | Overlay + depth smoothing |
| `findOralLipT()` / `oralBulgeScale()` | Lip hole constriction in render |
| `build_transferania_system` | (in `hq_ai.py`) System prompt assembly |

---

## Adult register (software)

- **On GitHub (through commit `3df656f`):** `hq_ai.py` implements `nsfw_gate()` and expects `_cb["nsfw_enabled"]()` from `hq_ai.bind(...)`. **`iphone_bridge.py` on the remote branch does not register that callback yet**, so `nsfw_allowed()` stays false and adult mode cannot activate from the UI even if the client sends `nsfw: true`.
- **Local operator tree (`C:\Transfert`, often unpushed):** `iphone_bridge.py` registers `nsfw_enabled=lambda: CONFIG.get("companion_nsfw_enabled", True) is not False`, admin checkbox for the Adult button, and companion assets under `assets/hq-companion.js` (nsfw toggle, `nsfw_allowed` from API).
- Prompt branch: `build_transferania_system(..., nsfw=True)` appends adult template blocks (see `hq_ai.py` — review as structure, do not paste explicit vocab constants in agent chat).
- **Review task:** treat as conditional prompt assembly + admin gating; verify bridge bind before claiming end-to-end adult flow on GitHub.

### Minimum files for adult gate on GitHub (not yet one commit)

| File | Role |
|------|------|
| `iphone_bridge.py` | `hq_ai.bind(..., nsfw_enabled=..., companion_persona=..., …)` |
| `assets/hq-companion.js` | Reads `nsfw_allowed` / `nsfw_block`; Adult toggle |
| `bridge_config.json` (local, gitignored) | Optional `companion_nsfw_enabled` |

After those land on the branch, re-run Level 4 against the new commit SHA.

---

## Tests & checks

```bash
node --check assets/hq-dangling-member.js
python -m pytest tests/test_hq_companion_presence.py tests/test_hq_companion_editor.py tests/test_hq_companion_memory.py -q
python -m pytest tests/test_hq_ai.py -q -k transferania
```

Playwright/check scripts under `tests/check_hq_companion_*.mjs` for UI behavior.
`tests/check_hq_palm_hand.mjs` covers `HqPalmHand` busy/cooldown/dual catch (no browser).

---

## Current focus (update on push)

**Draft PR #30 (architecture only):** branch `feat/household-foundations` — Household Intelligence foundations. Entry: `docs/household/README.md`. Audit fixes: inventory attempt phases (`not_started|in_flight|acknowledged`), exact `unit_price_ratio`, hardened validators, CI `.github/workflows/household-foundations.yml`. `*.v1.json` = custom contract descriptors (not JSON Schema). Tests: `python -m unittest tests.test_household_schemas -v`.

**Branch note:** integration remains **`main`**. Do not treat household docs as shipped runtime.

**Ask external agents for:** architecture audit of `docs/household/*` + `hq_household_schemas.py` — gaps in SQLite↔JSON reconciliation, cents safety, Inventoria coexistence — not implementation PRs unless the operator asks.

---

## Security reminder for agents

Never request or output: bridge PIN, `bridge_config.json`, `.hq-ai` contents, device HMAC secrets, or enroll tokens.

---

## Suggested review escalation (prompt series)

Use the separate prompt list in chat with this doc; start at **Level 1** and only advance when the model has read the cited files on GitHub.

Levels (summary):

1. Repo architecture (`README.txt`, bridge modules)
2. Companion prompt pipeline (`docs/companion-prompt-assembly.md`, `hq_ai.py` structure)
3. Personality storage (`hq_companion_presence.py`, `hq_companion_memory.py`, docs)
4. Adult register as flags (`nsfw` branches in `hq_ai.py`, bridge toggle — no copywriting)
5. Dangling member physics (`hq-dangling-member.js` — zones, carry, flick)
6. Oral overlay subsystem (mouth gate, tube, lip constriction — clinical terms only)
7. Targeted fix PR (jitter / entry) with test plan

See your operator’s prompt pack (not stored in repo) for exact wording per level.
