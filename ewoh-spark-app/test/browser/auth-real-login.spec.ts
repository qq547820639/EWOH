/**
 * Authenticated E2E tests with real credentials.
 * Tests the full login flow, dashboard, navigation, and core business pages.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://121.43.230.202:3000';
const ADMIN_USER = 'admin';

// R-03 交付收口（2026-08-30）：原硬编码 token 会过期导致整批注入用例失败——
// 改为运行时调用真实 login API 获取新鲜 token；密码经 EWOH_TEST_ADMIN_PASS
// 环境变量注入，绝不入库。
const ADMIN_PASS = process.env.EWOH_TEST_ADMIN_PASS ?? '';

let ACCESS_TOKEN = '';
const AUTH_USER = JSON.stringify({
  userId: 'admin',
  username: 'admin',
  roles: ['global_admin'],
  orgId: '00000000-0000-4000-8000-000000000001',
});

test.beforeAll(async () => {
  if (!ADMIN_PASS) {
    test.skip(true, '需要 EWOH_TEST_ADMIN_PASS 环境变量（真实平台凭据不入库）');
    return;
  }
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!res.ok) {
    throw new Error(`真实平台登录失败 (${res.status})——请核对新凭据或服务状态`);
  }
  const data = (await res.json()) as { accessToken: string };
  ACCESS_TOKEN = data.accessToken;
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
  test('clearing session redirects to login', async ({ page }) => {
    await injectSessionAndGo(page, '/command-center');
    await page.waitForTimeout(2000);

    // Clear session（access token 同时存在于 sessionStorage 与 localStorage，
    // 仅清其一在有效 token 下不会触发登录页重定向——auth 存储双通道见 lib/auth.ts）
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
    await page.goto(`${BASE_URL}/command-center`);
    await page.waitForURL(/\/login/, { timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
