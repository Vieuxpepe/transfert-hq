"""Transferania companion portraits via local Forge (Stable Diffusion WebUI).

Admin-only bridge routes call this module. Images land under assets/companion/.
"""

from __future__ import annotations

import base64
import io
import json
import re
import secrets
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import hq_forge as forge
from hq_forge_worker import submission_body

COMPANION_ASSETS = Path("assets") / "companion"
CHAT_ASSETS = COMPANION_ASSETS / "chat"
FORGE_STORE = Path(".hq-ai") / "companion_forge.json"
REFERENCE_IMAGE = "companion-forge-reference.jpg"
CHARACTER_SHEET_IMAGE = "companion-character-sheet.jpg"
# Default when no IP-Adapter weights: reference_only + model "None".
DEFAULT_CONTROLNET_MODULE = "reference_only"
DEFAULT_CONTROLNET_MODEL = "None"
DEFAULT_CONTROLNET_WEIGHT = 0.72
IPADAPTER_FACE_HINT = "ip-adapter-plus-face_sdxl"
IPADAPTER_MODULE_SDXL = "CLIP-ViT-bigG (IPAdapter)"
IPADAPTER_MODULE_FACE = "InsightFace+CLIP-H (IPAdapter)"
DEFAULT_IPADAPTER_WEIGHT = 0.88
CONTROL_MODE_CONTROL = "ControlNet is more important"

_CN_MODELS_AT = 0.0
_CN_MODELS: list[str] = []
# perf10: cache for the read-only Forge status probe used by GET /api/companion/art.
_STATUS_OK_TTL = 60.0
_STATUS_FAIL_TTL = 10.0
_STATUS_PRECHECK_SEC = 0.4
_STATUS_LOCK = threading.Lock()
_STATUS_CACHE: dict = {}

# Fast preview size (SDXL-friendly minimum; circle UI crops center).
CANVAS_WIDTH = 512
CANVAS_HEIGHT = 512
DEFAULT_STEPS = 16
DEFAULT_CFG = 4.5
DEFAULT_SAMPLER = "DPM++ 2M"
DEFAULT_SCHEDULER = "Karras"
JOB_TIMEOUT = 600.0
JPEG_QUALITY = 82
FORGE_RANDOM_SEED = -1  # API alias: pick a new random seed for this request


def _roll_seed(seed: int | None) -> int:
    """Forge txt2img seed. -1 / omitted → cryptographically random each call."""
    if seed is None or seed == FORGE_RANDOM_SEED:
        return secrets.randbelow(2**32 - 1)
    return int(seed)

CHARACTER_CORE = (
    "masterpiece, best quality, "
    "transferania, 1woman, solo, same character, same face, identical face, "
    "mature adult, fair skin, warm undertone, pink blush on cheeks, "
    "long wavy purple hair, magenta hair, amber eyes, golden eyes, full lips, dark red lipstick, heavy eyelashes, "
    "voluptuous, large breasts, narrow waist, wide hips, black lace lingerie"
)

CHARACTER_CORE_NUDE = (
    "masterpiece, best quality, "
    "transferania, 1woman, solo, same character, same face, identical face, "
    "mature adult, fair skin, warm undertone, pink blush on cheeks, "
    "long wavy purple hair, magenta hair, amber eyes, golden eyes, full lips, dark red lipstick, heavy eyelashes, "
    "voluptuous, large breasts, narrow waist, wide hips, nude, naked"
)

NEGATIVE = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, "
    "watermark, username, blurry, child, loli, shota, underage, "
    "multiple girls, 2girls, duplicate, deformed, different face, face change"
)

POSE_LINGERIE_CORE_IDS: frozenset[str] = frozenset({"portrait-neutral", "portrait-soft", "portrait-warm"})

_POSE_NEGATIVE_SUFFIX: dict[str, str] = {
    "oral": ", extra penis, multiple penises, bad teeth, tongue deform",
    "paizuri": ", extra arms, bad hands, duplicate torso",
    "vaginal": ", extra penis, censored, bar censor",
    "anal": ", prolapse exaggerated, gore, censored",
    "multi": ", 2boys, male face, yaoi, futanari, extra girl, 3girls, second person face, extra limbs",
    "bondage": ", rope burn gore, blood, censored",
}


def _negative_family(pose_id: str) -> str:
    if pose_id.startswith("hx-"):
        return "multi"
    if any(x in pose_id for x in ("bj", "deepthroat", "facefuck", "throat", "rhythm-lick", "rhythm-bob")):
        return "oral"
    if "paizuri" in pose_id:
        return "paizuri"
    if any(x in pose_id for x in ("anal", "gape")):
        return "anal"
    if any(x in pose_id for x in ("doggy", "missionary", "cowgirl", "creampie", "mating", "prone", "dp", "double")):
        return "vaginal"
    if "bondage" in pose_id or "suspended" in pose_id or "collar" in pose_id:
        return "bondage"
    if pose_id.startswith("hc-"):
        return "vaginal"
    return ""


def character_core_for_pose(pose_id: str) -> str:
    if pose_id in POSE_LINGERIE_CORE_IDS:
        return CHARACTER_CORE
    return CHARACTER_CORE_NUDE


def negative_for_pose(pose_id: str) -> str:
    fam = _negative_family(pose_id)
    extra = _POSE_NEGATIVE_SUFFIX.get(fam, "")
    return NEGATIVE + extra


_companion_forge_lock = threading.Lock()

POSE_DEFAULT_DEST: dict[str, str] = {
    "portrait-neutral": "transferania-adult-neutral.jpg",
    "portrait-soft": "transferania-adult-soft.jpg",
    "portrait-warm": "transferania-adult-warm.jpg",
    "portrait-lewd": "transferania-adult-lewd.jpg",
    "rhythm-bob": "transferania-adult-rhythm.jpg",
    "rhythm-lick": "transferania-adult-rhythm-lick.jpg",
    "rhythm-finish": "transferania-adult-rhythm-finish.jpg",
    "missionary-legs-up": "transferania-adult-missionary.jpg",
    "face-down-ass-up": "transferania-adult-face-down.jpg",
    "shower-wet": "transferania-adult-shower.jpg",
    "desk-bent-over": "transferania-adult-desk.jpg",
    "mirror-selfie-nude": "transferania-adult-mirror-selfie.jpg",
    "bondage-light": "transferania-adult-bondage.jpg",
    "reverse-cowgirl": "transferania-adult-reverse-cowgirl.jpg",
    "wall-pin-standing": "transferania-adult-wall-pin.jpg",
    "stomach-feet-up": "transferania-adult-stomach-feet.jpg",
    "bath-bubbles": "transferania-adult-bath.jpg",
    "chair-straddle-back": "transferania-adult-chair.jpg",
    "lingerie-peel": "transferania-adult-peel.jpg",
    "pole-dance-tease": "transferania-adult-pole.jpg",
    "spoon-side-nude": "transferania-adult-spoon.jpg",
    "lap-straddle-grind": "transferania-adult-lap.jpg",
    "split-stretch-tease": "transferania-adult-split.jpg",
    "against-glass": "transferania-adult-glass.jpg",
    "kneeling-collar": "transferania-adult-collar.jpg",
    "booty-arch-mirror": "transferania-adult-arch-mirror.jpg",
    "chat-spicy": "transferania-adult-all-fours.jpg",
    "doggystyle-lookback": "transferania-adult-doggy.jpg",
    "cowgirl-straddle": "transferania-adult-cowgirl.jpg",
    "hc-bj-pov": "transferania-adult-hc-bj.jpg",
    "hc-deepthroat-pov": "transferania-adult-hc-deepthroat.jpg",
    "hc-paizuri-pov": "transferania-adult-hc-paizuri.jpg",
    "hc-missionary-pov": "transferania-adult-hc-missionary.jpg",
    "hc-doggy-pov": "transferania-adult-hc-doggy.jpg",
    "hc-cowgirl-ride": "transferania-adult-hc-cowgirl-ride.jpg",
    "hc-creampie": "transferania-adult-hc-creampie.jpg",
    "hc-spread-pussy": "transferania-adult-hc-spread.jpg",
    "hc-fingering": "transferania-adult-hc-fingering.jpg",
    "hc-anal-doggy": "transferania-adult-hc-anal.jpg",
    "hc-facefuck": "transferania-adult-hc-facefuck.jpg",
    "hc-cum-covered": "transferania-adult-hc-cum.jpg",
    "hx-double-penetration": "transferania-adult-hx-dp.jpg",
    "hx-mating-press": "transferania-adult-hx-mating-press.jpg",
    "hx-prone-bone-rough": "transferania-adult-hx-prone-bone.jpg",
    "hx-gangbang-surround": "transferania-adult-hx-gangbang.jpg",
    "hx-ahegao-intercourse": "transferania-adult-hx-ahegao.jpg",
    "hx-throatpie-overflow": "transferania-adult-hx-throatpie.jpg",
    "hx-leash-plug-crawl": "transferania-adult-hx-petplay.jpg",
    "hx-breeding-overflow": "transferania-adult-hx-breeding.jpg",
    "hx-69-pov": "transferania-adult-hx-69.jpg",
    "hx-public-exhibition": "transferania-adult-hx-public.jpg",
    "hx-suspended-spread": "transferania-adult-hx-suspended.jpg",
    "hx-rough-anal-gape": "transferania-adult-hx-anal-gape.jpg",
    "hx-fucked-silly": "transferania-adult-hx-broken.jpg",
}

EXTREME_POSE_IDS: frozenset[str] = frozenset(
    {
        "hx-double-penetration",
        "hx-mating-press",
        "hx-prone-bone-rough",
        "hx-gangbang-surround",
        "hx-ahegao-intercourse",
        "hx-throatpie-overflow",
        "hx-leash-plug-crawl",
        "hx-breeding-overflow",
        "hx-69-pov",
        "hx-public-exhibition",
        "hx-suspended-spread",
        "hx-rough-anal-gape",
        "hx-fucked-silly",
    }
)

HARDCORE_POSE_IDS: frozenset[str] = frozenset(
    {
        "hc-bj-pov",
        "hc-deepthroat-pov",
        "hc-paizuri-pov",
        "hc-missionary-pov",
        "hc-doggy-pov",
        "hc-cowgirl-ride",
        "hc-creampie",
        "hc-spread-pussy",
        "hc-fingering",
        "hc-anal-doggy",
        "hc-facefuck",
        "hc-cum-covered",
        "rhythm-bob",
        "rhythm-lick",
        "rhythm-finish",
    }
) | EXTREME_POSE_IDS

POSE_PROMPTS: dict[str, dict[str, str | int | dict[str, tuple[str, ...]]]] = {
    "rhythm-lick": {
        "prompt_base": (
            "close-up portrait, face focus, looking at viewer, seductive half-lidded eyes, "
            "open mouth, tongue out, licking, glossy lips, "
            "nude, pov blowjob tease, erect penis tip at lips"
        ),
        "tag_pools": {
            "saliva": ("saliva string", "drool strand", "glossy wet lips", "shiny tongue"),
            "eyes": ("half-lidded bedroom eyes", "looking up at viewer", "teary lustful eyes"),
            "light": ("soft bedroom lighting", "warm rim light", "dim lamp glow", "moonlight through curtains"),
            "depth": ("shallow depth of field", "bokeh background", "soft focus background"),
            "extra": ("messy hair strands", "flushed cheeks", "nose blush", "heavy breathing"),
            "composition": ("extreme close-up face", "dutch angle portrait", "from above pov", "low angle looking up"),
        },
    },
    "rhythm-bob": {
        "prompt_base": (
            "close-up portrait, face focus, looking up at viewer, "
            "open mouth, deep throat pose, "
            "nude, pov, hands on thighs"
        ),
        "tag_pools": {
            "face": ("tears at eyes", "runny mascara", "messy lipstick", "saliva on chin"),
            "motion": ("motion blur hint", "bobbing motion", "throat bulge subtle"),
            "light": ("warm rim light", "overhead soft light", "screen glow on face"),
            "extra": ("sweaty skin sheen", "disheveled hair", "determined eyes", "submissive expression"),
            "composition": ("dynamic motion framing", "pov from above", "side angle profile", "centered deepthroat framing"),
        },
    },
    "rhythm-finish": {
        "prompt_base": (
            "close-up portrait, face focus, looking at viewer, surprised bliss, "
            "open mouth, facial, cum on face, cum on lips, "
            "messy hair, glossy skin, nude, after blowjob"
        ),
        "tag_pools": {
            "finish": ("cum strings", "cum drip on chin", "cum on cheek", "cum on tongue"),
            "expression": ("ahegao lite", "dazed smile", "satisfied blush", "eyes half closed"),
            "light": ("warm afterglow light", "soft window light", "candlelit bedroom"),
            "extra": ("smudged lipstick", "wet lashes", "messy bangs", "glistening skin"),
        },
    },
    "portrait-neutral": {
        "prompt_base": "upper body portrait, looking at viewer, bedroom, seductive",
        "tag_pools": {
            "expression": ("soft smile", "bedroom eyes", "parted lips", "knowing smirk", "lustful half-lidded eyes"),
            "outfit": (
                "black lace lingerie",
                "sheer lace bra and panties",
                "strappy black bodysuit",
                "topless, hands covering breasts",
                "micro lace bikini",
                "garter belt and stockings",
            ),
            "light": ("warm light", "soft window light", "golden hour glow", "diffused lamp light"),
            "pose": ("hand on thigh", "arch back subtle", "leaning forward cleavage", "sitting on bed legs apart"),
        },
    },
    "portrait-soft": {
        "prompt_base": "upper body portrait, bedroom, intimate atmosphere",
        "tag_pools": {
            "expression": ("gentle smile", "soft eyes", "shy smile", "dreamy look"),
            "outfit": ("pastel lace lingerie", "white sheer babydoll", "soft pink bralette", "delicate floral lace"),
            "light": ("warm light", "rose-tinted lamp", "morning sunlight haze", "soft bokeh lights"),
            "mood": ("cozy blankets", "pillow nest", "curtain backdrop", "vanilla tones"),
        },
    },
    "portrait-warm": {
        "prompt_base": "upper body portrait, inviting presence, bedroom, explicit tease",
        "tag_pools": {
            "expression": ("inviting smile", "bedroom eyes", "knowing smirk", "moaning expression subtle", "ahegao lite"),
            "outfit": (
                "red lace lingerie",
                "black satin robe open",
                "crimson bodysuit",
                "topless, panties only",
                "sheer babydoll lifted",
            ),
            "light": ("candlelight", "fireplace glow", "amber lamp light", "sunset through blinds"),
            "mood": ("rumpled sheets", "steamy air", "velvet sheets", "warm skin flush"),
        },
    },
    "portrait-lewd": {
        "prompt_base": (
            "full body on bed, legs spread suggestive, looking at viewer, "
            "explicit aroused, bedroom, messy sheets"
        ),
        "tag_pools": {
            "wear": ("lace panties aside", "topless glistening skin", "wet spot on sheets subtle", "stockings only"),
            "pose": ("fingering tease", "back arched", "hips raised", "on knees presenting"),
            "face": ("drool strand", "heavy blush", "lust drunk eyes", "open mouth panting"),
            "extra": ("sweat droplets", "disheveled hair", "love bite mark neck", "hand between legs"),
        },
    },
    "chat-spicy": {
        "prompt_base": "full body, on all fours on bed, arched back, looking back at viewer, seductive, bedroom",
        "tag_pools": {
            "wear": ("black thong", "micro bikini", "lace g-string", "topless, panties only"),
            "light": ("warm lamp", "neon accent subtle", "soft spotlight", "dim club lighting"),
            "pose": ("hip emphasis", "back dimples", "hair over shoulder", "bite lip"),
        },
    },
    "booty-arch-mirror": {
        "prompt_base": (
            "full body, kneeling on bed, deeply arched back, presenting booty, looking back over shoulder, "
            "sensual expression, large mirror reflection showing front and back, seductive bedroom"
        ),
        "tag_pools": {
            "butt": ("curved round buttocks", "hip emphasis", "back dimples", "butt focus"),
            "wear": ("sheer black lace thong", "strappy g-string", "garter belt straps", "micro lace panties"),
            "expression": ("bedroom eyes", "parted glossy lips", "flushed pink cheeks", "seductive smirk"),
            "lighting": ("candlelight rim light", "warm shadows", "golden ambient glow", "mirror reflection highlights"),
        },
    },
    "cowgirl-straddle": {
        "prompt_base": (
            "pov from below, sitting on viewer hips, straddling, leaning forward, hands on viewer chest, "
            "cleavage focus, looking down at viewer with desire, sweaty skin sheen, intimate bedroom"
        ),
        "tag_pools": {
            "expression": ("pleasure flushed face", "heavy breathing", "half-closed lustful eyes", "biting lip"),
            "wear": ("unhooked black lace bra", "bare shoulders", "silk chemise pulled up", "strappy lingerie"),
            "motion": ("hip motion blur subtle", "tousled purple hair", "sensual bounce hint"),
            "lighting": ("dim bedside lamp", "warm rim light on curves", "steamy atmosphere"),
        },
    },
    "doggystyle-lookback": {
        "prompt_base": (
            "on all fours on mattress, elbows on bed, head turned looking back at viewer, raised hips, arched spine, "
            "sensual submissive expression, close-up on arched lower back and hips, bedroom"
        ),
        "tag_pools": {
            "booty": ("voluptuous round booty", "toned thighs", "thong pulled aside subtle", "curved silhouette"),
            "expression": ("eager submissive gaze", "runny mascara subtle", "glossy parted lips", "cheeks flushed crimson"),
            "lighting": ("twilight bedroom light", "soft highlight along spine", "sensual shadow play"),
            "extra": ("messy wavy magenta hair cascading over shoulder", "heavy breathing", "aroused blush"),
        },
    },
    "against-glass": {
        "prompt_base": (
            "upper body close-up, pressed against glass window, hands pressed on glass, face close to viewer, "
            "steamy condensation around lips and breath, looking directly into camera with intense longing, bedroom window"
        ),
        "tag_pools": {
            "glass": ("foggy breath on glass", "condensation droplets", "finger traces on steam", "pressed skin against glass"),
            "expression": ("hungry lustful stare", "lips pressed near glass", "aroused expression", "bedroom eyes"),
            "wear": ("sheer black lace lingerie", "slip dress clinging to body", "bare collarbone"),
            "lighting": ("city lights bokeh background", "soft neon rim light", "moonlight reflections on glass"),
        },
    },
    "kneeling-collar": {
        "prompt_base": (
            "kneeling on bed on heels, posture erect and arched, chest pushed forward, obedient posture, "
            "looking up at viewer with total devotion, waiting for master command, luxurious boudoir"
        ),
        "tag_pools": {
            "expression": ("devoted gaze", "submissive smile", "blushing cheeks", "eyes wide with anticipation"),
            "wear": ("black velvet collar with small gold ring", "black lace corset lingerie", "silk stockings"),
            "lighting": ("dramatic soft spotlight from above", "velvet bedsheets", "warm amber backlight"),
        },
    },
    "missionary-legs-up": {
        "prompt_base": (
            "full body on bed, lying on back, legs up and spread, knees bent toward chest, "
            "looking at viewer, pov from above, explicit aroused, messy sheets, intimate bedroom"
        ),
        "tag_pools": {
            "wear": ("topless", "lace panties aside", "nude glistening skin", "stockings and garter only"),
            "face": ("lustful half-lidded eyes", "open mouth panting", "heavy blush", "bedroom eyes"),
            "pose": ("ankles held", "hips raised subtle", "hand between legs tease", "inviting spread"),
            "light": ("warm bedside lamp", "soft overhead light", "candlelit glow", "sunset through curtains"),
        },
    },
    "face-down-ass-up": {
        "prompt_base": (
            "full body, face down on pillow, ass up high, arched back, looking back at viewer over shoulder, "
            "presenting from behind, explicit tease, luxurious bed"
        ),
        "tag_pools": {
            "butt": ("round voluptuous ass", "back dimples", "hip emphasis", "thong pulled aside subtle"),
            "face": ("muffled moan expression", "flushed cheeks", "messy hair on pillow", "submissive gaze"),
            "wear": ("micro lace thong", "topless", "garter straps visible", "sheer panties"),
            "extra": ("rumpled sheets", "sweat sheen", "love bite on shoulder", "hand gripping sheet"),
        },
    },
    "shower-wet": {
        "prompt_base": (
            "full body in shower, wet tile walls, water streaming down skin, steamy atmosphere, "
            "looking at viewer, one hand on wall, explicit nude tease"
        ),
        "tag_pools": {
            "water": ("water droplets on skin", "wet hair clinging", "steam fog", "soap suds on curves"),
            "pose": ("hand between thighs tease", "back arched under showerhead", "pressing against glass door", "kneeling on tile"),
            "face": ("eyes closed pleasure", "open mouth", "water on lips", "sultry wet gaze"),
            "light": ("cool blue tile contrast", "warm skin tones", "backlit steam halo", "soft bathroom light"),
        },
    },
    "desk-bent-over": {
        "prompt_base": (
            "full body bent over wooden desk, skirt lifted, looking back at viewer, office-bedroom hybrid, "
            "caught in the act expression, explicit rear emphasis"
        ),
        "tag_pools": {
            "wear": ("pencil skirt hiked up", "lace panties pulled down thighs", "unbuttoned blouse open", "thong aside"),
            "pose": ("hands flat on desk", "one leg slightly apart", "arch emphasizing curves", "biting lip look back"),
            "prop": ("scattered papers", "dim desk lamp", "wine glass knocked over", "high heels"),
            "light": ("warm desk lamp spotlight", "evening window glow", "dramatic shadow on curves"),
        },
    },
    "mirror-selfie-nude": {
        "prompt_base": (
            "full body mirror selfie, holding smartphone, nude reflection, bedroom mirror, "
            "looking at viewer through mirror, private leaked photo vibe, explicit"
        ),
        "tag_pools": {
            "phone": ("smartphone in hand", "screen glow on face", "mirror flash subtle", "selfie angle"),
            "pose": ("hip cocked", "peace sign tease", "tongue out playful", "covering breasts one hand"),
            "wear": ("completely nude", "towel dropping", "lingerie half removed", "only choker"),
            "room": ("messy bed reflection", "string lights bokeh", "vanity makeup scattered", "steamy mirror edge"),
        },
    },
    "bondage-light": {
        "prompt_base": (
            "full body on bed, wrists bound with silk ties to headboard, legs spread suggestive, "
            "submissive obedient, looking at viewer, explicit aroused, soft bondage aesthetic"
        ),
        "tag_pools": {
            "bondage": ("silk ribbon restraints", "leather cuffs soft", "spread eagle hint", "blindfold lifted"),
            "expression": ("helpless pleasure", "obedient moan", "tearful bliss", "eager submissive eyes"),
            "wear": ("nude except collar", "lace harness", "nipple pasties", "crotchless lingerie"),
            "extra": ("rope marks subtle", "sweat on inner thighs", "disheveled sheets", "safe word vibe trust"),
        },
    },
    "reverse-cowgirl": {
        "prompt_base": (
            "full body, reverse cowgirl position, sitting on viewer, back to viewer, looking back over shoulder, "
            "arched back, round ass emphasis, pov from behind, explicit, bedroom"
        ),
        "tag_pools": {
            "ass": ("voluptuous ass focus", "hip grind hint", "back dimples", "thong aside"),
            "face": ("lustful look back", "parted lips moan", "flushed cheeks", "messy hair"),
            "wear": ("topless", "garter belt", "lace panties pulled aside", "nude glistening"),
            "light": ("warm rim on curves", "dim bedside lamp", "sunset through blinds"),
        },
    },
    "wall-pin-standing": {
        "prompt_base": (
            "full body standing, pressed against wall, one leg lifted and held, viewer pinning pose, "
            "face to face intimacy, explicit aroused, hallway or bedroom wall"
        ),
        "tag_pools": {
            "pose": ("leg hooked around waist hint", "hands above head", "deep kiss angle", "neck exposed"),
            "wear": ("dress hiked up", "panties aside", "open coat lingerie", "topless skirt only"),
            "face": ("hungry eyes", "gasping smile", "lip bite", "submissive eager"),
            "light": ("dramatic side light", "warm sconce glow", "rainy window mood"),
        },
    },
    "stomach-feet-up": {
        "prompt_base": (
            "full body lying on stomach on bed, feet up crossed in air, looking at viewer, playful explicit tease, "
            "ass and legs emphasis from rear angle"
        ),
        "tag_pools": {
            "legs": ("bare feet soles", "crossed ankles", "thigh squeeze", "toe curl tease"),
            "wear": ("micro thong", "topless back view", "g-string floss", "stockings"),
            "face": ("cheek on pillow smile", "bedroom eyes", "lipstick smudge", "inviting wink"),
            "prop": ("open book dropped", "phone nearby", "stuffed toy ironic", "rumpled duvet"),
        },
    },
    "bath-bubbles": {
        "prompt_base": (
            "upper body and shoulders in bathtub, bubble bath, foam barely covering breasts, "
            "looking at viewer, wet skin, explicit tease, luxurious bathroom"
        ),
        "tag_pools": {
            "bubbles": ("soap foam on chest", "bubble beard playful", "steam rising", "bath oils sheen"),
            "pose": ("leaning forward cleavage", "knees visible above water", "hand on tub edge", "hair up messy bun"),
            "face": ("relaxed pleasure", "steam flush", "wet lashes", "sultry half smile"),
            "prop": ("candles around tub", "champagne flute", "rose petals floating", "marble tiles"),
        },
    },
    "chair-straddle-back": {
        "prompt_base": (
            "full body straddling chair backwards, arms on chair back, chest forward, looking at viewer, "
            "explicit lingerie tease, boudoir studio"
        ),
        "tag_pools": {
            "wear": ("unhooked bra dangling", "crotchless panties", "sheer bodystocking", "pasties"),
            "pose": ("grinding hint on seat", "spread knees wide", "arch back", "hands gripping wood"),
            "face": ("dominant smirk", "obedient blush", "tongue tease", "heavy lidded"),
            "light": ("spotlight on curves", "velvet backdrop", "warm floor lamp"),
        },
    },
    "lingerie-peel": {
        "prompt_base": (
            "full body standing, mid striptease, removing lace bra or panties, looking at viewer, "
            "explicit undressing, bedroom mirror nearby"
        ),
        "tag_pools": {
            "action": ("bra strap sliding off shoulder", "panties halfway down thighs", "stepping out of heels", "tossing lingerie aside"),
            "wear": ("half removed lingerie", "nude except one piece", "open silk robe", "garter peeling off"),
            "face": ("teasing smile", "embarrassed aroused", "inviting strip continue", "eye contact locked"),
            "light": ("warm vanity bulbs", "sunset silhouette", "soft strip club glow"),
        },
    },
    "pole-dance-tease": {
        "prompt_base": (
            "full body pole dance, holding stripper pole, arched back around pole, "
            "micro bikini or lingerie, explicit athletic tease, club or bedroom pole"
        ),
        "tag_pools": {
            "pose": ("leg extended on pole", "hair flip motion", "invert hint", "grinding pole thigh"),
            "wear": ("micro bikini", "pasties and thong", "latex shorts", "high heels"),
            "face": ("confident seductive", "sweat glow", "parted lips", "performance smirk"),
            "light": ("neon pink accent", "spotlight beam", "smoke haze subtle", "disco bokeh"),
        },
    },
    "spoon-side-nude": {
        "prompt_base": (
            "full body lying on side in bed, nude spooning pose toward viewer, top leg lifted, "
            "intimate explicit cuddle, messy morning sheets"
        ),
        "tag_pools": {
            "pose": ("reaching back inviting", "hand guiding hip", "breasts pressed together", "ass against viewer hint"),
            "face": ("sleepy lust", "morning smile", "nibble ear tease", "soft moan"),
            "wear": ("completely nude", "sheet barely covering", "anklet only", "messy hair"),
            "light": ("morning sunbeam", "soft lamp still on", "cool blue dawn"),
        },
    },
    "lap-straddle-grind": {
        "prompt_base": (
            "full body sitting on viewer lap facing viewer, straddling, grinding tease, arms around neck, "
            "explicit intimate, office chair or bed edge"
        ),
        "tag_pools": {
            "pose": ("hips rolled forward", "forehead touching", "hands in hair", "deep cleavage pressed"),
            "wear": ("no panties under skirt", "open shirt no bra", "latex dress ridden up", "nude lap sit"),
            "face": ("desperate kiss need", "whimper expression", "dominant eye contact", "blushing submissive"),
            "prop": ("leather chair", "bed edge sit", "scattered clothes floor"),
        },
    },
    "split-stretch-tease": {
        "prompt_base": (
            "full body on bed doing deep split stretch or spread eagle stretch, flexible explicit tease, "
            "looking at viewer, athletic erotic, yoga pants ripped or nude"
        ),
        "tag_pools": {
            "flex": ("full split", "spread legs wide", "toes pointed", "hands on ankles"),
            "wear": ("torn leggings", "sports bra removed", "nude flexible", "micro shorts"),
            "face": ("playful strain pleasure", "competitive smirk", "inviting stretch deeper", "sweat on brow"),
            "light": ("gym window light", "bedroom afternoon sun", "warm spotlight"),
        },
    },
    "hc-bj-pov": {
        "prompt_base": (
            "pov, 1girl, solo focus, nude, fellatio, penis in mouth, sucking cock, "
            "looking up at viewer, hands on shaft, messy saliva, bedroom"
        ),
        "tag_pools": {
            "mouth": ("cheek bulge", "lipstick on shaft", "saliva drip", "half inserted"),
            "eyes": ("watery eyes upward", "submissive gaze", "half closed pleasure", "eye contact pov"),
            "motion": ("bobbing head", "hand stroking base", "twisting wrist", "both hands on cock"),
            "extra": ("messy purple hair", "blush", "throat relaxed", "nude breasts visible"),
        },
    },
    "hc-deepthroat-pov": {
        "prompt_base": (
            "pov, 1girl, irrumatio, deepthroat, penis deep in throat, nose near pelvis, "
            "hands on viewer thighs, gagging tears, nude, explicit oral sex"
        ),
        "tag_pools": {
            "throat": ("throat bulge", "saliva strings", "gagging", "tears streaming"),
            "face": ("runny mascara", "red face flush", "desperate eyes", "mascara streaks"),
            "pose": ("kneeling between legs", "head pushed down", "hair grabbed hint", "submitting"),
            "light": ("harsh overhead", "warm lamp side", "screen glow on face"),
        },
    },
    "hc-paizuri-pov": {
        "prompt_base": (
            "pov, 1girl, paizuri, titfuck, large breasts squeezing penis, "
            "tongue on tip, looking up at viewer, nude, glossy skin, explicit"
        ),
        "tag_pools": {
            "breasts": ("breast press tight", "nipples erect", "oil on cleavage", "bounce squeeze"),
            "mouth": ("licking tip", "open mouth around head", "saliva on glans", "kiss on tip"),
            "hands": ("push breasts together", "holding breasts", "one hand stroke shaft", "finger on lips"),
            "face": ("seductive smile up", "ahegao lite", "heavy blush", "parted lips"),
        },
    },
    "hc-missionary-pov": {
        "prompt_base": (
            "pov, 1girl, lying on back, missionary sex, vaginal penetration, legs spread wide, "
            "looking at viewer, moaning, nude, sweaty, messy bed, explicit intercourse"
        ),
        "tag_pools": {
            "sex": ("penis inside pussy", "deep insertion", "grinding hips", "clench thighs"),
            "face": ("mouth open moaning", "eyes rolled back lite", "tears of pleasure", "biting lip"),
            "body": ("breasts bouncing", "stomach taut", "toes curled", "sheets gripped"),
            "fluid": ("sweat sheen", "love juice shine", "wet sounds implied", "flushed skin"),
        },
    },
    "hc-doggy-pov": {
        "prompt_base": (
            "pov from behind, 1girl, doggystyle sex, vaginal penetration, on all fours, "
            "arched back, looking back at viewer, ass ripple, explicit intercourse, bedroom"
        ),
        "tag_pools": {
            "ass": ("ass clapping hint", "hip grab marks", "round ass focus", "back dimples"),
            "face": ("ahegao look back", "drool on sheet", "submissive moan", "hair pulled back"),
            "sex": ("penis entering from behind", "deep stroke", "panties aside", "spread cheeks"),
            "extra": ("disheveled sheets", "sweat on lower back", "stockings torn", "collar optional"),
        },
    },
    "hc-cowgirl-ride": {
        "prompt_base": (
            "pov from below, 1girl, cowgirl position, riding cock, vaginal sex, bouncing on penis, "
            "hands on viewer chest, breasts bouncing, looking down at viewer, explicit"
        ),
        "tag_pools": {
            "ride": ("hip slam down", "grinding circular", "hands on knees squat", "hair flying"),
            "breasts": ("bounce motion blur", "nipples hard", "sweat between cleavage", "hands fondle self"),
            "face": ("dominant lust", "open mouth panting", "dominant smirk", "submissive blush"),
            "body": ("abs flex", "thigh muscles", "wet pussy visible join", "cream froth hint"),
        },
    },
    "hc-creampie": {
        "prompt_base": (
            "1girl, after sex, lying on back, legs spread, cum dripping from pussy, creampie, "
            "cum overflow, looking at viewer satisfied, nude, messy sheets, explicit"
        ),
        "tag_pools": {
            "cum": ("cum pool on sheets", "cum string from pussy", "cum on inner thighs", "dripping labia"),
            "face": ("dazed bliss", "ahegao afterglow", "lazy smile", "exhausted happy"),
            "pose": ("fingers spreading pussy", "one knee up", "cum on stomach", "hand on belly"),
            "light": ("warm afterglow", "morning light", "candle flicker"),
        },
    },
    "hc-spread-pussy": {
        "prompt_base": (
            "1girl, lying on bed, spread legs wide, presenting pussy to viewer, "
            "hands spreading labia, explicit close-up genitals, looking at viewer, nude, aroused"
        ),
        "tag_pools": {
            "genitals": ("glistening pussy", "pink labia", "clitoris visible", "wet arousal"),
            "face": ("inviting smirk", "heavy blush", "bite lip", "please look expression"),
            "pose": ("knees up feet apart", "m-shaped legs", "one hand rub clit", "ass lifted pillow"),
            "extra": ("anal hint optional", "pubic hair trimmed", "oil shine", "vibrator aside"),
        },
    },
    "hc-fingering": {
        "prompt_base": (
            "1girl, masturbation, fingers inside pussy, lying on back, "
            "other hand on breast, squirting hint, looking at viewer, explicit solo, bedroom"
        ),
        "tag_pools": {
            "action": ("two fingers inserted", "rubbing clit", "fast motion blur hand", "arch back orgasm"),
            "face": ("o face moaning", "eyes shut climax", "drool corner mouth", "tears pleasure"),
            "fluid": ("wet fingers", "squirt puddle hint", "juice on thighs", "sheen on hand"),
            "prop": ("discarded panties", "vibrator nearby", "phone recording selfie", "mirror view"),
        },
    },
    "hc-anal-doggy": {
        "prompt_base": (
            "pov from behind, 1girl, anal sex, doggystyle, penis in ass, "
            "looking back pained pleasure, arched back, nude, explicit, lube shine"
        ),
        "tag_pools": {
            "anal": ("anal penetration", "spread ass cheeks", "gape hint after", "lube dripping"),
            "face": ("gritted teeth pleasure", "tears rolling", "submissive nod", "open mouth silent scream"),
            "body": ("white knuckle grip sheet", "trembling thighs", "sweat beads", "hair stuck to neck"),
            "wear": ("nude only", "collar leash", "garter belt askew", "heels still on"),
        },
    },
    "hc-facefuck": {
        "prompt_base": (
            "pov, 1girl, face fuck, penis slamming mouth, hands on head, "
            "saliva everywhere, kneeling, messy makeup, irrumatio rough, explicit oral"
        ),
        "tag_pools": {
            "mouth": ("cheeks hollow", "saliva waterfall chin", "cock outline cheek", "gagging mid thrust"),
            "hands": ("viewer hands on hair", "her hands on wrists", "arms behind back", "palms on thighs"),
            "face": ("ruined mascara", "red slap marks subtle", "teary upturned eyes", "messy lipstick smear"),
            "scene": ("floor kneeling", "bed edge", "mirror showing profile", "dim red light"),
        },
    },
    "hc-cum-covered": {
        "prompt_base": (
            "1girl, kneeling, cum on face, cum on breasts, cum on hair, "
            "after bukkake, tongue out catching drip, looking at viewer, nude, explicit messy"
        ),
        "tag_pools": {
            "cum": ("facial thick", "cum on tongue", "cum strings hair", "cum dripping nipples"),
            "face": ("happy cum drunk", "ahegao", "wink through mess", "peace sign ironic"),
            "pose": ("v sign", "mouth open pool", "cleavage pooled cum", "thumbs up tease"),
            "light": ("studio flash", "warm bedroom lamp", "contrast glossy white"),
        },
    },
    "hx-double-penetration": {
        "prompt_base": (
            "1girl, solo focus, double penetration, vaginal and anal, two penises, "
            "overwhelmed pleasure, looking at viewer, nude, explicit hardcore, messy bed"
        ),
        "tag_pools": {
            "dp": ("both holes filled", "stretching wide", "trembling thighs", "toes curled hard"),
            "face": ("ahegao breaking", "tongue out drool", "tears streaming", "cross eyed bliss"),
            "cum": ("precum drip", "lube overflow", "mixed fluids puddle", "string between legs"),
            "pose": ("lifted hips", "hands claw sheets", "hair matted sweat", "back arched extreme"),
        },
    },
    "hx-mating-press": {
        "prompt_base": (
            "pov, 1girl, mating press, legs pinned to chest, deep vaginal penetration, "
            "breeding press, looking up at viewer, ahegao, nude, explicit hardcore"
        ),
        "tag_pools": {
            "press": ("knees by ears", "folded in half", "deep cervix bump hint", "womb bulge subtle"),
            "face": ("mind broken smile", "rolling eyes", "scream silent", "saliva pool"),
            "body": ("breasts squeezed together", "stomach taut", "ass lifted off bed", "sweat flood"),
            "breed": ("impregnation fantasy", "cum already leaking", "breeding caption mood", "ownership collar"),
        },
    },
    "hx-prone-bone-rough": {
        "prompt_base": (
            "pov from behind, 1girl, prone bone, pinned flat on stomach, rough vaginal sex, "
            "head turned sideways moaning, ass rippling, explicit hardcore"
        ),
        "tag_pools": {
            "rough": ("hair yanked back", "arm pinned behind", "ass red slap marks", "brutal pace blur"),
            "face": ("cheek on pillow drool", " mascara ruined", "submissive broken", "eye roll back"),
            "sex": ("pelvis slam down", "ass clapping", "sheet torn grip", "pillow bite"),
            "fluid": ("sweat puddle", "squirt wet spot", "cum froth at join", "lube streak"),
        },
    },
    "hx-gangbang-surround": {
        "prompt_base": (
            "1girl, solo focus, surrounded by multiple penises, gangbang, kneeling center, "
            "hands on two shafts, third at lips, bukkake staging, nude, explicit hardcore"
        ),
        "tag_pools": {
            "cocks": ("penises from all angles", "handjob both sides", "cock on face cheek", "tip at tongue"),
            "face": ("eager cum slut smile", "open mouth waiting", "eye contact upward", "blush overload"),
            "cum": ("precum strands multiple", "already facial starter", "messy chin", "dripping on breasts"),
            "scene": ("floor kneeling", "bed surrounded", "dim red light", "used condoms aside"),
        },
    },
    "hx-ahegao-intercourse": {
        "prompt_base": (
            "1girl, mid intercourse, full ahegao, tongue out eyes rolled, vaginal sex pov, "
            "drool and sweat, fucked stupid, nude, explicit hardcore close-up"
        ),
        "tag_pools": {
            "ahegao": ("heart eyes", "tongue lolling", "brain melt expression", "victory peace sign broken"),
            "motion": ("bounce blur breasts", "hip snap", "hair whip", "splash sweat"),
            "noise": ("sound effects mood", "speech bubble moan", "wet slap implied", "bed creak"),
            "extra": ("nipple clamps", "collar tug", "writing on body degrading", "count marks thigh"),
        },
    },
    "hx-throatpie-overflow": {
        "prompt_base": (
            "pov, 1girl, irrumatio finish, cum overflowing mouth, throat pie, "
            "cum bubbling from lips, kneeling, nude, explicit oral hardcore"
        ),
        "tag_pools": {
            "cum": ("cum vomit overflow", "white pool on floor", "cum nose drip", "string to chin"),
            "face": ("dazed obedient", "half lidded worship", "cum drunk smile", "hand cupping spill"),
            "pose": ("mouth still on cock", "penis half soft", "hands on knees", "hair cum glued"),
            "after": ("used tissue nearby", "mirror reflection shame", "phone recording angle", "timer on screen"),
        },
    },
    "hx-leash-plug-crawl": {
        "prompt_base": (
            "1girl, pet play, crawling on all fours, anal plug tail, leash from collar, "
            "looking up at viewer, nude, explicit degradation aesthetic, bedroom floor"
        ),
        "tag_pools": {
            "pet": ("dog ears headband", "butt plug jewel", "kneepads red", "bell on collar"),
            "pose": ("ass up crawl", "tongue out panting", "presenting plug", "master foot near hint"),
            "wear": ("nude except collar", "nipple clamps chain", "wrist cuffs", " thigh writing"),
            "face": ("obedient happy pet", "await command", "blush humiliation", "wet thighs"),
        },
    },
    "hx-breeding-overflow": {
        "prompt_base": (
            "1girl, after rough breeding, legs spread on back, excessive cum overflow from pussy, "
            "cum inflation belly subtle, ahegao afterglow, nude, explicit hardcore"
        ),
        "tag_pools": {
            "cum": ("cum waterfall pussy", "pooled on ass", "cum bubbling", "internal cum drip"),
            "belly": ("slight cum bloat", "hand on stomach", "womb tattoo hint", "breeding pride face"),
            "face": ("broken satisfied", "tongue out lazy", "eyes empty bliss", "tears dried"),
            "pose": ("M spread legs", "cum string pull", "fingers gaping show", "used condom pile"),
        },
    },
    "hx-69-pov": {
        "prompt_base": (
            "pov, 1girl, sixty nine position, girl on top, sucking penis while pussy above face, "
            "mutual oral, looking at viewer sideways, nude, explicit hardcore"
        ),
        "tag_pools": {
            "69": ("deepthroat while licked", "ass in face", "mutual moan", "grinding hips down"),
            "genitals": ("wet pussy dripping on chin", "clit swollen", "asshole peek", "juice string"),
            "face": ("cheek bulge cock", "eye roll pleasure", "saliva on shaft", "blush full body"),
            "angle": ("from below pov", "side profile mirror", "close crotch focus", "face upper frame"),
        },
    },
    "hx-public-exhibition": {
        "prompt_base": (
            "1girl, public exhibitionism, masturbating in front of window at night, "
            "city lights outside, fingers inside pussy, looking at viewer shameless, nude, explicit"
        ),
        "tag_pools": {
            "public": ("against glass window", "curtain open risk", "silhouette to street", "flash photo pose"),
            "action": ("two fingers deep", "squirt on glass", "breast pressed glass", "vibrator in hand"),
            "face": ("exhibitionist high", "fear thrill blush", "biting lip watching outside", "ahegao lite"),
            "risk": ("distant figures outside blur", "police siren mood", "open balcony door", "high rise view"),
        },
    },
    "hx-suspended-spread": {
        "prompt_base": (
            "1girl, suspended bondage, spread eagle in air, ropes or cuffs, legs wide, "
            "vaginal penetration while hanging, helpless, nude, explicit hardcore"
        ),
        "tag_pools": {
            "bondage": ("wrist cuffs overhead", "spread bar ankles", "rope burn subtle", "swinging motion"),
            "sex": ("penis entering while suspended", "gravity deep thrust", "drip fluids down legs", "helpless orgasm"),
            "face": ("scream moaning", "tears pleasure", "hair hanging down", "drool arc"),
            "light": ("spotlight on body", "dark dungeon red", "chain glint", "sweat highlights"),
        },
    },
    "hx-rough-anal-gape": {
        "prompt_base": (
            "pov from behind, 1girl, after rough anal sex, gape, anal prolapse hint lite, "
            "cum dripping from ass, on all fours, looking back broken, nude, explicit hardcore"
        ),
        "tag_pools": {
            "anal": ("gaping asshole", "cum tunnel drip", "red rim swollen", "lube strings"),
            "face": ("pain pleasure mix", "sobbing smile", "makeup destroyed", "submissive nod"),
            "body": ("trembling knees", "hand spreading ass", "pussy dripping unused", "bruise hip grip"),
            "rough": ("torn fishnets", "spanked red ass", "hair pulled ponytail", "collar chain taut"),
        },
    },
    "hx-fucked-silly": {
        "prompt_base": (
            "1girl, lying collapsed on bed, fucked silly, full ahegao, cum everywhere face body pussy, "
            "spread limp legs, tongue out, empty eyes, after gangbang hardcore"
        ),
        "tag_pools": {
            "mess": ("cum puddles multiple", "hair white streaks", "body writing tally", "condoms on sheet"),
            "face": ("ultimate ahegao", "eyes spiral", "tongue hanging", "drool pool pillow"),
            "body": ("limb spread broken doll", "bruises thighs", "nipples sore red", "still twitching"),
            "mood": ("hours later lamp", "phone timer many", "used and happy", "waiting round two"),
        },
    },
}

# Optional extras appended to every pose (one random tag per pool, each generation).
GLOBAL_TAG_POOLS: dict[str, tuple[str, ...]] = {
    "quality": ("intricate details", "sharp focus face", "professional illustration", "detailed eyes"),
    "camera": ("portrait composition", "center framing", "slight low angle", "eye-level shot"),
    "color": ("rich colors", "soft color grading", "warm palette", "subtle vignette"),
}

PORTRAIT_STEPS = 22
SET_BATCH_STEPS = 12
WILDCARD_CHANCE = 0.15
WILDCARD_TAG_POOL: tuple[str, ...] = (
    "rose petals falling",
    "sheer curtains blowing",
    "mirror reflection subtle",
    "champagne sparkle bokeh",
    "rain on window mood",
    "silk sheets texture",
    "neon pink accent light",
    "holding wine glass",
)

TIME_TAG_POOLS: dict[str, tuple[str, ...]] = {
    "morning": ("morning sunlight through blinds", "soft dawn glow", "fresh awake expression", "steamy morning air"),
    "afternoon": ("bright soft daylight", "lazy afternoon haze", "sunbeam on skin"),
    "evening": ("sunset orange rim light", "golden hour bedroom", "twilight blue shadows"),
    "night": ("moonlit bedroom", "candlelit intimacy", "city lights through window", "deep night mood"),
}

SPICE_TAG_POOLS: dict[int, tuple[str, ...]] = {
    1: ("flirty gaze", "teasing smile", "playful energy", "lip bite tease", "cleavage peek"),
    2: (
        "heavy blush",
        "breathless expression",
        "sultry stare",
        "glistening skin",
        "cleavage emphasis",
        "hand on inner thigh",
        "wet panties hint",
    ),
    3: (
        "intense lustful eyes",
        "messy hair wild",
        "explicit aroused expression",
        "sweaty skin sheen",
        "dominant submissive tension",
        "parted lips moaning",
        "nipples hard through lace",
        "topless, panties only",
        "spread legs on bed",
        "fingering tease through panties",
    ),
    4: (
        "ahegao lite",
        "drool on chin",
        "fucked silly expression",
        "spread legs",
        "panties aside",
        "cum on body hint",
        "obedient submissive gaze",
        "explicit invitation pose",
        "masturbation tease",
        "pussy peek",
        "ass up face down hint",
        "collar and leash hint",
    ),
}

HEAT_BOOST_TAGS: dict[str, tuple[str, ...]] = {
    "high": (
        "explicit nude tease",
        "bedroom messy sheets",
        "steamy sweat",
        "thong pulled aside subtle",
    ),
    "max": (
        "explicit sexual pose",
        "orgasm face",
        "wet pussy glistening",
        "cum drip on thigh hint",
        "after sex glow",
        "bent over presenting",
    ),
}

TREAT_BONUS_TAGS: dict[str, tuple[str, ...]] = {
    "coffee": ("coffee steam ambiance", "morning caffeine glow"),
    "strawberry": ("juicy red lips", "sweet fruity mood"),
    "rose": ("rose petal accents", "romantic floral scent mood"),
    "kiss": ("fresh kiss mark on cheek", "smudged lipstick from kissing", "parted lips inviting"),
}

CHAT_ESCALATE_TAGS: tuple[str, ...] = (
    "obedient submissive tone",
    "explicit dirty talk face",
    "demanding eye contact",
    "eager to please expression",
    "spread legs on bed",
    "topless lingerie",
    "fingering self subtle",
    "pov seduction",
)

CHAT_WARM_TAGS: tuple[str, ...] = (
    "loving gaze",
    "tender smile",
    "warm affectionate eyes",
)

IMG2IMG_DENOISE_BASE = 0.28
IMG2IMG_MOOD_DENOISE_BASE = 0.22
REFRESH_STEPS = 10
DEFAULT_CHARACTER_LORA_WEIGHT = 0.82
DEFAULT_SHEET_WEIGHT = 0.58
DEFAULT_FORGE_GPU_MB = 7500
_applied_forge_gpu_mb: int | None = None
VARIATION_STRENGTH_BASE = 0.32

_SAFE_STEM = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
_SAFE_FILENAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}\.jpg$", re.I)


class CompanionArtError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        self.message = message or code
        super().__init__(self.message)


def _messages(code: str) -> str:
    return {
        "forge_offline": "Forge n'est pas démarré.",
        "busy": "Forge génère déjà une image.",
        "pose_unknown": "Pose inconnue.",
        "dest_invalid": "Nom de fichier refusé.",
        "nsfw_off": "Mode adulte requis.",
        "forbidden": "Réservé à l'administrateur.",
        "empty_image": "Forge n'a renvoyé aucune image.",
        "forge_error": "La génération Forge a échoué.",
    }.get(code, code)


def list_poses() -> list[dict[str, str]]:
    return [{"id": k, "label": k.replace("-", " ")} for k in sorted(POSE_PROMPTS)]


def _resolve_forge_gpu_mb(root: Path | None) -> int:
    if root is None:
        return DEFAULT_FORGE_GPU_MB
    meta = load_forge_meta(root)
    raw = meta.get("forge_gpu_mb", meta.get("xl_gpu_mb", DEFAULT_FORGE_GPU_MB))
    try:
        mb = int(raw)
    except (TypeError, ValueError):
        mb = DEFAULT_FORGE_GPU_MB
    return max(0, min(8192, mb))


def _apply_forge_gpu_mb(root: Path | None) -> None:
    """Sync Forge xl_GPU_MB before companion gens (cached per process)."""
    global _applied_forge_gpu_mb
    mb = _resolve_forge_gpu_mb(root)
    if _applied_forge_gpu_mb == mb:
        return
    try:
        forge.set_options({"xl_GPU_MB": mb})
    except forge._Probe:
        return
    _applied_forge_gpu_mb = mb


def _wait_idle(timeout: float = JOB_TIMEOUT) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = forge.status()
        if snap.get("forge") == "ready":
            return
        if snap.get("forge") != "busy":
            raise CompanionArtError(str(snap.get("code") or "forge_error"))
        time.sleep(0.45)
    raise CompanionArtError("busy")


def _forge_store_path(root: Path) -> Path:
    return root / FORGE_STORE


def load_forge_meta(root: Path) -> dict:
    path = _forge_store_path(root)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def forge_ui_defaults(root: Path | None) -> dict:
    meta = load_forge_meta(root) if root else {}
    try:
        stock_chance = float(meta.get("stock_chance", 0.5))
    except (TypeError, ValueError):
        stock_chance = 0.5
    try:
        hot_stock = int(meta.get("hot_hybrid_stock_slots", 1))
    except (TypeError, ValueError):
        hot_stock = 1
    hybrid_raw = meta.get("hybrid_default")
    hybrid_default = True if hybrid_raw is None else bool(hybrid_raw)
    portrait = str(meta.get("default_adult_portrait") or "transferania-adult-neutral.jpg").strip()
    if not _SAFE_FILENAME.fullmatch(portrait):
        portrait = "transferania-adult-neutral.jpg"
    return {
        "hybrid_default": hybrid_default,
        "stock_chance": round(max(0.05, min(0.95, stock_chance)), 3),
        "hot_hybrid_stock_slots": max(0, min(2, hot_stock)),
        "default_adult_portrait": portrait,
    }


def _stock_dir(root: Path, pose_id: str) -> Path:
    safe = re.sub(r"[^a-z0-9_-]", "", pose_id.lower())[:48]
    return (root / COMPANION_ASSETS / "stock" / safe).resolve()


def list_stock_portrait_paths(root: Path, pose_id: str, dest: str) -> list[Path]:
    root = root.resolve()
    base = (root / COMPANION_ASSETS).resolve()
    found: list[Path] = []
    seen: set[str] = set()
    stock_dir = _stock_dir(root, pose_id)
    if stock_dir.is_dir():
        for p in sorted(stock_dir.glob("*.jpg")):
            if p.is_file() and p.stat().st_size >= 2048:
                rp = str(p.resolve())
                if rp not in seen:
                    seen.add(rp)
                    found.append(p.resolve())
    if dest and _SAFE_FILENAME.fullmatch(dest):
        primary = (root / COMPANION_ASSETS / dest).resolve()
        if primary.is_file() and primary.stat().st_size >= 2048:
            rp = str(primary)
            if rp not in seen:
                seen.add(rp)
                found.append(primary)
    return found


CHAT_POSE_HINTS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("suce", "pipe", "oral", "bouche", "deepthroat", "gorge"), "hc-bj-pov"),
    (("paizuri", "nichons", "entre les seins"), "hc-paizuri-pov"),
    (("anal", "cul", "fesse", "doggy", "quatre pattes"), "hc-anal-doggy"),
    (("creampie", "rempli", "dedans"), "hc-creampie"),
    (("spread", "écarte", "ecarte", "chatte"), "hc-spread-pussy"),
    (("doigt", "masturb", "solo"), "hc-fingering"),
    (("cowgirl", "chevauche", "ride"), "hc-cowgirl-ride"),
    (("missionnaire", "missionary", "dos"), "hc-missionary-pov"),
    (("dp", "double", "deux bites"), "hx-double-penetration"),
    (("ahegao", "fucked silly", "broken"), "hx-fucked-silly"),
    (("69", "soixante"), "hx-69-pov"),
    (("douche", "shower", "mouill"), "shower-wet"),
    (("miroir", "selfie"), "mirror-selfie-nude"),
)


def infer_pose_from_chat(ctx: dict) -> str | None:
    blob = ((ctx.get("chat_snippet") or "") + " " + (ctx.get("escalate") or "")).lower()
    if not blob.strip():
        return None
    for keys, pose_id in CHAT_POSE_HINTS:
        if any(k in blob for k in keys):
            if pose_id in POSE_PROMPTS:
                return pose_id
    return None


def save_forge_meta(root: Path, meta: dict) -> None:
    path = _forge_store_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import hq_state

        hq_state.write_json_atomic(path, meta)
    except Exception:
        path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _forge_port_open(origin: str) -> bool:
    # perf10: Windows takes ~2 s to report a refused localhost connect; a short
    # TCP pre-check answers "offline" fast. Only used for read-only status probes.
    try:
        import socket
        import urllib.parse as _up
        parts = _up.urlsplit(origin)
        with socket.create_connection((parts.hostname or "127.0.0.1", parts.port or 80), timeout=_STATUS_PRECHECK_SEC):
            return True
    except OSError:
        return False


def invalidate_status_cache() -> None:
    global _CN_MODELS_AT, _CN_MODELS
    with _STATUS_LOCK:
        _STATUS_CACHE.clear()
        _CN_MODELS_AT = 0.0
        _CN_MODELS = []


def cached_forge_status() -> dict:
    """forge.status() with a 60 s (ok) / 10 s (failure) cache and a fast offline pre-check.
    Bypassed entirely when a test transport is installed."""
    if getattr(forge, "_test_transport", None) is not None:
        return forge.status()
    origin = getattr(forge, "_upstream", None) or getattr(forge, "UPSTREAM_ORIGIN", "http://127.0.0.1:7860")
    now = time.monotonic()
    with _STATUS_LOCK:
        hit = _STATUS_CACHE.get(origin)
        if hit is not None:
            ttl = _STATUS_OK_TTL if hit[1].get("forge") in ("ready", "busy") else _STATUS_FAIL_TTL
            if now - hit[0] < ttl:
                return dict(hit[1])
    if _forge_port_open(origin):
        snap = forge.status()
    else:
        snap = forge._status_payload("forge_offline")
    with _STATUS_LOCK:
        _STATUS_CACHE[origin] = (time.monotonic(), dict(snap))
    return snap


def _fetch_controlnet_model_names() -> list[str]:
    global _CN_MODELS_AT, _CN_MODELS
    now = time.monotonic()
    if _CN_MODELS and now - _CN_MODELS_AT < (10.0 if _CN_MODELS == ["None"] else 60.0):
        return _CN_MODELS
    origin = getattr(forge, "UPSTREAM_ORIGIN", "http://127.0.0.1:7860")
    if not _forge_port_open(origin):
        _CN_MODELS = ["None"]
        _CN_MODELS_AT = now
        return _CN_MODELS
    try:
        with urllib.request.urlopen(f"{origin}/controlnet/model_list", timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        names = [str(x) for x in (data.get("model_list") or []) if x]
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        names = ["None"]
    _CN_MODELS = names or ["None"]
    _CN_MODELS_AT = now
    return _CN_MODELS


def _resolve_controlnet_model(meta: dict, models: list[str]) -> str:
    want = str(meta.get("controlnet_model") or "auto").strip()
    if want.lower() not in ("", "auto"):
        for name in models:
            if name == want or name.split("[", 1)[0].strip() == want:
                return name
    for name in models:
        low = name.lower()
        if IPADAPTER_FACE_HINT in low or ("ip-adapter" in low and "face" in low and "sdxl" in low):
            return name
    for name in models:
        if "ip-adapter" in name.lower():
            return name
    return DEFAULT_CONTROLNET_MODEL


def _resolve_controlnet_module(meta: dict, model_name: str) -> str:
    mod = str(meta.get("controlnet_module") or "").strip()
    if mod:
        return mod
    low = model_name.lower()
    if model_name != "None" and "ip-adapter" in low and "face" in low:
        return IPADAPTER_MODULE_FACE
    if model_name != "None" and "ip-adapter" in low:
        return IPADAPTER_MODULE_SDXL
    return DEFAULT_CONTROLNET_MODULE


def _resolve_control_mode(meta: dict) -> str | int:
    raw = meta.get("controlnet_control_mode", "control")
    if isinstance(raw, int) and 0 <= raw <= 2:
        return raw
    text = str(raw or "control").strip().lower()
    if text in ("control", "cn", "controlnet"):
        return CONTROL_MODE_CONTROL
    if text in ("balanced", "balance", "0"):
        return "Balanced"
    if text in ("prompt", "1"):
        return "My prompt is more important"
    return CONTROL_MODE_CONTROL


def default_dest(pose_id: str) -> str | None:
    return POSE_DEFAULT_DEST.get(pose_id)


def _reference_path(root: Path, meta: dict | None = None) -> Path | None:
    if root is None:
        return None
    meta = meta if isinstance(meta, dict) else load_forge_meta(root)
    name = str(meta.get("reference_image") or REFERENCE_IMAGE).strip().replace("\\", "/")
    if not name or "/" in name or name.startswith("."):
        return None
    if not _SAFE_FILENAME.fullmatch(name):
        return None
    path = (root / COMPANION_ASSETS / name).resolve()
    base = (root / COMPANION_ASSETS).resolve()
    if not str(path).startswith(str(base)) or not path.is_file():
        return None
    return path


def _companion_asset_path(root: Path, filename: str) -> Path | None:
    if root is None:
        return None
    name = str(filename or "").strip().replace("\\", "/")
    if not name or "/" in name or name.startswith("."):
        return None
    if not _SAFE_FILENAME.fullmatch(name):
        return None
    path = (root / COMPANION_ASSETS / name).resolve()
    base = (root / COMPANION_ASSETS).resolve()
    if not str(path).startswith(str(base)) or not path.is_file():
        return None
    return path


def _character_sheet_path(root: Path, meta: dict | None = None) -> Path | None:
    meta = meta if isinstance(meta, dict) else load_forge_meta(root)
    if meta.get("character_sheet") is False:
        return None
    name = str(meta.get("character_sheet") or CHARACTER_SHEET_IMAGE).strip()
    return _companion_asset_path(root, name)


def character_sheet_status(root: Path | None) -> dict:
    if root is None:
        return {"enabled": False, "reason": "no_root"}
    meta = load_forge_meta(root)
    path = _character_sheet_path(root, meta)
    if path is None:
        return {
            "enabled": False,
            "reason": "no_file",
            "expected": str(meta.get("character_sheet") or CHARACTER_SHEET_IMAGE),
        }
    try:
        weight = float(meta.get("character_sheet_weight") or DEFAULT_SHEET_WEIGHT)
    except (TypeError, ValueError):
        weight = DEFAULT_SHEET_WEIGHT
    weight = max(0.1, min(1.2, weight))
    return {"enabled": True, "file": path.name, "weight": weight, "module": DEFAULT_CONTROLNET_MODULE}


def _encode_image_unit(path: Path, *, module: str, model: str, weight: float, width: int, height: int, meta: dict) -> dict | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if len(raw) > 8 * 1024 * 1024:
        return None
    if not 0.0 <= float(weight) <= 2.0:
        weight = DEFAULT_CONTROLNET_WEIGHT
    return {
        "enabled": True,
        "image": base64.b64encode(raw).decode("ascii"),
        "module": module[:120],
        "model": model[:120],
        "weight": float(weight),
        "resize_mode": "Crop and Resize",
        "guidance_start": 0.0,
        "guidance_end": 1.0,
        "control_mode": _resolve_control_mode(meta),
        "pixel_perfect": True,
        "processor_res": min(max(width, height), 512),
    }


def _face_controlnet_unit(root: Path, meta: dict, *, width: int, height: int) -> dict | None:
    st = controlnet_status(root)
    if not st.get("enabled"):
        return None
    path = _reference_path(root, meta)
    if path is None:
        return None
    weight = st["weight"]
    if not isinstance(weight, (int, float)) or not 0.0 <= float(weight) <= 2.0:
        weight = DEFAULT_CONTROLNET_WEIGHT
    return _encode_image_unit(
        path,
        module=st["module"],
        model=st["model"],
        weight=float(weight),
        width=width,
        height=height,
        meta=meta,
    )


def _sheet_controlnet_unit(root: Path, meta: dict, *, width: int, height: int) -> dict | None:
    st = character_sheet_status(root)
    if not st.get("enabled"):
        return None
    path = _character_sheet_path(root, meta)
    if path is None:
        return None
    return _encode_image_unit(
        path,
        module=DEFAULT_CONTROLNET_MODULE,
        model="None",
        weight=float(st["weight"]),
        width=width,
        height=height,
        meta=meta,
    )


def _controlnet_units(
    root: Path,
    meta: dict,
    *,
    width: int,
    height: int,
    include_face: bool = True,
    include_sheet: bool = True,
) -> list[dict]:
    units: list[dict] = []
    if include_face:
        face = _face_controlnet_unit(root, meta, width=width, height=height)
        if face:
            units.append(face)
    if include_sheet:
        sheet = _sheet_controlnet_unit(root, meta, width=width, height=height)
        if sheet:
            units.append(sheet)
    return units


def controlnet_status(root: Path | None) -> dict:
    if root is None:
        return {"enabled": False, "reason": "no_root"}
    meta = load_forge_meta(root)
    if meta.get("controlnet") is False:
        return {"enabled": False, "reason": "disabled"}
    models = _fetch_controlnet_model_names()
    model = _resolve_controlnet_model(meta, models)
    module = _resolve_controlnet_module(meta, model)
    ref = _reference_path(root, meta)
    if ref is None and module != DEFAULT_CONTROLNET_MODULE:
        return {
            "enabled": False,
            "reason": "no_reference",
            "reference_image": str(meta.get("reference_image") or REFERENCE_IMAGE),
            "model": model,
            "module": module,
        }
    if ref is None and model == "None":
        return {
            "enabled": False,
            "reason": "no_reference",
            "reference_image": str(meta.get("reference_image") or REFERENCE_IMAGE),
        }
    weight = float(meta.get("controlnet_weight") or DEFAULT_CONTROLNET_WEIGHT)
    if model != "None" and "ip-adapter" in model.lower() and "controlnet_weight" not in meta:
        weight = DEFAULT_IPADAPTER_WEIGHT
    return {
        "enabled": True,
        "reference_image": ref.name if ref else str(meta.get("reference_image") or REFERENCE_IMAGE),
        "module": module,
        "model": model,
        "weight": weight,
        "control_mode": _resolve_control_mode(meta),
        "mode": "ipadapter" if "ip-adapter" in model.lower() else "reference",
    }


def _controlnet_unit(root: Path, meta: dict, *, width: int, height: int) -> dict | None:
    units = _controlnet_units(root, meta, width=width, height=height, include_face=True, include_sheet=True)
    return units[0] if units else None


def companion_submission_body(
    settings: dict,
    task_id: str,
    root: Path | None,
    *,
    controlnet_mode: str = "full",
) -> tuple[dict, dict]:
    """txt2img body for companion art; optional ControlNet reference for same face."""
    body = submission_body(settings, task_id)
    cn_info: dict = {
        "controlnet": controlnet_status(root),
        "character_sheet": character_sheet_status(root),
    }
    mode = str(controlnet_mode or "full").strip().lower()
    if root is None or mode == "none":
        if isinstance(cn_info.get("controlnet"), dict):
            cn_info["controlnet"] = dict(cn_info["controlnet"])
            cn_info["controlnet"]["active"] = False
            if mode == "none":
                cn_info["controlnet"]["skipped"] = "controlnet_off"
        return body, cn_info
    meta = load_forge_meta(root)
    if mode == "face":
        meta = dict(meta)
        try:
            meta["controlnet_weight"] = float(meta.get("img2img_cn_weight") or 0.72)
        except (TypeError, ValueError):
            meta["controlnet_weight"] = 0.72
    include_face = mode in ("full", "face")
    include_sheet = mode == "full"
    units = _controlnet_units(
        root,
        meta,
        width=int(settings["width"]),
        height=int(settings["height"]),
        include_face=include_face,
        include_sheet=include_sheet,
    )
    if units:
        body["alwayson_scripts"] = {"controlnet": {"args": units}}
        cn_info["controlnet"]["active"] = True
        cn_info["controlnet"]["units"] = len(units)
    else:
        cn_info["controlnet"]["active"] = False
    return body, cn_info


def _png_to_jpeg_bytes(png: bytes, *, quality: int = JPEG_QUALITY) -> bytes:
    try:
        from PIL import Image
    except ImportError as exc:
        raise CompanionArtError("forge_error", "Pillow requis pour convertir PNG → JPG") from exc
    im = Image.open(io.BytesIO(png))
    if im.mode in ("RGBA", "P"):
        bg = Image.new("RGB", im.size, (18, 12, 14))
        if im.mode == "P":
            im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1] if im.mode == "RGBA" else None)
        im = bg
    elif im.mode != "RGB":
        im = im.convert("RGB")
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


def parse_generation_context(data: dict | None, *, root: Path | None = None) -> dict:
    raw = data if isinstance(data, dict) else {}
    try:
        intensity = int(raw.get("intensity") or 0)
    except (TypeError, ValueError):
        intensity = 0
    intensity = max(0, min(4, intensity))
    try:
        variations = int(raw.get("variations") or 1)
    except (TypeError, ValueError):
        variations = 1
    variations = max(1, min(4, variations))
    hour = raw.get("hour")
    if hour is not None:
        try:
            hour = int(hour)
        except (TypeError, ValueError):
            hour = None
    if hour is None:
        hour = datetime.now().hour
    treats = raw.get("treat_bonuses")
    if not isinstance(treats, list):
        treats = []
    treat_bonuses = [str(x).strip() for x in treats if str(x).strip()][:6]
    chat = str(raw.get("chat_snippet") or raw.get("chat") or "").strip()[:240]
    escalate = str(raw.get("escalate") or "").strip()[:120]
    replay = raw.get("replay_tags")
    replay_tags = replay if isinstance(replay, dict) else None
    locked_seed = raw.get("locked_seed")
    if locked_seed is not None:
        try:
            locked_seed = int(locked_seed)
        except (TypeError, ValueError):
            locked_seed = None
    try:
        stock_chance = float(raw.get("stock_chance", 0.5))
    except (TypeError, ValueError):
        stock_chance = 0.5
    stock_chance = max(0.05, min(0.95, stock_chance))
    hybrid_raw = raw.get("hybrid")
    if hybrid_raw is None and root is not None:
        hybrid = bool(forge_ui_defaults(root).get("hybrid_default", True))
    else:
        hybrid = True if hybrid_raw is None else hybrid_raw is True
    if raw.get("stock_chance") is None and root is not None:
        stock_chance = float(forge_ui_defaults(root).get("stock_chance") or stock_chance)
        stock_chance = max(0.05, min(0.95, stock_chance))
    return {
        "intensity": intensity,
        "variations": variations,
        "hour": hour,
        "treat_bonuses": treat_bonuses,
        "chat_snippet": chat,
        "escalate": escalate,
        "replay_tags": replay_tags,
        "locked_seed": locked_seed,
        "img2img_refresh": raw.get("img2img_refresh") is True,
        "mood_refresh": raw.get("mood_refresh") is True,
        "img2img_source": str(raw.get("img2img_source") or "").strip()[:120],
        "hot_variations": raw.get("hot_variations") is True,
        "set_batch": raw.get("set_batch") is True,
        "hybrid": hybrid,
        "stock_chance": stock_chance,
        "force_forge": raw.get("force_forge") is True,
        "force_stock": raw.get("force_stock") is True,
    }


def _time_of_day_key(hour: int) -> str:
    if 5 <= hour < 11:
        return "morning"
    if 11 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 22:
        return "evening"
    return "night"


def _lora_tag_from_meta(meta: dict, name_keys: tuple[str, ...], weight_key: str, default_w: float) -> str:
    name = ""
    for key in name_keys:
        name = str(meta.get(key) or "").strip()
        if name:
            break
    if not name:
        return ""
    if "<lora:" in name.lower():
        return name[:200]
    safe = re.sub(r"[<>:]", "", name).strip()
    if not safe:
        return ""
    try:
        weight = float(meta.get(weight_key, default_w))
    except (TypeError, ValueError):
        weight = default_w
    weight = max(0.05, min(2.0, weight))
    return f"<lora:{safe}:{weight:.2f}>"


def _lora_tag_fragment(meta: dict) -> str:
    return _lora_tag_from_meta(meta, ("lora_name", "lora"), "lora_weight", 0.75)


def _character_lora_tag_fragment(meta: dict) -> str:
    return _lora_tag_from_meta(
        meta,
        ("character_lora_name", "character_lora"),
        "character_lora_weight",
        DEFAULT_CHARACTER_LORA_WEIGHT,
    )


def _inject_lora_prompt(prompt: str, root: Path | None) -> str:
    if root is None:
        return prompt[:4000]
    meta = load_forge_meta(root)
    parts = [prompt]
    char_tag = _character_lora_tag_fragment(meta)
    if char_tag:
        parts.append(char_tag)
    tag = _lora_tag_fragment(meta)
    if tag:
        parts.append(tag)
    suffix = str(meta.get("lora_prompt_suffix") or meta.get("lora_tags") or "").strip()
    if suffix:
        parts.append(suffix[:400])
    merged = ", ".join(p for p in parts if p)
    return merged[:4000]


def _strip_legacy_character_seed(meta: dict) -> bool:
    if "character_seed" not in meta:
        return False
    meta.pop("character_seed", None)
    return True


def _favorite_recipe(root: Path | None) -> dict | None:
    if root is None:
        return None
    meta = load_forge_meta(root)
    fav = meta.get("favorite_recipe")
    return fav if isinstance(fav, dict) else None


def save_favorite_recipe(root: Path, recipe: dict) -> dict:
    meta = load_forge_meta(root)
    meta["favorite_recipe"] = {
        "pose": str(recipe.get("pose") or "")[:48],
        "seed": recipe.get("seed"),
        "prompt_tags": recipe.get("prompt_tags") if isinstance(recipe.get("prompt_tags"), dict) else {},
        "href": str(recipe.get("href") or "")[:200],
        "saved_at": time.time(),
    }
    save_forge_meta(root, meta)
    return meta["favorite_recipe"]


def _chat_injected_tags(ctx: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    chat = (ctx.get("chat_snippet") or "").lower()
    esc = (ctx.get("escalate") or "").lower()
    if esc or any(w in chat for w in ("maître", "maitre", "master", "direct", "sale", "ordre")):
        pick = CHAT_ESCALATE_TAGS[secrets.randbelow(len(CHAT_ESCALATE_TAGS))]
        out["chat_escalate"] = pick
    elif chat and any(w in chat for w in ("amour", "mon coeur", "bisou", "♥", "tendre")):
        pick = CHAT_WARM_TAGS[secrets.randbelow(len(CHAT_WARM_TAGS))]
        out["chat_warm"] = pick
    return out


def _treat_injected_tags(ctx: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for key in ctx.get("treat_bonuses") or []:
        pool = TREAT_BONUS_TAGS.get(str(key).lower())
        if not pool:
            continue
        tag = pool[secrets.randbelow(len(pool))]
        out[f"treat_{key}"] = tag
    return out


def _pick_from_pool(name: str, options: tuple[str, ...] | list[str] | str) -> tuple[str, str] | None:
    if isinstance(options, str):
        options = (options,)
    elif isinstance(options, list):
        options = tuple(str(x).strip() for x in options if str(x).strip())
    elif not isinstance(options, tuple):
        return None
    options = tuple(str(x).strip() for x in options if str(x).strip())
    if not options:
        return None
    choice = options[secrets.randbelow(len(options))]
    return name, choice


def _compose_pose_prompt(spec: dict, ctx: dict | None = None) -> tuple[str, dict[str, str]]:
    """Build pose-specific prompt fragment with random tag picks from each pool."""
    ctx = ctx or {}
    base = str(spec.get("prompt_base") or spec.get("prompt_extra") or "").strip()
    parts: list[str] = [base] if base else []
    picked: dict[str, str] = {}
    replay = ctx.get("replay_tags")
    if isinstance(replay, dict) and replay:
        for key, val in replay.items():
            if val:
                picked[str(key)] = str(val)
                parts.append(str(val))
    else:
        pools = spec.get("tag_pools")
        if isinstance(pools, dict):
            for pool_name, options in pools.items():
                got = _pick_from_pool(str(pool_name), options)  # type: ignore[arg-type]
                if got:
                    picked[got[0]] = got[1]
                    parts.append(got[1])
        for pool_name, options in GLOBAL_TAG_POOLS.items():
            got = _pick_from_pool(f"global_{pool_name}", options)
            if got:
                picked[got[0]] = got[1]
                parts.append(got[1])
        time_key = _time_of_day_key(int(ctx.get("hour") or datetime.now().hour))
        time_pool = TIME_TAG_POOLS.get(time_key)
        if time_pool:
            got = _pick_from_pool(f"time_{time_key}", time_pool)
            if got:
                picked[got[0]] = got[1]
                parts.append(got[1])
        intensity = int(ctx.get("intensity") or 0)
        if intensity >= 1:
            level = max(1, min(4, intensity))
            spice = SPICE_TAG_POOLS.get(level)
            if spice:
                got = _pick_from_pool(f"spice_{level}", spice)
                if got:
                    picked[got[0]] = got[1]
                    parts.append(got[1])
        if intensity >= 4:
            got = _pick_from_pool("heat_max", HEAT_BOOST_TAGS["max"])
            if got:
                picked[got[0]] = got[1]
                parts.append(got[1])
        elif intensity >= 3:
            got = _pick_from_pool("heat_high", HEAT_BOOST_TAGS["high"])
            if got:
                picked[got[0]] = got[1]
                parts.append(got[1])
        if secrets.randbelow(100) < int(WILDCARD_CHANCE * 100):
            got = _pick_from_pool("wildcard", WILDCARD_TAG_POOL)
            if got:
                picked[got[0]] = got[1]
                parts.append(got[1])
        chat_tags = _chat_injected_tags(ctx)
        picked.update(chat_tags)
        for val in chat_tags.values():
            parts.append(val)
        treat_tags = _treat_injected_tags(ctx)
        picked.update(treat_tags)
        for val in treat_tags.values():
            parts.append(val)
    extra = ", ".join(dict.fromkeys(p for p in parts if p))
    return extra, picked


def _default_settings(
    pose_id: str,
    *,
    seed: int | None = None,
    root: Path | None = None,
    ctx: dict | None = None,
) -> dict:
    spec = POSE_PROMPTS.get(pose_id)
    if not spec:
        raise CompanionArtError("pose_unknown")
    ctx = ctx or {}
    opts = forge.read_options()
    checkpoint = str(opts.get("sd_model_checkpoint") or "").strip()
    if not checkpoint:
        raise CompanionArtError("forge_error", "Aucun modèle Forge actif")
    locked = ctx.get("locked_seed")
    if locked is not None and isinstance(locked, int) and 0 <= locked < 2**32:
        seed = locked
    elif seed is None or seed == FORGE_RANDOM_SEED:
        seed = _roll_seed(FORGE_RANDOM_SEED)
    else:
        seed = int(seed)
    pose_extra, prompt_tags = _compose_pose_prompt(spec, ctx)
    prompt = _inject_lora_prompt(f"{character_core_for_pose(pose_id)}, {pose_extra}", root)
    w = int(spec.get("width") or CANVAS_WIDTH)
    h = int(spec.get("height") or CANVAS_HEIGHT)
    if pose_id.startswith(("portrait-", "hc-", "hx-")) and root is not None and ctx.get("width") is None and ctx.get("height") is None:
        meta = load_forge_meta(root)
        try:
            pw = int(meta.get("portrait_width") or 0)
            ph = int(meta.get("portrait_height") or 0)
            if pw > 0 and ph > 0:
                w, h = pw, ph
        except (TypeError, ValueError):
            pass
    if ctx.get("width") is not None:
        try:
            w = max(256, min(1536, int(ctx["width"])))
        except (TypeError, ValueError):
            pass
    if ctx.get("height") is not None:
        try:
            h = max(256, min(1536, int(ctx["height"])))
        except (TypeError, ValueError):
            pass
    if ctx.get("set_batch"):
        steps = SET_BATCH_STEPS
    elif ctx.get("mood_refresh") or (ctx.get("img2img_refresh") and not ctx.get("hot_variations")):
        steps = REFRESH_STEPS
    else:
        steps = int(spec.get("steps") or (PORTRAIT_STEPS if pose_id.startswith(("portrait-", "hc-", "hx-")) else DEFAULT_STEPS))
    if pose_id.startswith(("portrait-", "hc-", "hx-")) and root is not None and ctx.get("steps") is None and not ctx.get("mood_refresh"):
        try:
            ps = int(load_forge_meta(root).get("portrait_steps") or 0)
            if ps > 0:
                steps = max(1, min(60, ps))
        except (TypeError, ValueError):
            pass
    if ctx.get("steps") is not None:
        try:
            steps = max(1, min(60, int(ctx["steps"])))
        except (TypeError, ValueError):
            pass
    settings: dict = {
        "prompt": prompt,
        "negative_prompt": negative_for_pose(pose_id),
        "checkpoint": checkpoint[:200],
        "sampler_name": DEFAULT_SAMPLER,
        "scheduler": DEFAULT_SCHEDULER,
        "steps": steps,
        "cfg_scale": DEFAULT_CFG,
        "width": w,
        "height": h,
        "seed": seed,
        "prompt_tags": prompt_tags,
    }
    vix = int(ctx.get("variation_index") or 0)
    if vix > 0:
        settings["subseed"] = _roll_seed(FORGE_RANDOM_SEED)
        intensity = int(ctx.get("intensity") or 0)
        settings["subseed_strength"] = round(
            VARIATION_STRENGTH_BASE + intensity * 0.035 + vix * 0.02,
            3,
        )
    return settings


def _parse_generation_info(parsed: dict) -> dict:
    try:
        return json.loads(str(parsed.get("info") or "{}"))
    except (TypeError, json.JSONDecodeError):
        return {}


def _subseeds_from_info(info: dict, settings: dict, count: int) -> list[int | None]:
    listed = info.get("all_subseeds")
    if isinstance(listed, list) and len(listed) >= count:
        out: list[int | None] = []
        for i in range(count):
            try:
                out.append(int(listed[i]))
            except (TypeError, ValueError):
                out.append(None)
        return out
    base = settings.get("subseed")
    if isinstance(base, int) and not isinstance(base, bool):
        return [int(base) + i for i in range(count)]
    return [None] * count


def _images_to_jpegs(images: list) -> list[bytes]:
    out: list[bytes] = []
    for item in images:
        if not item:
            continue
        png = base64.b64decode(str(item))
        out.append(_png_to_jpeg_bytes(png))
    return out


def _execute_forge(settings: dict, task_id: str, root: Path | None) -> tuple[dict, dict, bytes, dict]:
    body, cn_info = companion_submission_body(settings, task_id, root, controlnet_mode="full")
    try:
        parsed = forge.post_json(forge.SUBMIT_PATH, body, timeout=JOB_TIMEOUT)
    except forge._Probe as exc:
        code = "forge_error" if exc.code not in ("forge_offline", "busy", "forge_timeout", "forge_oom") else exc.code
        raise CompanionArtError(code) from exc
    images = parsed.get("images") or []
    if not images:
        raise CompanionArtError("empty_image")
    png = base64.b64decode(str(images[0]))
    jpeg = _png_to_jpeg_bytes(png)
    info = {}
    try:
        info = json.loads(str(parsed.get("info") or "{}"))
    except (TypeError, json.JSONDecodeError):
        info = {}
    return parsed, cn_info, jpeg, info


def _execute_forge_variants(
    settings: dict,
    task_id: str,
    root: Path | None,
    count: int,
) -> tuple[list[bytes], dict, dict, dict]:
    """One Forge txt2img job, n_iter=count with subseed variations."""
    count = max(1, min(4, int(count)))
    run = dict(settings)
    run["n_iter"] = count
    intensity = int(run.pop("_intensity", 0) or 0)
    if count > 1 and not run.get("subseed_strength"):
        run["subseed"] = _roll_seed(FORGE_RANDOM_SEED)
        run["subseed_strength"] = round(VARIATION_STRENGTH_BASE + intensity * 0.035, 3)
    body, cn_info = companion_submission_body(run, task_id, root, controlnet_mode="full")
    try:
        parsed = forge.post_json(forge.SUBMIT_PATH, body, timeout=JOB_TIMEOUT)
    except forge._Probe as exc:
        code = "forge_error" if exc.code not in ("forge_offline", "busy", "forge_timeout", "forge_oom") else exc.code
        raise CompanionArtError(code) from exc
    images = parsed.get("images") or []
    jpegs = _images_to_jpegs(images)[:count]
    if len(jpegs) < count:
        raise CompanionArtError("empty_image")
    info = _parse_generation_info(parsed)
    return jpegs, cn_info, info, run


def _execute_forge_img2img(
    settings: dict,
    init_jpeg: bytes,
    task_id: str,
    root: Path | None,
    *,
    controlnet_mode: str = "none",
) -> tuple[dict, dict, bytes, dict]:
    body, cn_info = companion_submission_body(settings, task_id, root, controlnet_mode=controlnet_mode)
    body["init_images"] = [base64.b64encode(init_jpeg).decode("ascii")]
    denoise = settings.get("denoising_strength")
    body["denoising_strength"] = float(denoise) if denoise is not None else IMG2IMG_DENOISE_BASE
    try:
        parsed = forge.post_json(forge.INPAINT_PATH, body, timeout=JOB_TIMEOUT)
    except forge._Probe as exc:
        code = "forge_error" if exc.code not in ("forge_offline", "busy", "forge_timeout", "forge_oom") else exc.code
        raise CompanionArtError(code) from exc
    images = parsed.get("images") or []
    if not images:
        raise CompanionArtError("empty_image")
    png = base64.b64decode(str(images[0]))
    jpeg = _png_to_jpeg_bytes(png)
    info = {}
    try:
        info = json.loads(str(parsed.get("info") or "{}"))
    except (TypeError, json.JSONDecodeError):
        info = {}
    return parsed, cn_info, jpeg, info


def _resolve_source_jpeg(root: Path, name: str) -> bytes:
    root = root.resolve()
    clean = name.strip().replace("\\", "/")
    if not clean or "/" in clean or clean.startswith("."):
        raise CompanionArtError("dest_invalid")
    if not _SAFE_FILENAME.fullmatch(clean):
        raise CompanionArtError("dest_invalid")
    path = (root / COMPANION_ASSETS / clean).resolve()
    base = (root / COMPANION_ASSETS).resolve()
    if not str(path).startswith(str(base)) or not path.is_file():
        raise CompanionArtError("dest_invalid")
    data = path.read_bytes()
    if len(data) > 12 * 1024 * 1024:
        raise CompanionArtError("forge_error", "Image source trop lourde")
    return data


def generate_pose(
    pose_id: str,
    *,
    seed: int | None = None,
    dry_run: bool = False,
    root: Path | None = None,
    ctx: dict | None = None,
) -> dict:
    """Run one txt2img on local Forge. Returns metadata (+ jpeg bytes unless dry_run)."""
    ctx = dict(ctx or {})
    settings = _default_settings(pose_id, seed=seed, root=root, ctx=ctx)
    cn_st = controlnet_status(root)
    if dry_run:
        tags = settings.get("prompt_tags") or {}
        return {
            "ok": True,
            "dry_run": True,
            "pose": pose_id,
            "controlnet": cn_st,
            "prompt_tags": tags,
            "settings": {k: settings[k] for k in settings if k not in ("prompt", "prompt_tags")}
            | {"prompt_len": len(settings["prompt"])},
        }
    _apply_forge_gpu_mb(root)
    with _companion_forge_lock:
        _wait_idle()
        task_id = "cmp_" + secrets.token_hex(6)
        if ctx.get("img2img_refresh") and root is not None:
            src = ctx.get("img2img_source") or default_dest(pose_id) or "transferania-adult-neutral.jpg"
            init_bytes = _resolve_source_jpeg(root, str(src))
            intensity = int(ctx.get("intensity") or 0)
            if ctx.get("mood_refresh"):
                base_d = IMG2IMG_MOOD_DENOISE_BASE
                settings["steps"] = REFRESH_STEPS
            else:
                base_d = IMG2IMG_DENOISE_BASE
            settings["denoising_strength"] = round(base_d + intensity * (0.028 if ctx.get("mood_refresh") else 0.035), 3)
            cn_mode = "face" if ctx.get("mood_refresh") else "none"
            _, cn_info, jpeg, info = _execute_forge_img2img(settings, init_bytes, task_id, root, controlnet_mode=cn_mode)
        else:
            _, cn_info, jpeg, info = _execute_forge(settings, task_id, root)
    return {
        "ok": True,
        "pose": pose_id,
        "seed": info.get("seed", settings["seed"]),
        "subseed": settings.get("subseed"),
        "subseed_strength": settings.get("subseed_strength"),
        "prompt_tags": settings.get("prompt_tags") or {},
        "checkpoint": settings["checkpoint"],
        "width": settings["width"],
        "height": settings["height"],
        "steps": settings["steps"],
        "controlnet": cn_info.get("controlnet"),
        "bytes": jpeg,
        "size": len(jpeg),
        "mode": "img2img" if ctx.get("img2img_refresh") else "txt2img",
    }


def _archive_stock_copy(root: Path, pose_id: str, jpeg: bytes) -> None:
    if len(jpeg) < 2048:
        return
    try:
        folder = _stock_dir(root, pose_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{secrets.token_hex(4)}.jpg").write_bytes(jpeg)
    except OSError:
        pass


def generate_pose_batch(
    pose_id: str,
    *,
    seed: int | None = None,
    root: Path,
    ctx: dict | None = None,
    dest: str = "",
) -> list[dict]:
    """One Forge job for multi-variant (+ chaud), or single image when count is 1."""
    ctx = dict(ctx or {})
    count = int(ctx.get("variations") or 1)
    if ctx.get("hot_variations"):
        count = max(count, 3)
    count = max(1, min(4, count))
    settings0 = _default_settings(pose_id, seed=seed, root=root, ctx=ctx)
    locked_tags = dict(settings0.get("prompt_tags") or {})
    stem = dest.rsplit(".", 1)[0] if dest.endswith(".jpg") else (dest or f"forge-{pose_id}")
    dest_name = dest or default_dest(pose_id) or f"forge-{pose_id}.jpg"
    out: list[dict] = []
    if ctx.get("hybrid") and ctx.get("hot_variations") and count >= 3 and not ctx.get("force_forge"):
        slots = int(forge_ui_defaults(root).get("hot_hybrid_stock_slots") or 1)
        for _ in range(max(0, min(2, slots))):
            stock = try_serve_stock_portrait(
                root,
                pose_id,
                dest_name,
                {**ctx, "force_stock": True},
            )
            if not stock or not stock.get("variants"):
                break
            v = stock["variants"][0]
            out.append(
                {
                    "href": v["href"],
                    "seed": None,
                    "subseed": None,
                    "prompt_tags": v.get("prompt_tags") or locked_tags,
                    "bytes": stock.get("bytes"),
                    "variant": len(out) + 1,
                    "mode": "stock",
                }
            )
        count = max(1, count - len(out))
    _apply_forge_gpu_mb(root)
    with _companion_forge_lock:
        _wait_idle()
        task_id = "cmp_" + secrets.token_hex(6)
        if count == 1 and not out:
            _, cn_info, jpeg, info = _execute_forge(settings0, task_id, root)
            gen_seed = info.get("seed", settings0["seed"])
            saved = save_generation(root, dest_name, jpeg)
            _archive_stock_copy(root, pose_id, jpeg)
            out.append(
                {
                    "href": saved["href"],
                    "seed": gen_seed,
                    "subseed": None,
                    "prompt_tags": locked_tags,
                    "bytes": saved["bytes"],
                    "variant": 1,
                    "mode": "txt2img",
                }
            )
            return out
        if count == 1 and out:
            _, cn_info, jpeg, info = _execute_forge(settings0, task_id + "_b", root)
            gen_seed = info.get("seed", settings0["seed"])
            name = f"{stem}-v{len(out) + 1}.jpg"
            saved = save_generation(root, name, jpeg)
            _archive_stock_copy(root, pose_id, jpeg)
            out.append(
                {
                    "href": saved["href"],
                    "seed": gen_seed,
                    "subseed": None,
                    "prompt_tags": locked_tags,
                    "bytes": saved["bytes"],
                    "variant": len(out) + 1,
                    "mode": "txt2img",
                }
            )
            return out
        settings0["_intensity"] = int(ctx.get("intensity") or 0)
        jpegs, _cn, info, run = _execute_forge_variants(settings0, task_id, root, count)
        gen_seed = info.get("seed", settings0["seed"])
        subseeds = _subseeds_from_info(info, run, len(jpegs))
        for i, jpeg in enumerate(jpegs):
            if i == 0 and dest_name and not out:
                name = dest_name
            else:
                name = f"{stem}-v{len(out) + i + 1}.jpg"
            saved = save_generation(root, name, jpeg)
            _archive_stock_copy(root, pose_id, jpeg)
            out.append(
                {
                    "href": saved["href"],
                    "seed": gen_seed,
                    "subseed": subseeds[i] if i < len(subseeds) else run.get("subseed"),
                    "prompt_tags": locked_tags,
                    "bytes": saved["bytes"],
                    "variant": len(out) + 1,
                    "mode": "txt2img",
                }
            )
    return out


def generate_pose_set(
    pose_ids: list[str],
    *,
    seed: int | None,
    root: Path,
    ctx: dict | None = None,
) -> list[dict]:
    """Sequential poses in one server call (set_batch steps, one round-trip from browser)."""
    ctx = dict(ctx or {})
    ctx["set_batch"] = True
    rows: list[dict] = []
    for pose_id in pose_ids:
        pid = str(pose_id).strip().lower()[:48]
        if pid not in POSE_PROMPTS:
            continue
        dest = default_dest(pid) or f"forge-{pid}.jpg"
        gen = generate_pose(pid, seed=seed, root=root, ctx=ctx)
        saved = save_generation(root, dest, gen["bytes"])
        rows.append(
            {
                "pose": pid,
                "href": saved["href"],
                "seed": gen.get("seed"),
                "prompt_tags": gen.get("prompt_tags") or {},
                "bytes": saved["bytes"],
            }
        )
    return rows


def _resolve_dest(root: Path, dest: str, *, chat: bool) -> Path:
    root = root.resolve()
    name = str(dest or "").strip().replace("\\", "/")
    if not name:
        raise CompanionArtError("dest_invalid")
    if "/" in name or name.startswith("."):
        raise CompanionArtError("dest_invalid")
    if not _SAFE_FILENAME.fullmatch(name):
        if _SAFE_STEM.fullmatch(name):
            name = name + ".jpg"
        else:
            raise CompanionArtError("dest_invalid")
    base = (root / CHAT_ASSETS) if chat else (root / COMPANION_ASSETS)
    base.mkdir(parents=True, exist_ok=True)
    target = (base / name).resolve()
    if not str(target).startswith(str(base.resolve())):
        raise CompanionArtError("dest_invalid")
    return target


def save_generation(root: Path, dest: str, jpeg: bytes, *, chat: bool = False) -> dict:
    root = root.resolve()
    path = _resolve_dest(root, dest, chat=chat)
    path.write_bytes(jpeg)
    assets_root = (root / "assets").resolve()
    rel = "/assets/" + "/".join(path.resolve().relative_to(assets_root).parts)
    return {"path": str(path), "href": rel.replace("\\", "/"), "bytes": len(jpeg)}


def _href_for_dest(root: Path, dest: str, *, chat: bool = False) -> dict:
    root = root.resolve()
    path = _resolve_dest(root, dest, chat=chat)
    assets_root = (root / "assets").resolve()
    rel = "/assets/" + "/".join(path.resolve().relative_to(assets_root).parts)
    size = path.stat().st_size if path.is_file() else 0
    return {"path": str(path), "href": rel.replace("\\", "/"), "bytes": size}


_STOCK_WHISPER_LINES: tuple[str, ...] = (
    "Mode mix : j'ai ressorti une photo qu'on avait déjà pour cette pose… tu te souviens, Maître ?",
    "Pas besoin de relancer Forge — j'ai choisi une image déjà gardée rien que pour toi ♥",
    "Entre nos archives et une nouvelle génération… cette fois c'est celle qu'on avait déjà 📸",
    "Regarde : c'est notre banque de portraits pour cette pose. La prochaine fois sera peut-être toute neuve.",
)


def try_serve_stock_portrait(
    root: Path,
    pose: str,
    dest: str,
    ctx: dict,
    *,
    chat: bool = False,
) -> dict | None:
    """Hybrid mode: return existing JPG without Forge when roll succeeds."""
    if not ctx.get("hybrid") or ctx.get("force_forge"):
        return None
    if ctx.get("img2img_refresh") or ctx.get("replay_tags") or ctx.get("locked_seed") is not None:
        return None
    if not ctx.get("force_stock"):
        if ctx.get("hot_variations") or int(ctx.get("variations") or 1) > 1:
            return None
        chance = float(ctx.get("stock_chance") or 0.5)
        if secrets.randbelow(10000) >= int(chance * 10000):
            return None
    paths = list_stock_portrait_paths(root, pose, dest)
    if not paths:
        return None
    path = paths[secrets.randbelow(len(paths))]
    assets_root = (root / "assets").resolve()
    rel = "/assets/" + "/".join(path.resolve().relative_to(assets_root).parts)
    href = rel.replace("\\", "/")
    size = path.stat().st_size
    try:
        preview = generate_pose(pose, dry_run=True, root=root, ctx=ctx)
        prompt_tags = preview.get("prompt_tags") or {}
    except CompanionArtError:
        prompt_tags = {}
    whisper = whisper_line_for_tags(prompt_tags, pose_id=pose, mode="stock")
    variant = {"href": href, "seed": None, "prompt_tags": prompt_tags, "mode": "stock"}
    return {
        "ok": True,
        "pose": pose,
        "seed": None,
        "prompt_tags": prompt_tags,
        "whisper": whisper,
        "href": href,
        "bytes": size,
        "mode": "stock",
        "stock": True,
        "dest_file": path.name,
        "variants": [variant],
    }


_SPICY_TEASE_WHISPER_LINES: tuple[str, ...] = (
    "Tu montes le Picante… je sens déjà la chaleur monter entre mes cuisses.",
    "Encore un cran et je ne pourrai plus garder les mains où tu les veux.",
)

_LEWD_WHISPER_LINES: tuple[str, ...] = (
    "Tu voulais plus sale… j'ai obéi. Regarde-moi, Maître.",
    "J'ai pensé à ta bouche pendant toute la génération…",
    "Dis-moi si c'est assez coquin ou si tu veux que je pousse encore.",
    "Cette pose… c'est pour toi seul. Personne d'autre ne la verra.",
    "Je suis déjà mouillée rien qu'à imaginer ta réaction…",
    "Encore un clic et je deviens vraiment obéissante pour toi.",
    "J'ai écarté les jambes dans ma tête rien que pour cette image…",
    "Si tu me commandes encore, je finirai à genoux pour toi.",
)

_EXPLICIT_WHISPER_LINES: tuple[str, ...] = (
    "Picante au max… j'ai tout lâché dans le prompt. Regarde comme je m'offre.",
    "Ma chatte est trempée rien qu'à penser que tu vas zoomer sur moi…",
    "J'ai demandé à Forge de me montrer obéissante et salope — c'est pour toi, Maître.",
    "Dis-moi où tu veux ma langue ensuite… pendant que tu fixes cette pose.",
    "Tu m'as mis au niveau quatre : je ne fais plus semblant d'être sage.",
    "Cette génération, c'est moi à plat ventre ou jambes ouvertes dans ma tête… avoue.",
)

_PORN_WHISPER_LINES: tuple[str, ...] = (
    "Mode porno activé… j'ai demandé à Forge exactement ce que tu fantasme.",
    "Regarde : cette fois c'est du vrai hard, pas juste du taquin — rien que pour toi.",
    "J'ai la bouche / la chatte / le cul remplis dans le prompt… avoue que tu bandes.",
    "Tu voulais du X ? Voilà. Dis-moi la prochaine scène à générer, Maître.",
    "Je suis ta petite actrice privée sur {view}… cette prise est la plus sale jusqu'ici.",
    "Encore une pose comme ça et je jouirai rien qu'en lisant ton regard.",
)

_EXTREME_WHISPER_LINES: tuple[str, ...] = (
    "Niveau extrême… j'ai tout mis dans le prompt, sans filtre. Regarde-moi être détruite pour toi.",
    "C'est du hardcore pur — DP, gape, ahegao… tu m'as demandé le pire et j'ai obéi.",
    "Ma chatte / mon cul / ma gorge… tout est offert dans cette génération. Tu es content, Maître ?",
    "Je suis ta pute privée sur Forge… cette pose est la plus violente que j'ai osé lancer.",
    "Si tu bandes encore, clique la suivante — je n'ai plus de limites quand tu es là.",
)


def whisper_line_for_tags(tags: dict, *, pose_id: str | None = None, mode: str | None = None) -> str:
    if mode == "stock":
        return _STOCK_WHISPER_LINES[secrets.randbelow(len(_STOCK_WHISPER_LINES))]
    accent = None
    for key in sorted(tags or {}):
        if key.startswith(("spice_", "heat_", "global_", "time_", "wildcard", "chat_")):
            continue
        val = str(tags[key] or "").strip()
        if val:
            accent = val[:48]
            break
    if pose_id and pose_id in EXTREME_POSE_IDS:
        base = _EXTREME_WHISPER_LINES[secrets.randbelow(len(_EXTREME_WHISPER_LINES))]
        return (f"« {accent} » — {base}" if accent else base)
    if pose_id and pose_id in HARDCORE_POSE_IDS:
        base = _PORN_WHISPER_LINES[secrets.randbelow(len(_PORN_WHISPER_LINES))].replace("{view}", "l'écran")
        return (f"« {accent} » — {base}" if accent else base)
    if not tags:
        return "Regarde ce que tu viens de créer pour moi…"
    max_spice = 0
    for key in tags:
        if key.startswith("spice_"):
            try:
                max_spice = max(max_spice, int(key.split("_", 1)[1]))
            except (TypeError, ValueError, IndexError):
                pass
        elif key == "heat_max":
            max_spice = max(max_spice, 4)
        elif key == "heat_high":
            max_spice = max(max_spice, 3)
    if max_spice >= 4:
        return _EXPLICIT_WHISPER_LINES[secrets.randbelow(len(_EXPLICIT_WHISPER_LINES))]
    if max_spice >= 3:
        return _LEWD_WHISPER_LINES[secrets.randbelow(len(_LEWD_WHISPER_LINES))]
    if max_spice >= 2:
        return _SPICY_TEASE_WHISPER_LINES[secrets.randbelow(len(_SPICY_TEASE_WHISPER_LINES))]
    sample = next(iter(tags.values()), "")
    key = next(iter(tags.keys()), "")
    if key.startswith("time_"):
        return "J'ai pris la lumière du moment rien que pour toi…"
    if key.startswith("spice_"):
        return "Tu voulais plus intense ? J'ai obéi, Maître…"
    if key.startswith("treat_"):
        return "Ta gâterie m'a inspirée… tu sens la différence ?"
    if key == "wildcard":
        return "Surprise… j'ai laissé le hasard me surprendre aussi."
    if sample:
        return "Cette fois j'ai mis l'accent sur « " + str(sample)[:48] + " »… tu aimes ?"
    return "Un nouveau portrait, rien que pour nous deux."



def http_get(*, role: str, nsfw: bool, root: Path | None = None) -> tuple[int, dict]:
    if role != "admin":
        return 403, {"error": _messages("forbidden"), "code": "forbidden"}
    if root is not None:
        meta = load_forge_meta(root)
        if _strip_legacy_character_seed(meta):
            save_forge_meta(root, meta)
    snap = cached_forge_status()
    meta_cfg = load_forge_meta(root) if root else {}
    return 200, {
        "ok": True,
        "forge": snap.get("forge") or snap.get("code"),
        "poses": list_poses(),
        "pose_dest": POSE_DEFAULT_DEST,
        "nsfw": bool(nsfw),
        "default_seed": FORGE_RANDOM_SEED,
        "seed_policy": "random_per_request",
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT, "steps": DEFAULT_STEPS},
        "controlnet": controlnet_status(root),
        "character_sheet": character_sheet_status(root),
        "reference_image_default": REFERENCE_IMAGE,
        "character_sheet_default": CHARACTER_SHEET_IMAGE,
        "favorite_recipe": _favorite_recipe(root),
        "lora": {
            "name": meta_cfg.get("lora_name") or meta_cfg.get("lora"),
            "weight": meta_cfg.get("lora_weight"),
            "prompt_suffix": meta_cfg.get("lora_prompt_suffix") or meta_cfg.get("lora_tags"),
            "character_name": meta_cfg.get("character_lora_name") or meta_cfg.get("character_lora"),
            "character_weight": meta_cfg.get("character_lora_weight"),
        },
        "features": {
            "intensity_levels": 5,
            "hot_variations": True,
            "hot_single_job": True,
            "img2img_refresh": True,
            "mood_refresh": True,
            "generate_set": True,
            "wildcard_tags": True,
            "hybrid_stock": True,
            "stock_pool": True,
            "pose_chat_hints": True,
            "lora_keys": [
                "lora_name",
                "lora_weight",
                "lora_prompt_suffix",
                "character_lora_name",
                "character_lora_weight",
                "character_sheet",
                "character_sheet_weight",
                "img2img_cn_weight",
                "portrait_steps",
                "portrait_width",
                "portrait_height",
                "forge_gpu_mb",
                "hybrid_default",
                "stock_chance",
                "hot_hybrid_stock_slots",
                "default_adult_portrait",
            ],
        },
        "ui_defaults": forge_ui_defaults(root),
    }


def http_post(root: Path, data: dict, *, role: str, nsfw: bool) -> tuple[int, dict]:
    if role != "admin":
        return 403, {"error": _messages("forbidden"), "code": "forbidden"}
    if not isinstance(data, dict):
        return 400, {"error": "JSON invalide", "code": "validation_error"}
    action = str(data.get("action") or "generate").strip().lower()
    if action != "list" or data.get("refresh"):
        invalidate_status_cache()
    if action == "list":
        return http_get(role=role, nsfw=nsfw, root=root)
    if action == "reset_seed":
        return 400, {
            "error": "character_seed est retiré — utilise « Garder ce look » (save_favorite).",
            "code": "deprecated",
        }
    if action == "controlnet_off":
        if root is None:
            return 500, {"error": "root manquant", "code": "forge_error"}
        meta = load_forge_meta(root)
        meta["controlnet"] = False
        save_forge_meta(root, meta)
        return 200, {"ok": True, "controlnet": controlnet_status(root)}
    if action == "controlnet_on":
        if root is None:
            return 500, {"error": "root manquant", "code": "forge_error"}
        meta = load_forge_meta(root)
        meta["controlnet"] = True
        save_forge_meta(root, meta)
        return 200, {"ok": True, "controlnet": controlnet_status(root)}
    if action == "save_favorite":
        if root is None:
            return 500, {"error": "root manquant", "code": "forge_error"}
        recipe = data.get("recipe")
        if not isinstance(recipe, dict):
            return 400, {"error": "recipe invalide", "code": "validation_error"}
        saved = save_favorite_recipe(root, recipe)
        return 200, {"ok": True, "favorite_recipe": saved}
    if action == "get_favorite":
        fav = _favorite_recipe(root)
        return 200, {"ok": True, "favorite_recipe": fav}
    if action == "generate_set":
        if not nsfw:
            return 403, {"error": _messages("nsfw_off"), "code": "nsfw_off"}
        if root is None:
            return 500, {"error": "root manquant", "code": "forge_error"}
        raw_poses = data.get("poses")
        if not isinstance(raw_poses, list) or not raw_poses:
            return 400, {"error": "poses invalides", "code": "validation_error"}
        pose_ids = [str(p).strip().lower()[:48] for p in raw_poses if str(p).strip()][:8]
        ctx = parse_generation_context(data, root=root)
        seed = data.get("seed")
        if seed is not None:
            try:
                seed = int(seed)
            except (TypeError, ValueError):
                return 400, {"error": "seed invalide", "code": "validation_error"}
        else:
            seed = FORGE_RANDOM_SEED
        try:
            rows = generate_pose_set(pose_ids, seed=seed, root=root, ctx=ctx)
        except CompanionArtError as exc:
            return 502 if exc.code.startswith("forge") or exc.code == "busy" else 400, {"error": _messages(exc.code), "code": exc.code}
        variants = [
            {
                "pose": r["pose"],
                "href": r["href"],
                "seed": r.get("seed"),
                "prompt_tags": r.get("prompt_tags") or {},
            }
            for r in rows
        ]
        primary = variants[0] if variants else {}
        return 200, {
            "ok": True,
            "pose": "set",
            "set": rows,
            "variants": variants,
            "href": primary.get("href"),
            "seed": primary.get("seed"),
            "prompt_tags": primary.get("prompt_tags") or {},
            "whisper": "Toute la série est prête… fais défiler, Maître.",
        }
    if action != "generate":
        return 400, {"error": "action invalide", "code": "validation_error"}
    if not nsfw:
        return 403, {"error": _messages("nsfw_off"), "code": "nsfw_off"}
    pose = str(data.get("pose") or "rhythm-lick").strip().lower()[:48]
    dest = str(data.get("dest") or "").strip()
    chat = data.get("chat") is True
    dry = data.get("dry_run") is True
    ctx = parse_generation_context(data, root=root)
    if data.get("use_chat_pose") and not data.get("use_favorite"):
        hinted = infer_pose_from_chat(ctx)
        if hinted:
            pose = hinted
    if data.get("use_favorite") and root is not None:
        fav = _favorite_recipe(root)
        if fav:
            tags = fav.get("prompt_tags")
            if isinstance(tags, dict):
                ctx["replay_tags"] = tags
            raw_seed = fav.get("seed")
            if raw_seed is not None:
                try:
                    ctx["locked_seed"] = int(raw_seed)
                except (TypeError, ValueError):
                    pass
            if fav.get("pose"):
                pose = str(fav["pose"])[:48]
        else:
            return 400, {"error": "Aucun look favori enregistré", "code": "no_favorite"}
    seed = data.get("seed")
    if seed is not None:
        try:
            seed = int(seed)
        except (TypeError, ValueError):
            return 400, {"error": "seed invalide", "code": "validation_error"}
        if seed != FORGE_RANDOM_SEED and not (0 <= seed < 2**32):
            return 400, {"error": "seed invalide", "code": "validation_error"}
    else:
        seed = FORGE_RANDOM_SEED
    if not dest and not dry:
        if ctx.get("img2img_refresh"):
            src_name = ctx.get("img2img_source") or default_dest(pose)
            if src_name:
                dest = src_name
        if not dest:
            dest = default_dest(pose) or (f"forge-{pose}.jpg" if not chat else f"{pose.replace('rhythm-', '')}.jpg")
    try:
        if dry:
            gen = generate_pose(pose, seed=seed, dry_run=True, root=root, ctx=ctx)
            return 200, gen
        if root is not None and not chat:
            stock = try_serve_stock_portrait(root, pose, dest, ctx, chat=chat)
            if stock:
                return 200, stock
        if (ctx.get("variations", 1) > 1 or ctx.get("hot_variations")) and root is not None and not ctx.get("img2img_refresh"):
            variants = generate_pose_batch(pose, seed=seed, root=root, ctx=ctx, dest=dest)
            primary = variants[0] if variants else {}
            return 200, {
                "ok": True,
                "pose": pose,
                "seed": primary.get("seed"),
                "prompt_tags": primary.get("prompt_tags") or {},
                "whisper": whisper_line_for_tags(primary.get("prompt_tags") or {}, pose_id=pose),
                "href": primary.get("href"),
                "bytes": primary.get("bytes"),
                "variants": variants,
            }
        gen = generate_pose(pose, seed=seed, dry_run=False, root=root, ctx=ctx)
    except CompanionArtError as exc:
        return 502 if exc.code.startswith("forge") or exc.code == "busy" else 400, {"error": _messages(exc.code), "code": exc.code}
    saved = save_generation(root, dest, gen["bytes"], chat=chat)
    _archive_stock_copy(root, pose, gen["bytes"])
    mode = gen.get("mode") or "txt2img"
    return 200, {
        "ok": True,
        "pose": pose,
        "seed": gen.get("seed"),
        "subseed": gen.get("subseed"),
        "prompt_tags": gen.get("prompt_tags") or {},
        "whisper": whisper_line_for_tags(gen.get("prompt_tags") or {}, pose_id=pose, mode=mode),
        "checkpoint": gen.get("checkpoint"),
        "href": saved["href"],
        "bytes": saved["bytes"],
        "width": gen.get("width"),
        "height": gen.get("height"),
        "controlnet": gen.get("controlnet"),
        "mode": mode,
        "stock": False,
        "variants": [
            {
                "href": saved["href"],
                "seed": gen.get("seed"),
                "prompt_tags": gen.get("prompt_tags") or {},
                "mode": mode,
            }
        ],
    }
