import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { globalThis: {}, console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(root, "assets", "hq-household-icons.js"), "utf8"),
  context,
  { filename: "hq-household-icons.js" },
);

const api = context.HqHouseholdIcons;
const pure = api.pure;

assert.equal(pure.fold("Œufs"), "oeufs");
assert.equal(pure.fold("PÂTÉS"), "pates");
assert.equal(pure.fold("  Tomato! "), "tomato");
assert.equal(pure.fold("Vis M4×12"), "vis m4x12");
assert.equal(pure.fold("10 kΩ"), "10 kohm");
assert.equal(pure.stripSpecs("vis m4x12"), "vis");
assert.equal(pure.stripSpecs("foret 6 mm"), "foret");
assert.equal(pure.singularize("tomatoes"), "tomatoes");
assert.equal(pure.singularize("shallots"), "shallot");
assert.equal(pure.singularize("radishes"), "radish");

const tomato = pure.resolveItem("Tomates");
assert.equal(tomato.key, "tomato");
assert.equal(tomato.category, "vegetable");
assert.equal(tomato.domain, "food");
assert.equal(tomato.matched, true);

assert.equal(pure.resolveIngredient("olive oil").key, "oil");
assert.equal(pure.resolveIngredient("Huile d'olive").key, "oil");
assert.equal(pure.resolveIngredient("chicken breast").key, "chicken");
assert.equal(pure.resolveIngredient("Poulet").key, "chicken");
assert.equal(pure.resolveIngredient("Œufs").key, "egg");
assert.equal(pure.resolveIngredient("riz basmati").key, "rice");

assert.equal(pure.resolveItem("Boulon M8").key, "bolt");
assert.equal(pure.resolveItem("Écrou M8").key, "nut");
assert.equal(pure.resolveItem("écrou hexagonal").key, "nut");
assert.equal(pure.resolveItem("hex nut").key, "nut");
assert.equal(pure.resolveItem("Vis M4×12").key, "screw");
assert.equal(pure.resolveItem("vis m4x12").key, "screw");
assert.equal(pure.resolveItem("Rondelle plate").key, "washer");
assert.equal(pure.resolveItem("Tournevis Phillips").key, "screwdriver");
assert.equal(pure.resolveItem("Foret 6 mm").key, "drill-bit");
assert.equal(pure.resolveItem("drill bit 1/4").key, "drill-bit");
assert.equal(pure.resolveItem("ESP32 DevKit").key, "microcontroller");
assert.equal(pure.resolveItem("Résistance 10 kΩ").key, "resistor");
assert.equal(pure.resolveItem("Filament PLA").key, "filament");
assert.equal(pure.resolveItem("Perceuse").key, "drill");
assert.equal(pure.resolveItem("Marteau").key, "hammer");
assert.equal(pure.resolveItem("circuit board").key, "circuit-board");
assert.equal(pure.resolveItem("LED rouge").key, "led");
assert.equal(pure.resolveItem("Condensateur 100uF").domain, "hardware");

const bareSpec = pure.resolveItem("M4×12");
assert.equal(bareSpec.key, "hardware");
assert.equal(bareSpec.matched, true);
assert.equal(bareSpec.domain, "hardware");

const unknown = pure.resolveItem("Objet mystère xyz");
assert.equal(unknown.key, "other");
assert.equal(unknown.matched, false);
assert.equal(unknown.domain, "other");

assert.equal(pure.resolveItem("").key, "other");
assert.equal(pure.resolveItem(null).matched, false);

// Ambiguous multiword: food wins over hardware token
assert.equal(pure.resolveItem("spring onion").key, "onion");
assert.equal(pure.resolveItem("spring onion").domain, "food");

assert.equal(pure.resolveMeal("breakfast").key, "breakfast");
assert.equal(pure.resolveMeal("Souper").key, "dinner");

assert.equal(pure.resolveRecipe("Soupe à l'oignon").key, "soup");
assert.equal(pure.resolveRecipe("Pasta primavera").key, "pasta");

const fromIngredients = pure.resolveRecipe("Plat du soir", [
  { name: "Poulet" },
  { name: "Riz" },
  { name: "Carottes" },
]);
assert.equal(fromIngredients.key, "meat");

const hardwareIngredients = pure.resolveRecipe("Mystery Bowl", [{ name: "Vis" }, { name: "Écrou" }]);
assert.equal(hardwareIngredients.key, "recipe");
assert.equal(hardwareIngredients.matched, false);

assert.equal(api.has("screw"), true);
assert.equal(api.has("drill-bit"), true);
assert.equal(api.has("microcontroller"), true);
assert.equal(api.has("nope"), false);
assert.ok(api.keys().includes("hardware"));
assert.ok(api.keys().length >= 60);

console.log("household icons checks ok");
