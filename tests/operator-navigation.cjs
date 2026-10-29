async function openOperatorTool(page, name) {
  if (!['dashboard', 'tools', 'audit'].includes(name)) {
    await page.locator('[data-ops-tab="tools"]').first().click();
  }
  await page.locator(`[data-ops-tab="${name}"]`).first().click();
}
module.exports = { openOperatorTool };
