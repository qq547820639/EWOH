/* 分波派工（部分执行）浏览器验收。
 *
 * 只验证与"不可逆操作安全 + 后果可读"直接相关的行为：
 *  1. 批量确认必须**声明条数**，并写明派发后剩余；
 *  2. 覆盖全部剩余时必须告知方案进入终态、之后不能再加波；
 *  3. 部分波必须说明方案保持已审批、仍可继续分波；
 *  4. 不可派工的项（已提交）必须标出并禁止勾选，而不是隐藏；
 *  5. 未选任何任务时不给出可点击的派发入口（无"确定/OK"式按钮）；
 *  6. 服务端整波拒绝时如实说明"未产生任何派发"；
 *  7. 非授权角色不渲染派工入口。
 *
 * mock 数据层（无需真实后端）。
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

/**
 * 方案行 fixture：必须覆盖页面视图模型真正读取的字段。
 * 缺 `trigger` 会让行构建读取 `row.trigger.type` 时崩溃（页面变成"加载失败"）——
 * 第一版正是如此，因此这里按 render 测试的 canonical 形状构造。
 */
function planRow(over = {}) {
  return {
    planId: 'PLAN-WAVE-1',
    planName: '准时优先',
    status: 'approved',
    version: 1,
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-1',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    metrics: { lateMinutes: 10, walkingMeters: 100, stationWaitMinutes: 5, maxWorkload: 0.5, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    assignments: [],
    createdAt: '2026-09-10T08:00:00.000Z',
    ...over,
  };
}

function assignment(n, status = 'approved') {
  return {
    assignmentId: `ASG-${n}`,
    planId: 'PLAN-WAVE-1',
    taskId: `TASK-${n}`,
    personId: `p${n}`,
    deviceId: null,
    stationId: `s${n}`,
    status,
    reasons: [],
    plannedStart: iso(30 * 60 * 1000),
    plannedEnd: iso(90 * 60 * 1000),
  };
}

function handlers({ detail, dispatchResponse } = {}) {
  return {
    'GET /api/dashboard/overview': {
      deviceTotal: 1, deviceOnline: 1, eventOpen: 0, eventCritical: 0, avgLoad: 0.2, workerCount: 1,
    },
    'GET /api/dashboard/events': { items: [], total: 0 },
    'GET /api/scheduler/active-plans': [planRow()],
    'GET /api/scheduler/plans/PLAN-WAVE-1': detail ?? planRow({ assignments: [assignment(1), assignment(2), assignment(3)] }),
    'POST /api/scheduler/plans/PLAN-WAVE-1/dispatch': dispatchResponse ?? {
      ...planRow({ status: 'approved' }),
      dispatch: {
        planStatus: 'approved',
        dispatchedAssignmentIds: ['ASG-1'],
        remainingAssignmentIds: ['ASG-2', 'ASG-3'],
        remainingAssignments: 2,
        dispatchedAssignments: 1,
      },
    },
    'GET /api/exo/sessions': { sessions: [] },
  };
}

async function openScheduling(page, baseUrl, role, h) {
  await mockApi(page, h);
  await openSession(page, baseUrl, role, '/scheduling');
  await expect(page.getByRole('heading', { name: '生产调度中心' })).toBeVisible();
}

test.describe('Scheduling 分波派工', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('未选任务时不给可点击派发入口（安全默认，无确定/OK）', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers());

    const button = page.getByTestId('wave-dispatch-PLAN-WAVE-1');
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toContainText('请选择要派发的任务');
    await expect(page.getByRole('button', { name: /^(确定|确认|OK)$/ })).toHaveCount(0);
    expect(await collectA11yIssues(page)).toEqual([]);
  });

  test('部分波确认：声明条数 + 剩余 + 保持已审批 + 不可逆', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers());

    await page.getByRole('checkbox', { name: '选择 TASK-1' }).check();
    await expect(page.getByTestId('wave-selected-count-PLAN-WAVE-1')).toContainText('已选 1 条');
    await page.getByTestId('wave-dispatch-PLAN-WAVE-1').click();

    const consequence = page.getByTestId('wave-consequence-PLAN-WAVE-1');
    await expect(consequence).toContainText('本波派发 1 条');
    await expect(consequence).toContainText('仍有 2 条待派工');
    await expect(consequence).toContainText('未进入终态');
    await expect(consequence).toContainText('没有取消派工的接口');
    // 主按钮用真实动词
    await expect(page.getByTestId('wave-confirm-submit-PLAN-WAVE-1')).toContainText('派发 1 条');
  });

  test('覆盖全部剩余：告知进入终态且不能再追加波次', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers());

    await page.getByRole('button', { name: '全选待派工' }).click();
    await expect(page.getByTestId('wave-selected-count-PLAN-WAVE-1')).toContainText('已选 3 条');
    await page.getByTestId('wave-dispatch-PLAN-WAVE-1').click();

    const consequence = page.getByTestId('wave-consequence-PLAN-WAVE-1');
    await expect(consequence).toContainText('派完全部 3 条待派工任务');
    await expect(consequence).toContainText('进入终态');
    await expect(consequence).toContainText('不能再追加波次');
    await expect(page.getByTestId('wave-confirm-submit-PLAN-WAVE-1')).toContainText('派完全部 3 条');
  });

  test('派发成功：显示本波结果与剩余，并说明仍可继续分波', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers());

    await page.getByRole('checkbox', { name: '选择 TASK-1' }).check();
    await page.getByTestId('wave-dispatch-PLAN-WAVE-1').click();
    await page.getByTestId('wave-confirm-submit-PLAN-WAVE-1').click();

    const result = page.getByTestId('wave-result-PLAN-WAVE-1');
    await expect(result).toContainText('本波已派发 1 条');
    await expect(result).toContainText('剩余 2 条');
    await expect(result).toContainText('可继续分波派发');
  });

  test('已提交的项标出且不可勾选（不隐藏事实）', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers({
      detail: planRow({ assignments: [assignment(1, 'dispatched'), assignment(2, 'approved')] }),
    }));

    await expect(page.getByText('已提交，不可再派')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '选择 TASK-1' })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: '选择 TASK-2' })).toBeEnabled();
  });

  test('服务端整波拒绝：如实说明未产生任何派发', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers({
      dispatchResponse: {
        status: 409,
        body: { error: { message: 'DISPATCH_WAVE_INVALID: 1 assignment(s) 不在本方案待派工集合内' } },
      },
    }));

    await page.getByRole('checkbox', { name: '选择 TASK-1' }).check();
    await page.getByTestId('wave-dispatch-PLAN-WAVE-1').click();
    await page.getByTestId('wave-confirm-submit-PLAN-WAVE-1').click();

    const notice = page.getByTestId('wave-notice-PLAN-WAVE-1');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('未产生任何派发');
    await expect(notice).toContainText('DISPATCH_WAVE_INVALID');
  });

  test('无待派工任务：明确说明，不给派工入口', async ({ page }) => {
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, handlers({
      detail: planRow({ assignments: [assignment(1, 'dispatched')] }),
    }));

    await expect(page.getByTestId('wave-no-pending-PLAN-WAVE-1')).toContainText('没有待派工任务');
    await expect(page.getByTestId('wave-dispatch-PLAN-WAVE-1')).toHaveCount(0);
  });

  test('非"已审批"方案不渲染派工入口（shadow 不可派工、终态无待派工项）', async ({ page }) => {
    // 说明：本页导航角色本就只有 dispatcher/workshop_lead（worker 连页面都进不来，
    // 属页面级 RBAC，已由其它用例覆盖）。因此这里验证的是**面板自身**的门禁：
    // 只有 approved 方案才提供分波派工入口。
    await openScheduling(page, server.baseUrl, ROLES.dispatcher, {
      ...handlers(),
      'GET /api/scheduler/active-plans': [planRow(), planRow({ planId: 'PLAN-SHADOW', status: 'shadow' })],
      'GET /api/scheduler/plans/PLAN-SHADOW': planRow({
        planId: 'PLAN-SHADOW', status: 'shadow', assignments: [assignment(9, 'proposed')],
      }),
    });
    await expect(page.getByTestId('wave-dispatch-PLAN-WAVE-1')).toBeVisible();
    await expect(page.getByTestId('wave-dispatch-PLAN-SHADOW')).toHaveCount(0);
  });
});
