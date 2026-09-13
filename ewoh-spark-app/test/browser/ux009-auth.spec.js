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

  /* UX-IA-2026-08 §3.2：登录后按角色任务域分流——计划员(dispatcher)落地
   * `/factory-operations`（工厂作业台），不再直达 `/command-center`。
   * 本用例校验"落地页 + 用户可见标题 + KPI 来自真实接口数据"这条链路；
   * 指挥中心自身的可达性由 /command-center 的路由与权限用例覆盖。 */
  test('登录成功（计划员）落地工厂作业台，掷出用户可见标题与真实 KPI', async ({ page }) => {
    await mockApi(page, {
      'POST /api/auth/login': () => ({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        user: ROLES.dispatcher,
      }),
      // avgLoad 的口径是**0–1 归一化负荷**（服务端 avg(load_score)），UI 负责 ×100
      // 显示为百分比；mock 必须按真实口径给值，否则会出现"6200%"这类假象。
      'GET /api/dashboard/overview': {
        deviceTotal: 12,
        deviceOnline: 9,
        eventOpen: 2,
        eventCritical: 1,
        avgLoad: 0.62,
        workerCount: 8,
      },
      // 作业台的事件源契约是 { items, total }（不是裸数组——裸数组会让页面
      // 在 `data.items.length` 处崩成"页面加载失败"，mock 必须与接口同形）。
      'GET /api/dashboard/events': { items: [], total: 0 },
      'GET /api/scheduler/active-plans': [],
    });
    await page.goto(`${baseUrl}/login`);
    await page.fill('#username', 'dispatcher');
    await page.fill('#password', 'whatever');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/factory-operations/);
    await expect(page.locator('h1')).toHaveText('今天的工厂，先处理什么？');
    // 数据一致性：KPI 数值来自 mock 数据，而非仅 HTTP 200。
    // 用 KPI 卡片自身的 testid 精确定位——裸 `text=接入设备` 会命中引导语里的
    // 同名短语（strict mode violation：引导文案同样含"接入设备"）。
    // deviceTotal 不是独立卡片，它是"在线设备"卡片的 `在线 / 总数` 明细值。
    await expect(page.getByTestId('kpi-deviceOnline')).toContainText('在线设备');
    await expect(page.getByTestId('kpi-deviceOnline')).toContainText('9 / 12');
    await expect(page.getByTestId('kpi-eventOpen')).toContainText('待确认事件');
    await expect(page.getByTestId('kpi-eventOpen')).toContainText('2');
    // 单位口径：0.62 → 62%（0–1 归一化负荷）
    await expect(page.getByTestId('kpi-avgLoad')).toContainText('62%');
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
    // 数字世界依赖空间层级与世界状态 API，mock 避免回退到静态 HTML。
    // 载荷必须与 `CurrentWorldState` 契约同形（persons/devices/workstations/events
    // 都是数组）——只给 `entities` 会让页面在计数处崩成"页面加载失败"。
    await mockApi(page, {
      'GET /api/spatial/hierarchy': [],
      'GET /api/world/state': {
        persons: [],
        devices: [],
        workstations: [],
        events: [],
        updatedAt: new Date().toISOString(),
      },
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
    // CLI-507：重定向需携带 redirect= 保留被中断页面（原断言 /login$ 与
    // redirectToLogin 的 ?redirect= 行为矛盾，在 redirect 特性合入后即失效）。
    await expect(page).toHaveURL(/\/login\?redirect=%2Fwork-orchestration$/, { timeout: 20_000 });
  });
});