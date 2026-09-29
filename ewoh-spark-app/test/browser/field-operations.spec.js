/* 现场作业台（/field-operations）浏览器验收。
 *
 * 只验证**安全与可信度相关**的行为，不做外观回归：
 *  1. 账号未绑定业务人员时，绝不推断"你的任务"——猜测会把他人待办显示给当前用户；
 *  2. 提醒必须带来源与新鲜度；数据过期时停止给出待办结论，而不是拿旧数据当现值；
 *  3. 页面不提供任何设备控制入口（外骨骼安全控制在控制器本地，平台不代理）；
 *  4. 无障碍基线：无 axe 违规。
 *
 * 使用 mock 数据层（无需真实后端/数据库），与 factory-operations-receipt.spec.js 同构。
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

const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function execution(overrides = {}) {
  return {
    executionId: 'exec-field-1',
    runId: 'run-1',
    planId: 'plan-field-1',
    assignmentId: 'assignment-field-1',
    taskId: 'task-field-1',
    personId: 'person-1',
    deviceId: null,
    stationId: 'station-1',
    plannedStartAt: iso(-30 * 60 * 1000), // 30 分钟前应开工 → 逾期
    plannedEndAt: iso(30 * 60 * 1000),
    actualStartAt: null,
    actualEndAt: null,
    plannedTravelMs: null,
    actualTravelMs: null,
    plannedDistanceM: null,
    actualDistanceM: null,
    plannedWaitingMs: null,
    actualWaitingMs: null,
    status: 'DISPATCHED',
    deviationType: 'NONE',
    deviationReason: null,
    snapshotVersion: 'snapshot-1',
    policyVersion: 1,
    solverVersion: 'solver-1',
    source: 'dispatch',
    createdAt: iso(-60 * 60 * 1000),
    updatedAt: iso(-60 * 1000),
    ...overrides,
  };
}

const baseMock = {
  'GET /api/scheduler/field/my-work': { personId: 'person-1', executions: [], total: 0 },
  'GET /api/dashboard/overview': {
    deviceTotal: 1, deviceOnline: 1, eventOpen: 0, eventCritical: 0, avgLoad: 0.2, workerCount: 1,
  },
  'GET /api/dashboard/events': { items: [], total: 0 },
  'GET /api/scheduler/active-plans': [],
  'GET /api/exo/sessions': { sessions: [] },
};

/**
 * 注入带 personId 的会话（默认 fixture 的账号没有业务人员绑定）。
 *
 * 必须用 addInitScript 的**参数**通道传值：init 脚本会被序列化后注入页面，
 * 闭包无法跨边界；若在脚本里读一个从未传入的 arg，会抛错并留下一个"已注入"
 * 标记却没有身份——表现为登录态缺失（403），而不是脚本报错。第一版正是如此。
 */
async function openField(page, baseUrl, role, handlers, personId) {
  await mockApi(page, handlers);
  if (personId) {
    await page.addInitScript((arg) => {
      if (window.sessionStorage.getItem('ewoh_session_injected')) return;
      window.sessionStorage.setItem('ewoh_session_injected', '1');
      window.sessionStorage.setItem('ewoh_access_token', 'fake-access-token');
      window.sessionStorage.setItem('ewoh_auth_user', JSON.stringify({
        userId: arg.userId, username: arg.username, roles: arg.roles,
        orgId: 'default-factory', personId: arg.personId,
      }));
    }, { ...role, personId });
  }
  await openSession(page, baseUrl, role, '/field-operations');
  await expect(page.getByRole('heading', { name: '现场作业台' })).toBeVisible();
}

test.describe('FieldOperations 现场作业台', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('账号未绑定业务人员：明确告知且不推断任务列表', async ({ page }) => {
    await openField(page, server.baseUrl, ROLES.worker, {
      ...baseMock,
      // 即使库里存在属于某人的逾期任务，未绑定账号也不得据此渲染"你的待办"
      'GET /api/scheduler/field/my-work': { personId: 'person-1', executions: [execution()], total: 1 },
    });

    await expect(page.getByText('当前账号未绑定业务人员')).toBeVisible();
    await expect(page.getByTestId('field-reminder-ASSIGNMENT_OVERDUE')).toHaveCount(0);
    await expect(page.getByTestId('field-reminder-ASSIGNMENT_START_DUE')).toHaveCount(0);
    // 未绑定身份时页面明确说明"不推断你的任务"，而不是显示空提醒列表。
    await expect(page.getByText('账号未绑定业务人员，本页不推断你的任务，因此不显示提醒。')).toBeVisible();
    await expect(page.getByText('当前没有需要现场处理的提醒。')).toHaveCount(0);
    // 本班概览也不呈现：0 值卡片会被误读成"我没有任务"。
    await expect(page.getByTestId('field-summary-待开工')).toHaveCount(0);
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('已绑定人员 + 逾期派工：提醒带来源与新鲜度，并给出关联对象', async ({ page }) => {
    await openField(page, server.baseUrl, ROLES.worker, {
      ...baseMock,
      'GET /api/scheduler/field/my-work': { personId: 'person-1', executions: [execution()], total: 1 },
    }, 'person-1');

    await expect(page.getByText('已识别业务人员：')).toBeVisible();
    const overdue = page.getByTestId('field-reminder-ASSIGNMENT_OVERDUE');
    await expect(overdue).toBeVisible();
    await expect(overdue.getByTestId('reminder-origin')).toHaveText('GET /api/scheduler/field/my-work');
    await expect(overdue.getByText('数据新鲜')).toBeVisible();
    await expect(overdue.getByText('已逾期')).toBeVisible();
    await expect(overdue.getByText('查看方案 plan-field-1')).toBeVisible();
    // 未绑定外骨骼会话 → 提示未绑定（不断言设备故障）
    await expect(page.getByTestId('field-reminder-EXO_SESSION_UNBOUND')).toBeVisible();
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('执行记录不可用：不当作过期，显式告警并暂停待办推断', async ({ page }) => {
    await openField(page, server.baseUrl, ROLES.worker, {
      ...baseMock,
      'GET /api/scheduler/field/my-work': { status: 503, body: { message: '执行记录服务暂不可用' } },
    }, 'person-1');

    await expect(page.getByRole('alert').filter({ hasText: '执行记录获取失败' })).toBeVisible();
    await expect(page.getByTestId('field-reminder-FIELD_DATA_NOT_READY')).toBeVisible();
    await expect(page.getByTestId('field-reminder-ASSIGNMENT_OVERDUE')).toHaveCount(0);
  });

  test('外骨骼会话获取失败：说明"绑定状态未知"，不当作未绑定结论', async ({ page }) => {
    await openField(page, server.baseUrl, ROLES.worker, {
      ...baseMock,
      'GET /api/scheduler/field/my-work': { personId: 'person-1', executions: [], total: 0 },
      'GET /api/exo/sessions': { status: 503, body: { message: '会话服务暂不可用' } },
    }, 'person-1');

    await expect(page.getByRole('alert').filter({ hasText: '外骨骼会话获取失败' })).toBeVisible();
    // 会话未知时不得输出"未绑定"这一确定结论（读不到 ≠ 没绑定）
    await expect(page.getByTestId('field-reminder-EXO_SESSION_UNBOUND')).toHaveCount(0);
    await expect(page.getByTestId('field-reminder-EXO_SESSION_STALE')).toHaveCount(0);
  });

  test('页面不提供任何设备控制入口（外骨骼安全控制留在控制器本地）', async ({ page }) => {
    await openField(page, server.baseUrl, ROLES.worker, {
      ...baseMock,
      'GET /api/scheduler/field/my-work': { personId: 'person-1', executions: [execution({ status: 'STARTED', actualStartAt: iso(-10 * 60 * 1000) })], total: 1 },
    }, 'person-1');

    await expect(page.getByRole('button', { name: /关节|力矩|助力|限速|急停|复位|校准/ })).toHaveCount(0);
    const boundary = page.getByText('执行边界');
    await expect(boundary).toBeVisible();
    await expect(page.getByText('不下发', { exact: false })).toBeVisible();
  });

  test('现场回执面板默认收起；展开后由现场端点数据渲染，且不依赖全厂执行台账', async ({ page }) => {
    const requested = [];
    page.on('request', (req) => { if (req.url().includes('/api/scheduler/')) requested.push(req.url()); });
    await openField(page, server.baseUrl, ROLES.worker, {
      ...baseMock,
      'GET /api/scheduler/field/my-work': {
        personId: 'person-1',
        executions: [execution({ status: 'STARTED', actualStartAt: iso(-10 * 60 * 1000) })],
        total: 1,
      },
    }, 'person-1');

    // 默认收起：回执行不渲染
    await expect(page.getByTestId('execution-receipt-assignment-field-1')).toHaveCount(0);
    await page.getByRole('button', { name: '打开回执面板' }).click();
    await expect(page.getByTestId('execution-receipt-assignment-field-1')).toBeVisible();
    // 关键：worker 视角不得请求全厂执行台账（该端点对 worker 是 403）
    expect(requested.some((u) => /\/api\/scheduler\/executions(\?|$)/.test(u))).toBe(false);
  });
});
