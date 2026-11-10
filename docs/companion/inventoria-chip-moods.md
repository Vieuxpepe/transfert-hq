# Inventoria chip — moods (Forge keepers)

Promoted from `backup/inventoria-forge-demos-pr33-contaminated:docs/demos/` via
`scripts/promote_inventoria_chip_moods.py` — **not** the full `docs/demos` tree on `main`.

**Galerie (cliquable)** : [inventoria-chip-moods-gallery.html](http://127.0.0.1:8765/assets/companion/inventoria-chip-moods-gallery.html)  
*(bridge HQ local ; adapte le port si besoin)*

| Mood | Forge source | Intent | 1× WebP |
|------|--------------|--------|---------|
| **idle** | `v16-shorter-h1536.png` | Kitchen forge canon | [idle](http://127.0.0.1:8765/assets/companion/inventoria-chip.webp) |
| **listening** | `v19d-short-squat-txt.png` | Squat peek | [listening](http://127.0.0.1:8765/assets/companion/inventoria-chip-listening.webp) |
| **speaking** | `v19d-short-wave-txt.png` | Wave | [speaking](http://127.0.0.1:8765/assets/companion/inventoria-chip-speaking.webp) |
| **proactive** | `v19d-short-lean-txt.png` | Smug lean | [proactive](http://127.0.0.1:8765/assets/companion/inventoria-chip-proactive.webp) |
| **busy** | `v19-sheet-hands-hips.png` | Hands on hips | [busy](http://127.0.0.1:8765/assets/companion/inventoria-chip-busy.webp) |
| **sister** | `v19-sheet-sit-dangle.png` | Sit on counter | [sister](http://127.0.0.1:8765/assets/companion/inventoria-chip-sister.webp) |

@2x : remplace `.webp` par `@2x.webp` dans l’URL.

Assets: `assets/companion/inventoria-chip[-mood].webp` (+ `@2x`).  
Client: `assets/hq-inventoria-chip.js` — `PORTRAIT_BY_MOOD`, `setMood`, `setBusy`, event `hq:inventoria-mood`.

**HQ :** bulle ouverte → **listening** ; fermée → **idle** ; `setLine(text)` → **speaking**. Menu pastille (appui long) → humeurs nommées.

**Test :** [inventoria-chip-preview.html](http://127.0.0.1:8765/assets/companion/inventoria-chip-preview.html) (barre de humeurs en haut à gauche).

Regenerate:

```bash
python scripts/promote_inventoria_chip_moods.py
```
