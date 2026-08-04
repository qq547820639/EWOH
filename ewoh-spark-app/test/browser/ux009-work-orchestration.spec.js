/**
 * UX-009 端到端体验测试矩阵 —— 执行控制台业务域。
 *
 * 覆盖：Gate 批准/条件批准/驳回/撤销、Handoff 创建/接收/未决项、Git Sync 批量 Dry Run/批准/冲突、
 *       Site Readiness 向导。
 * 断言验证最终用户可见状态（门禁决定、影响预览、交接状态、同步结果、场地就绪阶段），
 *      而非仅 HTTP 状态码。
 *
 * 说明：Gate 撤销在后端为 TODO（前端点击提示「撤销功能待后端支持」），故撤销用例断言用户可见的提示文案。
 *
 * 运行方式：`npm run test:browser:ux009 -- --grep "UX-009/WorkOrchestration"`
 * 依赖：`dist/client` 构建产物已存在。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const OVERVIEW_WRITABLE = {
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

// 门禁影响预览由 GatesPanel 基于「图节点 + 边」反向传播计算（downstreamCount(gateId)）。
// 因此 mock 图必须包含门禁节点 G-1，并有一条指向下游节点的边，使「影响 1 个下游节点」成立。
const GRAPH_MOCK = {
  generatedAt: new Date().toISOString(),
  items: [
    { id: 'G-1', title: '试点范围确认', type: 'gate', status: 'requires_approval', actor: 'AG-00' },
    { id: 'WI-1', title: '任务1', type: 'workitem', status: 'in_progress', actor: 'AG-00' },
  ],
  edges: [{ from: 'G-1', to: 'WI-1' }],
  evidence: [],
  gates: [],
  conflicts: [],
};

const GATES_MOCK = [
  {
    gateId: 'G-1',
    title: '试点范围确认',
    calculatedStatus: 'requires_approval',
    humanDecision: null,
    conditions: ['试点范围已确认'],
    approver: null,
    decidedAt: null,
  },
];

test.describe('UX-009/WorkOrchestration', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('Gate 批准：门禁面板展示规则状态与影响预览，批准后回显人工决定', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/graph': GRAPH_MOCK,
      'GET /api/work/gates': GATES_MOCK,
      'POST /api/work/gates/G-1/decision': () => ({
        gateId: 'G-1',
        humanDecision: 'approved',
      }),
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=gates');
    await expect(page.locator('h1')).toHaveText('执行控制台');
    // 影响预览是用户可见状态（WI-2 在 G-1 下游）
    await expect(page.locator('text=影响 1 个下游节点')).toBeVisible();

    // 批准（默认 approved）。getByRole name 默认子串匹配，会同时命中头部「批量记录 1」按钮；
    // 用 exact:true 精确匹配行内「记录」按钮，打开单条门禁确认对话框。
    await page.getByRole('button', { name: '记录', exact: true }).click();
    await expect(page.locator('text=确认记录门禁决定')).toBeVisible();
    await page.getByRole('button', { name: '确认记录' }).click();
    await expect(page.locator('text=已记录 G-1 的决定')).toBeVisible();
  });

  test('Gate 条件批准：选择条件批准并提交，回显用户可见决定', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/graph': GRAPH_MOCK,
      'GET /api/work/gates': GATES_MOCK,
      'POST /api/work/gates/G-1/decision': () => ({
        gateId: 'G-1',
        humanDecision: 'conditional',
      }),
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=gates');
    // 选择「条件批准」（定位到该门禁行的下拉，而非头部批量下拉）
    await page.locator('tbody tr').first().locator('select').selectOption('conditional');
    await page.getByRole('button', { name: '记录', exact: true }).click();
    await expect(page.locator('text=确认记录门禁决定')).toBeVisible();
    await expect(page.locator('text=对 G-1 执行「条件批准」')).toBeVisible();
    await page.getByRole('button', { name: '确认记录' }).click();
    await expect(page.locator('text=已记录 G-1 的决定')).toBeVisible();
  });

  test('Gate 驳回：选择驳回并提交，回显用户可见决定', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/graph': GRAPH_MOCK,
      'GET /api/work/gates': GATES_MOCK,
      'POST /api/work/gates/G-1/decision': () => ({
        gateId: 'G-1',
        humanDecision: 'rejected',
      }),
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=gates');
    await page.locator('tbody tr').first().locator('select').selectOption('rejected');
    await page.getByRole('button', { name: '记录', exact: true }).click();
    await expect(page.locator('text=对 G-1 执行「驳回」')).toBeVisible();
    await page.getByRole('button', { name: '确认记录' }).click();
    await expect(page.locator('text=已记录 G-1 的决定')).toBeVisible();
  });

  test('Gate 撤销：点击撤销展示「待后端支持」用户可见提示（后端 TODO）', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/graph': GRAPH_MOCK,
      'GET /api/work/gates': GATES_MOCK,
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=gates');
    await page.getByRole('button', { name: '撤销' }).first().click();
    await expect(page.locator('text=撤销功能待后端支持：需新增 gate 撤销/回滚 API（TODO）')).toBeVisible();
  });

  test('Handoff 创建：填写交接并登记，确认后回显用户可见的交接提示', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/handoffs': [],
      'POST /api/work/handoffs': () => ({
        handoffId: 'H-1',
        fromActor: 'AG-00',
        toActor: 'AG-01',
        scope: '工序交接',
        status: 'open',
        createdAt: new Date().toISOString(),
      }),
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=handoffs');
    await expect(page.locator('h2', { hasText: '交接记录' })).toBeVisible();
    // 填表
    await page.getByPlaceholder('接收 Agent').fill('AG-01');
    await page.getByPlaceholder('交接范围').fill('工序交接');
    await page.getByPlaceholder('验收标准').fill('验收通过');
    await page.getByRole('button', { name: '登记交接' }).click();
    await expect(page.locator('text=确认登记交接')).toBeVisible();
    await page.getByRole('button', { name: '确认登记' }).click();
    await expect(page.locator('text=交接已登记')).toBeVisible();
  });

  test('Handoff 接收：未决项展示「接收」动作，接收后回显用户可见状态', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/handoffs': [
        {
          handoffId: 'H-2',
          fromActor: 'AG-00',
          toActor: 'AG-01',
          scope: '设备交接',
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      ],
      'POST /api/work/handoffs/H-2/state': () => ({
        handoffId: 'H-2',
        status: 'accepted',
      }),
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=handoffs');
    // 未决项（open）展示接收动作
    await expect(page.getByRole('button', { name: '接收' })).toBeVisible();
    await page.getByRole('button', { name: '接收' }).click();
    await expect(page.locator('text=确认交接状态')).toBeVisible();
    await page.getByRole('button', { name: '确认' }).click();
    await expect(page.locator('text=交接状态已更新')).toBeVisible();
  });

  test('Git Sync：Dry Run 变更预览与统一时间线渲染，批准后应用同步计划', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/graph': GRAPH_MOCK,
      'GET /api/work/git-sync': {
        schema: '1',
        generatedAt: new Date().toISOString(),
        repository: 'org/repo',
        branch: 'main',
        headSha: 'abc123def456',
        itemCount: 1,
        trackedCount: 1,
        missingCount: 0,
        status: 'ready',
        source: 'local',
        items: [
          {
            workItemId: 'WI-1',
            title: '任务1',
            type: 'workitem',
            owner: 'AG-00',
            status: 'in_progress',
            issueNumber: 5,
            prNumber: null,
            branch: 'main',
            commitSha: 'abc123def456',
            state: 'in_progress',
            missing: false,
          },
        ],
      },
      'POST /api/work/git-sync/apply': () => ({ ok: true }),
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=git-sync');
    await expect(page.locator('h2', { hasText: 'GitHub Issue/PR 同步' })).toBeVisible();
    // Dry Run 变更预览（用户可见）
    await expect(page.getByRole('heading', { name: 'Dry Run 变更预览' })).toBeVisible();
    // 统一时间线
    await expect(page.locator('text=统一时间线')).toBeVisible();
    // 批准后应用同步计划
    await page.getByRole('button', { name: '应用同步计划' }).click();
    await expect(page.locator('text=应用 Git 同步计划')).toBeVisible();
    await page.getByRole('button', { name: '确认应用' }).click();
    await expect(page.locator('text=Git 同步计划已应用')).toBeVisible();
  });

  test('Git Sync：冲突检测展示本地/服务端差异（用户可见）', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/graph': GRAPH_MOCK,
      'GET /api/work/git-sync': {
        schema: '1',
        generatedAt: new Date().toISOString(),
        repository: 'org/repo',
        branch: 'main',
        headSha: 'abc123def456',
        itemCount: 1,
        trackedCount: 1,
        missingCount: 0,
        status: 'ready',
        source: 'local',
        items: [
          {
            workItemId: 'WI-1',
            title: '任务1',
            type: 'workitem',
            owner: 'AG-00',
            status: 'in_progress',
            issueNumber: 5,
            prNumber: null,
            branch: 'main',
            commitSha: 'abc123def456',
            state: 'in_progress',
            missing: false,
          },
        ],
      },
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=git-sync');
    await expect(page.getByRole('heading', { name: '冲突检测' })).toBeVisible();
  });

  test('Site Readiness：向导展示 F0-F6 阶段与场地就绪检查项', async ({ page }) => {
    await mockApi(page, {
      'GET /api/work/overview': OVERVIEW_WRITABLE,
      'GET /api/work/site-readiness': [
        {
          sourcePath: 'output/site-readiness.json',
          example: true,
          factoryName: '示例工厂',
          ready: false,
          requiredCount: 1,
          requiredPassed: 0,
        },
      ],
    });
    await openSession(page, baseUrl, ROLES.global_admin, '/work-orchestration?tab=site-readiness');
    // 向导阶段标题（用户可见）。F0-F6 Stepper 每个阶段渲染为「F0 · 环境准备」按钮；
    // 同时当前阶段详情区也渲染「F0 · 环境准备」，故用 getByRole('button') 精确匹配 Stepper 按钮，避免 strict 复用冲突。
    await expect(page.getByRole('button', { name: 'F0 · 环境准备' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'F1 · 工具与依赖' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'F3 · 映射与导入' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'F6 · 上线与交接' })).toBeVisible();
  });
});