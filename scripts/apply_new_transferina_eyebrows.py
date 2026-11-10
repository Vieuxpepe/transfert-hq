import os
import re
import sys
from PIL import Image
import numpy as np
from scipy.ndimage import map_coordinates

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import companion_face_assets as face_assets

WORKSPACE = r'c:\Transfert'
FACE_PNG = os.path.join(WORKSPACE, 'assets', 'companion', 'rig-neutral-v1', 'face.png')
FACE_SVG = os.path.join(WORKSPACE, 'assets', 'companion', 'rig-neutral-v1', 'face.svg')
CSS_FILE = os.path.join(WORKSPACE, 'assets', 'hq-companion.css')

clean_face = Image.open(os.path.join(WORKSPACE, 'scratch', 'clean_face_no_brows.png')).convert('RGBA')
brow_l_raw = Image.open(os.path.join(WORKSPACE, 'scratch', 'user_brow_left.png')).convert('RGBA')
brow_r_raw = Image.open(os.path.join(WORKSPACE, 'scratch', 'user_brow_right.png')).convert('RGBA')

def compress_outer_towards_inner(img, side='left', p=0.50):
    """
    Compress the outside corners of each eyebrow towards the inside corner.
    """
    arr = np.array(img).astype(np.float32)
    H, W, C = arr.shape
    yy, xx = np.mgrid[0:H, 0:W]
    u = xx / (W - 1)
    if side == 'left':
        u_in = u ** p
    else:
        u_in = 1.0 - (1.0 - u) ** p
    v = yy
    x_in = u_in * (W - 1)
    coords = np.array([v, x_in])
    out_arr = np.zeros_like(arr)
    for c in range(C):
        out_arr[:, :, c] = map_coordinates(arr[:, :, c], coords, order=1, mode='constant', cval=0)
    return Image.fromarray(np.clip(out_arr, 0, 255).astype(np.uint8))

def tilt_outside_corner_down(img, angle_deg=10):
    """
    Tilt the outside corner (the outer tail) downwards by angle_deg.
    """
    arr = np.array(img).astype(np.float32)
    H, W, C = arr.shape
    yy, xx = np.mgrid[0:H, 0:W]
    u = xx / (W - 1)
    theta = np.radians(angle_deg)
    disp = np.maximum(0.0, 0.6 - u) * (W - 1) * np.tan(theta)
    v = yy - disp
    x_in = xx
    coords = np.array([v, x_in])
    out_arr = np.zeros_like(arr)
    for c in range(C):
        out_arr[:, :, c] = map_coordinates(arr[:, :, c], coords, order=1, mode='constant', cval=0)
    return Image.fromarray(np.clip(out_arr, 0, 255).astype(np.uint8))

def tilt_right_tail_down(img, angle_deg=5, start_u=0.45):
    """
    Tilt the right eyebrow outside tail downwards to match feminine eye orbit curve.
    """
    arr = np.array(img).astype(np.float32)
    H, W, C = arr.shape
    yy, xx = np.mgrid[0:H, 0:W]
    u = xx / (W - 1)
    theta = np.radians(angle_deg)
    disp = np.maximum(0.0, u - start_u) * (W - 1) * np.tan(theta)
    v = yy - disp
    x_in = xx
    coords = np.array([v, x_in])
    out_arr = np.zeros_like(arr)
    for c in range(C):
        out_arr[:, :, c] = map_coordinates(arr[:, :, c], coords, order=1, mode='constant', cval=0)
    return Image.fromarray(np.clip(out_arr, 0, 255).astype(np.uint8))

# 1. Process Left Brow: compress outside towards inside (p=0.50), tilt outside corner down 10 deg, rotate +8 deg
w_l = compress_outer_towards_inner(brow_l_raw, 'left', p=0.50)
bent_l = tilt_outside_corner_down(w_l, angle_deg=10)
arr_l = np.array(bent_l)
yl, xl = np.where(arr_l[:, :, 3] > 10)
tight_l = bent_l.crop((xl.min(), yl.min(), xl.max() + 1, yl.max() + 1))

r_l = tight_l.rotate(8, resample=Image.BICUBIC, expand=True)
arr_rl = np.array(r_l)
yrl, xrl = np.where(arr_rl[:, :, 3] > 10)
tight_rl = r_l.crop((xrl.min(), yrl.min(), xrl.max() + 1, yrl.max() + 1))

target_w_l = 134
target_h_l = int(round(tight_rl.height * (target_w_l / tight_rl.width)))
b_l = tight_rl.resize((target_w_l, target_h_l), Image.LANCZOS)

# Position left brow slightly closer to the right brow: xl = 444, yl = 275
xl, yl = 444, 275

# 2. Process Right Brow: compress outside towards inside (p=0.50), curve tail down 5 deg, scale to target_w_r=134
w_r = compress_outer_towards_inner(brow_r_raw, 'right', p=0.50)
bent_r = tilt_right_tail_down(w_r, angle_deg=5, start_u=0.45)
arr_r = np.array(bent_r)
yr, xr = np.where(arr_r[:, :, 3] > 10)
tight_r = bent_r.crop((xr.min(), yr.min(), xr.max() + 1, yr.max() + 1))

target_w_r = 134
target_h_r = int(round(tight_r.height * (target_w_r / tight_r.width)))
b_r = tight_r.resize((target_w_r, target_h_r), Image.LANCZOS)
xr, yr = 658, 228

# Paste onto clean face canvas
canvas = clean_face.copy()
canvas.paste(b_l, (xl, yl), b_l)
canvas.paste(b_r, (xr, yr), b_r)

print(f"1. Saving full face.png (size={canvas.size})...")
canvas.save(FACE_PNG, format='PNG')

print("2. Re-encoding face.svg...")
face_assets.write_face_svg()
print("face.svg saved.")

print("3. Updating hq-companion.css clip-paths and transform-origins...")
with open(CSS_FILE, 'r', encoding='utf-8') as f:
    css = f.read()

# The clip ends just under each brow with a soft fade: the moving layer must never include the eyelid.
# Replace left brow
css = re.sub(
    r'\.hq-companion-rig-face-brow-left\{[^}]*\}',
    '''.hq-companion-rig-face-brow-left{
  clip-path:inset(15.4% 52.0% 79.7% 35.3%);
  -webkit-mask-image:linear-gradient(to bottom,#000 0 19.2%,transparent 20.3%);
  mask-image:linear-gradient(to bottom,#000 0 19.2%,transparent 20.3%);
  --rig-brow-x:0px;
  --rig-brow-y:var(--rig-brow-left-y,0px);
  --rig-brow-rot:var(--rig-brow-left-rot,0deg);
  transform-origin:41.7% 19.9%;
}''',
    css
)

# Replace right brow
css = re.sub(
    r'\.hq-companion-rig-face-brow-right\{[^}]*\}',
    '''.hq-companion-rig-face-brow-right{
  clip-path:inset(12.3% 36.6% 82.6% 50.7%);
  -webkit-mask-image:linear-gradient(to bottom,#000 0 16.4%,transparent 17.4%);
  mask-image:linear-gradient(to bottom,#000 0 16.4%,transparent 17.4%);
  --rig-brow-x:0px;
  --rig-brow-y:var(--rig-brow-right-y,0px);
  --rig-brow-rot:var(--rig-brow-right-rot,0deg);
  transform-origin:57.0% 15.6%;
}''',
    css
)

with open(CSS_FILE, 'w', encoding='utf-8') as f:
    f.write(css)

print("4. Rebuilding face.webp (the image the page actually loads) and bumping its cache tag...")
# The runtime loads face.webp, not face.svg: without this step the new face never reaches the screen.
changed = face_assets.sync_face_webp()
print(f"face.webp {'rebuilt' if changed else 'already current'}, cache tag px{face_assets.current_tag()}.")

print("DEPLOYMENT OF ARCHED RIGHT BROW COMPLETE!")
