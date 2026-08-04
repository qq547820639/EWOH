/**
 * UX-009 端到端体验测试矩阵 —— axe 无障碍扫描（阻断 serious/critical）。
 *
 * 使用 @axe-core/playwright 的 AxeBuilder 对核心页面运行 axe 扫描，
 * 断言**无 serious/critical 级别的违规**（WCAG 严重度）。
 * minor/moderate 级别允许存在，但记录到 stdout 便于追溯。
 *
 * 覆盖页面：登录页、指挥中心、移动工作台、因果执行控制台。
 * 页面渲染策略与 ux009-a11y.spec.js / ux009-visual.spec.js 保持一致（mock + 会话注入）。
 *
 * 运行方式：`npm run test:browser:ux009 -- --grep "UX-009/Axe"`
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

/** 阻断级别：serious + critical。其余（minor/moderate）仅记录不阻断。 */
const BLOCKING_IMPACT = ['serious', 'critical'];

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

const GRAPH_MOCK = {
  generatedAt: new Date().toISOString(),
  items: [],
  edges: [],
  evidence: [],
  gates: [],
  conflicts: [],
};

/**
 * 对当前页面运行 axe 扫描，断言无 serious/critical 违规。
 * 返回 { violations, minorModerate } 供调用方进一步记录。
 */
async function runAxeScan(page, label) {
  const results = await new AxeBuilder({ page }).analyze();

  const blocking = results.violations.filter((v) =>
    BLOCKING_IMPACT.includes(v.impact),
  );
  const minorModerate = results.violations.filter(
    (v) => !BLOCKING_IMPACT.includes(v.impact),
  );

  // 记录非阻断级问题（minor/moderate），便于追溯但不阻断用例。
  if (minorModerate.length > 0) {
    console.log(
      `[axe][${label}] 非阻断级违规（${minorModerate.length}）: ` +
        minorModerate
          .map((v) => `${v.id}(${v.impact})×${v.nodes.length}`)
          .join(', '),
    );
  }

  const summary = blocking
    .map(
      (v) =>
        `${v.id}(${v.impact})×${v.nodes.length}: ${v.nodes
          .map((n) => n.target.join(' '))
          .join('; ')}`,
    )
    .join(' || ');

  expect(
    blocking,
    `[${label}] 存在 serious/critical 无障碍违规：${summary}`,
  ).toEqual([]);

  return { violations: results.violations, blocking, minorModerate };
}

test.describe('UX-009/Axe', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('登录页无 serious/critical 无障碍违规', async ({ page }) => {
    await page.goto(`${baseUrl}/login`);
    await expect(page.locator('h1')).toBeVisible();
    await runAxeScan(page, 'login');
  });

  test('指挥中心无 serious/critical 无障碍违规', async ({ page }) => {
    await mockApi(page, DASHBOARD_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await runAxeScan(page, 'command-center');
  });

  test('移动工作台无 serious/critical 无障碍违规', async ({ page }) => {
    await mockApi(page, { 'GET /api/mobile/workbench': [] });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await runAxeScan(page, 'mobile-workbench');
  });

  test('因果执行控制台无 serious/critical 无障碍违规', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_MOCK,
      'GET /api/work/graph': GRAPH_MOCK,
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration');
    await expect(page.locator('h1')).toHaveText('执行控制台');
    await runAxeScan(page, 'work-orchestration');
  });
});