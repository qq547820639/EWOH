/* 审批控制台 · 执行边界授权视图（NO-24a）浏览器验收。
 *
 * 为什么单列：NO-22a 让"已授权"变成有时效（24 小时）、会被逐台消耗的凭证，
 * 但审批台此前只列**待批**清单——"已通过但已过期"在界面上完全不可见，
 * 只有现场真去执行时才会撞到 409。本用例钉死三件事：
 *   1. 有效授权的剩余有效期可见；
 *   2. 已过期授权**明确标注不可用**（不是隐藏、不是仍显示"有效"）；
 *   3. 用量可见（谁/何时/备注）——同一份授权被用在哪台设备上必须能追溯。
 *
 * 使用 mock 数据层（无需真实后端/数据库）；真实后端的授权读写链路由
 * `test/e2e/capability-disabled-plan-explain.mjs`（7a/7c/7d/7e）覆盖。
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { ROLES, mockApi, openSession, startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const NOW = Date.parse('2026-09-12T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const AUTHORIZATIONS = [
  {
    approvalId: 'AP-VALID',
    entityType: 'device_capability_change',
    entityId: 'capability:exo-lift',
    status: 'approved',
    createdAt: iso(NOW - 2 * 3_600_000),
    approvedAt: iso(NOW - 2 * 3_600_000),
    expiresAt: iso(NOW + 22 * 3_600_000),
    expired: false,
    remainingMs: 22 * 3_600_000,
    subject: {
      objectType: 'device_capability_change',
      objectId: 'capability:exo-lift',
      title: '恢复高风险能力：exo-lift（2 台设备）',
      summary: 'e2e：批量恢复',
      metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' },
    },
    usage: [
      {
        usageKey: 'capability:exo-lift|device:EXO-1',
        usedBy: 'admin',
        at: iso(NOW - 1 * 3_600_000),
        note: '助力模块已检修',
      },
    ],
  },
  {
    approvalId: 'AP-EXPIRED',
    entityType: 'device_capability_change',
    entityId: 'capability:crane',
    status: 'approved',
    createdAt: iso(NOW - 30 * 3_600_000),
    approvedAt: iso(NOW - 30 * 3_600_000),
    expiresAt: iso(NOW - 6 * 3_600_000),
    expired: true,
    remainingMs: 0,
    subject: {
      objectType: 'device_capability_change',
      objectId: 'capability:crane',
      title: '恢复高风险能力：crane（1 台设备）',
      summary: '上个月的检修',
      metrics: { capabilityKey: 'crane', deviceIds: 'CRANE-1' },
    },
    usage: [],
  },
  {
    approvalId: 'AP-TASK',
    entityType: 'task_capability_change',
    entityId: '00000000-0000-4000-8000-0000000000a1',
    status: 'pending',
    createdAt: iso(NOW - 600_000),
    approvedAt: null,
    expiresAt: null,
    expired: false,
    remainingMs: null,
    subject: {
      objectType: 'task_capability_change',
      objectId: '00000000-0000-4000-8000-0000000000a1',
      title: '放宽高风险能力要求：crane',
      summary: '调度员申请放宽',
      metrics: { relaxedHighRiskCapabilities: 'crane', resultingDeviceCapabilities: '' },
    },
    usage: [],
  },
];

/**
 * NO-46a：提醒治理度量（运行记忆）——有可计算样本 + 一个不可比样本 + 一个反复出现的对象。
 */
const NOTIFICATION_METRICS = {
  generatedAt: iso(NOW),
  windowDays: 30,
  minSample: 3,
  scanned: 10,
  truncated: false,
  totals: { total: 10, pending: 4, read: 2, resolved: 4, failedDelivery: 1 },
  dispositionRate: 0.4,
  medianTimeToResolveMs: 90 * 60_000,
  meanTimeToResolveMs: 2 * 3_600_000,
  comparable: 3,
  notComparable: 1,
  aging: [
    { key: 'lt1h', label: '1 小时内', count: 1 },
    { key: 'lt8h', label: '1–8 小时', count: 0 },
    { key: 'lt24h', label: '8–24 小时', count: 2 },
    { key: 'gte24h', label: '超过 24 小时', count: 1 },
    { key: 'unknown', label: '时间未记录', count: 0 },
  ],
  byKind: [
    {
      kind: 'session_overdue',
      label: '会话超时未收工',
      total: 6,
      pending: 3,
      read: 1,
      resolved: 2,
      failedDelivery: 1,
      comparable: 2,
      notComparable: 0,
      medianTimeToResolveMs: 45 * 60_000,
      meanTimeToResolveMs: 45 * 60_000,
      oldestPendingAgeMs: 30 * 3_600_000,
    },
  ],
  topSources: [
    {
      externalRef: 'exo-session:A',
      kind: 'session_overdue',
      kindLabel: '会话超时未收工',
      total: 4,
      pending: 2,
      resolved: 2,
    },
  ],
  notes: ['口径：按创建时间取最近 30 天。', '样本少于 3 条时不给比率。'],
};

function consoleMock(overrides = {}) {
  return {
    'GET /api/approvals/authorizations': AUTHORIZATIONS,
    'GET /api/approvals/pending': [],
    'GET /api/agents/approvals': [],
    'GET /api/notifications': [],
    'GET /api/notifications/metrics': NOTIFICATION_METRICS,
    'GET /api/scheduler/runs': { items: [], total: 0, page: 1, pageSize: 20 },
    ...overrides,
  };
}

test.describe('审批控制台 · 执行边界授权', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('授权时效与用量可见：有效显示剩余、已过期明确标注不可用、待批不可用', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');

    await expect(page.getByTestId('authorization-section')).toBeVisible();
    // 顶部汇总：有效/即将过期/已过期/待批 + 已消耗对象数
    await expect(page.getByRole('heading', { name: '审批控制台' })).toBeVisible();

    // 1) 有效授权：状态"有效" + 剩余有效期（不是只写"已通过"）
    const valid = page.getByTestId('authorization-AP-VALID');
    await expect(valid).toContainText('设备能力恢复');
    await expect(valid).toContainText('exo-lift');
    await expect(valid).toContainText('覆盖 2 台');
    await expect(page.getByTestId('authorization-state-AP-VALID')).toContainText('有效');
    await expect(page.getByTestId('authorization-state-AP-VALID')).toContainText('剩余');

    // 2) 用量可追溯：谁/何时/备注 + 计数
    await expect(page.getByTestId('authorization-usage-AP-VALID')).toContainText('已消耗 1 个对象');
    await expect(page.getByTestId('authorization-usage-AP-VALID')).toContainText('admin');
    await expect(page.getByTestId('authorization-usage-AP-VALID')).toContainText('助力模块已检修');

    // 3) 已过期授权：明确"不可用"，且不显示剩余有效期（避免被当成仍有效）
    await expect(page.getByTestId('authorization-state-AP-EXPIRED')).toContainText('已过期');
    await expect(page.getByTestId('authorization-state-AP-EXPIRED')).toContainText('不可用');
    await expect(page.getByTestId('authorization-usage-AP-EXPIRED')).toContainText('尚未使用');

    // 4) 待批的能力放宽也在这里可见（尚不可用），并区分为"任务能力放宽"
    await expect(page.getByTestId('authorization-AP-TASK')).toContainText('任务能力放宽');
    await expect(page.getByTestId('authorization-state-AP-TASK')).toContainText('待审批');
    await expect(page.getByTestId('authorization-state-AP-TASK')).toContainText('不可用');
  });

  test('没有授权记录 → 说明这里会出现什么（不留白）', async ({ page }) => {
    await mockApi(page, consoleMock({ 'GET /api/approvals/authorizations': [] }));
    // 角色修正（2026-09-13）：此前这里用 `ROLES.dispatcher`。但审批控制台依赖的
    // `GET /api/approvals/authorizations` 服务端只放行 global_admin/workshop_lead/
    // safety_admin —— dispatcher 打这个页面在真实后端必然 403。前端曾与后端漂移
    // （把 dispatcher 放进导航、又漏了 safety_admin），本轮已把前端对齐到后端；
    // 用例随之改用真实可访问的角色，否则它断言的是一扇**打不开的门**。
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');
    await expect(page.getByTestId('authorization-empty')).toContainText('当前没有执行边界授权记录');
  });

  test('授权视图读取失败 → 显式报错（不静默显示为空）', async ({ page }) => {
    await mockApi(
      page,
      consoleMock({
        'GET /api/approvals/authorizations': { status: 500, body: { message: 'boom' } },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');
    await expect(page.getByTestId('authorization-section')).toContainText('授权视图读取失败');
    await expect(page.getByTestId('authorization-empty')).toHaveCount(0);
  });

  test('dispatcher 无权进入审批控制台（与后端角色边界一致，不再"链到 403"）', async ({ page }) => {
    // 这是上一条注释提到的漂移的**反向断言**：前端导航一旦再把 dispatcher 放回来，
    // 这里会失败——把"前后端角色同源"变成可执行约束，而不是靠注释维持。
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.dispatcher, '/approval-console');
    await expect(page.getByRole('heading', { name: '403 无权限' })).toBeVisible();
    await expect(page.getByTestId('authorization-section')).toHaveCount(0);
  });

  /**
   * 无障碍回归（axe，serious/critical 零违规）。
   *
   * 为什么把这些页面也纳入：UX-009 只扫指挥地图族；`/exo`、`/materials`、`/reasoning`、
   * 审批台是 2026-09 新增的产品面，此前只有行为断言、没有对比度/语义/命名的机器门。
   */
  /* ── NO-44a：通知中心的"已处置"（提醒有终态，但不静默消失）────────────── */
  test('已处置通知独立展示：带处置类型/处置人/时间与指向，且投递失败不被吞掉', async ({ page }) => {
    const notifications = [
      {
        notificationId: 'NTF-PENDING-1',
        recipientType: 'role',
        recipientId: 'workshop_lead',
        channel: 'app',
        title: '外骨骼会话已超过预计结束',
        body: '会话 exo-session:S1 超过预计结束 20 分钟',
        severity: 'medium',
        status: 'pending',
        externalRef: 'exo-session:S1',
        readAt: null,
        createdAt: iso(NOW - 1_800_000),
        sentAt: null,
        errorMessage: null,
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
        resolutionRef: null,
      },
      {
        notificationId: 'NTF-RESOLVED-1',
        recipientType: 'user',
        recipientId: 'worker.zhangwei',
        channel: 'app',
        title: '佩戴人与遥测不符（需核实）',
        body: '遥测上报的佩戴人是 P-9999，而会话记录的是 P-1002',
        severity: 'high',
        status: 'resolved',
        externalRef: 'exo-session:OLD',
        readAt: null,
        createdAt: iso(NOW - 1_200_000),
        sentAt: null,
        errorMessage: null,
        resolution: 'session_corrected',
        resolvedAt: iso(NOW - 600_000),
        resolvedBy: 'lead.chen',
        resolutionRef: 'exo-session:NEW',
      },
      {
        notificationId: 'NTF-PUSH-FAILED-1',
        recipientType: 'role',
        recipientId: 'workshop_lead',
        channel: 'lark',
        title: '推送：会话超时',
        body: null,
        severity: 'high',
        status: 'failed',
        externalRef: 'exo-session:S2',
        readAt: null,
        createdAt: iso(NOW - 900_000),
        sentAt: null,
        errorMessage: 'lark_webhook_http_500',
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
        resolutionRef: null,
      },
    ];
    await mockApi(page, consoleMock({ 'GET /api/notifications': notifications }));
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');

    // 汇总行必须把"已处置"与"未读/已读"并列（否则已处置的提醒看起来像凭空消失）
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '通知中心' })).toContainText('已处置 1');

    const resolvedSection = page.getByTestId('notification-resolved');
    await expect(resolvedSection).toBeVisible();
    await expect(resolvedSection).toContainText('不需要再处理');
    const resolvedRow = page.getByTestId('notification-resolved-NTF-RESOLVED-1');
    await expect(resolvedRow).toContainText('佩戴人与遥测不符（需核实）');
    // 处置依据：类型 + 处置人 + 指向新会话
    await expect(resolvedRow).toContainText('更正');
    await expect(resolvedRow).toContainText('lead.chen');
    await expect(resolvedRow).toContainText('exo-session:NEW');
    // 已处置 ≈ 不必再处理：它不应出现在"未读"待办列表里
    await expect(page.getByText('未读 1', { exact: false })).toBeVisible();

    // 投递失败是运维事件，不能被"已处置"吞掉
    await expect(page.getByText('lark_webhook_http_500')).toBeVisible();
  });

  /* ── NO-46a：提醒治理（运行记忆）────────────────────────────────────── */
  test('提醒治理卡片：处置率/时长/账龄/反复出现对象可见，零值桶不渲染', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();

    const card = page.getByTestId('notification-governance');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('notification-governance-scope')).toContainText('最近 30 天');
    await expect(page.getByTestId('notification-governance-totals')).toContainText('已处置 4');
    await expect(page.getByTestId('notification-governance-rate')).toContainText('40%');
    await expect(page.getByTestId('notification-governance-latency')).toContainText('中位 1 小时 30 分');

    // 账龄：只渲染非零桶（"1–8 小时 0 条"这类假信息不出现）
    const aging = page.getByTestId('notification-governance-aging');
    await expect(aging).toContainText('超过 24 小时：1 条');
    await expect(aging).not.toContainText('1–8 小时');

    // 按类型 + 反复出现对象
    await expect(page.getByTestId('notification-governance-kinds')).toContainText('会话超时未收工');
    await expect(page.getByTestId('notification-governance-kinds')).toContainText('最久待办 1 天 6 小时');
    await expect(page.getByTestId('notification-governance-top-sources')).toContainText('exo-session:A');

    // 口径说明必须展示（数字要能被解释）
    await expect(page.getByTestId('notification-governance-notes')).toContainText('样本少于 3 条时不给比率');
  });

  test('提醒治理：样本不足时不显示比率（"证据不足"），绝不显示 0%', async ({ page }) => {
    await mockApi(
      page,
      consoleMock({
        'GET /api/notifications/metrics': {
          ...NOTIFICATION_METRICS,
          scanned: 2,
          dispositionRate: null,
          totals: { total: 2, pending: 1, read: 1, resolved: 0, failedDelivery: 0 },
          medianTimeToResolveMs: null,
          meanTimeToResolveMs: null,
          comparable: 0,
          notComparable: 0,
          byKind: [],
          topSources: [],
        },
      }),
    );
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');

    const rate = page.getByTestId('notification-governance-rate');
    await expect(rate).toContainText('证据不足');
    await expect(rate).not.toContainText('0%');
    await expect(page.getByTestId('notification-governance-latency')).toContainText('暂无可计算的处置时长');
  });

  test('无障碍：审批控制台（授权视图）无 serious/critical 级违规（axe）', async ({ page }) => {
    await mockApi(page, consoleMock());
    await openSession(page, server.baseUrl, ROLES.workshop_lead, '/approval-console');
    await expect(page.getByRole('heading', { name: '审批控制台' })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(
      blocking.map((v) => `${v.id}(${v.impact})×${v.nodes.length}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
    ).toEqual([]);
  });
});
