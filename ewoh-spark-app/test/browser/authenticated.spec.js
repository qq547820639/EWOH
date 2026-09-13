const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { resolveBrowserBaseUrl, browserCredentials } = require('./runtime-target');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(APP_DIR, '..');
const BASE_URL = resolveBrowserBaseUrl();

async function loginAsDispatcher(page, user) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#username', user.username);
  await page.fill('#password', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/factory-operations/, { timeout: 30_000 });
  await expect(page.getByTestId('factory-operations')).toBeVisible();
}

test.describe('authenticated browser flow', () => {
  let credentials;
  test.beforeAll(() => {
    credentials = browserCredentials('dispatcher');
  });

  test('logs in as dispatcher and renders the factory operations workflow', async ({ page }, testInfo) => {
    await loginAsDispatcher(page, credentials);

    const screenshotDir = path.join(ROOT, 'output', 'playwright');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, `browser-authenticated-factory-operations-${testInfo.project.name}.png`),
      fullPage: true,
    });
  });

  test('renders the command map after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/command-map`);
    await expect(page.locator('body')).toContainText('EWOH 指挥地图');
    await expect(page.locator('input[placeholder*="搜索实体"]')).toBeVisible();
  });

  test('renders the mobile workbench after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/mobile-workbench`);
    await expect(page.locator('body')).toContainText('移动工作台');
    await expect(page.locator('input[placeholder*="扫码或输入工单号"]')).toBeVisible();
  });

  test('renders the alerts page after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/alerts`);
    await expect(page.locator('body')).toContainText('风险与告警');
  });

  test('renders the role workbench after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/role-workbench`);
    await expect(page.locator('body')).toContainText('角色任务工作台');
    await expect(page.getByRole('button', { name: '班组长', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
