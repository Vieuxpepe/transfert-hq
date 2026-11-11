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
assert.equal(pure.singularize("tomatoes"), "tomatoes"); // known plural alias kept
assert.equal(pure.singularize("shallots"), "shallot");
assert.equal(pure.singularize("berries"), "berries"); // known plural alias kept
assert.equal(pure.singularize("radishes"), "radish");
assert.equal(pure.singularize("carottes"), "carottes");

const tomato = pure.resolveIngredient("Tomates");
assert.equal(tomato.key, "tomato");
assert.equal(tomato.category, "vegetable");
assert.equal(tomato.matched, true);

assert.equal(pure.resolveIngredient("olive oil").key, "oil");
assert.equal(pure.resolveIngredient("Huile d'olive").key, "oil");
assert.equal(pure.resolveIngredient("chicken breast").key, "chicken");
assert.equal(pure.resolveIngredient("Poulet").key, "chicken");
assert.equal(pure.resolveIngredient("Œufs").key, "egg");
assert.equal(pure.resolveIngredient("eggs").key, "egg");
assert.equal(pure.resolveIngredient("riz basmati").key, "rice");
assert.equal(pure.resolveIngredient("cheddar").key, "cheese");
assert.equal(pure.resolveIngredient("saumon fumé").key, "fish");

const unknown = pure.resolveIngredient("Vis M4×12");
assert.equal(unknown.key, "other");
assert.equal(unknown.matched, false);
assert.equal(unknown.category, "other");

assert.equal(pure.resolveIngredient("").key, "other");
assert.equal(pure.resolveIngredient(null).matched, false);

assert.equal(pure.resolveMeal("breakfast").key, "breakfast");
assert.equal(pure.resolveMeal("Souper").key, "dinner");
assert.equal(pure.resolveMeal("collation").key, "snack");
assert.equal(pure.resolveMeal("lunch").key, "lunch");

assert.equal(pure.resolveRecipe("Soupe à l'oignon").key, "soup");
assert.equal(pure.resolveRecipe("Pasta primavera").key, "pasta");
assert.equal(pure.resolveRecipe("Chocolate cake").key, "dessert");

const fromIngredients = pure.resolveRecipe("Plat du soir", [
  { name: "Poulet" },
  { name: "Riz" },
  { name: "Carottes" },
]);
assert.equal(fromIngredients.key, "meat");
assert.equal(fromIngredients.matched, true);

const fallbackRecipe = pure.resolveRecipe("Mystery Bowl", [{ name: "Vis" }, { name: "Écrou" }]);
assert.equal(fallbackRecipe.key, "recipe");
assert.equal(fallbackRecipe.matched, false);

assert.equal(api.has("tomato"), true);
assert.equal(api.has("nope"), false);
assert.ok(api.keys().includes("grocery"));
assert.ok(api.keys().length >= 30);

console.log("household icons checks ok");
