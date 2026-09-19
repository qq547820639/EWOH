/* 移动工单"设备执行状态行"浏览器验收（NO-79a）。
 *
 * 现场问题："我的工单为什么没动？"——工单卡的状态行必须把调度语言翻译成工人语言：
 *   · 设备执行中（等待回执）——不是工单失败；
 *   · 设备排队中（上一条命令执行中 / 配额用尽）——**不是工单失败**；
 *   · 命令投递积压（已通知值班）——工人不需要自己升级；
 *   · 设备空闲，可执行。
 * 查不到派工设备 → 状态行**不渲染**（如实缺项，不伪造"设备正常"）。
 *
 * 使用 mock 数据层；真实后台判定由 `e2e:control-actuator`（同一 listDeviceCommands 实现）覆盖。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  mockApi,
  openSession,
  startStaticServer,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const NOW = '2026-09-16T12:00:00.000Z';

function orderDetail(overrides = {}) {
  return {
    workOrder: { scheduleTaskId: 'WO-Q1', title: '批次 7 转运（AGV）', status: 'in_progress', progress: 0.4 },
    steps: [],
    materials: [],
    deviceExecution: null,
    ...overrides,
  };
}

const QUEUED = orderDetail({
  deviceExecution: {
    deviceId: 'AGV-07',
    inFlight: 0,
    queued: 1,
    awaitingDelivery: 0,
    overdue: 0,
    oldestWaitingMs: 40_000,
    busyBlocker: 'dispatch_task:att-9',
  },
});

const INFLIGHT = orderDetail({
  deviceExecution: {
    deviceId: 'AGV-07',
    inFlight: 1,
    queued: 0,
    awaitingDelivery: 0,
    overdue: 0,
    oldestWaitingMs: 20_000,
    busyBlocker: null,
  },
});

const OVERDUE = orderDetail({
  deviceExecution: {
    deviceId: 'AGV-07',
    inFlight: 0,
    queued: 0,
    awaitingDelivery: 1,
    overdue: 1,
    oldestWaitingMs: 31 * 60_000,
    busyBlocker: null,
  },
});

const IDLE = orderDetail({
  deviceExecution: {
    deviceId: 'AGV-07',
    inFlight: 0,
    queued: 0,
    awaitingDelivery: 0,
    overdue: 0,
    oldestWaitingMs: null,
    busyBlocker: null,
  },
});

async function scanOrder(page, baseUrl, handlers) {
  await mockApi(page, handlers);
  await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
  await expect(page.getByRole('heading', { name: '移动工作台' })).toBeVisible();
  await page.getByLabel('扫码或输入工单号').fill('WO-Q1');
  await page.getByLabel('扫码或输入工单号').press('Enter');
  // 只等工单卡标题（toast 也含标题文本 → 必须用 heading 角色避免 strict-mode 双命中）
  await expect(page.getByRole('heading', { name: '批次 7 转运（AGV）' })).toBeVisible();
}

test.describe('移动工单设备执行状态行（NO-79a）', () => {
  let server;

  test.beforeAll(async () => {
    server = await startStaticServer();
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('排队中：显示"设备排队中……不是工单失败"（工人不需要重扫）', async ({ page }) => {
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': QUEUED,
      'GET /api/mobile/workbench/orders/WO-Q1': QUEUED,
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toBeVisible();
    await expect(line).toContainText('AGV-07');
    await expect(line).toContainText('设备在执行上一单');
    await expect(line).toContainText('等它空下来');
    await expect(line).toContainText('不是工单失败');
  });

  test('NO-81a：限流排队（配额用尽）显示"等下一分钟配额窗口"', async ({ page }) => {
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': orderDetail({
        deviceExecution: {
          deviceId: 'AGV-07', inFlight: 0, queued: 0, awaitingDelivery: 1,
          overdue: 0, oldestWaitingMs: 20_000, busyBlocker: null,
          queuedReasons: { device_busy: 0, quota: 1 },
        },
      }),
      'GET /api/mobile/workbench/orders/WO-Q1': orderDetail({
        deviceExecution: {
          deviceId: 'AGV-07', inFlight: 0, queued: 0, awaitingDelivery: 1,
          overdue: 0, oldestWaitingMs: 20_000, busyBlocker: null,
          queuedReasons: { device_busy: 0, quota: 1 },
        },
      }),
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toContainText('投递限流中');
    await expect(line).toContainText('等下一分钟配额窗口');
    await expect(line).toContainText('不是工单失败');
  });

  test('执行中：显示"设备执行中（等待回执）"', async ({ page }) => {
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': INFLIGHT,
      'GET /api/mobile/workbench/orders/WO-Q1': INFLIGHT,
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toContainText('设备执行中（等待回执）');
  });

  test('积压：显示"已通知值班"（工人不需要自己升级）', async ({ page }) => {
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': OVERDUE,
      'GET /api/mobile/workbench/orders/WO-Q1': OVERDUE,
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toContainText('命令投递积压');
    await expect(line).toContainText('已通知值班');
  });

  test('空闲：显示"设备空闲，可执行"', async ({ page }) => {
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': IDLE,
      'GET /api/mobile/workbench/orders/WO-Q1': IDLE,
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toContainText('设备空闲，可执行');
  });

  test('NO-83b：多设备协同派工显示首台 + "+N 台协同"（协同事实不静默丢弃）', async ({ page }) => {
    const multi = orderDetail({
      deviceExecution: {
        deviceId: 'AGV-07',
        otherDevices: ['AGV-08', 'AGV-09'],
        inFlight: 1,
        queued: 0,
        awaitingDelivery: 0,
        overdue: 0,
        oldestWaitingMs: 15_000,
        busyBlocker: null,
      },
    });
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': multi,
      'GET /api/mobile/workbench/orders/WO-Q1': multi,
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toContainText('AGV-07');
    await expect(line).toContainText('+2 台协同');
    await expect(line).toContainText('设备执行中（等待回执）');
  });

  test('NO-85a：协同设备未就绪在工单卡上可见（首台空闲 ≠ 万事大吉）', async ({ page }) => {
    const multi = orderDetail({
      deviceExecution: {
        deviceId: 'AGV-07',
        otherDevices: ['AGV-08'],
        otherStuckCount: 1,
        otherStuck: [{ deviceId: 'AGV-08', queued: 1, awaitingDelivery: 0, overdue: 0 }],
        inFlight: 0,
        queued: 0,
        awaitingDelivery: 0,
        overdue: 0,
        oldestWaitingMs: null,
        busyBlocker: null,
      },
    });
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': multi,
      'GET /api/mobile/workbench/orders/WO-Q1': multi,
    });

    const line = page.getByTestId('order-device-execution');
    await expect(line).toContainText('AGV-07');
    await expect(line).toContainText('+1 台协同设备未就绪');
    // 首台空闲（状态行主体是"设备空闲"），但协同设备卡住的事实**不被吞掉**
    await expect(line).toContainText('设备空闲，可执行');
  });

  test('无派工设备：状态行不渲染（如实缺项，不伪造"设备正常"）', async ({ page }) => {
    await scanOrder(page, server.baseUrl, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/scan': orderDetail({ deviceExecution: null }),
      'GET /api/mobile/workbench/orders/WO-Q1': orderDetail({ deviceExecution: null }),
    });

    await expect(page.getByTestId('order-device-execution')).toHaveCount(0);
  });
});
