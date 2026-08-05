/**
 * UX-0011 跨浏览器弱网测试矩阵 —— 代理层/测试服务器式弱网机制。
 *
 * 核心目标：弱网模拟「不依赖 Chromium 专属的 CDP Network.emulateNetworkConditions」，
 * 而是把限速/断连/超时/错误注入下沉到测试服务器（startThrottledServer，纯 node http），
 * 因此 Chromium / Firefox / WebKit 三个浏览器项目命中的是同一套弱网语义。
 *
 * 视觉/字体/浏览器/OS 差异策略（重要）：
 *   - 本文件只做「行为断言」（DOM 文本、队列 UI、toast、SW 生命周期），不做像素级截图，
 *     因此不受字体/浏览器/OS 渲染差异影响。像素级视觉回归请走
 *     playwright.visual.config.ts（见 ux009-visual.spec.js 与视觉基线策略说明）。
 *   - 断连用 Playwright 提供、跨浏览器一致的 `context.setOffline()`（非 CDP-only）；
 *     服务端限速/错误注入用 startThrottledServer 的服务端层，两者共同保证三浏览器一致。
 *
 * 截图容差策略：
 *   - 本测试矩阵不设置、也不放宽任何截图 tolerance（无 toScreenshot 断言）。
 *   - 视觉回归的 tolerance 由 playwright.visual.config.ts 统一管理（maxDiffPixelRatio 0.02 /
 *     maxDiffPixels 200），并明确「主金基线 = Linux Chromium」。禁止通过无限抬高容差来掩盖真实回归。
 *
 * 运行方式（该语法可在三种浏览器上运行，无 CDP-only skip）：
 *   npx playwright test --config playwright.config.ts --project=chromium --grep "UX-0011/WeakNet"
 *   npx playwright test --config playwright.config.ts --project=firefox --grep "UX-0011/WeakNet"
 *   npx playwright test --config playwright.config.ts --project=webkit --grep "UX-0011/WeakNet"
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  startThrottledServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

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

const WORKBENCH_MOCK = { 'GET /api/mobile/workbench': [] };

/** 单条离线待同步操作（transition），与 UX-009 网络域保持一致结构。 */
function queuedTransition(overrides = {}) {
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

/** 向 IndexedDB('ewoh-offline').pendingActions 预置待同步操作并等待写入完成。 */
async function seedPending(page, items) {
  await page.evaluate(
    ({ items }) =>
      new Promise((resolve) => {
        const req = indexedDB.open('ewoh-offline', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          const stores = [
            'pendingActions',
            'drafts',
            'attachments',
            'syncState',
            'serverVersion',
            'auditLog',
          ];
          for (const name of stores) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: 'key' });
            }
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
    { items },
  );
}

/** 读取当前受控 SW 的状态（version / contract）。 */
async function readSwState(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        navigator.serviceWorker.ready
          .then((reg) => {
            const worker = reg.active || reg.waiting || reg.installing;
            if (!worker) {
              resolve(null);
              return;
            }
            const mc = new MessageChannel();
            mc.port1.onmessage = (e) => resolve(e.data);
            worker.postMessage({ type: 'GET_STATE' }, [mc.port2]);
          })
          .catch(() => resolve(null));
      }),
  );
}

async function waitForController(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() =>
      page.evaluate(() => (navigator.serviceWorker.controller ? 'yes' : 'no')),
    )
    .toBe('yes');
}

// ---- 场景 (a)-(e),(g),(h)：托管 dist/client 的共享限速服务器 ----
test.describe('UX-0011/WeakNet', () => {
  test.use({ serviceWorkers: 'block' });

  let server;
  let baseUrl;

  test.beforeAll(async () => {
    // 共享弱网服务器：每静态请求注入 80ms 延迟，作为整套用例的「弱网底色」。
    server = await startThrottledServer({ latency: 80 });
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('机制原语：服务端限速/错误注入/随机断连在三种浏览器上一致生效', async ({ page }) => {
    // 先加载到限速服务器 origin，fetch('/api/echo') 才能解析到正确地址。
    await page.goto(baseUrl + '/login');
    await page.waitForLoadState('domcontentloaded');

    // 错误注入：对 /api/echo（未 mock，走真实服务器）注入 503
    server.configureThrottle({ errorStatus: 503 });
    const status503 = await page.evaluate(() =>
      fetch('/api/echo').then((r) => r.status),
    );
    expect(status503).toBe(503);
    server.configureThrottle({ errorStatus: 0 });

    // 随机断连：dropRate=1 强制销毁连接 → fetch 应失败（部分浏览器 reject，
    // 部分浏览器 resolve 一个 status=0 的「网络错误」响应，故统一断言非正常 2xx）
    server.configureThrottle({ dropRate: 1 });
    const dropOutcome = await page.evaluate(() =>
      fetch('/api/echo')
        .then((r) => ({ rejected: false, status: r.status }))
        .catch(() => ({ rejected: true, status: -1 })),
    );
    expect(dropOutcome.rejected || dropOutcome.status !== 200).toBe(true);
    server.configureThrottle({ dropRate: 0 });

    // 延迟：请求应晚于 latency 返回
    server.configureThrottle({ latency: 500, errorStatus: 0 });
    const t0 = Date.now();
    const statusAgain = await page.evaluate(() =>
      fetch('/api/echo').then((r) => r.status),
    );
    const elapsed = Date.now() - t0;
    expect(statusAgain).toBe(200); // 静态服务器 SPA fallback 返回 200
    expect(elapsed).toBeGreaterThanOrEqual(450);
    server.configureThrottle({ latency: 80 });
  });

  test('(a) 登录后断连：离线横幅与排队提示', async ({ page }) => {
    await mockApi(page, WORKBENCH_MOCK);
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await expect(page.locator('text=在线').first()).toBeVisible();
    // 登录态建立后断连（跨浏览器 setOffline）
    await page.context().setOffline(true);
    await expect(page.locator('text=离线').first()).toBeVisible();
    await expect(
      page.locator('text=当前处于离线状态，操作会加入待同步队列，联网后自动提交。'),
    ).toBeVisible();
  });

  test('(b) 提交中断连：操作不丢失，保留在待同步队列供重试', async ({ page }) => {
    // 提交后端不可达（未 mock POST → 404）→ flush 失败，操作保留在队列中
    await mockApi(page, WORKBENCH_MOCK);
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await page.waitForTimeout(400); // 首屏 flush 落定
    await seedPending(page, [queuedTransition()]);
    await page.reload();
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await expect(page.locator('section[aria-label="待同步队列"]')).toBeVisible({
      timeout: 15_000,
    });
    // 断连/提交失败时操作不丢失，保留在待同步队列中（应用无独立『重试』按钮，依赖联网后自动重放）
    await expect(page.locator('section[aria-label="待同步队列"]')).toContainText('S1');
    await expect(page.locator('text=待同步 1').first()).toBeVisible();
    // 断连期间操作仍保留，离线横幅可见
    await page.context().setOffline(true);
    await expect(
      page.locator('text=当前处于离线状态，操作会加入待同步队列，联网后自动提交。'),
    ).toBeVisible();
    await page.context().setOffline(false);
  });

  test('(c) 离线队列重放：断连期间入队，联网后自动重放并清空', async ({ page }) => {
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': () => ({
        stepId: 'S1',
        name: '装配',
        status: 'in_progress',
      }),
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await page.waitForTimeout(400);
    // 断连：模拟提交期间离线，操作入队
    await page.context().setOffline(true);
    await seedPending(page, [queuedTransition()]);
    await expect(
      page.locator('text=当前处于离线状态，操作会加入待同步队列，联网后自动提交。'),
    ).toBeVisible();
    // 重新联网：应用自动重放队列并清空
    await page.context().setOffline(false);
    await expect(page.locator('text=已同步 1 项离线操作')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('section[aria-label="待同步队列"]')).toBeHidden();
  });

  test('(d) 重复提交：同一幂等键重放不产生冲突，队列幂等清空', async ({ page }) => {
    const seenKeys = [];
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': ({ body }) => {
        seenKeys.push(body && body.idempotencyKey);
        return { stepId: 'S1', name: '装配', status: 'in_progress' };
      },
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await page.waitForTimeout(400);
    // 模拟重复提交：同一操作被重放两次（相同幂等键，例如双击/崩溃重投）
    const dup = queuedTransition();
    await seedPending(page, [dup, { ...dup, id: 'p2', key: 'p2' }]);
    await page.reload();
    await expect(page.locator('text=已同步 2 项离线操作')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('section[aria-label="待同步队列"]')).toBeHidden();
    // 两次重放都携带同一幂等键，供服务端去重（客户端幂等契约）
    expect(seenKeys.filter((k) => k === 'ik-1').length).toBe(2);
  });

  test('(e) 冲突处理：服务端 409 进入冲突态并可解决', async ({ page }) => {
    await mockApi(page, {
      ...WORKBENCH_MOCK,
      'POST /api/mobile/workbench/orders/WO-1001/steps/S1/state': {
        status: 409,
        body: { message: 'STATE_CONFLICT: step already advanced' },
      },
    });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page.locator('h1')).toHaveText('移动工作台');
    await page.waitForTimeout(400);
    await seedPending(page, [queuedTransition()]);
    await page.reload();
    await expect(page.locator('text=状态冲突 — 请选择处理方式')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('text=本地值')).toBeVisible();
    await expect(page.locator('text=服务端值')).toBeVisible();
    await page.getByRole('button', { name: '采用服务端' }).click();
    await expect(page.locator('text=已采用服务端值').first()).toBeVisible();
    await expect(page.locator('section[aria-label="待同步队列"]')).toBeHidden();
  });

  test('(g) 页面刷新：弱网下刷新后内容稳定可渲染', async ({ page }) => {
    await mockApi(page, DASHBOARD_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expect(page.locator('text=设备总数')).toBeVisible();
    await page.reload();
    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expect(page.locator('text=设备总数')).toBeVisible();
    await expect(page.getByText('12', { exact: true }).first()).toBeVisible();
  });

  test('(h) 多标签页并发：共享待同步队列，两标签读取一致', async ({ context }) => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();
    // POST 未 mock → flush 失败，操作保留在队列，便于确定性验证共享
    await mockApi(page1, WORKBENCH_MOCK);
    await mockApi(page2, WORKBENCH_MOCK);
    await openSession(page1, baseUrl, ROLES.worker, '/mobile-workbench');
    await openSession(page2, baseUrl, ROLES.worker, '/mobile-workbench');
    await expect(page1.locator('h1')).toHaveText('移动工作台');
    await expect(page2.locator('h1')).toHaveText('移动工作台');
    await page1.waitForTimeout(400);
    await page2.waitForTimeout(200);
    // 标签页1 写入两个并发离线操作（模拟两个标签同时捕获的提交）
    await seedPending(page1, [
      queuedTransition(),
      queuedTransition({ id: 'p2', key: 'p2', stepId: 'S2', idempotencyKey: 'ik-2' }),
    ]);
    // 标签页1 刷新后读取到共享队列
    await page1.reload();
    await expect(page1.locator('h1')).toHaveText('移动工作台');
    await expect(page1.locator('section[aria-label="待同步队列"]')).toBeVisible({
      timeout: 15_000,
    });
    // 标签页2 刷新后看到同一共享队列（两个操作均可见，全局一致）
    await page2.reload();
    await expect(page2.locator('h1')).toHaveText('移动工作台');
    await expect(page2.locator('section[aria-label="待同步队列"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page1.locator('section[aria-label="待同步队列"] li')).toHaveCount(2);
    await expect(page2.locator('section[aria-label="待同步队列"] li')).toHaveCount(2);
  });
});

// ---- 场景 (f)：Service Worker 更新（用参数化 SW 的最弱网服务器，不阻塞 SW）----
test.describe('UX-0011/WeakNet/SW', () => {
  test('(f) 弱网下 Service Worker 更新：SKIP_WAITING 安全接管', async ({ page }) => {
    const server = await startThrottledServer({
      sw: true,
      swVersion: 'v1',
      swContract: '1.0.0',
      latency: 200,
    });
    try {
      await page.goto(server.baseUrl + '/');
      await page.evaluate(() => navigator.serviceWorker.register('/sw.js'));
      await waitForController(page);
      const initial = await readSwState(page);
      expect(initial === null || initial.version).toBeTruthy();

      // 升级到 v2：弱网下触发更新，新 SW 应进入 waiting 且不静默接管
      server.setSw({ version: 'v2' });
      server.configureThrottle({ latency: 300 });
      await page.evaluate(() =>
        navigator.serviceWorker.getRegistration('/').then((r) => r && r.update()),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            navigator.serviceWorker.getRegistration('/').then((r) =>
              r && r.waiting ? 'waiting' : 'none',
            ),
          ),
        )
        .toBe('waiting');
      const during = await readSwState(page);
      expect(during.version).toContain('v1');

      // 安全更新：向 waiting worker 发 SKIP_WAITING，随后 reload 让新版本接管
      await page.evaluate(() =>
        navigator.serviceWorker.getRegistration('/').then((r) => {
          r.waiting.postMessage({ type: 'SKIP_WAITING' });
        }),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            navigator.serviceWorker.getRegistration('/').then((r) =>
              r.active ? r.active.state : 'none',
            ),
          ),
        )
        .toBe('activated');
      await page.reload();
      await waitForController(page);
      await expect
        .poll(async () => (await readSwState(page)).version)
        .toContain('v2');
    } finally {
      await server.close();
    }
  });
});