// Forge Studio browser checks. Mock Forge only. No GPU and no port 7860.
//   FORGE_SHOTS=dir node tests/visual_forge_studio_playwright.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  chromium = createRequire(import.meta.url)("playwright").chromium;
} catch (_) {
  console.log("SKIP: Playwright not available");
  process.exit(0);
}
let passed = 0;
function check(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed += 1;
  console.log("  OK  ", msg);
}
const SHOTS = process.env.FORGE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }) : null);

const root = mkdtempSync(path.join(tmpdir(), "hq-forge-ui-"));
const proc = spawn(process.env.PYTHON || "python", [path.join(here, "carnet_test_server.py"), root], {
  env: { ...process.env, HQ_FORGE_MOCK: "ready" },
  stdio: ["pipe", "pipe", "inherit"],
});
const info = await new Promise((resolve, reject) => {
  proc.once("error", reject);
  proc.stdout.once("data", (data) => resolve(JSON.parse(String(data))));
});
const base = info.base;
const browser = await chromium.launch();
const consoleErrors = [];
const requests = [];

function lum(color) {
  const m = color.match(/[\d.]+/g).map(Number);
  const [r, g, b] = m.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const L1 = lum(a);
  const L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

async function login(ctx, pin) {
  const response = await ctx.request.post(base + "/login", { form: { pin }, headers: { origin: base }, maxRedirects: 0 });
  if (response.status() !== 303) throw new Error("login " + response.status());
}
async function open(ctx, viewport, scheme) {
  const page = await ctx.newPage();
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: scheme || "dark", reducedMotion: "reduce" });
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("request", (request) => requests.push(request.url()));
  return page;
}

try {
  const admin = await browser.newContext();
  await login(admin, info.admin_pin);
  const page = await open(admin, { width: 1280, height: 900 }, "dark");
  await page.goto(base + "/");
  await page.locator('.bottom-nav [data-nav="forge"]').click();
  await page.locator("#forge-status").waitFor();
  await page.waitForFunction(() => /en ligne/i.test(document.querySelector("#forge-status").textContent || ""));
  check((await page.locator("#forge-studio h1").innerText()).includes("Générer"), "forge heading");
  check(await page.locator("#forge-cancel-note").innerText().then((t) => t.includes("autre travail")), "cancel limitation is visible");
  const ratio = await page.evaluate(() => {
    const node = document.querySelector("#forge-status");
    const style = getComputedStyle(node);
    return [style.color, style.backgroundColor];
  });
  check(contrast(ratio[0], ratio[1]) >= 4.5, "status contrast " + ratio.join(" / "));
  await shot(page, "forge-desktop-dark");

  await page.locator("#forge-prompt").fill("un cercle rouge");
  await page.locator("#forge-prompt").press("Tab");
  check(await page.evaluate(() => document.activeElement.id === "forge-negative"), "tab leaves the prompt");
  await page.locator("#forge-generate").click();
  await page.locator("#forge-results img").waitFor({ timeout: 10000 });
  check(await page.locator("#forge-results img").count() >= 1, "result preview");
  await page.locator("#forge-results .forge-card").click();
  await page.locator("#forge-viewer").waitFor({ state: "visible" });
  check(await page.evaluate(() => document.querySelector("#forge-viewer").open), "viewer open");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#forge-viewer").open);
  check(await page.evaluate(() => document.activeElement.closest("#forge-results")), "escape restores focus");
  await shot(page, "forge-result-desktop");

  await page.evaluate(() => document.body.classList.add("theme-oled"));
  await shot(page, "forge-oled");
  await page.evaluate(() => { document.body.classList.remove("theme-oled"); document.body.classList.add("theme-midnight"); });
  await shot(page, "forge-midnight");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await shot(page, "forge-light");

  const phone = await open(admin, { width: 390, height: 844 }, "dark");
  await phone.goto(base + "/");
  await phone.locator('.bottom-nav [data-nav="forge"]').click();
  await phone.locator("#forge-generate").waitFor();
  const boxes = await phone.evaluate(() => {
    const button = document.querySelector("#forge-generate").getBoundingClientRect();
    const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
    return { button: button.bottom, nav: nav.top, width: button.width, height: button.height };
  });
  check(boxes.button <= boxes.nav + 1, "generate sits above the nav");
  check(boxes.width >= 44 && boxes.height >= 44, "generate meets the touch size");
  await shot(phone, "forge-phone");

  const upload = await browser.newContext();
  await login(upload, info.upload_pin);
  const denied = await upload.request.get(base + "/api/forge/status");
  check(denied.status() === 403, "upload role is rejected");
  const anon = await browser.newContext();
  const anonStatus = await anon.request.get(base + "/api/forge/status");
  check(anonStatus.status() === 401, "anonymous is rejected");

  check(requests.every((url) => url.startsWith(base) || url.startsWith("data:")), "browser stays on HQ");
  check(!requests.some((url) => url.includes(":7860")), "browser does not call Forge");
  check(consoleErrors.length === 0, "no console errors: " + consoleErrors.join(" | "));
  console.log("PASSED", passed);
} finally {
  await browser.close();
  proc.stdin.end();
  proc.kill();
}
