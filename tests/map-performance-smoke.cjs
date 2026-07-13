const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const chromePath = process.env.CHROME_PATH;
const screenshotDir = process.env.SCREENSHOT_DIR;

if (!chromePath) throw new Error("CHROME_PATH is required");

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => localStorage.clear());
  await page.goto(pathToFileURL(path.join(__dirname, "..", "index.html")).href, { waitUntil: "load" });
  await page.click("#googleLogin");
  await page.locator(".home-screen").waitFor({ state: "visible" });
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "home-320.png"), fullPage: true });
  }
  await page.click('button[data-route="map"]');
  await page.locator(".map-screen").waitFor({ state: "visible" });
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "map-320.png"), fullPage: true });

  await page.click("#mapSearchBtn");
  await page.locator("#searchScreenInput").evaluate((input) => {
    input.value = "1";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "1", inputType: "insertText" }));
  });
  const compositionState = await page.locator("#searchScreenInput").evaluate((input) => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
    input.value = "1ㅎ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ㅎ", inputType: "insertCompositionText", isComposing: true }));
    return { connected: input.isConnected, stateSearch: state.search };
  });
  if (!compositionState.connected || compositionState.stateSearch !== "1") {
    throw new Error(`Korean composition was interrupted: ${JSON.stringify(compositionState)}`);
  }
  await page.locator("#searchScreenInput").evaluate((input) => {
    input.value = "1학년";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "학년" }));
  });
  await page.locator(".search-result-meta strong").filter({ hasText: "8개 결과" }).waitFor();
  const composedQuery = await page.locator("#searchScreenInput").inputValue();
  if (composedQuery !== "1학년") throw new Error(`Korean query changed to ${composedQuery}`);
  await page.click("#clearSearchScreen");
  await page.click("#closeSearchScreen");

  await page.evaluate(() => {
    window.__renderCount = 0;
    window.__renderDurations = [];
    const originalRender = render;
    render = function measuredRender(...args) {
      const startedAt = performance.now();
      const result = originalRender(...args);
      window.__renderCount += 1;
      window.__renderDurations.push(performance.now() - startedAt);
      return result;
    };
  });

  for (let index = 0; index < 8; index += 1) {
    await page.evaluate(() => document.querySelector('button[data-route="map"]')?.click());
  }

  for (const route of ["home", "scan", "stamps", "profile", "map"]) {
    await page.click(`button[data-route="${route}"]`);
    const overflow = await page.evaluate(() => ({
      route: state.route,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      navItems: document.querySelectorAll(".bottom-nav .nav-btn").length,
    }));
    if (overflow.route !== route) throw new Error(`route failed: ${JSON.stringify(overflow)}`);
    if (overflow.bodyWidth > overflow.viewportWidth + 1) throw new Error(`horizontal overflow on ${route}`);
    if (overflow.navItems !== 5) throw new Error(`bottom navigation count is ${overflow.navItems}`);
  }

  await page.click('button[data-route="scan"]');
  await page.click('button[data-nfc]');
  await page.locator(".scan-pad.success").waitFor({ state: "visible" });
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "nfc-success-320.png"), fullPage: true });
  await page.click("#clearScanResult");
  await page.click('button[data-nfc]');
  await page.locator(".scan-pad.duplicate").waitFor({ state: "visible" });
  await page.click('button[data-route="stamps"]');
  const earnedPassRows = await page.locator(".pass-row.earned").count();
  if (earnedPassRows !== 1) throw new Error(`festival pass has ${earnedPassRows} earned rows`);
  await page.click('button[data-route="map"]');
  await page.evaluate(() => document.querySelector('button[data-route="map"]')?.click());

  await page.locator("[data-map-select]").first().click();
  await page.locator(".map-preview-card").waitFor({ state: "visible" });
  const previewFilter = await page.locator(".map-canvas").evaluate((element) => getComputedStyle(element).filter);
  if (previewFilter === "none") throw new Error("map preview background blur is missing");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "map-preview-blur-320.png"), fullPage: true });
  await page.locator("#mapCard").click({ position: { x: 12, y: 12 } });
  if (await page.locator(".map-preview-card").count()) throw new Error("map preview did not close after backdrop tap");

  const metrics = await page.evaluate(() => ({
    renderCount: window.__renderCount,
    maxRenderMs: Math.max(0, ...window.__renderDurations),
    route: state.route,
    mapVisible: Boolean(document.querySelector(".map-screen")),
    screenAnimation: document.querySelector(".map-screen")
      ? getComputedStyle(document.querySelector(".map-screen")).animationName
      : "missing",
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  metrics.previewFilter = previewFilter;

  if (metrics.renderCount > 26) throw new Error(`repeated render listeners detected: ${metrics.renderCount}`);
  if (!metrics.mapVisible || metrics.route !== "map") throw new Error(`map route was lost: ${JSON.stringify(metrics)}`);
  if (metrics.screenAnimation !== "none") throw new Error(`same-route animation is active: ${metrics.screenAnimation}`);
  if (metrics.bodyWidth > metrics.viewportWidth + 1) throw new Error("horizontal overflow detected");

  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  await browser.close();
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
