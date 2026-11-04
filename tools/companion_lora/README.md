# Transferania character LoRA

The companion stack already locks **face** with IP-Adapter. A **character LoRA** (+ optional **character sheet** CN) locks body/outfit when tag pools change.

## What runs automatically

```powershell
cd C:\Transfert
python tools\companion_lora\prepare_dataset.py
python tools\companion_lora\build_character_sheet.py
```

- Dataset: `.hq-ai/companion_lora_dataset/10_transferania/` (images + `.txt` captions, trigger word `transferania`)
- Sheet: `assets/companion/companion-character-sheet.jpg` (used if present)

## Full training (you run locally — not in Forge)

Forge at `127.0.0.1:7860` **infers** only; it does not train LoRAs.

1. Install [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) (see `train_transferania.ps1` for commands).
2. Edit `train_transferania.toml` → `pretrained_model_name_or_path` = your **SDXL** checkpoint (same base as Forge).
3. Run:

```powershell
.\tools\companion_lora\train_transferania.ps1
```

4. Update `.hq-ai/companion_forge.json`:

```json
"character_lora_name": "transferania_char",
"character_lora_weight": 0.82
```

## Dataset quality

~15–20 JPGs from `assets/companion/` is enough for a **light** LoRA, not a studio-grade one. For better results, add 20–40 more **consistent** gens (same face ref, varied poses/outfits), re-run `prepare_dataset.py`, then train again.

## VRAM

RTX 4060 (8 GB): settings in the TOML use batch 1, dim 32, cached latents — typical for SDXL LoRA on 8 GB.
