import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readLayeredPortrait } = require("../assets/hq-companion.js").pure;
const preference = value => ({ localStorage: { getItem: key => {
  assert.equal(key, "hq_companion_layered_portrait");
  return value;
} } });
assert.equal(readLayeredPortrait(preference(null)), true, "a browser without the new preference defaults to layers");
assert.equal(readLayeredPortrait(preference("1")), true, "explicit activation survives reload");
assert.equal(readLayeredPortrait(preference("0")), false, "an explicit flat-portrait choice remains available");
assert.equal(readLayeredPortrait({ localStorage: { getItem() { throw new Error("storage blocked"); } } }), true,
  "blocked storage does not revert the default to the old portrait");
const dir = new URL("../assets/companion/rig-neutral-v1/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const source = readFileSync(new URL("source.jpg", dir));
assert.equal(createHash("sha256").update(source).digest("hex"), manifest.source_sha256);
assert.deepEqual(manifest.canvas, [512, 512]);
assert.equal(manifest.layers.length, 5);
for (const { file } of manifest.layers) {
  assert.ok(existsSync(new URL(file, dir)), file + " is present");
  const svg = readFileSync(new URL(file, dir), "utf8");
  assert.ok(svg.includes('viewBox="0 0 512 512"'), file + " has the shared registration frame");
  const textures = [...svg.matchAll(/<image\b[^>]*href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(textures.length > 0 && textures.every(h => h.startsWith("data:image/")),
    file + " renders without external SVG image fetches");
}
for (const png of ["breast-left.png", "breast-right.png"]) {
  assert.ok(existsSync(new URL(png, dir)), png + " is present for layered bust lobes");
}
const js = readFileSync(new URL("../assets/hq-companion.js", import.meta.url), "utf8");
assert.ok(js.includes("rig-face-brow") && js.includes("--rig-brow-left-y"), "layered rig animates brows");
assert.ok(js.includes("rig-face-mouth") && js.includes("--rig-mouth-sy"), "layered rig animates mouth");
const overlay = readFileSync(new URL("garment-front.svg", dir), "utf8");
const textures = [...overlay.matchAll(/<image\b[^>]*href="data:image\/jpeg;base64,([^"]+)"/g)];
assert.equal(textures.length, 1, "the moving part has exactly one original texture");
assert.ok(Buffer.from(textures[0][1], "base64").equals(source), "original pixels are preserved without regeneration");
assert.ok(overlay.includes('mask="url(#cut)"'), "the full square portrait is never used as the moving silhouette");
const css = readFileSync(new URL("../assets/hq-companion.css", import.meta.url), "utf8");
assert.ok(/has-layered-portrait\.is-nsfw[^}]*rig-garment-front[^}]*clip-path:none/.test(css.replace(/\s+/g, " ")),
  "layered bust lobes are not circle-clipped at idle");
assert.ok(/has-layered-portrait\.is-nsfw[^}]*overflow:visible/.test(css.replace(/\s+/g, " ")),
  "layered portrait allows bust overflow past the avatar ring");
assert.ok(/has-layered-portrait\.is-nsfw:not\(\.is-minimal\)\{[^}]*contain:layout style/.test(css.replace(/\s+/g, " ")),
  "layered bust lobes are not paint-contained above the tab bar");
assert.ok(!/rig-bust-right\{[^}]*position\s*:\s*relative/.test(css.replace(/\s+/g, " ")),
  "right bust layer keeps absolute rig registration");
assert.ok(/has-layered-portrait\.is-nsfw[^}]*rig-background[^}]*mask-image/.test(css.replace(/\s+/g, " ")),
  "background layer hides duplicate breasts under PNG lobes");
assert.ok(/is-bust-pull\.is-nsfw[^}]*rig-breast-cut-sx/.test(css.replace(/\s+/g, " ")),
  "pull expands breast cutouts on torso and background");
console.log("check_hq_companion_layers: five registered assets, embedded textures and original garment source ok");
