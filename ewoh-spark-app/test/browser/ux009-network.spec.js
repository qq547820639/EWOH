/**
 * UX-009 端到端体验测试矩阵 —— 网络域。
 *
 * 覆盖：正常网络、弱网（throttle）、完全离线、离线重启恢复、数据冲突。
 * 说明：离线/冲突通过 IndexedDB 预置待同步队列 + mock 后端状态机来驱动，
 *      在可复现、无真实后端的前提下验证「最终用户可见」的队列与冲突 UI。
 *
 * 运行方式：`npm run test:browser:ux009 -- --grep "UX-009/Network"`
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
  weakNetwork,
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

/** 预置一条离线待同步队列（模拟之前离线会话已入队、重启后待恢复）。
 *  说明：重启恢复用例通过 page.evaluate 显式写入 IndexedDB 并等待写入完成后再 reload，
 *  以确定性恢复出队列并验证自动同步，避免「首屏自动 flush」与异步写入的竞态。 */
function queuedTransition(overrides) {
  return {
    key: 'p1',
    id: 'p1',
    type: 'transition',
    orderId: 'WO-1001',
    stepId: 'S1',
    action: 'start',
    body: {},
    idempotencyKey: 'ik-1',
    actorId: 'u-worker',
    queuedAt: new Date().toISOString(),
    status: 'local',
    retryCount: 0,
    ...overrides,
  };
}

test.describe('UX-009/Network', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('正常网络：指挥中心渲染出 mock 数据可见状态', async ({ page }) => {
    await mockApi(page, DASHBOARD_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expect(page.locator('text=设备总数')).toBeVisible();
    await expect(page.getByText('12', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('9', { exact: true }).first()).toBeVisible();
  });

  test('弱网：注入延迟后仍能渲染出最终用户可见的指挥中心', async ({ page }) => {
    await mockApi(page, DASHBOARD_MOCK);
    await weakNetwork(page, 400);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expect(page.locator('text=设备总数')).toBeVisible();
  });

  test('完全离线：移动工作台展示离线状态横幅与离线提示', async ({ page }) => {
    await mockApi(page, { 'GET /api/mobile/workbench': [] });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    // 切到完全离线
    await page.context().setOffline(true);
    await expect(page.locator('text=离线').first()).toBeVisible();
    await expect(page.locator('text=当前处于离线状态，操作会加入待同步队列，联网后自动提交。')).toBeVisible();
  });

  test('离线重启恢复：重启后从 IndexedDB 恢复待同步队列并自动同步成功', async ({ page }) => {
    await mockApi(page, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': () => ({
        stepId: 'S1',
        name: '装配',
        status: 'in_progress',
      }),
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    // 首屏挂载会自动 flush 一次（此时队列为空）。等待其异步读取落定，避免它
    // 抢在下面「预置队列」之前读到数据，导致该队列在本次会话就被同步掉。
    await page.waitForTimeout(400);
    // 1) 预置一条待同步操作（本地 IndexedDB 写；等待写入完成再重启）
    await page.evaluate(
      ({ items }) =>
        new Promise((resolve) => {
          const req = indexedDB.open('ewoh-offline', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            const stores = ['pendingActions', 'drafts', 'attachments', 'syncState', 'serverVersion', 'auditLog'];
            for (const name of stores) {
              if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('pendingActions', 'readwrite');
            items.forEach((p) => tx.objectStore('pendingActions').put(p));
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              resolve();
            };
          };
          req.onerror = () => resolve();
        }),
      { items: [queuedTransition()] },
    );
    // 2) 重启：应用重新挂载，自动 flush 从 IndexedDB 恢复队列并同步成功（用户可见 toast）
    await page.reload();
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await expect(page.locator('text=已同步 1 项离线操作')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('section[aria-label="待同步队列"]')).toBeHidden();
  });

  test('数据冲突：服务端返回 409 时队列项进入冲突态并展示本地/服务端差异', async ({ page }) => {
    await mockApi(page, {
      'GET /api/mobile/workbench': [],
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': {
        status: 409,
        body: { message: 'STATE_CONFLICT: step already advanced' },
      },
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    // 预置一条待同步队列并刷新（重启），自动 flush 命中 409 后进入冲突态
    await page.evaluate(
      ({ items }) =>
        new Promise((resolve) => {
          const req = indexedDB.open('ewoh-offline', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            const stores = ['pendingActions', 'drafts', 'attachments', 'syncState', 'serverVersion', 'auditLog'];
            for (const name of stores) {
              if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('pendingActions', 'readwrite');
            items.forEach((p) => tx.objectStore('pendingActions').put(p));
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              resolve();
            };
          };
          req.onerror = () => resolve();
        }),
      { items: [queuedTransition()] },
    );
    await page.reload();
    await expect(page.locator('h1')).toHaveText('移动工作台');
    // 冲突 UI（用户可见）出现
    await expect(page.locator('text=状态冲突 — 请选择处理方式')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=本地值')).toBeVisible();
    await expect(page.locator('text=服务端值')).toBeVisible();
    // 采用服务端解决冲突
    await page.getByRole('button', { name: '采用服务端' }).click();
    await expect(page.locator('text=已采用服务端值').first()).toBeVisible();
    await expect(page.locator('section[aria-label="待同步队列"]')).toBeHidden();
  });
});