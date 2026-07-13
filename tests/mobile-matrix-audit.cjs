const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const chromePath = process.env.CHROME_PATH;
const outputDir = process.env.SCREENSHOT_DIR || path.join(__dirname, "..", "artifacts", "mobile-audit");
const appUrl = pathToFileURL(path.join(__dirname, "..", "index.html")).href;
const viewports = [
  { name: "320", width: 320, height: 740 },
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
];

if (!chromePath) throw new Error("CHROME_PATH is required");

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const report = [];

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(9000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    await page.addInitScript(() => localStorage.clear());
    await page.goto(appUrl, { waitUntil: "load" });

    const capture = async (step, wait = 420) => {
      await page.waitForTimeout(wait);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-${step}.png`), fullPage: false });
    };
    const assertBottomNav = async (step) => {
      const result = await page.evaluate(() => {
        const nav = document.querySelector(".bottom-nav");
        if (!nav) return { exists: false };
        const rect = nav.getBoundingClientRect();
        return { exists: true, top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
      });
      ensure(result.exists && result.top >= 0 && result.bottom <= result.viewportHeight + 1, `${viewport.name}/${step}: 하단 내비게이션이 화면에 고정되지 않음`);
    };
    const layout = async (step) => page.evaluate((label) => {
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const visible = [...document.querySelectorAll("body *")].filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < viewportHeight
          && rect.right > 0
          && rect.left < viewportWidth;
      });
      const isTopmost = (element) => {
        const rect = element.getBoundingClientRect();
        const x = Math.min(viewportWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(viewportHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      };
      const hasPageOverflow = document.documentElement.scrollWidth > viewportWidth + 1;
      const horizontalOverflow = hasPageOverflow
        ? visible.filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > viewportWidth + 1;
        }).slice(0, 12).map((element) => ({
          tag: element.tagName,
          className: element.className,
          text: element.textContent.trim().slice(0, 40),
          rect: element.getBoundingClientRect().toJSON(),
        }))
        : [];
      const undersizedTargets = visible
        .filter((element) => element.matches("button, a, input, select, textarea") && isTopmost(element))
        .filter((element) => {
          if (element.matches(".plan-room.booth-room")) return false;
          const rect = element.getBoundingClientRect();
          return rect.width < 44 || rect.height < 44;
        })
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent.trim().slice(0, 30),
          width: Math.round(element.getBoundingClientRect().width * 100) / 100,
          height: Math.round(element.getBoundingClientRect().height * 100) / 100,
        }));
      return {
        step: label,
        route: state.route,
        bodyWidth: document.body.scrollWidth,
        viewportWidth,
        horizontalOverflow,
        undersizedTargets,
      };
    }, step);

    const steps = [];
    await capture("01-login");
    steps.push(await layout("login"));

    await page.evaluate(() => {
      const button = document.querySelector("#googleLogin");
      button.click();
      button.click();
      button.click();
    });
    await page.locator(".home-screen").waitFor({ state: "visible" });
    ensure(await page.evaluate(() => state.db.users.filter((user) => user.role !== "admin").length) === 1, `${viewport.name}: 로그인 중복 클릭으로 사용자가 중복 생성됨`);
    await assertBottomNav("home");
    await capture("02-home");
    steps.push(await layout("home"));

    await page.click('button[data-route="map"]');
    await page.locator(".map-screen").waitFor({ state: "visible" });
    await assertBottomNav("map");
    await capture("03-map");
    steps.push(await layout("map"));

    await page.click("#mapSearchBtn");
    await page.locator("#searchScreenInput").waitFor({ state: "visible" });
    await page.evaluate(() => {
      const input = document.querySelector("#searchScreenInput");
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value = "1ㅎ";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ㅎ", inputType: "insertCompositionText", isComposing: true }));
      input.value = "1학년";
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "1학년" }));
    });
    await page.locator(".search-result-meta strong").filter({ hasText: "8개 결과" }).waitFor();
    ensure(await page.evaluate(() => state.search) === "1학년", `${viewport.name}: 한글 IME 조합이 분리됨`);
    await capture("04-search");
    steps.push(await layout("search"));
    await page.click("#closeSearchScreen");
    await page.locator(".search-screen").waitFor({ state: "hidden" });
    ensure(await page.evaluate(() => state.search) === "", `${viewport.name}: 검색 닫기 후 검색어가 남음`);

    await page.locator("[data-map-select]").first().click();
    await page.locator(".map-preview-card").waitFor({ state: "visible" });
    await capture("05-preview");
    steps.push(await layout("preview"));
    await page.click(".preview-detail-btn");
    await page.locator(".detail-screen").waitFor({ state: "visible" });
    await assertBottomNav("detail");
    await capture("06-detail");
    steps.push(await layout("detail"));
    await page.goBack();
    await page.locator(".map-preview-card").waitFor({ state: "visible" });
    await page.goBack();
    await page.locator(".map-preview-card").waitFor({ state: "hidden" });

    await page.click('button[data-route="scan"]');
    await page.locator(".scan-screen").waitFor({ state: "visible" });
    await assertBottomNav("nfc");
    await capture("07-nfc-ready");
    steps.push(await layout("nfc-ready"));
    await page.evaluate(() => {
      const button = document.querySelector("button[data-nfc]");
      button.click();
      button.click();
      button.click();
    });
    await page.locator(".scan-pad.success").waitFor({ state: "visible" });
    await capture("08-nfc-success", 1000);
    const stampCountAfterSuccess = await page.evaluate(() => state.db.stamps.length);
    await page.click("#clearScanResult");
    await page.evaluate(() => {
      const button = document.querySelector("button[data-nfc]");
      button.click();
      button.click();
    });
    await page.locator(".scan-pad.duplicate").waitFor({ state: "visible" });
    await capture("09-nfc-duplicate", 520);
    const stampCountAfterDuplicate = await page.evaluate(() => state.db.stamps.length);
    ensure(stampCountAfterSuccess === 1 && stampCountAfterDuplicate === 1, `${viewport.name}: NFC 중복 클릭 방지가 실패함`);
    await page.goBack();
    await page.locator(".map-screen").waitFor({ state: "visible" });

    await page.click('button[data-route="stamps"]');
    await page.locator(".stamp-screen").waitFor({ state: "visible" });
    await assertBottomNav("pass");
    await capture("10-pass");
    steps.push(await layout("pass"));

    await page.click('button[data-route="profile"]');
    await page.locator(".profile-screen").waitFor({ state: "visible" });
    await assertBottomNav("profile");
    await capture("11-profile");
    steps.push(await layout("profile"));

    await page.click('button[data-route="login"]');
    await page.evaluate(() => {
      const button = document.querySelector("#adminLogin");
      button.click();
      button.click();
    });
    await page.locator(".admin-screen").waitFor({ state: "visible" });
    await assertBottomNav("admin-dashboard");
    await capture("12-admin-dashboard");
    steps.push(await layout("admin-dashboard"));

    await page.click('[data-toggle-menu="admin-tab"]');
    await page.click('[data-admin-tab="booths"]');
    await assertBottomNav("admin-booths");
    await capture("13-admin-booths");
    steps.push(await layout("admin-booths"));
    const boothCountBefore = await page.evaluate(() => state.db.booths.length);
    await page.fill("#boothName", "중복 클릭 테스트 부스");
    await page.fill("#boothLocation", "1층 테스트실");
    await page.fill("#boothNfc", `NFC-RAPID-${viewport.name}`);
    await page.evaluate(() => {
      const button = document.querySelector("#addBooth");
      button.click();
      button.click();
      button.click();
    });
    ensure(await page.evaluate(() => state.db.booths.length) === boothCountBefore + 1, `${viewport.name}: 부스 추가 중복 클릭 방지가 실패함`);
    await page.locator(".admin-table .table-row").last().scrollIntoViewIfNeeded();
    await capture("14-admin-booths-scroll");
    const adminScrollReady = await page.locator(".admin-table .table-row").last().isVisible();
    ensure(adminScrollReady, `${viewport.name}: 관리자 긴 목록의 마지막 카드가 렌더링되지 않음`);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('[data-toggle-menu="admin-tab"]');
    await page.click('[data-admin-tab="visits"]');
    await assertBottomNav("admin-visits");
    await page.selectOption("#manualBooth", "b2");
    const visitsBefore = await page.evaluate(() => state.db.stamps.length);
    await page.evaluate(() => {
      const button = document.querySelector("#manualApproveStamp");
      button.click();
      button.click();
      button.click();
    });
    ensure(await page.evaluate(() => state.db.stamps.length) === visitsBefore + 1, `${viewport.name}: 수동 승인 중복 클릭 방지가 실패함`);
    await capture("15-admin-visits");
    steps.push(await layout("admin-visits"));

    const renderPerformance = await page.evaluate(() => {
      const routes = ["home", "map", "scan", "stamps", "profile", "admin"];
      const samples = [];
      for (let index = 0; index < 24; index += 1) {
        state.route = routes[index % routes.length];
        const started = performance.now();
        render();
        samples.push(performance.now() - started);
      }
      state.route = "admin";
      state.adminTab = "visits";
      render();
      return {
        averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
        maxMs: Math.max(...samples),
      };
    });
    ensure(renderPerformance.maxMs < 100, `${viewport.name}: 최대 렌더 시간이 100ms를 넘음`);

    report.push({
      viewport,
      steps,
      errors,
      stampCountAfterSuccess,
      stampCountAfterDuplicate,
      adminScrollReady,
      renderPerformance,
    });
    await page.close();
  }

  fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  for (const result of report) {
    const smallTargets = result.steps.reduce((sum, step) => sum + step.undersizedTargets.length, 0);
    process.stdout.write(`${result.viewport.name}px: errors=${result.errors.length}, smallTargets=${smallTargets}, stamps=${result.stampCountAfterSuccess}->${result.stampCountAfterDuplicate}, renderMax=${result.renderPerformance.maxMs.toFixed(2)}ms\n`);
  }
  await browser.close();
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
