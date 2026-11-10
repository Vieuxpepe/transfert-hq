# Chip portraits — icônes standard (adulte off)

When **mode adulte Transferania** is off, Else and Inventoria chips show **monogram icons** (not Forge photos).

**Galerie** : [chip-sfw-gallery.html](http://127.0.0.1:8765/assets/companion/chip-sfw-gallery.html)

| | |
|---|---|
| Else (source SVG) | `assets/companion/else-chip.svg` |
| Inventoria (source SVG) | `assets/companion/inventoria-chip-icon.svg` |
| Raster HQ | `assets/companion/*-chip-sfw.webp` (+ `@2x`, même icône par humeur) |

**Génération** : `python scripts/gen_chip_sfw_portraits.py`

**Bascule** : `hqCompanionNsfwOn()` · event `hq:companion-nsfw`

**Aperçus interactifs** :
- [else-chip-preview.html](http://127.0.0.1:8765/assets/companion/else-chip-preview.html) — humeurs + **SFW / Adulte**
- [inventoria-chip-preview.html](http://127.0.0.1:8765/assets/companion/inventoria-chip-preview.html) — idem

### Liens 1× (bridge `8765`)

**Else** — cercle violet, **E** + bulle ([else-chip-sfw.webp](http://127.0.0.1:8765/assets/companion/else-chip-sfw.webp)) · SVG [else-chip.svg](http://127.0.0.1:8765/assets/companion/else-chip.svg)

**Inventoria** — carré arrondi teal, **grille** + gemme ([inventoria-chip-sfw.webp](http://127.0.0.1:8765/assets/companion/inventoria-chip-sfw.webp)) · SVG [inventoria-chip-icon.svg](http://127.0.0.1:8765/assets/companion/inventoria-chip-icon.svg)

Pastille SFW : point d’accent par humeur (coin) ; anneau chip inchangé.
