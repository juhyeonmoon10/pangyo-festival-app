// Home-screen and notification icons (1.59) drawn from the site's "P." brand mark with Chrome:
// node tools/build-app-icons.cjs (CHROME_PATH may point at an installed Chrome).
const path = require('node:path');
const { chromium } = require('playwright');

const out = path.join(__dirname, '../assets');
const mark = (size, { pad = 0, round = true, badge = false } = {}) => `<!doctype html><html><body style="margin:0;background:transparent">
  <div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:${badge ? 'transparent' : '#98eec7'};${round ? `border-radius:${size * 0.22}px;` : ''}">
    <span style="font:850 ${(size - pad * 2) * 0.62}px/1 -apple-system,'Segoe UI',Arial,sans-serif;color:${badge ? '#ffffff' : '#076547'};letter-spacing:-0.02em;transform:translateY(-2%)">P.</span>
  </div></body></html>`;

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  const shots = [
    ['app-icon-180.png', 180, { round: false }],
    ['app-icon-192.png', 192, {}],
    ['app-icon-512.png', 512, {}],
    // Maskable: launchers crop to a circle, so the mark keeps to the inner 80%.
    ['app-icon-512-maskable.png', 512, { round: false, pad: 51 }],
    ['app-badge-96.png', 96, { round: false, badge: true }],
  ];
  for (const [name, size, options] of shots) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(mark(size, options));
    await page.screenshot({ path: path.join(out, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
  console.log(`${shots.length} icons in assets/`);
})();
