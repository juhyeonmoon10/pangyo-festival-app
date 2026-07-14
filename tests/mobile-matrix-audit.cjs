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
  { name: "757-in-app", width: 757, height: 802 },
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
    const sheetGeometry = await page.evaluate(() => {
      const sheet = document.querySelector("#sheet")?.getBoundingClientRect();
      const handle = document.querySelector("#sheetToggle")?.getBoundingClientRect();
      const grip = document.querySelector(".sheet-grip")?.getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav")?.getBoundingClientRect();
      const sheetPosition = document.querySelector("#sheet")
        ? getComputedStyle(document.querySelector("#sheet")).position
        : null;
      return sheet && handle && grip && nav ? {
        sheetPosition,
        sheetHeight: sheet.height,
        handleHeight: handle.height,
        handleBottom: handle.bottom,
        navTop: nav.top,
        gap: nav.top - handle.bottom,
        gripInside: grip.top >= sheet.top && grip.bottom <= sheet.bottom,
        gripWidth: grip.width,
      } : null;
    });
    ensure(sheetGeometry, `${viewport.name}: 부스 목록 핸들 또는 하단 탭바가 없음`);
    ensure(sheetGeometry.sheetPosition === "fixed", `${viewport.name}: 부스 목록이 화면 기준으로 고정되지 않음 ${JSON.stringify(sheetGeometry)}`);
    ensure(sheetGeometry.sheetHeight >= 42 && sheetGeometry.handleHeight >= 42, `${viewport.name}: 기본 화면 핸들 바 높이가 부족함 ${JSON.stringify(sheetGeometry)}`);
    ensure(sheetGeometry.gripInside && sheetGeometry.gripWidth >= 40, `${viewport.name}: 기본 화면에서 핸들 표시가 잘림 ${JSON.stringify(sheetGeometry)}`);
    ensure(sheetGeometry.gap >= 0 && sheetGeometry.gap <= 8, `${viewport.name}: 핸들이 하단 탭바 바로 위에 있지 않음 ${JSON.stringify(sheetGeometry)}`);
    await capture("03-map");
    steps.push(await layout("map"));

    await page.click("#sheetToggle");
    ensure(await page.evaluate(() => state.sheetLevel) === "mid", `${viewport.name}: 부스 목록 중간 펼침 실패`);
    const sheetListLayout = await page.locator(".sheet .booth-item").first().evaluate((item) => {
      const meta = item.querySelector(".meta");
      const status = item.querySelector(".status-badge");
      return {
        itemHeight: item.getBoundingClientRect().height,
        itemClipped: item.scrollHeight > item.clientHeight + 1,
        metaVisible: Boolean(meta && meta.getBoundingClientRect().height > 0),
        statusVisible: Boolean(status && status.getBoundingClientRect().height > 0),
      };
    });
    ensure(sheetListLayout.itemHeight >= 84, `${viewport.name}: 부스 카드가 너무 낮음 ${JSON.stringify(sheetListLayout)}`);
    ensure(!sheetListLayout.itemClipped && sheetListLayout.metaVisible && sheetListLayout.statusVisible, `${viewport.name}: 부스 카드 정보가 잘림 ${JSON.stringify(sheetListLayout)}`);
    await capture("03b-sheet-mid");
    await page.click("#sheetToggle");
    ensure(await page.evaluate(() => state.sheetLevel) === "full", `${viewport.name}: 부스 목록 전체 펼침 실패`);
    const fullSheetGeometry = await page.evaluate(() => {
      const sheet = document.querySelector("#sheet")?.getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav")?.getBoundingClientRect();
      return sheet && nav ? {
        top: sheet.top,
        bottomGap: nav.top - sheet.bottom,
      } : null;
    });
    ensure(fullSheetGeometry, `${viewport.name}: 전체 펼침 위치를 측정할 수 없음`);
    ensure(fullSheetGeometry.top <= 130, `${viewport.name}: 전체 펼침이 충분히 올라오지 않음 ${JSON.stringify(fullSheetGeometry)}`);
    ensure(fullSheetGeometry.bottomGap >= 0 && fullSheetGeometry.bottomGap <= 8, `${viewport.name}: 펼친 목록이 하단 탭바에 붙지 않음 ${JSON.stringify(fullSheetGeometry)}`);
    await capture("03c-sheet-full");
    await page.click("#sheetToggle");
    ensure(await page.evaluate(() => state.sheetLevel) === "peek", `${viewport.name}: 부스 목록 접기 실패`);

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
      const button = document.querySelector('[data-nfc-test="NFC-G1-01"]');
      button.click();
      button.click();
      button.click();
    });
    await page.locator(".scan-pad.success").waitFor({ state: "visible" });
    await page.waitForFunction(() => state.db.stamps.length === 1);
    await capture("08-nfc-success", 1000);
    const stampCountAfterSuccess = await page.evaluate(() => state.db.stamps.length);

    await page.click('[data-nfc-test="NFC-G1-02"]');
    await page.waitForFunction(() => state.db.stamps.length === 2 && state.scanResult?.type === "success");
    const stampCountAfterSecond = await page.evaluate(() => state.db.stamps.length);
    await capture("08b-nfc-second-success", 520);

    await page.evaluate(() => {
      const button = document.querySelector('[data-nfc-test="NFC-G1-01"]');
      button.click();
      button.click();
    });
    await page.waitForFunction(() => state.scanResult?.type === "duplicate");
    await capture("09-nfc-duplicate", 520);
    const stampCountAfterDuplicate = await page.evaluate(() => state.db.stamps.length);
    ensure(stampCountAfterSuccess === 1 && stampCountAfterSecond === 2 && stampCountAfterDuplicate === 2, `${viewport.name}: NFC 연속 적립 또는 중복 방지가 실패함`);

    await page.click("#resetNfcTestStamps");
    await page.waitForFunction(() => state.db.stamps.length === 0 && state.nfcTestMessage.includes("2개"));
    await capture("09b-nfc-reset", 320);

    const idempotencyContract = await page.evaluate(async () => {
      const idempotencyKey = makeId();
      const request = {
        eventId: state.db.event.id,
        userId: state.user.id,
        nfcToken: mockNfcTokenForTagId("NFC-G1-01"),
        idempotencyKey,
      };
      const first = await stampGateway.claimNfc(request);
      const countAfterFirst = state.db.stamps.length;
      const replay = await stampGateway.claimNfc(request);
      const countAfterReplay = state.db.stamps.length;
      const conflict = await stampGateway.claimNfc({
        ...request,
        nfcToken: mockNfcTokenForTagId("NFC-G1-02"),
      });
      return {
        first,
        replay,
        conflict,
        countAfterFirst,
        countAfterReplay,
        countAfterConflict: state.db.stamps.length,
      };
    });
    ensure(idempotencyContract.first.result === "EARNED", `${viewport.name}: 최초 멱등성 요청이 적립되지 않음`);
    ensure(idempotencyContract.replay.result === "EARNED" && idempotencyContract.replay.replayed, `${viewport.name}: 같은 멱등성 키 재시도 결과가 재사용되지 않음`);
    ensure(idempotencyContract.conflict.code === "IDEMPOTENCY_KEY_REUSED", `${viewport.name}: 다른 태그의 멱등성 키 재사용이 거부되지 않음`);
    ensure(
      idempotencyContract.countAfterFirst === 1
      && idempotencyContract.countAfterReplay === 1
      && idempotencyContract.countAfterConflict === 1,
      `${viewport.name}: 멱등성 재시도 중 스탬프 수가 변경됨`,
    );
    await page.evaluate(() => resetNfcTestStamps());
    await page.waitForFunction(() => state.db.stamps.length === 0);

    await page.click('[data-nfc-test="NFC-G1-02"]');
    await page.waitForFunction(() => state.db.stamps.length === 1 && state.scanResult?.type === "success");
    await page.goBack();
    await page.locator(".map-screen").waitFor({ state: "visible" });

    await page.click('button[data-route="stamps"]');
    await page.locator(".stamp-screen").waitFor({ state: "visible" });
    await assertBottomNav("pass");
    ensure(await page.locator(".pass-row.earned").count() === 1, `${viewport.name}: NFC 초기화 후 패스 기록이 즉시 갱신되지 않음`);
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
      stampCountAfterSecond,
      stampCountAfterDuplicate,
      adminScrollReady,
      renderPerformance,
    });
    await page.close();
  }

  fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  for (const result of report) {
    const smallTargets = result.steps.reduce((sum, step) => sum + step.undersizedTargets.length, 0);
    process.stdout.write(`${result.viewport.name}px: errors=${result.errors.length}, smallTargets=${smallTargets}, stamps=${result.stampCountAfterSuccess}->${result.stampCountAfterSecond}->${result.stampCountAfterDuplicate}, renderMax=${result.renderPerformance.maxMs.toFixed(2)}ms\n`);
  }
  await browser.close();
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
