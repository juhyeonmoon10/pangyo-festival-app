const path = require("path");
const { pathToFileURL } = require("url");

const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const chromePath = process.env.CHROME_PATH;

if (!chromePath) throw new Error("CHROME_PATH is required");

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => localStorage.clear());
  await page.goto(pathToFileURL(path.join(__dirname, "..", "index.html")).href, { waitUntil: "load" });
  await page.click("#googleLogin");
  await page.locator(".map-screen").waitFor({ state: "visible" });

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

  for (let index = 0; index < 12; index += 1) {
    await page.evaluate(() => document.querySelector('button[data-route="map"]')?.click());
  }

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

  if (metrics.renderCount > 14) throw new Error(`repeated render listeners detected: ${metrics.renderCount}`);
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
