"""Generate 6 ultra-lewd/spicy bra variations via local Forge UI (Illustrious SDXL) inpaint API,
extract them into Transferania's 2.5D rig, and build the spicy comparison sheet.
"""
import json, base64, io, urllib.request, time, re
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

RIG = Path(r"c:\Transfert\assets\companion\rig-neutral-v1")
BRAS_DIR = RIG / "accessories" / "bras"
BRAS_DIR.mkdir(parents=True, exist_ok=True)

ART = Path(r"C:\Users\autm_\.gemini\antigravity\brain\bd3a32cb-4355-4140-94fa-e16e9e08ea4c")
SPICY_DIR = ART / "forge_spicy_bras"
SPICY_DIR.mkdir(parents=True, exist_ok=True)

SRC_PATH = RIG / "source.jpg"
src_im = Image.open(SRC_PATH).convert("RGB")
src_rgb = np.array(src_im, dtype=np.uint8)

# Load clean torso
def load_svg_rgba(svg_path: Path) -> Image.Image:
    p = svg_path.read_text(encoding="utf-8")
    m = re.search(r'transform="matrix\(([^)]+)\)"\s+href="data:image/png;base64,([A-Za-z0-9+/=]+)"', p)
    if m:
        vals = [float(x) for x in m.group(1).split()]
        im = Image.open(io.BytesIO(base64.b64decode(m.group(2)))).convert("RGBA")
        a, b, c, d, e, f = vals
        M = np.array([[a, c, e], [b, d, f], [0, 0, 1]], dtype=np.float64)
        Minv = np.linalg.inv(M)
        coeffs = (Minv[0, 0], Minv[0, 1], Minv[0, 2], Minv[1, 0], Minv[1, 1], Minv[1, 2])
        return im.transform((512, 512), Image.Transform.AFFINE, coeffs, resample=Image.Resampling.BICUBIC)
    m2 = re.search(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", p)
    return Image.open(io.BytesIO(base64.b64decode(m2.group(2)))).convert("RGBA")

def render_user_svg_512(svg_path: Path) -> Image.Image:
    out = load_svg_rgba(svg_path)
    arr = np.array(out, dtype=np.float32)
    for y in range(512):
        if y <= 278:
            w = 0.0
        elif y < 290:
            w = 0.25 * (y - 278) / 12.0
        elif y < 312:
            w = 0.25 + 0.75 * (y - 290) / 22.0
        else:
            w = 1.0
        arr[y, :, 3] *= w
    rgb = Image.fromarray(np.clip(arr[:, :, :3], 0, 255).astype(np.uint8), "RGB")
    alpha = Image.fromarray(np.clip(arr[:, :, 3], 0, 255).astype(np.uint8), "L").filter(
        ImageFilter.GaussianBlur(radius=0.55)
    )
    rgba = np.dstack([np.array(rgb), np.array(alpha)])
    return Image.fromarray(rgba, "RGBA")

clean_im = load_svg_rgba(RIG / "torso-clean.svg").convert("RGB")
clean_rgb = np.array(clean_im, dtype=np.uint8)

l_ref = render_user_svg_512(RIG / "breast-left-user.svg")
r_ref = render_user_svg_512(RIG / "breast-right-user.svg")

# Inpaint mask for Forge
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

# Base torso alpha mask for live garment-surface layer
def build_base_torso_mask():
    m = Image.new("L", (512, 512), 0)
    d = ImageDraw.Draw(m)
    p = [
        (162, 260),
        (350, 260),
        (408, 300),
        (438, 350),
        (444, 405),
        (434, 450),
        (418, 495),
        (412, 511),
        (98, 511),
        (88, 485),
        (64, 455),
        (48, 420),
        (48, 375),
        (72, 330),
        (114, 296),
    ]
    d.polygon(p, fill=255)
    poly_arr = np.array(m, dtype=np.float32) / 255.0
    l_a = np.array(l_ref, dtype=np.float32)[:, :, 3] / 255.0
    r_a = np.array(r_ref, dtype=np.float32)[:, :, 3] / 255.0
    combined = np.maximum(poly_arr, np.maximum(l_a, r_a))
    ys = np.arange(512, dtype=np.float32)[:, None]
    top_fade = np.clip((ys - 258.0) / 24.0, 0.0, 1.0)
    combined *= top_fade
    alpha_im = Image.fromarray(np.clip(combined * 255.0, 0, 255).astype(np.uint8), "L").filter(
        ImageFilter.GaussianBlur(radius=1.8)
    )
    return np.array(alpha_im, dtype=np.uint8)

base_mask = build_base_torso_mask()

def build_clean_plate_rgb(plate_rgb):
    p = plate_rgb.astype(np.float32)
    s = src_rgb.astype(np.float32)
    c = clean_rgb.astype(np.float32)
    curl_diff = np.sqrt(np.sum((s - c) ** 2, axis=2))
    ys = np.arange(512)[:, None]
    xs = np.arange(512)[None, :]
    curl_mask = np.clip((curl_diff - 14.0) / 22.0, 0.0, 1.0) * ((ys >= 245) & (ys <= 302)).astype(np.float32)
    bra_diff = np.sqrt(np.sum((p - s) ** 2, axis=2))
    central_zone = ((xs >= 166) & (xs <= 348)) | (ys >= 289)
    keep_bra = np.clip((bra_diff - 32.0) / 22.0, 0.0, 1.0) * central_zone.astype(np.float32)
    replace_w = (curl_mask * (1.0 - keep_bra))[:, :, None]
    out = p * (1.0 - replace_w) + c * replace_w
    return np.clip(out, 0, 255).astype(np.uint8)

SPICY_CONFIGS = {
    "cupless": {
        "label": "Bonnets Ouverts Cupless",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, huge breasts, deep cleavage, wearing extremely lewd erotic open-cup underwire bra, cupless shelf bra, bare breasts, exposed cleavage, tiny thin black lace trim under breasts, sensual erotic lingerie, detailed skin",
        "seed": 999,
        "denoise": 0.72,
    },
    "micro_fil": {
        "label": "Micro-Ficelle Rouge",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, huge breasts, deep cleavage, wearing extremely lewd micro string bikini bra, tiny micro red satin triangle cups, thin red string cords, exposed bare breasts, massive cleavage, sensual erotic lingerie, detailed skin",
        "seed": 1111,
        "denoise": 0.70,
    },
    "sheer_mesh": {
        "label": "Voile Blanc Transparent",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, huge breasts, deep cleavage, wearing completely sheer transparent white gossamer tulle bralette, see-through delicate white lace trim, bare breasts visible underneath, deep plunge, sensual erotic lingerie, detailed skin",
        "seed": 2222,
        "denoise": 0.68,
    },
    "chaine_bijou": {
        "label": "Pasties d'Or & Chaînes",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, huge breasts, deep cleavage, wearing erotic sparkling gold pasties and draped gold body chains across bare breasts and cleavage, no bra fabric, bare skin, gold chains jewelry, sensual erotic lingerie, detailed skin",
        "seed": 3333,
        "denoise": 0.72,
    },
    "bondage_vinyle": {
        "label": "Vinyle Fendu & Harnais",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, huge breasts, deep cleavage, wearing glossy black vinyl open cup bra, open cleavage, bondage leather straps, silver O-ring on sternum, shiny latex texture, sensual dominatrix lingerie, detailed skin",
        "seed": 4444,
        "denoise": 0.70,
    },
    "ruban_soie": {
        "label": "Ruban Cadeau Dénoué",
        "prompt": "masterpiece, best quality, very aesthetic, 1girl, solo, purple hair, orange eyes, huge breasts, deep cleavage, wearing a single loose pink silk ribbon tied across bare breasts, untied bow between cleavage, bare chest skin, sensual erotic lingerie, detailed skin",
        "seed": 5555,
        "denoise": 0.70,
    },
}

NEG_PROMPT = "worst quality, low quality, bad anatomy, bad hands, text, watermark, deformed, ugly, bad proportions, blur, extra limbs, dark nipples"

def main():
    print("=== Generating 6 Extra-Lewd Spicy Bras via Forge UI ===")
    previews = []

    # Original Noir as baseline
    comp0 = src_im.copy().convert("RGBA")
    comp0.alpha_composite(l_ref)
    comp0.alpha_composite(r_ref)
    previews.append(("Noir Dentelle (Origine)", comp0.crop((40, 255, 472, 505))))

    for style_id, conf in SPICY_CONFIGS.items():
        out_raw_path = SPICY_DIR / f"forge_spicy_{style_id}.png"
        if not out_raw_path.exists():
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
            out_im.save(out_raw_path)
            print(f"  Generated in {time.time()-t0:.1f}s")
        else:
            out_im = Image.open(out_raw_path)
            print(f"Loaded existing {out_raw_path.name}")

        plate_rgb = np.array(out_im.convert("RGB"), dtype=np.uint8)
        clean_plate = build_clean_plate_rgb(plate_rgb)

        base_bra = Image.fromarray(np.dstack([clean_plate, base_mask]), "RGBA")
        l_bra = Image.fromarray(np.dstack([clean_plate, np.array(l_ref)[:, :, 3]]), "RGBA")
        r_bra = Image.fromarray(np.dstack([clean_plate, np.array(r_ref)[:, :, 3]]), "RGBA")

        b_out = BRAS_DIR / f"bra-{style_id}-base.webp"
        l_out = BRAS_DIR / f"bra-{style_id}-left.webp"
        r_out = BRAS_DIR / f"bra-{style_id}-right.webp"
        base_bra.save(b_out, "WEBP", lossless=True, quality=100)
        l_bra.save(l_out, "WEBP", lossless=True, quality=100)
        r_bra.save(r_out, "WEBP", lossless=True, quality=100)

        comp = src_im.copy().convert("RGBA")
        comp.alpha_composite(base_bra)
        comp.alpha_composite(l_bra)
        comp.alpha_composite(r_bra)
        previews.append((conf["label"], comp.crop((40, 255, 472, 505))))
        print(f"  Extracted -> {b_out.name}, {l_out.name}, {r_out.name}")

    # Build comparison grid (7 items = 2 cols x 4 rows)
    cw, ch = previews[0][1].size
    grid = Image.new("RGB", (cw * 2, (ch + 28) * 4), (20, 14, 24))
    draw = ImageDraw.Draw(grid)
    for idx, (lbl, im) in enumerate(previews):
        gx = (idx % 2) * cw
        gy = (idx // 2) * (ch + 28)
        grid.paste(im.convert("RGB"), (gx, gy + 28))
        draw.text((gx + 12, gy + 6), f"🌶️ {lbl}", fill=(255, 180, 210))
    preview_path = ART / "ai_bras_spicy_comparison.jpg"
    grid.save(preview_path, quality=94)
    print("Saved spicy comparison sheet to", preview_path)

if __name__ == "__main__":
    main()
