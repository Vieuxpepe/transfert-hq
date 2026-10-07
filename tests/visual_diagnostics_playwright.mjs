// Phase 15 admin diagnostics page (GET /diagnostics): sections, honest status display, explicit write probe, failure display,
// no auto-refresh, no external request, mobile/dark layout, non-admin refusal.
//   P15_SHOTS=dir node tests/visual_diagnostics_playwright.mjs
// Engines: Chromium only. Runs on a throwaway loopback HQ (tests/carnet_test_server.py) with fake PINs.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  const require = createRequire(process.env.PLAYWRIGHT_NODE_PATH ? process.env.PLAYWRIGHT_NODE_PATH.replace(/\/?$/, "/") : import.meta.url);
  chromium = require("playwright").chromium;
} catch (_) {
  try { chromium = createRequire("/opt/node22/lib/node_modules/")("playwright").chromium; } catch (e) { console.log("SKIP: Playwright not available"); process.exit(0); }
}
let passed = 0;
function check(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed += 1;
  console.log("  OK  ", msg);
}
const SHOTS = process.env.P15_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }) : null);

const root = mkdtempSync(path.join(tmpdir(), "hq-diag-ui-"));
const proc = spawn(process.env.PYTHON || "python3", [path.join(here, "carnet_test_server.py"), root], { stdio: ["pipe", "pipe", "inherit"] });
const info = await new Promise((res, rej) => { proc.once("error", rej); proc.stdout.once("data", (d) => res(JSON.parse(String(d)))); });
const base = info.base;
const browser = await chromium.launch();
const consoleErrors = [];
const requests = [];

async function login(ctx, pin) {
  const r = await ctx.request.post(base + "/login", { form: { pin }, headers: { origin: base }, maxRedirects: 0 });
  if (r.status() !== 303) throw new Error("login failed " + r.status());
}
async function open(ctx, viewport, scheme) {
  const page = await ctx.newPage();
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: scheme || "light" });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("request", (r) => requests.push(r.url()));
  return page;
}
const text = (p) => p.locator("#root").innerText();
const waitLoaded = (p) => p.waitForFunction(() => document.querySelectorAll("#root section").length >= 7, null, { timeout: 15000 });

try {
  const admin = await browser.newContext();
  await login(admin, info.admin_pin);
  await admin.request.get(base + "/api/carnet"); // normal use creates the notebook
  const page = await open(admin, { width: 1280, height: 800 });

  console.log("A. sections and honest status");
  await page.goto(base + "/diagnostics");
  await waitLoaded(page);
  const t = await text(page);
  for (const h of ["Instance", "Santé", "Sous-systèmes", "Stockage", "Sauvegardes", "Erreurs récentes", "Déploiement"]) check(t.includes(h), "section: " + h);
  check(/Liveness\s+ok/.test(t), "liveness shown as ok");
  check(/Readiness\s+(ok|degraded)/.test(t), "readiness shown (typed, not a bare boolean)");
  check(/transcription\s+not_configured/.test(t), "unconfigured optional subsystem shown as not_configured, not ok");
  check(/Build \(SHA\)\s+unknown/.test(t), "unknown build is displayed as unknown (temp root is not a checkout), never invented");
  check(/Jamais exécuté/.test(t), "write probe never auto-runs");
  await shot(page, "diagnostics-desktop-light");

  console.log("B. explicit write probe");
  await page.getByRole("button", { name: "Lancer le test d'écriture" }).click();
  await page.waitForFunction(() => /Étape en échec\s+aucune/.test(document.getElementById("root").innerText), null, { timeout: 15000 });
  const t2 = await text(page);
  check(/Résultat\s+ok/.test(t2) && t2.includes("verify_removed ✓"), "probe result lists every step and ends verified");
  check(!existsSync(path.join(root, ".hq-carnet", "diagnostics")) || readdirCount(path.join(root, ".hq-carnet", "diagnostics")) === 0, "probe left no file behind");

  console.log("C. deployment comparison");
  const inp = page.getByPlaceholder("SHA attendu (7–40 hex)");
  await inp.fill("zz");
  await page.getByRole("button", { name: "Comparer" }).click();
  await page.waitForFunction(() => /SHA attendu invalide/.test(document.getElementById("root").innerText));
  check(true, "invalid expected SHA rejected");
  await inp.fill("457c665");
  await page.getByRole("button", { name: "Comparer" }).click();
  await page.waitForFunction(() => /inconnu \(build non déterminé\)/.test(document.getElementById("root").innerText));
  check(true, "unknown running build is inconclusive, not a false match");

  console.log("D. failures are displayed as failures");
  const asset = path.join(root, "assets", "hq-carnet.js");
  const keep = readFileSync(asset);
  unlinkSync(asset);
  await page.getByRole("button", { name: "Rafraîchir" }).click();
  await page.waitForFunction(() => /Readiness\s+not_ready/.test(document.getElementById("root").innerText), null, { timeout: 15000 });
  const t3 = await text(page);
  check(/Résumé\s+Not ready: static_assets/.test(t3), "missing asset: readiness is not_ready and names static_assets");
  check(!/Readiness\s+ok/.test(t3), "the page never says ok while a required asset is missing");
  await shot(page, "diagnostics-not-ready");
  writeFileSync(asset, keep);
  const dd = path.join(root, ".hq-carnet");
  renameSync(dd, dd + ".moved");
  writeFileSync(dd, "file in the way");
  await page.getByRole("button", { name: "Lancer le test d'écriture" }).click();
  await page.waitForFunction(() => /Étape en échec\s+mkdir/.test(document.getElementById("root").innerText), null, { timeout: 15000 });
  check(true, "unusable data dir: probe reports error and the exact failing step (mkdir)");
  unlinkSync(dd);
  renameSync(dd + ".moved", dd);
  await page.getByRole("button", { name: "Rafraîchir" }).click();
  await page.waitForFunction(() => /Readiness\s+(ok|degraded)/.test(document.getElementById("root").innerText), null, { timeout: 15000 });
  check(true, "recovers once the fault is removed");

  console.log("E. no auto-refresh, no external call");
  const before = requests.filter((u) => u.includes("/api/diag/")).length;
  await page.waitForTimeout(6000);
  check(requests.filter((u) => u.includes("/api/diag/")).length === before, "no background polling (0 requests in 6 s idle)");
  check(requests.every((u) => u.startsWith(base) || u.startsWith("data:")), "every request stays on the bridge origin");

  console.log("F. layout: mobile + dark");
  const mobile = await open(admin, { width: 390, height: 800 }, "dark");
  await mobile.goto(base + "/diagnostics");
  await waitLoaded(mobile);
  const ov = await mobile.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(ov.sw <= ov.iw + 1, "no horizontal overflow at 390px (" + ov.sw + " <= " + ov.iw + ")");
  const contrast = await mobile.evaluate(() => {
    const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bg = lum(getComputedStyle(document.body).backgroundColor);
    return [...document.querySelectorAll(".badge")].map((e) => { const l = lum(getComputedStyle(e).color); const [hi, lo] = l > bg ? [l, bg] : [bg, l]; return (hi + 0.05) / (lo + 0.05); });
  });
  check(contrast.length > 5 && contrast.every((c) => c >= 4.5), "status badges keep contrast >= 4.5 in dark mode (min " + Math.min(...contrast).toFixed(2) + ")");
  await shot(mobile, "diagnostics-mobile-dark");

  console.log("G. non-admin is refused");
  const up = await browser.newContext();
  await login(up, info.upload_pin);
  const r1 = await up.request.get(base + "/diagnostics");
  check(r1.status() === 403, "upload role: /diagnostics -> 403");
  const r2 = await up.request.get(base + "/api/diag/info");
  check(r2.status() === 403, "upload role: /api/diag/info -> 403");
  const anon = await browser.newContext();
  const r3 = await anon.request.get(base + "/api/diag/info");
  check(r3.status() === 401, "anonymous: /api/diag/info -> 401");

  const unexpected = consoleErrors.filter((m) => !/Failed to load resource: the server responded with a status of (503|404)/.test(m));
  check(unexpected.length === 0, "no console/page errors other than the deliberate 503/404 (" + unexpected.join(" | ") + ")");
  console.log(`\nPASS ${passed} checks`);
} catch (e) {
  console.error(String(e && e.stack || e));
  process.exitCode = 1;
} finally {
  await browser.close();
  try { proc.stdin.end(); } catch (_) {}
  rmSync(root, { recursive: true, force: true });
}
function readdirCount(d) { return require_fs().readdirSync(d).length; }
function require_fs() { return createRequire(import.meta.url)("node:fs"); }
