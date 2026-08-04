/**
 * UX-009 端到端体验测试矩阵 —— 视觉回归（多视口 + 基准截图）。
 *
 * 覆盖：6 个核心页面（登录、指挥中心、执行控制台、Git 同步、移动工作台、场地就绪）
 * 在 3 个视口（mobile / tablet / desktop）下的像素级截图对比。
 * 每个「页面 × 视口」组合生成唯一截图文件（`{page-key}-{viewport-key}.png`），
 * 基线存放于 `test/browser/snapshots/ux009-visual.spec.js/`。
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
  VIEWPORTS,
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

/** 执行控制台（因果图 tab）所需的工作图数据。 */
const GRAPH_MOCK = {
  'GET /api/work/overview': OVERVIEW_MOCK,
  'GET /api/work/graph': {
    generatedAt: new Date().toISOString(),
    items: [],
    edges: [],
    evidence: [],
    gates: [],
    conflicts: [],
  },
};

/** Git 同步计划（GitSyncPlan 结构，参考 client/src/api/work.ts 的 GitSyncPlan）。 */
const GIT_SYNC_PLAN = {
  schema: 'git-sync-plan.v1',
  generatedAt: new Date().toISOString(),
  repository: 'acme/factory-ops',
  branch: 'main',
  headSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  itemCount: 2,
  trackedCount: 1,
  missingCount: 1,
  status: 'ready',
  source: 'offline',
  items: [
    {
      workItemId: 'WI-1001',
      title: '上线部署',
      type: '部署',
      status: 'open',
      owner: '老赵',
      issueNumber: 42,
      prNumber: null,
      branch: 'feat/deploy',
      commitSha: 'a1b2c3d4e5f6',
      state: 'open',
      missing: false,
    },
    {
      workItemId: 'WI-1002',
      title: '设备接入',
      type: '接入',
      status: 'open',
      owner: '老钱',
      issueNumber: null,
      prNumber: null,
      branch: null,
      commitSha: null,
      state: 'pending',
      missing: true,
    },
  ],
};

/** 场地就绪报告（SiteReadinessSummary[] 结构，参考 client/src/api/work.ts）。 */
const SITE_READINESS_REPORTS = [
  {
    sourcePath: 'config/site-readiness.json',
    example: false,
    factoryName: '华东一厂',
    siteContact: '王工',
    ready: true,
    requiredCount: 3,
    requiredPassed: 3,
    requiredFailed: 0,
    checks: [
      { id: 'F0-env', label: '环境准备：Docker 就绪', passed: true, status: 'passed' },
      { id: 'F1-deploy', label: '部署验证通过', passed: true, status: 'passed' },
      { id: 'F2-device', label: '设备接入完成', passed: true, status: 'passed' },
    ],
  },
];

/**
 * 6 个页面 × 3 个视口的矩阵定义。
 * role 为 null 表示无需登录态（直接 goto）；mock 为 null 表示不 mock API。
 * ready 为断言函数，确保页面渲染出预期内容后再截图。
 */
const PAGES = [
  {
    key: 'login',
    label: '登录页',
    route: '/login',
    role: null,
    mock: null,
    ready: (page) => expect(page.getByRole('heading', { name: 'EWOH' })).toBeVisible(),
  },
  {
    key: 'command-center',
    label: '指挥中心',
    route: '/command-center',
    role: ROLES.dispatcher,
    mock: DASHBOARD_MOCK,
    ready: (page) => expect(page.locator('h1')).toHaveText('指挥中心'),
  },
  {
    key: 'work-orchestration',
    label: '执行控制台',
    route: '/work-orchestration',
    role: ROLES.global_admin,
    mock: GRAPH_MOCK,
    ready: (page) => expect(page.locator('h1')).toHaveText('执行控制台'),
  },
  {
    key: 'git-sync',
    label: 'Git 同步',
    route: '/work-orchestration?tab=git-sync',
    role: ROLES.global_admin,
    mock: { ...GRAPH_MOCK, 'GET /api/work/git-sync': GIT_SYNC_PLAN },
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'GitHub Issue/PR 同步' })).toBeVisible(),
  },
  {
    key: 'mobile-workbench',
    label: '移动工作台',
    route: '/mobile-workbench',
    role: ROLES.worker,
    mock: { 'GET /api/mobile/workbench': [] },
    ready: (page) => expect(page.locator('h1')).toHaveText('移动工作台'),
  },
  {
    key: 'site-readiness',
    label: '场地就绪',
    route: '/work-orchestration?tab=site-readiness',
    role: ROLES.global_admin,
    mock: { ...GRAPH_MOCK, 'GET /api/work/site-readiness': SITE_READINESS_REPORTS },
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'Site Readiness 实施向导' })).toBeVisible(),
  },
];

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

  for (const pageCase of PAGES) {
    for (const [viewportKey, viewport] of Object.entries(VIEWPORTS)) {
      test(`${pageCase.label}/${viewportKey} 视觉基线`, async ({ page }) => {
        test.skip(!process.env.EWOH_VISUAL, '视觉回归需显式设置 EWOH_VISUAL=1');
        // 冻结页面时钟，避免 QueryState 的"更新于 HH:MM:SS"等动态时间戳导致截图不稳定。
        await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
        await page.setViewportSize(viewport);
        if (pageCase.mock) {
          await mockApi(page, pageCase.mock);
        }
        if (pageCase.role) {
          await openSession(page, baseUrl, pageCase.role, pageCase.route);
        } else {
          await page.goto(baseUrl + pageCase.route);
        }
        await pageCase.ready(page);
        await expect(page).toHaveScreenshot(`${pageCase.key}-${viewportKey}.png`);
      });
    }
  }
});