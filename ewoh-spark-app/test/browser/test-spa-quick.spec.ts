import { test, expect } from '@playwright/test';
const { resolveBrowserBaseUrl } = require('./runtime-target');

const BASE_URL = resolveBrowserBaseUrl();

for (const route of ['/', '/login']) {
  test(`${route} serves HTTP 200 and renders a usable login form`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const response = await page.goto(`${BASE_URL}${route}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/EWOH/);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });
}
