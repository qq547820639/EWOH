/**
 * UX-009 端到端体验测试矩阵 —— Auth 域。
 *
 * 覆盖：角色矩阵（操作员/质检员/计划员/厂长/项目Owner）、登录、权限不足、会话过期。
 * 断言不仅看 HTTP 状态、路由跳转，还验证最终用户可见状态（页面标题、403 文案、登录表单）。
 *
 * 运行方式：`npm run test:browser:ux009 -- --grep "UX-009/Auth"`
 * 依赖：`dist/client` 构建产物已存在（否则可先 `npm run build:client:standalone`）。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

// 每个用例独立 context，拦截 service worker 避免干扰。
test.use({ serviceWorkers: 'block' });

test.describe('UX-009/Auth', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('未登录访问受保护路由会重定向到登录页', async ({ page }) => {
    await page.goto(`${baseUrl}/work-orchestration`);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('form button[type="submit"]')).toContainText('登录');
  });

  test('登录成功（计划员）进入指挥中心，掷出用户可见的指挥中心标题', async ({ page }) => {
    await mockApi(page, {
      'POST /api/auth/login': () => ({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        user: ROLES.dispatcher,
      }),
      'GET /api/dashboard/overview': {
        deviceTotal: 12,
        deviceOnline: 9,
        eventOpen: 2,
        eventCritical: 1,
        avgLoad: 62,
        workerCount: 8,
      },
      'GET /api/dashboard/events': [],
    });
    await page.goto(`${baseUrl}/login`);
    await page.fill('#username', 'dispatcher');
    await page.fill('#password', 'whatever');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/command-center/);
    await expect(page.locator('h1')).toHaveText('指挥中心');
    // 数据一致性：KPI 数值来自 mock 数据，而非仅 HTTP 200
    await expect(page.locator('text=设备总数')).toBeVisible();
    await expect(page.getByText('12', { exact: true }).first()).toBeVisible();
  });

  test('登录失败展示错误提示，绝不跳转', async ({ page }) => {
    await mockApi(page, {
      'POST /api/auth/login': { status: 401, body: { message: '用户名或密码错误' } },
    });
    await page.goto(`${baseUrl}/login`);
    await page.fill('#username', 'nobody');
    await page.fill('#password', 'wrong');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('form').getByText(/Request failed|401|登录失败/)).toBeVisible();
  });

  test('角色矩阵：操作员(worker)可访问移动工作台，但访问组织/指挥中心被拒（403）', async ({ page }) => {
    // worker 可访问 /mobile-workbench（mock 待办工序，避免回退到静态 HTML）
    await mockApi(page, {
      'GET /api/mobile/workbench': [],
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');

    // worker 无权访问 /organization —— 用户可见 403 文案
    await page.goto(`${baseUrl}/organization`);
    await expect(page.locator('h1')).toHaveText('403 无权限');
    await expect(page.locator('text=无权访问该中心')).toBeVisible();

    // worker 无权访问 /command-center
    await page.goto(`${baseUrl}/command-center`);
    await expect(page.locator('h1')).toHaveText('403 无权限');
  });

  test('角色矩阵：厂长(workshop_lead)可访问数字世界/排产，但组织/执行控制台被拒', async ({ page }) => {
    // 数字世界依赖空间层级与世界状态 API，mock 避免回退到静态 HTML
    await mockApi(page, {
      'GET /api/spatial/hierarchy': [],
      'GET /api/world/state': { status: 'ready', entities: [], updatedAt: new Date().toISOString() },
    });
    await openSession(page, baseUrl, ROLES.workshop_lead, '/digital-world');
    await expect(page.locator('h1')).toContainText('数字世界');

    await page.goto(`${baseUrl}/organization`);
    await expect(page.locator('h1')).toHaveText('403 无权限');
    await page.goto(`${baseUrl}/work-orchestration`);
    await expect(page.locator('h1')).toHaveText('403 无权限');
  });

  test('角色矩阵：项目Owner(global_admin)可访问所有中心（含执行控制台）', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': {
        generatedAt: new Date().toISOString(),
        phase: '试点',
        criticalPath: 'CP-1',
        counts: { itemCount: 3, edgeCount: 2, actorCount: 1, artifactCount: 0, evidenceCount: 0, gateCount: 1, riskCount: 0, decisionCount: 0, statusCounts: {}, conflicts: [] },
        gates: [],
        conflicts: [],
        writable: true,
      },
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration');
    await expect(page.locator('h1')).toHaveText('执行控制台');
    // 写回已启用（writable=true）是用户可见状态
    await expect(page.locator('text=写回已启用')).toBeVisible();
  });

  test('会话过期：受保护接口返回 401 且刷新失败后，重定向回登录页', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': { status: 401, body: { message: 'expired' } },
      'POST /api/auth/refresh': { status: 401, body: { message: 'invalid refresh' } },
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration');
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  });
});