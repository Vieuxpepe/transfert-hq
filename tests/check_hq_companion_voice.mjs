import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const {speechDelivery, speechSegments} = require("../assets/hq-companion.js").pure;

assert.equal(speechDelivery("Je me demande pourquoi les étoiles scintillent.").style, "thoughtful");
assert.equal(speechDelivery("Quel miracle informatique.").style, "deadpan");
assert.equal(speechDelivery("Prends ton temps, je t'écoute.", {mode:"comfort"}).style, "warm");
assert.equal(speechDelivery("Malin, toi.", {mode:"social",flirt:true}).style, "playful");
assert.equal(speechDelivery("Malin, toi.", {mode:"practical",flirt:true}).style, "neutral");
assert.equal(speechDelivery("Malin, toi.", {mode:"social",flirt:false}).style, "neutral");
assert.equal(speechDelivery("Quel miracle informatique.", {mode:"comfort"}).style, "warm");
assert.equal(speechDelivery("Bonjour.", {style:"deadpan"}).style,"deadpan");
assert.equal(speechDelivery("Bonjour.", {style:"untrusted"}).style,"neutral");
for (const text of ["Bonjour. Comment vas-tu ? Très bien !", "3.14 est un nombre. Oui.",
  "… Oui… Puis ?", "Étrange 😀 !\nPourquoi ?", "A. B. C. D. E. F. G. H.", "", "Sans ponctuation"]){
  const chunks = speechSegments(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length <= 6);
}
for (const text of ["Je me demande…", "Quel miracle.", "Prends ton temps.", "Malin.", "Bonjour."]){
  const d = speechDelivery(text, {mode:"social",flirt:true});
  assert.ok(d.rate >= .9 && d.rate <= 1.1);
  assert.ok(d.pitch >= .95 && d.pitch <= 1.15);
  assert.ok(d.pause >= 100 && d.pause <= 400);
}
console.log("Companion speech planning: passed");
