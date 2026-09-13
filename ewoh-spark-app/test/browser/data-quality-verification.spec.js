/* 待核实数据提醒（是否真的叫到了人）浏览器验收 —— NO-53a。
 *
 * 摄入侧开 `DataQualityAlert` 之后最容易被糊弄过去的一环：
 * 告警"可见"不等于"有人被叫到"。覆盖：
 *  1. 谁被叫到 / 等了多久 / 未处置条数逐条可见；
 *  2. 同一告警的多个收件人合并成一行（不重复刷屏）；
 *  3. 投递失败显式提示，并写明"不能视为已经叫到人"；
 *  4. 已读未处置仍然出现在待办里（read ≠ resolved）；
 *  5. 无提醒时显式空态（"无提醒 ≠ 数据可信"）；
 *  6. 读取失败显式报错，绝不显示成"已经叫到人"；
 *  7. 核实判定由人做出：确认可信/质疑分别 POST confirmed|contested，且回写源告警事件号。
 *
 * mock 数据层；真实后端版本由 test/e2e/data-quality-notification-leg.mjs 覆盖。
 */
const { test, expect } = require('@playwright/test');
const { ROLES, mockApi, openSession, startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const NOW = '2026-09-12T10:00:00.000Z';
/** 页面用浏览器真实时钟算"等了多久"：夹具必须相对当前时间，否则会走"时钟异常"分支。 */
const HOURS_AGO = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

const SHIFTS = [
  { shiftId: 'SHIFT-DAY', name: '白班', code: 'A', startTime: '08:00', endTime: '20:00', crossesMidnight: false, active: true },
];

function dqNotification(partial) {
  return {
    notificationId: 'NTF-DQ-EVT-DQ-1-quality_alert-role-workshop_lead-app',
    recipientType: 'role',
    recipientId: 'workshop_lead',
    channel: 'app',
    title: '数据质量待核实',
    body: '编号 CLOCK_DRIFT 的告警需要人核实（设备 EXO-1）',
    severity: 'high',
    status: 'pending',
    externalRef: 'EVT-DQ-1',
    readAt: null,
    createdAt: HOURS_AGO(4),
    sentAt: null,
    errorMessage: null,
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionRef: null,
    ...partial,
  };
}

function baseMock(overrides = {}) {
  return {
    'GET /api/shifts/current': { current: SHIFTS[0], next: null },
    'GET /api/shifts': SHIFTS,
    'GET /api/device-responsibilities/coverage': {
      shiftId: 'SHIFT-DAY',
      shiftUnknown: false,
      total: 0,
      covered: 0,
      gaps: 0,
      uncovered: 0,
      devices: [],
      notes: [],
    },
    'GET /api/shifts/handovers': [],
    'GET /api/dashboard/events': { items: [], total: 0 },
    'GET /api/dashboard/overview': {
      deviceTotal: 0, deviceOnline: 0, eventOpen: 0, eventCritical: 0, avgLoad: 0, workerCount: 0,
    },
    'GET /api/scheduler/plans': { items: [], total: 0 },
    'GET /api/scheduler/executions': { items: [], total: 0 },
    'GET /api/data-quality/confirmations': [],
    'GET /api/notifications': [dqNotification({})],
    ...overrides,
  };
}

async function openShiftWorkbench(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.workshop_lead, '/shift-workbench');
  await expect(page.getByTestId('shift-workbench')).toBeVisible();
}

test.describe('待核实数据提醒（叫到了谁）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('谁被叫到、等了多久、未处置几条都看得见', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/notifications': [
        dqNotification({}),
        dqNotification({
          notificationId: 'NTF-DQ-EVT-DQ-1-quality_alert-user-worker.zhangwei-app',
          recipientType: 'user',
          recipientId: 'worker.zhangwei',
          createdAt: HOURS_AGO(1),
        }),
      ],
    }));
    const card = page.getByTestId('data-quality-verification');
    await expect(card).toBeVisible();
    await expect(card.getByText('未处置 2')).toBeVisible();
    // 同一告警的两个收件人合并成一行（不刷屏）
    await expect(page.getByTestId('dq-verification-row')).toHaveCount(1);
    const recipients = page.getByTestId('dq-verification-recipients');
    await expect(recipients).toContainText('role:workshop_lead');
    await expect(recipients).toContainText('user:worker.zhangwei');
    await expect(recipients).toContainText('已等待');
  });

  test('投递失败显式提示：不能视为已经叫到人', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/notifications': [
        dqNotification({
          notificationId: 'NTF-DQ-EVT-DQ-1-quality_alert-role-workshop_lead-feishu',
          channel: 'feishu',
          status: 'failed',
          errorMessage: 'webhook 超时',
        }),
      ],
    }));
    await expect(page.getByTestId('dq-verification-failed')).toContainText('投递失败');
    await expect(page.getByTestId('dq-verification-notes')).toContainText('不能视为');
  });

  test('已读但未处置仍然留在待办里（read ≠ resolved）', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/notifications': [dqNotification({ status: 'read', readAt: NOW })],
    }));
    await expect(page.getByTestId('dq-verification-row')).toHaveCount(1);
    await expect(page.getByTestId('dq-verification-recipients')).toContainText('已读 1 条');
  });

  test('无提醒 → 显式空态，不暗示数据可信', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({ 'GET /api/notifications': [] }));
    const empty = page.getByTestId('dq-verification-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('无提醒 ≠ 数据可信');
  });

  test('提醒读取失败 → 显式报错，不显示成"已经叫到人"', async ({ page }) => {
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'GET /api/notifications': { status: 500, body: { message: '通知表不可用' } },
    }));
    const error = page.getByTestId('dq-verification-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('不会显示成');
    await expect(page.getByTestId('dq-verification-row')).toHaveCount(0);
  });

  test('核实判定由人做出：确认可信/质疑分别回写 confirmed|contested 到源告警', async ({ page }) => {
    const posts = [];
    await openShiftWorkbench(page, server.baseUrl, baseMock({
      'POST /api/data-quality/confirmations': ({ body }) => {
        posts.push(body);
        return { record: { eventId: body.eventId, verdict: body.verdict }, created: true, linkedAlertsResolved: 1, resolvedNotificationCount: 1 };
      },
    }));
    const card = page.getByTestId('data-quality-verification');
    await card.getByRole('button', { name: '确认可信' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ eventId: 'EVT-DQ-1', verdict: 'confirmed' });
    await card.getByRole('button', { name: '质疑' }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toMatchObject({ eventId: 'EVT-DQ-1', verdict: 'contested' });
  });
});
