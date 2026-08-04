/**
 * UX-009 端到端体验测试矩阵 —— 视觉回归。
 *
 * 覆盖：核心页面（登录、指挥中心、移动工作台、执行控制台）在桌面视口下的像素级截图对比。
 * 断言使用 Playwright `toHaveScreenshot`，基线存放于 `test/browser/snapshots/visual/`。
 *
 * 说明：
 *  - 本用例默认被跳过（除非设置 `EWOH_VISUAL=1`），避免在常规 E2E 中因缺少基线或字体差异失败。
 *  - 使用独立配置 `playwright.visual.config.ts` 运行：`npm run test:browser:visual`。
 *  - 首次运行需 `--update-snapshots` 生成基线。
 *
 * 运行方式：
 *   npm run test:browser:visual -- --update-snapshots
 *   npm run test:browser:visual
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

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

const OVERVIEW_MOCK = {
  generatedAt: new Date().toISOString(),
  phase: '试点',
  criticalPath: 'CP-1',
  counts: {
    itemCount: 3,
    edgeCount: 2,
    actorCount: 1,
    artifactCount: 0,
    evidenceCount: 0,
    gateCount: 1,
    riskCount: 0,
    decisionCount: 0,
    statusCounts: {},
    conflicts: [],
  },
  gates: [],
  conflicts: [],
  writable: true,
};

test.describe('UX-009/Visual', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('登录页视觉基线', async ({ page }) => {
    test.skip(!process.env.EWOH_VISUAL, '视觉回归需显式设置 EWOH_VISUAL=1');
    await page.goto(`${baseUrl}/login`);
    await expect(page.locator('form')).toBeVisible();
    await expect(page).toHaveScreenshot('login.png');
  });

  test('指挥中心视觉基线', async ({ page }) => {
    test.skip(!process.env.EWOH_VISUAL, '视觉回归需显式设置 EWOH_VISUAL=1');
    await mockApi(page, DASHBOARD_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expect(page).toHaveScreenshot('command-center.png');
  });

  test('移动工作台视觉基线', async ({ page }) => {
    test.skip(!process.env.EWOH_VISUAL, '视觉回归需显式设置 EWOH_VISUAL=1');
    await mockApi(page, { 'GET /api/mobile/workbench': [] });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await expect(page).toHaveScreenshot('mobile-workbench.png');
  });

  test('执行控制台视觉基线', async ({ page }) => {
    test.skip(!process.env.EWOH_VISUAL, '视觉回归需显式设置 EWOH_VISUAL=1');
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_MOCK,
      'GET /api/work/graph': { generatedAt: new Date().toISOString(), items: [], edges: [], evidence: [], gates: [], conflicts: [] },
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration');
    await expect(page.locator('h1')).toHaveText('执行控制台');
    await expect(page).toHaveScreenshot('work-orchestration.png');
  });
});