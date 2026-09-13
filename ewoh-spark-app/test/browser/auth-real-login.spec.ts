/**
 * Authenticated E2E tests with real credentials.
 * Tests the full login flow, dashboard, navigation, and core business pages.
 */
import { test, expect } from '@playwright/test';
const { resolveBrowserBaseUrl, browserCredentials } = require('./runtime-target');

const BASE_URL = resolveBrowserBaseUrl();

// R-03 交付收口（2026-08-30）：原硬编码 token 会过期导致整批注入用例失败——
// 改为运行时调用真实 login API 获取新鲜 token；密码经 EWOH_TEST_ADMIN_PASS
// 环境变量注入，绝不入库。

let ACCESS_TOKEN = '';
let AUTH_USER = '';

test.beforeAll(async () => {
  const credentials = browserCredentials();
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) {
    throw new Error(`真实平台登录失败 (${res.status})——请核对新凭据或服务状态`);
  }
  const data = (await res.json()) as { accessToken: string; user: unknown };
  ACCESS_TOKEN = data.accessToken;
  expect(data.user).toBeDefined();
  AUTH_USER = JSON.stringify(data.user);
});

test.use({ serviceWorkers: 'block' });

// ─── Helper: inject session and navigate ───
async function injectSessionAndGo(page: import('@playwright/test').Page, route: string) {
  await page.addInitScript(
    ({ token, userJson }) => {
      if (window.sessionStorage.getItem('ewoh_session_injected')) return;
      window.sessionStorage.setItem('ewoh_session_injected', '1');
      window.sessionStorage.setItem('ewoh_access_token', token);
      window.sessionStorage.setItem('ewoh_auth_user', userJson);
    },
    { token: ACCESS_TOKEN, userJson: AUTH_USER },
  );
  await page.goto(`${BASE_URL}${route}`);
  await page.waitForLoadState('domcontentloaded');
}

// ─── Section 1: Login Flow ───
test.describe('Real Login Flow', () => {
  test('login page renders with form elements', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText('登录');
  });

  test('login with injected session shows command center', async ({ page }) => {
    await injectSessionAndGo(page, '/command-center');
    await page.waitForTimeout(3000);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(50);
    await expect(page).toHaveURL(/\/command-center/);
  });
});

// ─── Section 2: Navigation After Login ───
test.describe('Authenticated Navigation', () => {
  const pages = [
    { route: '/command-center', name: '指挥中心' },
    { route: '/devices', name: '设备' },
    { route: '/personnel', name: '人员' },
    { route: '/alerts', name: '告警' },
    { route: '/organization', name: '组织' },
    { route: '/system', name: '系统' },
    { route: '/scheduling', name: '排产' },
    { route: '/work-orchestration', name: '执行控制台' },
  ];

  for (const p of pages) {
    test(`${p.name} (${p.route}) renders content`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await injectSessionAndGo(page, p.route);
      await page.waitForTimeout(5000);

      const bodyText = await page.textContent('body');
      expect(bodyText!.length).toBeGreaterThan(50);

      const h1 = page.locator('h1');
      const h1Count = await h1.count();
      expect(h1Count).toBeGreaterThanOrEqual(1);

      const criticalErrors = pageErrors.filter(
        (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error'),
      );
      if (criticalErrors.length > 0) {
        console.log(`Page errors on ${p.route}:`, criticalErrors);
      }
    });
  }
});

// ─── Section 3: SPA Deep Links (Authenticated) ───
test.describe('SPA Deep Links (Authenticated)', () => {
  test('direct access to /command-center works', async ({ page }) => {
    await injectSessionAndGo(page, '/command-center');
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/command-center/);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(50);
  });

  test('direct access to /devices works', async ({ page }) => {
    await injectSessionAndGo(page, '/devices');
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/devices/);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(50);
  });

  test('refresh on command-center preserves session', async ({ page }) => {
    await injectSessionAndGo(page, '/command-center');
    await page.waitForTimeout(2000);
    await page.reload();
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/command-center/);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(50);
  });
});

// ─── Section 4: Console Error Monitoring ───
test.describe('Console Error Monitoring (Authenticated)', () => {
  test('command center has no critical JS errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: { url: string; status: number }[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (resp) => {
      if (resp.status() >= 400) {
        failedRequests.push({ url: resp.url(), status: resp.status() });
      }
    });

    await injectSessionAndGo(page, '/command-center');
    await page.waitForTimeout(5000);

    const criticalPageErrors = pageErrors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error'),
    );

    console.log('Console errors:', consoleErrors.length);
    console.log('Page errors:', criticalPageErrors.length);
    console.log('Failed requests:', failedRequests.length);

    if (failedRequests.length > 0) {
      console.log(
        'Failed requests:',
        failedRequests.map((r) => `${r.status} ${r.url}`),
      );
    }

    expect(criticalPageErrors).toHaveLength(0);
  });
});

// ─── Section 5: Responsive After Login ───
test.describe('Responsive After Login', () => {
  const viewports = [
    { name: 'Desktop 1920x1080', width: 1920, height: 1080 },
    { name: 'Desktop 1440x900', width: 1440, height: 900 },
    { name: 'Tablet 1024x768', width: 1024, height: 768 },
    { name: 'Mobile 390x844', width: 390, height: 844 },
  ];

  for (const vp of viewports) {
    test(`command center at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await injectSessionAndGo(page, '/command-center');
      await page.waitForTimeout(3000);

      const bodyText = await page.textContent('body');
      expect(bodyText!.length).toBeGreaterThan(50);

      const hasHScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 10,
      );
      if (hasHScroll) {
        console.warn(`Horizontal overflow at ${vp.name}`);
      }
    });
  }
});

// ─── Section 6: Logout Flow ───
test.describe('Logout Flow', () => {
  // 2026-09-13 重写：原用例"清空 Web Storage 后应跳登录页"断言的是**废弃架构**。
  // 现行认证（CLI-501/701）：refresh token 在 **httpOnly cookie**（服务端下发/吊销，
  // JS 不可见），access token 才在 sessionStorage。只清 Web Storage 撤销不了会话
  // ——刷新走 httpOnly cookie 照常续期，用户保持登录是**安全设计的正确行为**
  // （XSS 拿不到 30 天长期凭证，清 JS 存储也不构成登出）。真实登出 =
  // 服务端吊销 refresh cookie（POST /api/auth/logout）+ 客户端清理 + 跳转，
  // 即侧栏的「退出登录」按钮。本用例改为走这条真实路径。
  test('退出登录按钮：服务端吊销 refresh 会话并重定向登录页', async ({ page }) => {
    await injectSessionAndGo(page, '/command-center');
    await page.waitForTimeout(2000);

    await page.getByTitle('退出登录').click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);

    // 登出后重新访问受保护页：refresh cookie 已被服务端吊销，不得再进入业务页。
    await page.goto(`${BASE_URL}/command-center`);
    await page.waitForURL(/\/login/, { timeout: 10_000 });
  });
});
