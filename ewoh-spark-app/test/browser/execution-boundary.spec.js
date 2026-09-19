/* 执行边界面板浏览器验收（NO-67a）——"这台设备为什么不动"必须能在页面上回答。
 *
 * 覆盖：
 *  1. 在飞（已投递未回执）与**排队（设备忙）**逐条区分，并显示占用者与"暂缓 ≠ 失败"；
 *  2. 授权可信度分两维显示：指纹**方案** + **是否复核**（"没验过"不得渲染成已验证）；
 *  3. 已撤回显示原因码与人话说明；违规留痕（未授权执行）单独提示为安全事件；
 *  4. 空列表显式说明"无命令 ≠ 设备正常"；读失败显式报错（不显示"一切正常"的假状态）；
 *  5. 基础无障碍不回归（axe 扫描零严重项）。
 *
 * 使用 mock 数据层（无需真实后端/数据库）；真实后台的同一读面由
 * `test/e2e/control-actuator-loop.mjs` 的 17b/17c 步覆盖（真实 PG）。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  collectA11yIssues,
  mockApi,
  openSession,
  startStaticServer,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const NOW = '2026-09-13T02:00:00.000Z';

const DEVICES = [
  {
    id: 'd-agv',
    deviceId: 'AGV-01',
    workerName: '',
    deviceModel: 'AGV-SIM',
    deviceCategory: 'agv',
    batteryPct: 88,
    online: true,
    lastTelemetryAt: NOW,
    sourceType: 'simulated',
  },
];

const BOUNDARY = {
  deviceId: 'AGV-01',
  checkedAt: NOW,
  summary: { inFlight: 1, queued: 1, awaitingDelivery: 0, revoked: 1, busyBlocker: 'dispatch_task:att-1' },
  commands: [
    {
      commandId: 'att-1',
      requestId: 'ctl-1',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'gateway_received',
      deliveryState: 'gateway_received',
      deliveryNote: null,
      sentAt: '2026-09-13T01:58:00.000Z',
      responseAt: null,
      revokedReason: null,
      revokedReasonLabel: null,
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: true,
      ack: { delivered: true, reason: null, at: '2026-09-13T01:58:10.000Z' },
      receipt: null,
      violations: [],
      executable: true,
    },
    {
      commandId: 'att-2',
      requestId: 'ctl-2',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'sent',
      deliveryState: 'queued_device_busy',
      deliveryNote: '设备正在执行 dispatch_task:att-1，本条按"一车一活"排队（暂缓 ≠ 失败）',
      sentAt: '2026-09-13T01:58:30.000Z',
      responseAt: null,
      revokedReason: null,
      revokedReasonLabel: null,
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: false,
      ack: null,
      receipt: null,
      violations: [],
      executable: true,
    },
    {
      commandId: 'att-3',
      requestId: 'ctl-3',
      commandKey: 'resume',
      attemptNo: 1,
      status: 'revoked',
      deliveryState: 'revoked',
      deliveryNote: '授权范围与命令内容不一致（请求/设备/命令/参数被改写，或签名不符）',
      sentAt: '2026-09-13T01:57:00.000Z',
      responseAt: null,
      revokedReason: 'fingerprint_mismatch',
      revokedReasonLabel: '授权范围与命令内容不一致（请求/设备/命令/参数被改写，或签名不符）',
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: false,
      ack: null,
      receipt: null,
      violations: [
        { resultType: 'delivery_rejected', resultCode: 'fingerprint_mismatch', at: '2026-09-13T01:57:05.000Z' },
      ],
      executable: false,
    },
    {
      commandId: 'att-4',
      requestId: 'ctl-4',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'executed',
      deliveryState: 'executed',
      deliveryNote: null,
      sentAt: '2026-09-13T01:50:00.000Z',
      responseAt: '2026-09-13T01:52:00.000Z',
      revokedReason: null,
      revokedReasonLabel: null,
      fingerprintScheme: 'fnv1a64:v1',
      fingerprintVerified: true,
      ack: { delivered: true, reason: null, at: '2026-09-13T01:50:10.000Z' },
      receipt: { result: 'executed', at: '2026-09-13T01:52:00.000Z' },
      violations: [
        { resultType: 'authorization_violation', resultCode: 'unauthorized_execution', at: '2026-09-13T01:52:01.000Z' },
      ],
      executable: false,
    },
  ],
};

function baseMock(overrides = {}) {
  return {
    'GET /api/dashboard/devices': DEVICES,
    'GET /api/device-responsibilities': [],
    'GET /api/personnel': [],
    'GET /api/shifts': [],
    'GET /api/dashboard/overview': {
      deviceTotal: 1, deviceOnline: 1, eventOpen: 0, eventCritical: 0, avgLoad: 0.3, workerCount: 0,
    },
    'GET /api/dashboard/events': [],
    'GET /api/spatial/entities': [],
    'GET /api/devices/AGV-01': { ...DEVICES[0], capabilities: [] },
    'GET /api/dashboard/devices/AGV-01/bindings': {
      deviceId: 'AGV-01', spatialEntityId: null, boundPersonId: null, hierarchyPath: [],
    },
    // 执行边界读面（NO-66a）：路径匹配忽略 query，与生产路由 `/api/control/requests?deviceId=`
    // 同路径 → mock 键与生产一致，避免"测了一个不存在的路由"。
    'GET /api/control/requests': BOUNDARY,
    ...overrides,
  };
}

async function openBoundary(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.device_ops, '/devices');
  await expect(page.getByRole('heading', { name: '设备态势总览' })).toBeVisible();
  await page
    .locator('tr')
    .filter({ has: page.getByTestId('device-category-AGV-01') })
    .getByRole('button', { name: '编辑' })
    .click();
  // 执行边界在向导第 3 步「状态历史」（运行状态，不是绑定配置）。
  // 只等"这一步已经渲染"（时间线标题），**不**预设面板一定成功——
  // 失败态/空态是不同容器，断言交给各用例（否则错误态用例永远等不到 panel）。
  await page.getByRole('tab', { name: /状态历史/ }).click();
  await expect(page.getByText('状态历史 / 时间线')).toBeVisible();
}

/** 成功态：等面板出现（供正常数据的用例使用）。 */
async function expectBoundaryPanel(page) {
  await expect(page.getByTestId('execution-boundary-panel')).toBeVisible();
}

test.describe('执行边界面板（NO-67a）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('在飞 / 排队（设备忙）/ 已撤回逐条区分，并显示占用者与"暂缓 ≠ 失败"', async ({ page }) => {
    await openBoundary(page, server.baseUrl, baseMock());
    await expectBoundaryPanel(page);

    await expect(page.getByText('在飞 1')).toBeVisible();
    await expect(page.getByText('排队 1')).toBeVisible();
    await expect(page.getByText('已撤回 1')).toBeVisible();
    await expect(page.getByText('已投递未回执')).toBeVisible();
    await expect(page.getByText('排队（设备忙）')).toBeVisible();
    // 占用者 + 暂缓语义（不能让人以为那条命令失败了）
    // 注意：摘要与逐条说明都会提到"设备正在执行"，必须**分别在各自容器内**断言，
    // 否则 getByText 会 strict-mode 命中多个元素（Playwright 会直接报错而不是"通过"）。
    await expect(page.getByTestId('execution-boundary-panel').getByText(/设备正在执行/).first()).toBeVisible();
    await expect(page.getByTestId('execution-boundary-panel').getByText(/一车一活/).first()).toBeVisible();
    await expect(
      page.getByTestId('execution-boundary-commands').getByText(/暂缓 ≠ 失败/).first(),
    ).toBeVisible();
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('授权可信度分两维：指纹方案 + 是否复核（"没验过"不得显示成已验证）', async ({ page }) => {
    await openBoundary(page, server.baseUrl, baseMock());
    await expectBoundaryPanel(page);

    const panel = page.getByTestId('execution-boundary-panel');
    // 同一文案可能在多条命令上出现（att-1 已验签、att-2/att-3 未验签）→ 用 count 断言**分布**，
    // 这比"至少出现一次"更严格：必须两种状态都存在，且不得互相冒充。
    await expect(panel.getByText('签名指纹已验签（HMAC-SHA256）')).toHaveCount(1);
    await expect(panel.getByText('签名指纹未验签')).toHaveCount(2);
    await expect(panel.getByText('一致性指纹已核对（无密钥）')).toHaveCount(1);
  });

  test('撤回原因码 + 人话说明；未授权执行单独提示为安全事件', async ({ page }) => {
    await openBoundary(page, server.baseUrl, baseMock());
    await expectBoundaryPanel(page);

    const panel = page.getByTestId('execution-boundary-panel');
    await expect(panel.getByText(/授权范围与命令内容不一致/).first()).toBeVisible();
    await expect(panel.getByText('投递被拒并撤回（fingerprint_mismatch）')).toHaveCount(1);
    // 未授权执行不与"执行失败"混档：单独文案 + 处置指引
    await expect(panel.getByText(/未授权执行（unauthorized_execution）/, { exact: false })).toHaveCount(1);
    await expect(panel.getByText(/按安全事件处置/)).toHaveCount(1);
  });

  test('NO-68a：投递积压（超 SLA）在面板上直接可见（没人看时也能被问出来）', async ({ page }) => {
    await openBoundary(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/control/requests': {
          ...BOUNDARY,
          summary: { ...BOUNDARY.summary, overdue: 2, oldestWaitingMs: 12 * 60_000, deliverySlaMs: 5 * 60_000 },
        },
      }),
    );
    await expectBoundaryPanel(page);

    await expect(page.getByText('投递积压 2 条')).toBeVisible();
    await expect(page.getByText(/最久等待 12 分钟/)).toBeVisible();
    await expect(page.getByText(/超过 SLA 5 分钟/)).toBeVisible();
  });

  test('NO-70a：配额用尽时配额徽章显示排队语义（不是失败）', async ({ page }) => {
    await openBoundary(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/control/requests': {
          ...BOUNDARY,
          summary: {
            ...BOUNDARY.summary,
            quota: { perMinute: 3, usedInWindow: 3, remaining: 0, motionPerMinute: 3, motionUsedInWindow: 3, motionRemaining: 0 },
          },
        },
      }),
    );
    await expectBoundaryPanel(page);

    await expect(page.getByText(/窗口内已投 3 \/ 上限 3 每分钟/)).toBeVisible();
    await expect(page.getByText(/命令排队到下一分钟，不是失败/)).toBeVisible();
  });

  test('空列表显式说明"无命令 ≠ 设备正常"（不显示假状态）', async ({ page }) => {
    await openBoundary(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/control/requests': {
          ...BOUNDARY,
          commands: [],
          summary: { inFlight: 0, queued: 0, awaitingDelivery: 0, revoked: 0, busyBlocker: null },
        },
      }),
    );

    await expectBoundaryPanel(page);
    await expect(page.getByTestId('execution-boundary-empty')).toContainText('该设备当前没有控制命令记录');
    await expect(page.getByTestId('execution-boundary-empty')).toContainText('无命令 ≠ 设备正常');
  });

  test('读面失败显式报错（不显示"一切正常"的假状态）', async ({ page }) => {
    await openBoundary(
      page,
      server.baseUrl,
      baseMock({
        'GET /api/control/requests': () => ({ status: 500, body: { message: 'boom' } }),
      }),
    );

    await expect(page.getByTestId('execution-boundary-error')).toBeVisible();
    await expect(page.getByTestId('execution-boundary-error')).toContainText('执行边界读取失败');
    await expect(page.getByTestId('execution-boundary-panel')).toHaveCount(0);
  });
});
