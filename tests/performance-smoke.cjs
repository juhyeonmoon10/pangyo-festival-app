const path = require("path");
const { pathToFileURL } = require("url");

const playwrightPath = process.env.PLAYWRIGHT_PATH || "playwright";
const chromePath = process.env.CHROME_PATH;
const { chromium } = require(playwrightPath);

if (!chromePath) throw new Error("CHROME_PATH is required");

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(8000);
  const session = await page.context().newCDPSession(page);
  const cpuRate = Math.max(1, Number(process.env.CPU_RATE) || 1);
  if (cpuRate > 1) await session.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await page.addInitScript(() => {
    localStorage.clear();
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        window.__longTasks.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Long Task API is optional in some browser builds.
    }
  });

  const appUrl = process.env.APP_URL || pathToFileURL(path.join(__dirname, "..", "index.html")).href;
  await page.goto(appUrl, { waitUntil: "load" });
  await page.click("#googleLogin");
  await page.locator(".map-screen").waitFor({ state: "visible" });

  await page.evaluate(() => {
    window.__renderTimes = [];
    window.__skippedRenders = 0;
    window.__longTasks = [];
    const originalRender = render;
    render = function measuredRender(options) {
      if (renderInProgress) {
        window.__skippedRenders += 1;
        return originalRender(options);
      }
      const startedAt = performance.now();
      const result = originalRender(options);
      window.__renderTimes.push({
        route: state.route,
        reason: options?.reason || "interaction",
        duration: performance.now() - startedAt,
      });
      return result;
    };
  });

  for (const floor of [2, 3, 4, 1, 2, 3, 4, 1]) {
    await page.evaluate((value) => document.querySelector(`[data-floor="${value}"]`)?.click(), floor);
  }

  await page.evaluate(() => {
    const booths = state.db.booths.slice(0, state.db.marketSettings.stampGoal);
    for (const booth of booths) {
      if (!repo.hasStamp(state.user.id, booth.id)) {
        state.db.stamps.push({ id: makeId(), userId: state.user.id, boothId: booth.id, createdAt: new Date().toISOString() });
      }
    }
    syncMarketReward(state.user.id);
    state.route = "market";
    render();
  });
  await page.locator(".market-stock-list").waitFor({ state: "visible" });

  const stockIds = ["happy-tech", "cloud-food", "momo-games", "green-energy", "moon-travel"];
  for (let index = 0; index < 10; index += 1) {
    await page.evaluate((stockId) => {
      state.marketStockId = stockId;
      state.marketQuantity = 1;
      state.marketMessage = "";
      render();
    }, stockIds[index % stockIds.length]);
  }

  await page.evaluate(() => window.scrollTo(0, 480));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => {
    render({ preserveScroll: true, reason: "performance-test" });
  });
  await page.waitForTimeout(80);
  const scrollCheck = { before: scrollBefore, after: await page.evaluate(() => window.scrollY) };

  const metrics = await page.evaluate(() => ({
    renders: window.__renderTimes,
    longTasks: window.__longTasks,
    skippedRenders: window.__skippedRenders,
    sameRouteAnimation: getComputedStyle(document.querySelector(".screen")).animationName,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  const durations = metrics.renders.map((item) => item.duration);
  const countBy = (key) => metrics.renders.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] || 0) + 1;
    return counts;
  }, {});
  const summary = {
    renderCount: durations.length,
    skippedRenderCount: metrics.skippedRenders,
    cpuRate,
    medianMs: Number(percentile(durations, 0.5).toFixed(1)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(1)),
    maxMs: Number(Math.max(0, ...durations).toFixed(1)),
    longTaskCount: metrics.longTasks.length,
    longestTaskMs: Number(Math.max(0, ...metrics.longTasks).toFixed(1)),
    sameRouteAnimation: metrics.sameRouteAnimation,
    scrollCheck,
    rendersByRoute: countBy("route"),
    rendersByReason: countBy("reason"),
  };

  if (summary.sameRouteAnimation !== "none") throw new Error(`same-route animation still active: ${summary.sameRouteAnimation}`);
  if (scrollCheck.before !== scrollCheck.after) throw new Error(`scroll was not preserved: ${JSON.stringify(scrollCheck)}`);
  if (metrics.bodyWidth > metrics.viewportWidth + 1) throw new Error("horizontal overflow detected");
  if (summary.renderCount > 30) throw new Error(`unexpected repeated renders: ${summary.renderCount}`);
  if (summary.p95Ms > 80) throw new Error(`render p95 is too slow at ${cpuRate}x CPU throttle: ${summary.p95Ms}ms`);
  if (summary.longestTaskMs > 250) throw new Error(`long task is too slow at ${cpuRate}x CPU throttle: ${summary.longestTaskMs}ms`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await session.detach();
  await browser.close();
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
