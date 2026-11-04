"""Tests for Forge-backed companion art (mocked Forge)."""
from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_companion_art as art
import hq_forge as forge

ROOT = Path(__file__).resolve().parents[1]


class CompanionArtRouteTests(unittest.TestCase):
    def test_admin_only(self):
        code, out = art.http_get(role="viewer", nsfw=True)
        self.assertEqual(code, 403)

    def test_compose_prompt_varies_by_pools(self):
        spec = art.POSE_PROMPTS["portrait-neutral"]
        rolls = iter([0, 0, 0, 0, 0, 0, 0])
        with mock.patch.object(art.secrets, "randbelow", side_effect=lambda n: next(rolls, 0) % max(n, 1)):
            extra_a, tags_a = art._compose_pose_prompt(spec)
            rolls = iter([1, 1, 1, 1, 1, 1, 1])
            with mock.patch.object(art.secrets, "randbelow", side_effect=lambda n: next(rolls, 0) % max(n, 1)):
                extra_b, tags_b = art._compose_pose_prompt(spec)
        self.assertNotEqual(extra_a, extra_b)
        self.assertIn("expression", tags_a)
        self.assertIn("global_quality", tags_a)

    def test_dry_run_includes_prompt_tags(self):
        with mock.patch.object(forge, "read_options", return_value={"sd_model_checkpoint": "test.safetensors"}):
            gen = art.generate_pose("portrait-neutral", dry_run=True, root=ROOT)
        self.assertTrue(gen.get("dry_run"))
        self.assertIsInstance(gen.get("prompt_tags"), dict)
        self.assertTrue(gen["prompt_tags"])

    def test_new_explicit_poses_registered(self):
        for pid in (
            "missionary-legs-up",
            "face-down-ass-up",
            "shower-wet",
            "desk-bent-over",
            "mirror-selfie-nude",
            "bondage-light",
            "reverse-cowgirl",
            "wall-pin-standing",
            "stomach-feet-up",
            "bath-bubbles",
            "chair-straddle-back",
            "lingerie-peel",
            "pole-dance-tease",
            "spoon-side-nude",
            "lap-straddle-grind",
            "split-stretch-tease",
            "hc-bj-pov",
            "hc-missionary-pov",
            "hc-creampie",
            "hx-mating-press",
            "hx-fucked-silly",
        ):
            self.assertIn(pid, art.POSE_PROMPTS)
            self.assertTrue(art.default_dest(pid))
        line = art.whisper_line_for_tags({}, pose_id="hc-bj-pov")
        self.assertTrue(line)
        line_x = art.whisper_line_for_tags({}, pose_id="hx-double-penetration")
        self.assertTrue(line_x)
        self.assertIn("nude", art.character_core_for_pose("hx-double-penetration"))
        self.assertIn("2boys", art.negative_for_pose("hx-double-penetration"))
        with mock.patch.object(forge, "read_options", return_value={"sd_model_checkpoint": "test.safetensors"}):
            gen = art.generate_pose("shower-wet", dry_run=True, root=ROOT)
        tags = gen.get("prompt_tags") or {}
        self.assertTrue(tags)
        self.assertTrue(any(k in tags for k in ("water", "pose", "face", "light")))

    def test_each_generate_gets_fresh_seed(self):
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 64).decode()
        seen: list[int] = []

        def fake_post(_path, body, **_kw):
            seen.append(int(body["seed"]))
            return {"images": [png_b64], "info": json.dumps({"seed": body["seed"]})}

        rolls = iter([111, 222])

        with mock.patch.object(forge, "read_options", return_value={"sd_model_checkpoint": "test.safetensors"}):
            with mock.patch.object(art, "_wait_idle"):
                with mock.patch.object(art, "_roll_seed", side_effect=lambda _s: next(rolls)):
                    with mock.patch.object(art.secrets, "randbelow", return_value=0):
                        with mock.patch.object(forge, "post_json", side_effect=fake_post):
                            with mock.patch.object(art, "_png_to_jpeg_bytes", return_value=b"\xff\xd8\xff"):
                                art.generate_pose("rhythm-lick", root=ROOT)
                                art.generate_pose("rhythm-lick", root=ROOT)
        self.assertEqual(seen, [111, 222])


class CompanionArtGenerateTests(unittest.TestCase):
    def test_generate_mock_forge(self):
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 64).decode()
        with mock.patch.object(forge, "read_options", return_value={"sd_model_checkpoint": "test.safetensors"}):
            with mock.patch.object(art, "_wait_idle"):
                with mock.patch.object(forge, "post_json", return_value={"images": [png_b64], "info": "{}"}):
                    with mock.patch.object(art, "_png_to_jpeg_bytes", return_value=b"\xff\xd8\xff"):
                        gen = art.generate_pose("rhythm-lick", root=ROOT)
        self.assertEqual(gen["bytes"], b"\xff\xd8\xff")

    def test_controlnet_body_when_reference_present(self):
        ref = ROOT / "assets" / "companion" / "companion-forge-reference.jpg"
        if not ref.is_file():
            self.skipTest("reference image missing")
        settings = {
            "prompt": "test",
            "negative_prompt": "",
            "checkpoint": "m.safetensors",
            "sampler_name": "Euler",
            "scheduler": "automatic",
            "steps": 16,
            "cfg_scale": 5,
            "width": 512,
            "height": 512,
            "seed": 1,
        }
        body, info = art.companion_submission_body(settings, "cmp_abcd12", ROOT)
        self.assertTrue(info["controlnet"].get("active"))
        cn = body.get("alwayson_scripts", {}).get("controlnet", {}).get("args", [])
        self.assertGreaterEqual(len(cn), 1)
        self.assertIn("image", cn[0])
        self.assertNotIn("input_image", cn[0])
        self.assertIn(
            cn[0].get("module"),
            (art.DEFAULT_CONTROLNET_MODULE, art.IPADAPTER_MODULE_SDXL, art.IPADAPTER_MODULE_FACE),
        )
        self.assertEqual(cn[0].get("control_mode"), art.CONTROL_MODE_CONTROL)


class CompanionArtContextTests(unittest.TestCase):
    def test_parse_intensity_and_variations(self):
        ctx = art.parse_generation_context({"intensity": 9, "hot_variations": True, "treat_bonuses": ["kiss"]})
        self.assertEqual(ctx["intensity"], 4)
        self.assertTrue(ctx["hot_variations"])
        self.assertEqual(ctx["treat_bonuses"], ["kiss"])

    def test_whisper_line(self):
        line = art.whisper_line_for_tags({"wildcard": "rose petals falling"})
        self.assertIn("Surprise", line)

    def test_hybrid_stock_serves_existing_file(self):
        dest = art.default_dest("portrait-warm")
        self.assertTrue(dest)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "assets" / "companion" / dest
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\xff\xd8\xff" + b"x" * 4096)
            ctx = {"hybrid": True, "stock_chance": 1.0, "intensity": 2}
            with mock.patch.object(art.secrets, "randbelow", return_value=0), mock.patch.object(
                art, "generate_pose", return_value={"prompt_tags": {}}
            ):
                out = art.try_serve_stock_portrait(root, "portrait-warm", dest, ctx)
        self.assertIsNotNone(out)
        self.assertTrue(out.get("stock"))
        self.assertEqual(out.get("mode"), "stock")
        self.assertIn("/assets/companion/", out.get("href", ""))

    def test_hybrid_skips_when_force_forge(self):
        dest = art.default_dest("portrait-warm")
        ctx = {"hybrid": True, "stock_chance": 1.0, "force_forge": True}
        out = art.try_serve_stock_portrait(ROOT, "portrait-warm", dest or "x.jpg", ctx)
        self.assertIsNone(out)


    def test_batch_reuses_prompt_tags(self):
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 64).decode()

        def fake_variants(settings, task_id, root, count):
            self.assertEqual(count, 3)
            self.assertEqual(settings.get("prompt_tags", {}).get("mood"), "soft")
            return ([b"\xff\xd8\xff"] * 3, {"controlnet": {}}, {"seed": 99, "all_subseeds": [10, 11, 12]}, settings)

        with mock.patch.object(forge, "read_options", return_value={"sd_model_checkpoint": "test.safetensors"}):
            with mock.patch.object(art, "_wait_idle"):
                with mock.patch.object(
                    art,
                    "_default_settings",
                    return_value={
                        "seed": 99,
                        "prompt_tags": {"mood": "soft", "light": "warm"},
                        "prompt": "x",
                        "negative_prompt": "",
                        "checkpoint": "t.safetensors",
                        "sampler_name": "Euler",
                        "scheduler": "automatic",
                        "steps": 16,
                        "cfg_scale": 4.5,
                        "width": 512,
                        "height": 512,
                    },
                ):
                    with mock.patch.object(art, "_execute_forge_variants", side_effect=fake_variants):
                        with mock.patch.object(art, "save_generation", side_effect=lambda _r, name, b: {"href": "/assets/x/" + name, "bytes": len(b)}):
                            rows = art.generate_pose_batch(
                                "portrait-neutral",
                                root=ROOT,
                                ctx={"hot_variations": True, "variations": 3},
                                dest="transferania-adult-neutral.jpg",
                            )
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["prompt_tags"].get("mood"), "soft")

    def test_img2img_skips_controlnet(self):
        settings = {
            "prompt": "test",
            "negative_prompt": "",
            "checkpoint": "m.safetensors",
            "sampler_name": "Euler",
            "scheduler": "automatic",
            "steps": 16,
            "cfg_scale": 5,
            "width": 512,
            "height": 512,
            "seed": 1,
        }
        body, info = art.companion_submission_body(settings, "cmp_abcd12", ROOT, controlnet_mode="none")
        self.assertNotIn("controlnet", body.get("alwayson_scripts", {}))
        self.assertEqual(info["controlnet"].get("skipped"), "controlnet_off")

    def test_lora_tag_in_prompt(self):
        meta_path = ROOT / ".hq-ai" / "companion_forge.json"
        backup = meta_path.read_text(encoding="utf-8") if meta_path.is_file() else None
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
            data["lora_name"] = "test_lora"
            data["lora_weight"] = 0.6
            meta_path.parent.mkdir(parents=True, exist_ok=True)
            meta_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            out = art._inject_lora_prompt("base prompt", ROOT)
            self.assertIn("<lora:test_lora:0.60>", out)
        finally:
            if backup is None:
                if meta_path.is_file():
                    meta_path.unlink()
            else:
                meta_path.write_text(backup, encoding="utf-8")

    def test_character_lora_in_prompt(self):
        meta_path = ROOT / ".hq-ai" / "companion_forge.json"
        backup = meta_path.read_text(encoding="utf-8") if meta_path.is_file() else None
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
            data["character_lora_name"] = "body_lock"
            data["character_lora_weight"] = 0.9
            meta_path.parent.mkdir(parents=True, exist_ok=True)
            meta_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            out = art._inject_lora_prompt("base prompt", ROOT)
            self.assertIn("<lora:body_lock:0.90>", out)
        finally:
            if backup is None:
                if meta_path.is_file():
                    meta_path.unlink()
            else:
                meta_path.write_text(backup, encoding="utf-8")

    def test_mood_refresh_uses_fewer_steps(self):
        with mock.patch.object(forge, "read_options", return_value={"sd_model_checkpoint": "test.safetensors"}):
            gen = art.generate_pose(
                "portrait-neutral",
                dry_run=True,
                root=ROOT,
                ctx={"img2img_refresh": True, "mood_refresh": True},
            )
        self.assertEqual(gen["settings"]["steps"], art.REFRESH_STEPS)


if __name__ == "__main__":
    unittest.main()
