# Inventoria Forge — character sheet (from v16 reference)

Lock these on **new txt2img** (768×1024) or light img2img from `inventoria-forge-sdxl-v16-shorter-2x-d080.png`.

## Positive (core) — **always include v14 stature block** or she reads tall on txt2img

```
Inventoria, Masterpiece, best quality, ultra-detailed, sexy inventory android waifu, intense, 1girl solo, full body,
(adolescent:1.5), (dwarf stature female enfant:1.7), (micro stature:1.5), (very short legs:1.7), (stubby legs:1.7),
short lower body, compact legs, (large head:1.5), huge emerald green eyes slit pupils, flat chest, narrow waist, thin youngster-body,
(kitchen counter comes up to her eyes:1.6), (counter much taller than character:1.6),
```

Then add look + scene:

```
Inventoria, masterpiece, best quality, ultra-detailed, anime cel shading, 1girl solo,
short dwarf-stature adolescent android girl, very petite, large head,
silver-white bob hair with bangs, huge emerald green eyes slit pupils, black winged eyeliner,
mischievous smug smirk, light cheek blush,
flat chest, narrow waist, very short stubby legs, thin bare thighs, barefoot,
glossy TEAL cyan latex mecha leotard high-cut hips, small green diamond chest gem,
black robotic shoulder joints, teal forearm guards, black gloves NOT boots,
bright kitchen: white cabinets, black vertical handles, dark gray countertop, tan wood floor,
MUST INCLUDE: small orange-bearded dwarf peeking over counter left side,
silver pot boiling on gas stove right with steam,
kitchen counter reaches her eye level, girl much shorter than counter
```

## Negative

```
low quality, adult, worst quality, blurry, bad anatomy, tall, long legs,
thick thighs, meaty thighs, wings, bat wings, horns, antenna, succubus,
white leotard, pink leotard, armored boots, thigh boots, robot ears,
different hair color, different outfit color, breasts, cleavage, large hips,
text, watermark, multiple girls
```

## Sampler

- Model: `waiIllustriousSDXL_v170.safetensors`
- DPM++ 2M Karras, steps 48, CFG 7.5
- Seed family: `923988103` (+ `105`, `107` for pose variants)

## Pose suffix (append to core)

| Tag | Suffix |
|-----|--------|
| lean | `, standing leaning back against countertop, hands on counter edge, facing viewer` |
| wave | `, standing, waving at viewer, other hand on hip, playful` |
| sit | `, sitting on countertop edge, legs dangling, facing viewer` |
| hips | `, standing, legs apart, hands on hips, confident` |
| squat | `, squatting low, peeking over counter edge playfully` |
| back | `, from behind, back view, looking back over shoulder at viewer, arched lower back, high-cut leotard hips emphasis` |
| kneel-pov | `, kneeling on both knees on kitchen floor, looking up at viewer, POV from above, upward gaze, counter towering behind` |
| kneel-pole | `, kneeling on knees POV from above, vertical shiny chrome metal pole, lips sealed around polished rod tip, sucking metal pipe end, hands on thighs, kitchen` |

## Pipeline notes

- **Resolution:** **768×1024** for new poses (1536 txt2img tends to elongate legs).
- **New pose + short:** txt2img with **v14 stature block** + pose suffix; skip heavy hybrid img2img (pulls tall).
- **Polish:** 2× from v16 chain (0.8 → shorter canvas) only after a short txt2img base you like.
- **Pose only on locked v16:** img2img from v16 at **0.78–0.85** (design lock, pose change).

### v19d example (short squat) — good base

`inventoria-forge-sdxl-v19d-short-squat-txt.png` — seed `923988107`, squat peek, dwarf + pot, counter above head.

### v19g lean / wave (matched squat height)

Re-run with **v14 block** + `(head below cabinet handles:1.4)` on **768×1024** txt2img. Keepers (also copied over `v19d-short-*-txt.png`):

| Pose | File | Seed |
|------|------|------|
| lean | `inventoria-forge-sdxl-v19g-short-lean-s111.png` → `v19d-short-lean-txt.png` | `111` |
| wave | `inventoria-forge-sdxl-v19g-short-wave-s111.png` → `v19d-short-wave-txt.png` | `111` |

Squat-base img2img for **wave** above ~0.66 drifts back to lean; use txt2img or ≤0.66 from squat init. Squat-base **lean** at **0.82** (`v19f-squatbase-lean-s923988103-d82.png`) is a strong alternate if you want chin-on-counter lean.

### v19i back view

| File | Seed | Notes |
|------|------|-------|
| `inventoria-forge-sdxl-v19d-short-back-txt.png` ← `v19i-short-back-s114.png` | `114` | Back to camera, glance over shoulder; counter at head height; pot |
| alts | `111`, `107`, `116` | `v19i-short-back-s*.png` — more bent-over / leaf-ahoge drift on some |

### v19k kneel POV (`v19k-short-kneel-pov-s{seed}.png`)

| File | Seed | Notes |
|------|------|-------|
| `inventoria-forge-sdxl-v19d-short-kneel-pov-txt.png` ← `v19k-short-kneel-pov-s118.png` | `118` | Kneeling, hands clasped, looking up; counter/oven above — keeper |
| alt | `119` | Same POV, knees apart, smirk, green cabinets |
| avoid | `111` | Unwanted **male POV legs** in frame — NEG `1boy`, `pov hands`, `male legs` |

### v19m kneel + pole oral (`v19m-short-kneel-pole-oral-s{seed}.png`)

| File | Seed | Notes |
|------|------|-------|
| `inventoria-forge-sdxl-v19d-short-kneel-pole-oral-txt.png` ← `v19m-short-kneel-pole-oral-s119.png` | `119` | Mouth on chrome rod tip, top-down POV, kitchen — **keeper** |
| alt | `118` | Same pose, spread knees, green cabinets |
| weak | img2img from pov118 | Denoise **0.62+** keeps clasped hands; use **pure txt2img** for this pose |
| NEG | — | `1boy`, `male legs`, `tongue only licking`, `penis` |

Earlier `v19l*` batches were lick/tongue-out only — superseded by **v19m**.

### v19j back batch 2 (`v19j-short-back-{stand|bend|hip}-s{seed}.png`)

12× **768×1024** txt2img, seeds **117–120** (stand + bend pairs), **121–124** (hip). Standout: **`bend-s119`** (dwarf on stove, clear back glance, short scale).
