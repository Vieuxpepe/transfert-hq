"""Read-only inventory of a local Forge. No generation.

Skipped unless HQ_FORGE_LIVE=1. This never POSTs.
"""

from __future__ import annotations

import json
import os
import unittest
import urllib.error
import urllib.request


@unittest.skipUnless(os.environ.get("HQ_FORGE_LIVE") == "1", "set HQ_FORGE_LIVE=1 to read the local Forge API")
class LiveCatalog(unittest.TestCase):
    def test_read_only_inventory(self) -> None:
        def get(path: str):
            request = urllib.request.Request("http://127.0.0.1:7860" + path, method="GET")
            try:
                with urllib.request.urlopen(request, timeout=8) as response:
                    return response.status, json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                return exc.code, None

        status, upscalers = get("/sdapi/v1/upscalers")
        self.assertEqual(status, 200)
        names = [item.get("name") for item in upscalers if isinstance(item, dict)]
        self.assertIn("R-ESRGAN 4x+", names)
        self.assertNotIn("None", [name for name in names if name in {"R-ESRGAN 4x+", "Lanczos"}])
        vae_status, _vae = get("/sdapi/v1/sd-vae")
        self.assertEqual(vae_status, 404)
        _status, options = get("/sdapi/v1/options")
        self.assertIsInstance(options, dict)
        self.assertIn("CLIP_stop_at_last_layers", options)
        self.assertIn("sd_vae", options)
        self.assertNotIn("prompt", options)


if __name__ == "__main__":
    unittest.main()
