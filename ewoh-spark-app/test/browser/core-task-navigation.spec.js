/**
 * UX-IA-2026-08 核心任务到达路径防回归（E2E）。
 *
 * 验证信息架构重构后的「可用、好用」底线：
 *  1. 侧栏为 5 组任务域结构，非当前组折叠为组标题；
 *  2. roleText 权限文案不再常驻导航项（降噪）；
 *  3. ⌘K 命令面板可直达页面内功能（≤2 次交互到达「维保任务」）；
 *  4. Operations tab 支持 URL 直达（?tab=）。
 *
 * 运行：npx playwright test --config playwright.config.ts test/browser/core-task-navigation.spec.js
 * 依赖：dist/client 构建产物已存在。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const OPERATIONS_MOCK = {
  'GET /api/operations/summary': {
    assetCount: 3,
    inProgressTasks: 2,
    calibrationDueCount: 1,
    averageEfficiencyPercent: 88,
  },
  'GET /api/operations/maintenance/assets': [],
  'GET /api/operations/maintenance/tasks': [],
  'GET /api/operations/maintenance/tools': [],
  'GET /api/operations/work-centers': [],
  'GET /api/operations/standard-hours': [],
  'GET /api/operations/efficiency/entries': [],
  'GET /api/operations/efficiency/summary': { averageEfficiencyPercent: 88 },
};

test.describe('UX-IA 核心任务到达路径', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('侧栏呈现任务域分组：非当前组折叠、当前组自动展开、无权限文案第二行', async ({ page }) => {
    await mockApi(page, {
      'GET /api/dashboard/overview': { deviceTotal: 1, deviceOnline: 1, eventOpen: 0, eventCritical: 0, avgLoad: 50, workerCount: 1 },
      'GET /api/dashboard/events': [],
    });
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1').first()).toBeVisible();

    // 移动视口（<lg）侧栏为抽屉，需先打开；桌面视口常驻。
    if ((page.viewportSize()?.width ?? 1440) < 1024) {
      await page.getByRole('button', { name: '打开导航' }).click();
    }

    // 1) 组标题以可折叠按钮呈现（aria-expanded），5 组结构
    const groupButtons = page.locator('aside nav > div > div > button[aria-expanded]');
    await expect(groupButtons).toHaveCount(5);
    expect(await groupButtons.allTextContents()).toEqual([
      '驾驶舱',
      '调度与执行',
      '作业现场',
      '资源与资产',
      '仿真与治理',
    ]);

    // 2) 当前组（驾驶舱）默认展开且高亮项可见
    const cockpit = page.locator('aside nav > div > div > button[aria-expanded]', { hasText: '驾驶舱' });
    await expect(cockpit).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('aside').getByRole('link', { name: /指挥中心/ })).toBeVisible();

    // 3) 非当前组折叠（如「资源与资产」收起后其子项不可见）
    const resources = page.locator('aside nav > div > div > button[aria-expanded]', { hasText: '资源与资产' });
    await expect(resources).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('aside').getByRole('link', { name: /设备中心/ })).toHaveCount(0);

    // 4) 点击组标题展开子项
    await resources.click();
    await expect(resources).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('aside').getByRole('link', { name: /设备中心/ })).toBeVisible();

    // 5) roleText 权限文案不再作为第二行常驻（降噪回归锚点：
    //    导航项内不应出现「厂长 · 计划员」这类角色串联文案）
    const sidebarText = await page.locator('aside nav').innerText();
    expect(sidebarText).not.toContain('厂长 ·');
    expect(sidebarText).not.toContain('安全员 ·');
  });

  test('⌘K 直达页面内功能：搜索「维保任务」≤2 次交互到达目标内容', async ({ page }) => {
    await mockApi(page, OPERATIONS_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1').first()).toBeVisible();

    // 交互 1：打开命令面板并输入
    await page.getByRole('button', { name: /全局搜索/ }).click();
    await page.getByPlaceholder('输入页面名称或关键词…').fill('维保任务');
    // 交互 2：选中「页面内功能」分组条目
    await page.getByRole('option', { name: /维保任务/ }).first().click();

    // 到达：URL 携带 tab 参数，页面 tab 状态同步
    await expect(page).toHaveURL(/\/operations\?tab=/);
    await expect(page.locator('h1')).toHaveText(/运维中心/);
  });

  test('Operations tab 支持 URL 直达（?tab=维保资产）', async ({ page }) => {
    await mockApi(page, OPERATIONS_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/operations?tab=维保资产');
    await expect(page.locator('h1')).toHaveText('运维中心');
    // 对应 tab 处于激活态（激活按钮为主色底），内容区渲染维保资产面板
    const activeTab = page.locator('.sticky button.bg-primary');
    await expect(activeTab).toHaveText(/维保资产/);
  });
});
