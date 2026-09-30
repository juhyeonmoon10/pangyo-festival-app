const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const chromePath = process.env.CHROME_PATH;
const screenshotDir = process.env.SCREENSHOT_DIR;
const appUrl = process.env.APP_URL || pathToFileURL(path.join(__dirname, "..", "index.html")).href;

if (!chromePath) throw new Error("CHROME_PATH is required");

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => localStorage.clear());
  await page.goto(appUrl, { waitUntil: "load" });
  await page.click("#googleLogin");
  await page.locator(".home-screen").waitFor({ state: "visible" });
  const clubCatalog = await page.evaluate(() => ({
    officialCount: state.db.booths.filter((booth) => booth.officialClubId).length,
    unassignedCount: state.db.booths.filter((booth) => booth.assignmentStatus === "unassigned").length,
    names: state.db.booths.filter((booth) => booth.officialClubId).map((booth) => booth.name),
    sourcesValid: state.db.booths.filter((booth) => booth.officialClubId).every((booth) => booth.sourceUrl?.startsWith("https://chatdong.xyz/clubs/")),
  }));
  if (clubCatalog.officialCount !== 20 || clubCatalog.unassignedCount !== 4 || !clubCatalog.sourcesValid) {
    throw new Error(`Official club catalog migration failed: ${JSON.stringify(clubCatalog)}`);
  }
  if (clubCatalog.names.includes("지오네틱스(GEONETICS)") || clubCatalog.names.includes("아고라(AGORA)")) {
    throw new Error("Non-Pangyo clubs were imported into the festival map");
  }
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "home-320.png"), fullPage: true });
  }
  await page.click('button[data-route="map"]');
  await page.locator(".map-screen").waitFor({ state: "visible" });
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "map-320.png"), fullPage: true });

  const initialZoom = await page.evaluate(() => state.mapZoom);
  if (initialZoom !== 1) throw new Error(`unexpected initial map zoom: ${initialZoom}`);
  await page.click("#mapZoomIn");
  const zoomedIn = await page.evaluate(() => state.mapZoom);
  if (zoomedIn !== 1.2) throw new Error(`map zoom in failed: ${zoomedIn}`);
  await page.click("#mapZoomOut");
  await page.click("#mapZoomOut");
  const zoomedOut = await page.evaluate(() => ({ zoom: state.mapZoom, disabled: document.querySelector("#mapZoomOut").disabled }));
  if (zoomedOut.zoom !== 0.9 || !zoomedOut.disabled) throw new Error(`map zoom out limit failed: ${JSON.stringify(zoomedOut)}`);
  await page.click("#resetMapView");
  const resetZoom = await page.evaluate(() => state.mapZoom);
  if (resetZoom !== 1) throw new Error(`map zoom reset failed: ${resetZoom}`);

  await page.click("#mapSearchBtn");
  const stableSearchDom = await page.locator("#searchScreenInput").evaluate((input) => {
    const mapCard = document.querySelector("#mapCard");
    input.value = "1";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "1", inputType: "insertText" }));
    return {
      inputPreserved: document.querySelector("#searchScreenInput") === input,
      mapPreserved: document.querySelector("#mapCard") === mapCard,
      inputConnected: input.isConnected,
    };
  });
  if (!stableSearchDom.inputPreserved || !stableSearchDom.mapPreserved || !stableSearchDom.inputConnected) {
    throw new Error(`Search replaced stable DOM: ${JSON.stringify(stableSearchDom)}`);
  }
  const compositionState = await page.locator("#searchScreenInput").evaluate((input) => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅇ" }));
    input.value = "아";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ㅇ", inputType: "insertCompositionText", isComposing: true }));
    return { connected: input.isConnected, preserved: document.querySelector("#searchScreenInput") === input, stateSearch: state.search };
  });
  if (!compositionState.connected || !compositionState.preserved || compositionState.stateSearch !== "1") {
    throw new Error(`Korean composition was interrupted: ${JSON.stringify(compositionState)}`);
  }
  await page.locator("#searchScreenInput").evaluate((input) => {
    input.value = "아트 캔버스";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "아트 캔버스" }));
  });
  await page.locator(".search-result-meta strong").filter({ hasText: "1개 결과" }).waitFor();
  const composedQuery = await page.locator("#searchScreenInput").inputValue();
  if (composedQuery !== "아트 캔버스") throw new Error(`Korean query changed to ${composedQuery}`);

  for (const query of ["아트캔버스", "아트 캔버스", "아트   캔버스"]) {
    const preserved = await page.locator("#searchScreenInput").evaluate((input, nextQuery) => {
      input.value = nextQuery;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextQuery, inputType: "insertText" }));
      return document.querySelector("#searchScreenInput") === input && input.isConnected;
    }, query);
    if (!preserved) throw new Error(`Search input was replaced for query: ${query}`);
    await page.locator(".search-result-meta strong").filter({ hasText: "1개 결과" }).waitFor();
    const firstResult = await page.locator("#searchResultList .booth-item strong").first().innerText();
    if (!firstResult.includes("아트 캔버스")) {
      throw new Error(`Whitespace-insensitive search failed for ${query}: ${firstResult}`);
    }
  }

  const clubImageLoaded = await page.locator("#searchResultList .club-visual img").first().evaluate((image) => image.complete && image.naturalWidth > 0);
  if (!clubImageLoaded) throw new Error("Official club image did not load");

  const searchItemHeight = await page.locator(".search-result-list .booth-item").first().evaluate((item) => item.getBoundingClientRect().height);
  if (searchItemHeight < 72) throw new Error(`search result card collapsed to ${searchItemHeight}px`);
  if (screenshotDir) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(screenshotDir, "search-korean-320.png"), fullPage: true });
  }
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
  const studentMockToolCount = await page.locator('.nfc-test-panel, [data-nfc-source="mock-panel"], [data-nfc-source="detail-action"], [data-nfc-source="detail-shortcut"]').count();
  if (studentMockToolCount !== 0) throw new Error(`student can see ${studentMockToolCount} mock NFC tools`);
  await page.evaluate(() => nfcAdapter.scan(createNfcClaim(mockNfcTokenForTagId("NFC-G1-01"), "tag-url")));
  await page.locator(".scan-pad.success").waitFor({ state: "visible" });
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "nfc-success-320.png"), fullPage: true });
  await page.click("#clearScanResult");
  await page.evaluate(() => nfcAdapter.scan(createNfcClaim(mockNfcTokenForTagId("NFC-G1-01"), "tag-url")));
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

  await page.click('button[data-route="profile"]');
  await page.click('button[data-route="login"]');
  await page.click("#adminLogin");
  await page.locator(".admin-screen").waitFor({ state: "visible" });
  const adminCopy = await page.locator(".admin-screen").innerText();
  if (adminCopy.includes("리뷰") || adminCopy.includes("음료 교환")) throw new Error("legacy P1 copy is exposed in the P0 admin screen");
  await page.click('button[data-route="scan"]');
  await page.locator(".nfc-test-panel").waitFor({ state: "visible" });
  const adminMockToolCount = await page.locator('[data-nfc-source="mock-panel"]').count();
  if (adminMockToolCount !== 2) throw new Error(`admin mock NFC tool count is ${adminMockToolCount}`);
  await page.click('button[data-route="profile"]');
  await page.click('button[data-route="admin"]');
  await page.locator(".admin-screen").waitFor({ state: "visible" });

  await page.click('[data-toggle-menu="admin-tab"]');
  await page.click('[data-admin-tab="booths"]');
  await page.selectOption("#status-b1", "paused");
  await page.click('[data-save-status="b1"]');
  await page.locator(".success-text").filter({ hasText: "일시 중지" }).waitFor();

  await page.click('[data-toggle-menu="admin-tab"]');
  await page.click('[data-admin-tab="visits"]');
  await page.selectOption("#manualBooth", "b2");
  await page.click("#manualApproveStamp");
  await page.locator(".admin-table").filter({ hasText: "수동 승인" }).waitFor();

  const verifyNfcEntryUrl = async (entryUrl, expectedBoothId, label) => {
    const entryPage = await browser.newPage({ viewport: { width: 320, height: 740 } });
    entryPage.setDefaultTimeout(8000);
    await entryPage.addInitScript(() => localStorage.clear());
    await entryPage.goto(entryUrl, { waitUntil: "load" });
    await entryPage.locator(".login-screen").waitFor({ state: "visible" });
    if (entryPage.url().includes("?nfc=") || entryPage.url().includes("#t=")) {
      throw new Error(`${label} NFC token was not removed from the address`);
    }
    await entryPage.click("#googleLogin");
    await entryPage.locator(".scan-pad.success").waitFor({ state: "visible" });
    const claim = await entryPage.evaluate(() => ({
      stampCount: state.db.stamps.length,
      boothId: state.db.stamps[0]?.boothId,
      pendingClaim: state.pendingNfcClaim,
    }));
    if (claim.stampCount !== 1 || claim.boothId !== expectedBoothId || claim.pendingClaim) {
      throw new Error(`${label} NFC URL claim failed: ${JSON.stringify(claim)}`);
    }
    await entryPage.close();
  };

  await verifyNfcEntryUrl(`${appUrl}?nfc=NFC-G1-01`, "g1-1", "legacy query");
  const fragmentToken = `mock-v1.${Buffer.from("NFC-G1-02", "utf8").toString("base64url")}`;
  await verifyNfcEntryUrl(`${appUrl}#t=${fragmentToken}`, "g1-2", "fragment token");

  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  await browser.close();
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
