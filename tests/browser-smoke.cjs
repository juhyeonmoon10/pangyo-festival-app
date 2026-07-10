const path = require("path");
const { pathToFileURL } = require("url");

const playwrightPath = process.env.PLAYWRIGHT_PATH || "playwright";
const chromePath = process.env.CHROME_PATH;
const { chromium } = require(playwrightPath);

if (!chromePath) throw new Error("CHROME_PATH is required");

async function expectVisible(page, selector, label) {
  await page.locator(selector).waitFor({ state: "visible", timeout: 5000 });
  return label;
}

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.addInitScript(() => localStorage.clear());

  const appUrl = process.env.APP_URL || pathToFileURL(path.join(__dirname, "..", "index.html")).href;
  await page.goto(appUrl, { waitUntil: "load" });
  await expectVisible(page, "#googleLogin", "login");
  await page.click("#googleLogin");
  await expectVisible(page, ".map-screen", "map");
  await page.screenshot({ path: path.join(__dirname, "map-mobile.png"), fullPage: true });

  await page.click('[data-route="market"]');
  await expectVisible(page, ".market-gate", "locked market");
  await page.screenshot({ path: path.join(__dirname, "market-locked-mobile.png"), fullPage: true });

  for (const tag of ["NFC-G1-01", "NFC-G1-02", "NFC-G1-03"]) {
    await page.evaluate(async (tagId) => nfcAdapter.scan(tagId), tag);
  }
  await page.click('[data-route="market"]');
  await expectVisible(page, ".market-stock-list", "unlocked market");

  const reward = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("pangyo-festival-db-v3"));
    const user = db.users.find((item) => item.googleUid === "google-local-student");
    const portfolio = db.portfolios.find((item) => item.userId === user.id);
    return {
      cash: portfolio.cash,
      grants: db.marketTransactions.filter((item) => item.userId === user.id && item.type === "grant").length,
    };
  });
  if (reward.cash !== 100000 || reward.grants !== 1) throw new Error(`invalid reward: ${JSON.stringify(reward)}`);

  await page.click("#marketBuy");
  const trade = await page.evaluate(() => {
    const portfolio = repo.portfolioForUser(state.user.id);
    return { cash: portfolio.cash, shares: portfolio.holdings["happy-tech"] };
  });
  if (!(trade.cash < 100000) || trade.shares !== 1) throw new Error(`buy failed: ${JSON.stringify(trade)}`);
  await page.click("#marketSell");
  const sold = await page.evaluate(() => {
    const portfolio = repo.portfolioForUser(state.user.id);
    return { cash: portfolio.cash, shares: portfolio.holdings["happy-tech"] };
  });
  if (sold.cash !== 100000 || sold.shares !== 0) throw new Error(`sell failed: ${JSON.stringify(sold)}`);
  await page.click("#marketBuy");

  await page.evaluate(() => {
    const portfolio = repo.portfolioForUser(state.user.id);
    state.db.marketSettings.prizeTarget = portfolioValues(portfolio).total;
    saveDb();
    render();
  });
  await expectVisible(page, ".qualification-banner", "qualification");
  await page.screenshot({ path: path.join(__dirname, "market-mobile.png"), fullPage: true });

  await page.click('[data-route="wallet"]');
  await expectVisible(page, ".prize-status.ready", "wallet ready");
  await page.screenshot({ path: path.join(__dirname, "wallet-mobile.png"), fullPage: true });

  const mobileLayout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    bodyWidth: document.body.scrollWidth,
    overflowingText: [...document.querySelectorAll("button, strong, small, span")]
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .filter((element) => getComputedStyle(element).overflowX !== "hidden")
      .slice(0, 5)
      .map((element) => element.textContent.trim()),
  }));
  if (mobileLayout.bodyWidth > mobileLayout.viewport + 1) throw new Error(`horizontal overflow: ${JSON.stringify(mobileLayout)}`);

  await page.evaluate(() => {
    resetLogin();
    state.route = "login";
    render();
  });
  await page.click("#adminLogin");
  await expectVisible(page, ".admin-screen", "admin");
  await page.evaluate(() => {
    state.adminTab = "users";
    render();
  });
  const exchange = page.locator("[data-exchange]").first();
  if (await exchange.isDisabled()) throw new Error("qualified user exchange button is disabled");
  await exchange.click();
  const exchanged = await page.evaluate(() => state.db.users.find((item) => item.googleUid === "google-local-student").exchangedAt);
  if (!exchanged) throw new Error("exchange completion was not saved");
  if (!(await exchange.isDisabled())) throw new Error("exchange button was not locked after completion");

  await page.evaluate(() => {
    state.adminTab = "dashboard";
    render();
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.screenshot({ path: path.join(__dirname, "admin-desktop.png"), fullPage: true });

  const result = {
    passed: true,
    reward,
    trade,
    sold,
    mobileLayout,
    errors,
  };
  await browser.close();
  if (errors.length) throw new Error(JSON.stringify(result));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
