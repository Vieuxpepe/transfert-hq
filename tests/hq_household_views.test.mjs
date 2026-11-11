import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function load(name) {
  const context = { globalThis: {}, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "assets", name), "utf8"), context, { filename: name });
  return context;
}

const meals = load("hq-household-meals.js").HqHouseholdMeals.pure;
const budget = load("hq-household-budget.js").HqHouseholdBudget.pure;

assert.equal(meals.parseIso("2026-02-31"), null);
assert.equal(JSON.stringify(meals.weekBounds("2026-11-11")), JSON.stringify({
  start: "2026-11-09",
  end: "2026-11-15",
  days: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"],
}));
assert.equal(meals.weekBounds("2026-11-15").start, "2026-11-09");
assert.equal(meals.addDays("2026-12-31", 1), "2027-01-01");
assert.equal(meals.addDays("2026-01-01", -1), "2025-12-31");
assert.equal(meals.formatMilli(1250, "g"), "1,25 g");
assert.equal(meals.formatMilli(1000, "ml"), "1 ml");
assert.equal(JSON.stringify(meals.groceryPreviewBody()), JSON.stringify({ mode: "preview", subtract_available_stock: true }));
const commit = meals.groceryCommitBody("a".repeat(64), "meal-list-0123456789abcdef");
assert.equal(commit.mode, "commit");
assert.equal(commit.subtract_available_stock, true);
assert.equal(commit.idempotency_key.length >= 8, true);

assert.equal(JSON.stringify(budget.monthBounds("2026-11-11")), JSON.stringify({ start: "2026-11-01", end: "2026-11-30" }));
assert.equal(JSON.stringify(budget.monthBounds("2024-02-10")), JSON.stringify({ start: "2024-02-01", end: "2024-02-29" }));
assert.equal(budget.shiftMonth("2026-12-01", 1), "2027-01-01");
assert.equal(budget.shiftMonth("2026-01-15", -1), "2025-12-01");
assert.equal(budget.formatCadCents(123456), "1\u00a0234,56\u00a0$");
assert.equal(budget.formatCadCents(-50), "−0,50\u00a0$");
assert.equal(budget.parseCadToCents("12,34"), 1234);
assert.equal(budget.parseCadToCents("12.3"), 1230);
assert.equal(budget.parseCadToCents("-0,05"), -5);
assert.equal(budget.parseCadToCents("12.345"), null);
assert.equal(budget.parseCadToCents("1e2"), null);

const totals = budget.monthTotals([
  { status: "posted", booked_on: "2026-11-02", amount_cents: 250000, category_id: "income", transfer_pair_id: null },
  { status: "posted", booked_on: "2026-11-03", amount_cents: -1800, category_id: "food", transfer_pair_id: null },
  { status: "posted", booked_on: "2026-11-04", amount_cents: -500, category_id: "move", transfer_pair_id: "pair" },
  { status: "pending", booked_on: "2026-11-05", amount_cents: -999, category_id: "food", transfer_pair_id: null },
  { status: "posted", booked_on: "2026-12-01", amount_cents: -100, category_id: "food", transfer_pair_id: null },
], [
  { id: "income", kind: "income" },
  { id: "food", kind: "expense" },
  { id: "move", kind: "transfer" },
], "2026-11-01", "2026-11-30");
assert.equal(JSON.stringify(totals), JSON.stringify({ incomeCents: 250000, expenseCents: -1800, remainingCents: 248200 }));
assert.equal(budget.envelopeRemaining({ allocated_cents: 10000, spent_cents: 1800 }), 8200);
assert.equal(budget.cadBalance({ balances_by_currency: { CAD: 400, USD: 25 } }), 400);
assert.equal(JSON.stringify(budget.otherCurrencies({ balances_by_currency: { USD: 25, EUR: 10, CAD: 1 } })), JSON.stringify(["EUR", "USD"]));

const mealsSource = fs.readFileSync(path.join(root, "assets", "hq-household-meals.js"), "utf8");
const budgetSource = fs.readFileSync(path.join(root, "assets", "hq-household-budget.js"), "utf8");
assert.match(mealsSource, /HqHouseholdMeals\.mount/);
assert.match(budgetSource, /label: "Budget"/);
assert.match(mealsSource, /credentials: "same-origin"/);
assert.match(budgetSource, /auto_post: false/);
assert.doesNotMatch(mealsSource, /innerHTML/);
assert.doesNotMatch(budgetSource, /innerHTML/);
assert.match(mealsSource, /restrictions alimentaires ne sont pas exposées/);

console.log("household view checks ok");
