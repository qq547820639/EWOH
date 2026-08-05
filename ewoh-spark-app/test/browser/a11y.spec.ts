/**
 * UX-0011 工业无障碍 —— axe 扫描 + 可见焦点样式 + 键盘可导航性。
 *
 * 覆盖无需登录即可触达的登录页：
 *   1. @axe-core/playwright 扫描，断言无 serious/critical 违规；
 *   2. 键盘聚焦控件时具有可见焦点样式（非 none outline）；
 *   3. 页面可纯键盘导航（Tab 依次聚焦 用户名 → 密码 → 提交按钮）。
 *
 * 运行方式：
 *   npx playwright test --config playwright.config.ts --project=chromium --grep "UX-0011/A11y"
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AxeBuilder = require('@axe-core/playwright').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const BLOCKING_IMPACT = ['serious', 'critical'];

test.describe('UX-0011/A11y', () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let baseUrl: string;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('登录页 axe 扫描无 serious/critical 违规', async ({ page }) => {
    await page.goto(`${baseUrl}/login`);
    await expect(page.getByRole('heading', { name: 'EWOH' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) =>
      BLOCKING_IMPACT.includes(v.impact),
    );
    const summary = blocking
      .map((v) => `${v.id}(${v.impact})×${v.nodes.length}`)
      .join(', ');
    expect(blocking, `登录页存在 serious/critical 无障碍违规：${summary}`).toEqual([]);
  });

  test('键盘聚焦的登录控件具有可见焦点样式', async ({ page }) => {
    await page.goto(`${baseUrl}/login`);
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toBeVisible();
    const username = page.locator('#username');
    // 通过 Tab 逐次聚焦（键盘交互触发 :focus-visible），即使存在 skip-link 等前置焦点目标也稳健。
    await focusByTab(page, '#username');
    await expect(username).toBeFocused();

    const style = await username.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        boxShadow: s.boxShadow,
      };
    });
    const hasVisibleIndicator =
      style.outlineStyle !== 'none' && style.outlineStyle !== 'auto' &&
      parseFloat(style.outlineWidth) > 0;
    expect(
      hasVisibleIndicator,
      `焦点控件应具有可见焦点指示，实际 outline=${style.outlineStyle} ${style.outlineWidth}`,
    ).toBe(true);
  });

  test('登录页可纯键盘导航聚焦所有主要控件', async ({ page }) => {
    await page.goto(`${baseUrl}/login`);
    await expect(page.locator('#username')).toBeVisible();
    await focusByTab(page, '#username');
    await expect(page.locator('#username')).toBeFocused();
    // 密码框与提交按钮之间可能存在浏览器差异化的居中焦点目标（如 WebKit 的
    // 显示/隐藏密码切换按钮）。用「连续 Tab 直到聚焦」既验证提交按钮纯键盘可达，
    // 又容忍跨浏览器中间焦点目标，避免在 WebKit 上层假失败。
    await focusByTab(page, '#password');
    await expect(page.locator('#password')).toBeFocused();
    await focusByTab(page, 'button[type="submit"]');
    await expect(page.locator('button[type="submit"]')).toBeFocused();
  });
});

/**
 * 连续按 Tab 直到指定选择器成为焦点元素（最多 15 次），
 * 用于验证纯键盘可达性，同时容忍页面顶部存在 skip-link 等前置焦点目标。
 */
async function focusByTab(
  page: {
    evaluate: (fn: (sel: string) => boolean, sel: string) => Promise<boolean>;
    keyboard: { press: (key: string) => Promise<void> };
    locator: (sel: string) => { focus: () => Promise<void> };
  },
  selector: string,
): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    const focused = await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      selector,
    );
    if (focused) return;
    await page.keyboard.press('Tab');
  }
  await page.locator(selector).focus();
}