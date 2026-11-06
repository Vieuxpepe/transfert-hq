# Transferina hand — grip sprite (`transferina-hand-grip.png`)

## Canvas
- **Size:** **976 × 352 px** (same as `transferina-hand.png` slap sprite).
- **Background:** transparent (Paint: erase to transparent, or export PNG-32).

## Orientation (important)
- **Dorsal / knuckles toward the viewer** — back of the hand faces the screen, **not** a horizontal side profile like the slap sprite.
- **Vertical pole gap** near **x ≈ ⅓** from the left (center of the curl) — the shaft passes through this hole.
- **Wrist cut** on the **right** edge (toward her body when the hand grips the member).

## Pose
- Four knuckles read clearly across the top; nails visible on the near side of the curl.
- Thumb pad on the **right** of the gap; finger mass on the **left**.
- Tense curl around a thick **vertical** cylinder; **do not** draw the pole inside the gap.

## Style (match existing trio)
- Fair peach skin, soft top-left highlight, thin dark outline.
- Long almond nails, dusty rose / light pink.
- No arm, no jewelry.

## Regenerate (procedural draft)
```bash
python scripts/build_transferina_hand_grip.py
```

## Import AI / Paint export
After generating or painting a **vertical dorsal** grip (knuckles top, wrist bottom) on white:
```bash
python scripts/import_transferina_hand_grip.py path/to/image.png
```
Keys white to alpha, rotates to horizontal (wrist right), fits **976×352**.

## Preview
1. Export **`assets/transferina-hand-grip.png`** at 976×352.
2. **`docs/transferina-hand-grip-preview.html`** on PC, or on **iPhone** (same Wi‑Fi, bridge running):  
   **`http://<PC-IP>:8765/assets/transferina-hand-grip-mobile.html`**  
   Direct PNG: **`/assets/transferina-hand-grip-showcase.png`**

## Runtime
- **`HqPalmHand.play("grip_pole", { near })`** — flies in with **~0° land rotation** (knuckles out), anchors on the **pole gap**, **holds** until **`releaseHold()`**.
- Used when the dangling member **rests on tit or face** (`beginRest` in `hq-dangling-member.js`).
