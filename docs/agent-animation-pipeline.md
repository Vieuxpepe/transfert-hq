# Animation fix pipeline (agents & CI)

Use this when HQ feels janky, FPS drops on Accueil/Intime, or you change **motion loops**, **CSS keyframes**, or **canvas/rAF** code.

---

## 1. Reproduce with evidence (live bridge)

1. Turn on the debug HUD; hard-refresh the view (`Ctrl+F5`).
2. Capture triage: `GET /api/diag/agent-brief` or `python scripts/agent_hq_brief.py --pin …` (see [agent-debugging.md](agent-debugging.md)).
3. In the brief, sort **`perf-mark`** rows by `costMs` — typical buckets:
   - `companion` / `live2d-frame` → [assets/hq-companion.js](../assets/hq-companion.js)
   - Dangle lag with no expanded companion → [assets/hq-dangling-member.js](../assets/hq-dangling-member.js)
   - Home hero / panels only → [assets/hq-home-fx.js](../assets/hq-home-fx.js) + CSS

Optional deep audit prompt (external agent, code-only): [agent-fps-audit-prompt.txt](agent-fps-audit-prompt.txt).

---

## 2. Classify the subsystem

Shared tier / budgets: [assets/hq-motion-coordinator.js](../assets/hq-motion-coordinator.js) (`HqMotion.tier()`, auto-lite from Live2D EMA). Shared motion **intent** (sparse phrases): [assets/hq-kinetic-score.js](../assets/hq-kinetic-score.js) (`HqKinetic.emit` / `subscribe`; rAF only while envelopes are active). User-facing control: **Outils → Réglages → Fluidité HQ** (same as debug HUD motion dropdown; `localStorage` `hq-motion-mode`).

| Symptom | First files |
|---------|-------------|
| Idle Accueil, member visible, low FPS | `hq-dangling-member.js`, `hq-chrome.css` (`hq-dangle` swing) |
| Intime / expanded companion | `hq-companion.js`, `hq-companion.css`, adult FX CSS |
| Pull / bust / steam jank | `hq-companion.js` (`renderBustPull`, `setPullVar`), adult FX keyframes |
| Home aurora / clock / stars | `hq-home-fx.js`, `hq-home-fx.css` |
| Tab hidden still burning CPU | `is-anim-paused`, `visibilitychange`, `IntersectionObserver` guards |

Do **not** assume WebGL shaders or a physics engine — see the audit prompt “DO NOT ASSUME” section.

---

## 3. Fix (constraints)

- Preserve interaction: drag, oral, throb, rest-on-avatar, vein trace must stay hot-path quality.
- Prefer **scheduling** (timer park, unified rAF, dirty flags) over removing motion entirely.
- **`prefers-reduced-motion`**: static or paused motion; pointer physics may still run.
- Minimize diff scope; match existing naming in the file you touch.

Skills: `companion-behavior` (companion), `hq-incident` (symptoms/logs), `run-these-tests` (what to run after).

---

## 4. Verify (required before “done”)

```bash
python scripts/verify_animation_pipeline.py
```

This runs:

| Layer | What |
|-------|------|
| Coordinator | `tests.test_hq_motion_coordinator` |
| Syntax | `node --check` on coordinator, companion, dangling member, home FX JS |
| Assets | `tests/check_hq_files.mjs` (script order, dangle hooks) |
| Companion motion | `tests.test_hq_motion_perf14`, `tests.test_hq_motion_perf16` |
| Dangle idle | `tests.test_hq_avatar_idle_perf12`, `tests/test_hq_dangling_perf15.py` |
| Home idle | `tests.test_hq_idle_perf11` |

CI: GitHub workflow **Animation & motion perf** (`.github/workflows/animation-perf.yml`) on pushes/PRs that touch those paths.

Broader checks only when asked: `python -m unittest discover -s tests -p "test_*.py"`.

---

## 5. Browser spot-check (Maître or agent with bridge)

Automated gate (CI + local):

```bash
pip install playwright && playwright install chromium
python tests/visual_hq_motion_fps_playwright.py
```

| Scenario | Expect |
|----------|--------|
| Accueil idle ~2 s (automated) | `HqMotion` present; dangle still PNG (`!is-softbody`); frames ≥ 18; long tasks ≤ 12 |
| Accueil idle ~10 s (manual) | Stable FPS; no long tasks every frame |
| Drag member | Smooth curve render; vein hot path |
| Throb / rest on avatar | Glisten + sim paths wake; settle parks |
| Toggle adult / expand Intime | Live2D throttling; pull uncapped when dragging bust |
| `prefers-reduced-motion` | No idle shimmer loops; drag still works |

---

## 6. Adding a new guard

When you lock in a new animation invariant:

1. Add a focused test under `tests/` (name `test_hq_*_perf*.py` or `check_hq_*.mjs`).
2. Register it in `scripts/verify_animation_pipeline.py`.
3. Extend path filters in `.github/workflows/animation-perf.yml` if new files are outside current globs.
4. Add one row to [test-index.md](test-index.md) § Animation pipeline.
