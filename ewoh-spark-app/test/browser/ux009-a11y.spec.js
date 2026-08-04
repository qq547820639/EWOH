/**
 * UX-009 端到端体验测试矩阵 —— 无障碍与多视口。
 *
 * 覆盖：核心页面的无障碍语义检查（h1 唯一、main 地标、按钮可访问名、图片 alt、控件标签、
 *       触控目标尺寸），并在桌面 / 工业平板 / 手机三种视口下验证。
 * 说明：当前未引入 axe-core（避免新增依赖），使用 fixture 提供的轻量语义检查 `collectA11yIssues`。
 *       若未来接入 axe，可在此基础上叠加 `@axe-core/playwright` 的 axelog 断言。
 *
 * 运行方式：`npm run test:browser:ux009 -- --grep "UX-009/A11y"`
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  VIEWPORTS,
  startStaticServer,
  openSession,
  mockApi,
  collectA11yIssues,
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

test.describe('UX-009/A11y', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`核心页面在「${name}」视口下通过无障碍语义检查`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockApi(page, DASHBOARD_MOCK);
      await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
      await expect(page.locator('h1')).toHaveText('指挥中心');

      const issues = await collectA11yIssues(page);
      // 空数组表示通过；任何问题都视为失败并给出具体列表
      expect(issues, `视口 ${name} 无障碍问题：${issues.join('；')}`).toEqual([]);
    });
  }

  test('移动工作台在手机视口下通过无障碍语义检查', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await mockApi(page, { 'GET /api/mobile/workbench': [] });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');

    const issues = await collectA11yIssues(page);
    expect(issues, `移动工作台无障碍问题：${issues.join('；')}`).toEqual([]);
  });
});