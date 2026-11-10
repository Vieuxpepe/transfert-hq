"""Generate all 7 sexy luxury bra variations via local Forge UI (Illustrious SDXL) inpaint API,
then extract them into Transferania's 2.5D rig and build the updated comparison sheet.
"""
import json, base64, io, urllib.request, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

RIG = Path(r"c:\Transfert\assets\companion\rig-neutral-v1")
ART = Path(r"C:\Users\autm_\.gemini\antigravity\brain\bd3a32cb-4355-4140-94fa-e16e9e08ea4c")
OUT_DIR = ART / "forge_bras"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SRC_PATH = RIG / "source.jpg"
src_im = Image.open(SRC_PATH).convert("RGB")

# Create smooth inpaint mask: White (255) = inpaint area, Black (0) = keep original
mask_im = Image.new("L", (512, 512), 0)
draw = ImageDraw.Draw(mask_im)

poly = [
    (165, 275),
    (345, 275),
    (435, 330),
    (450, 400),
    (440, 460),
    (415, 511),
    (98, 511),
    (70, 460),
    (55, 400),
    (75, 330),
]
draw.polygon(poly, fill=255)
mask_feathered = mask_im.filter(ImageFilter.GaussianBlur(radius=3.0))

def to_base64(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

init_b64 = to_base64(src_im)
mask_b64 = to_base64(mask_feathered)

BRA_CONFIGS = {
    "rubis": {
        "label": "Balconnet Satin Rubis (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing ultra revealing ruby red duchess satin micro-balconette bra, delicate gold lace trim, tiny cups, plunging cleavage, bare chest skin, sensual luxury lingerie",
        "seed": 101,
        "denoise": 0.68,
    },
    "harnais": {
        "label": "Harnais Cuir & Anneaux (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing gothic black leather harness bra, strappy open chest bondage harness, small silver O-rings, sheer black mesh demi cups, plunging cleavage, bare skin, sensual luxury lingerie",
        "seed": 202,
        "denoise": 0.68,
    },
    "rose": {
        "label": "Dentelle & Soie Rose (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing skimpy blush pink silk and sheer white floral Chantilly lace micro-bralette, plunging deep V neckline, tiny pearl trim, bare chest skin, sensual luxury lingerie",
        "seed": 303,
        "denoise": 0.66,
    },
    "violet": {
        "label": "Velours Violet & Argent (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing royal midnight violet velvet sweetheart demi-bra, intricate metallic silver floral embroidery, low-cut plunge neckline, bare chest skin, sensual luxury lingerie",
        "seed": 404,
        "denoise": 0.68,
    },
    "emeraude": {
        "label": "Tulle Émeraude & Or (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing sheer emerald green gossamer tulle bralette, gold botanical leaf embroidery, low-cut cups, bare chest skin, sensual luxury lingerie",
        "seed": 505,
        "denoise": 0.68,
    },
    "saphir": {
        "label": "Cyber-Néon Saphir (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing futuristic cyber dark navy blue techwear bra, glowing cyan-blue neon circuit underwire strips, low-cut cups, bare chest skin, sci-fi tech luxury lingerie",
        "seed": 606,
        "denoise": 0.68,
    },
    "or": {
        "label": "Brocart & Chaînes d'Or (Échancré)",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, large breasts, deep cleavage, wearing opulent imperial gold brocade demi-bra, fine draped gold body-chains across bare chest and cleavage, scalloped gold lace, plunging neckline, sensual luxury lingerie",
        "seed": 707,
        "denoise": 0.68,
    },
}

NEG_PROMPT = "worst quality, low quality, bad anatomy, bad hands, text, watermark, deformed, ugly, bad proportions, blur, extra limbs, dark nipples"

def main():
    print("=== Starting Forge UI Inpaint Batch for 7 Lingerie Variations ===")
    results = {}
    for style_id, conf in BRA_CONFIGS.items():
        print(f"Generating '{style_id}' ({conf['label']})...")
        payload = {
            "init_images": [init_b64],
            "mask": mask_b64,
            "mask_blur": 4,
            "inpainting_fill": 1,
            "inpaint_full_res": False,
            "inpainting_mask_invert": 0,
            "prompt": conf["prompt"],
            "negative_prompt": NEG_PROMPT,
            "sampler_name": "Euler a",
            "steps": 25,
            "cfg_scale": 6.5,
            "width": 512,
            "height": 512,
            "seed": conf["seed"],
            "denoising_strength": conf["denoise"],
        }
        req = urllib.request.Request(
            "http://127.0.0.1:7860/sdapi/v1/img2img",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        t0 = time.time()
        res = urllib.request.urlopen(req, timeout=180)
        res_data = json.loads(res.read().decode("utf-8"))
        out_b64 = res_data["images"][0]
        out_im = Image.open(io.BytesIO(base64.b64decode(out_b64)))
        out_path = OUT_DIR / f"forge_bra_{style_id}.png"
        out_im.save(out_path)
        dt = time.time() - t0
        print(f"  Done in {dt:.1f}s -> {out_path.name}")
        results[style_id] = out_path

    print("=== All 7 Forge Plates Generated Successfully! ===")

if __name__ == "__main__":
    main()
