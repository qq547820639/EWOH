/**
 * UX-009 端到端体验测试矩阵 —— 页面状态域。
 *
 * 覆盖：核心页面在 loading / error / empty / offline / permission-denied
 *      五种状态下的用户可见反馈（不依赖真实后端，通过 mock 数据层驱动）。
 *
 * 运行方式：`npx playwright test --config playwright.config.ts --grep "UX-009/States"`
 */
const { test, expect } = require('@playwright/test');
const { ROLES, startStaticServer, openSession, mockApi } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const DASHBOARD_MOCK = {
  'GET /api/dashboard/overview': {
    deviceTotal: 12,
    deviceOnline: 9,
    eventOpen: 2,
    eventCritical: 1,
    avgLoad: 62,
    workerCount: 8,
  },
  'GET /api/dashboard/events': [],
};

test.describe('UX-009/States', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('Loading：指挥中心数据加载中显示状态提示', async ({ page }) => {
    await mockApi(page, DASHBOARD_MOCK);
    // 延迟 API 响应，让 loading 状态可被稳定观察到
    await page.route('**/api/dashboard/overview', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await page.route('**/api/dashboard/events', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('text=正在加载指挥中心数据')).toBeVisible();
    // 数据到达后 loading 消失，渲染出内容
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expect(page.locator('text=设备总数')).toBeVisible();
  });

  test('Error：指挥中心接口失败时显示错误状态与重试', async ({ page }) => {
    await mockApi(page, {
      'GET /api/dashboard/overview': { status: 500, body: { message: 'server unavailable' } },
      'GET /api/dashboard/events': { status: 500, body: { message: 'server unavailable' } },
    });
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
  });

  test('Empty：告警列表为空时显示空状态', async ({ page }) => {
    await mockApi(page, { 'GET /api/alerts': [] });
    await openSession(page, baseUrl, ROLES.dispatcher, '/alerts');
    await expect(page.locator('h1')).toHaveText('风险与告警');
    await expect(page.locator('text=暂无告警记录。')).toBeVisible();
  });

  test('Offline：移动工作台离线时显示离线状态提示', async ({ page }) => {
    await mockApi(page, { 'GET /api/mobile/workbench': [] });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await page.context().setOffline(true);
    await expect(
      page.locator('text=当前处于离线状态，操作会加入待同步队列，联网后自动提交。'),
    ).toBeVisible();
  });

  test('Permission：worker 访问无权页面时显示 403 无权限', async ({ page }) => {
    await mockApi(page, {});
    await openSession(page, baseUrl, ROLES.worker, '/system');
    await expect(page.locator('text=403 无权限')).toBeVisible();
  });
});