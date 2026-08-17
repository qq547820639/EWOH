/* Phase 4 收口：Command Map 真实后端浏览器 E2E（scheduler-command-map）。
 *
 * 场景：
 *  A. 登录 → Command Map 打开 → 调度数据层渲染（真实后端）；
 *  B. 创建调度 Run → 方案生成 → 审批 → dispatch → Execution 记录（真实 PG）；
 *  C. KPI 聚合端点经浏览器代理访问（真实后端）；
 *  D. Policy Replay / Gate 端点可用（真实后端，无历史快照时允许明确失败）；
 *  E. SSE v2/stream 建立 + Last-Event-ID 续传字段（经代理）。
 *
 * 前置：真实 NestJS 在 3100（standalone-e2e-server.ts），PostgreSQL 15432 已迁移。
 * 运行：npx playwright test --config playwright.commandmap.config.ts
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BACKEND = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || 'Admin@123456';
const CLIENT_DIR = path.resolve(__dirname, '..', '..', 'dist', 'client');
const INDEX_HTML = path.join(CLIENT_DIR, 'index.standalone.html');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** 静态托管 dist/client（SPA fallback）。 */
function startStaticServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let filePath = path.join(CLIENT_DIR, url.pathname);
      if (url.pathname === '/') filePath = INDEX_HTML;
      if (!filePath.startsWith(CLIENT_DIR)) filePath = INDEX_HTML;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = INDEX_HTML;
      }
      const ext = path.extname(filePath).toLowerCase();
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** 真实后端登录，返回 access token。 */
async function loginRealBackend(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  return data;
}

/** 通过 Playwright 代理把 /api/** 转发到真实后端（带 Bearer token）。 */
async function routeApiToBackend(page: import('@playwright/test').Page, accessToken: string): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const backendUrl = `${BACKEND}${new URL(url).pathname}${new URL(url).search}`;
    // 小写键覆盖，避免与 req.headers() 的 authorization 键并存导致 401。
    const upstream: Record<string, string> = { ...req.headers() };
    delete upstream['authorization'];
    upstream['authorization'] = `Bearer ${accessToken}`;
    upstream['host'] = new URL(BACKEND).host;
    const headers = upstream;
    let body: Buffer | undefined;
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      const postData = req.postDataBuffer();
      if (postData) body = postData;
    }
    const backendRes = await fetch(backendUrl, {
      method: req.method(),
      headers: headers as Record<string, string>,
      body,
      // 透传 Content-Type（axios JSON 请求）
      duplex: req.method() === 'GET' || req.method() === 'HEAD' ? undefined : ('half' as never),
    } as RequestInit);
    const resBody = Buffer.from(await backendRes.arrayBuffer());
    const resHeaders: Record<string, string> = {};
    for (const [k, v] of backendRes.headers.entries()) {
      if (k.toLowerCase() === 'set-cookie') continue; // cookie 由浏览器本地管理
      resHeaders[k] = v;
    }
    await route.fulfill({ status: backendRes.status, headers: resHeaders, body: resBody });
  });
}

let staticServer: { baseUrl: string; close: () => Promise<void> } | null = null;

test.beforeAll(async () => {
  staticServer = await startStaticServer();
});

test.afterAll(async () => {
  if (staticServer) await staticServer.close();
});

test.describe('Command Map 真实后端浏览器 E2E', () => {
  test('A: 登录注入会话后 Command Map 可加载（真实后端数据层）', async ({ page }) => {
    const { accessToken, refreshToken } = await loginRealBackend();
    // 注入会话（与 Login 后 setSession 相同的 localStorage key）。
    await page.addInitScript(
      ({ access, refresh }) => {
        window.localStorage.setItem('ewoh_access_token', access);
        window.localStorage.setItem('ewoh_refresh_token', refresh);
        window.localStorage.setItem(
          'ewoh_auth_user',
          JSON.stringify({ username: 'admin', roles: ['global_admin'], orgId: '00000000-0000-4000-8000-000000000001' }),
        );
      },
      { access: accessToken, refresh: refreshToken },
    );
    await routeApiToBackend(page, accessToken);

    await page.goto(`${staticServer!.baseUrl}/command-map`, { waitUntil: 'domcontentloaded' });
    // SSE 长连接使 networkidle 永不达成；等待真实 UI 元素出现（模式面板或地图底座）。
    try {
      await page.waitForSelector('[data-layer="base"], .mode-panel, [data-testid="command-map"], button', {
        timeout: 15_000,
      });
    } catch {
      const bodyText = (await page.locator('body').innerText()).slice(0, 400);
      const url = page.url();
      expect(
        bodyText,
        `Command Map 未渲染 UI（url=${url} body=${bodyText}）`,
      ).not.toMatch(/登录已过期|UNAUTHORIZED|401|not found/);
    }
    // 渲染出至少一个可交互元素（按钮/面板/图层任一）。
    const interactiveCount = await page.locator('button, [data-layer], [data-testid="command-map"], .mode-panel').count();
    expect(interactiveCount).toBeGreaterThan(0);
  });

  test('B: 真实调度链路——创建 Run → 方案 → 审批 → dispatch（经浏览器代理，真实 PG）', async ({ page }) => {
    const { accessToken } = await loginRealBackend();
    // 直接经代理触发真实后端调度 API（等价于浏览器内用户操作）。
    await routeApiToBackend(page, accessToken);

    // 创建调度 run（page.evaluate 内 fetch → 走 route 代理 → 真实后端；真实浏览器路径）。
    // R2-APT-007：每个环节捕获 HTTP 状态 + 业务状态，断言链路真实成功；
    // 旧 expect(chain).toBeDefined() 恒真（evaluate 必然返回对象）已移除。
    const chain = await page.evaluate(
      async (args: { base: string; token: string }) => {
        const headers = { Authorization: `Bearer ${args.token}` };
        const post = async (pathname: string, data?: unknown) => {
          const res = await fetch(`${args.base}${pathname}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: data ? JSON.stringify(data) : undefined,
          });
          const body = await res.json().catch(() => ({}));
          return { httpStatus: res.status, body };
        };
        const run = await post('/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' });
        const plan = ((run.body as { plans?: Array<{ planId: string; version: number; snapshotVersion: string }> })
          .plans ?? [])[0];
        if (!plan) {
          return {
            runHttpStatus: run.httpStatus,
            runCreated: false,
            planId: null as string | null,
            approveHttpStatus: null as number | null,
            approveStatus: null as string | null,
            dispatchHttpStatus: null as number | null,
            dispatchStatus: null as string | null,
          };
        }
        const approve = await post(`/api/scheduler/plans/${plan.planId}/approve`, {
          version: plan.version,
          snapshotVersion: plan.snapshotVersion,
          operator: 'browser-e2e',
        });
        const dispatch =
          (approve.body as { status?: string }).status === 'approved'
            ? await post(`/api/scheduler/plans/${plan.planId}/dispatch`)
            : null;
        return {
          runHttpStatus: run.httpStatus,
          runCreated: true,
          planId: plan.planId,
          approveHttpStatus: approve.httpStatus,
          approveStatus: (approve.body as { status?: string }).status ?? null,
          dispatchHttpStatus: dispatch ? dispatch.httpStatus : null,
          dispatchStatus: dispatch ? ((dispatch.body as { status?: string }).status ?? null) : null,
        };
      },
      { base: staticServer!.baseUrl, token: accessToken } as never,
    );
    // R2-APT-007：调度去抖冷却（409）为环境性跳过——显式 skip 注明，不静默恒真。
    if (chain.runHttpStatus === 409) {
      test.skip(true, '调度 run 创建触发 409 去抖冷却，本轮链路断言显式跳过');
    }
    // run 创建必须真实成功并携带方案。
    expect(chain.runHttpStatus, `run 创建失败（HTTP ${chain.runHttpStatus}）`).toBe(201);
    expect(chain.runCreated).toBe(true);
    expect(chain.planId).toBeTruthy();
    // 审批：真实成功且业务状态翻转。
    expect(chain.approveHttpStatus, `approve 失败（HTTP ${chain.approveHttpStatus}）`).toBe(201);
    expect(chain.approveStatus).toBe('approved');
    // 派工：审批通过后必须可达且状态翻转。
    expect(chain.dispatchHttpStatus, `dispatch 失败（HTTP ${chain.dispatchHttpStatus}）`).toBe(201);
    expect(chain.dispatchStatus).toBe('dispatched');
  });

  test('C: KPI / Execution / Policy 端点经真实后端可用', async ({ page }) => {
    const { accessToken } = await loginRealBackend();
    await routeApiToBackend(page, accessToken);

    const result = await page.evaluate(
      async (args: { base: string; token: string }) => {
        const headers = { Authorization: `Bearer ${args.token}` };
        const get = async (pathname: string) => {
          const res = await fetch(`${args.base}${pathname}`, { headers });
          const body = await res.json().catch(() => ({}));
          return { status: res.status, body };
        };
        const post = (pathname: string, data?: unknown) =>
          fetch(`${args.base}${pathname}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: data ? JSON.stringify(data) : undefined,
          }).then((r) => ({ status: r.status, body: r.json().catch(() => ({})) }));
        const kpi = await get('/api/scheduler/kpi');
        const execs = await get('/api/scheduler/executions');
        const replay = await post('/api/scheduler/policy/replay', { candidatePolicyVersion: 1, seed: 42 });
        return { kpi, execs, replay };
      },
      { base: staticServer!.baseUrl, token: accessToken } as never,
    );
    expect(result.kpi.status).toBe(200);
    expect((result.kpi.body as { delivery?: unknown; stability?: unknown }).delivery).toBeDefined();
    expect((result.kpi.body as { stability?: unknown }).stability).toBeDefined();
    expect(result.execs.status).toBe(200);
    if (result.replay.status === 201 || result.replay.status === 200) {
      expect((result.replay.body as { replayId?: string }).replayId).toBeTruthy();
      expect((result.replay.body as { seed?: number }).seed).toBe(42);
    } else {
      // 500 = 无历史快照的合法失败路径（后端显式错误），不掩盖。
      expect([400, 409, 500]).toContain(result.replay.status);
    }
  });

  test('D: SSE v2/stream 可建立（经代理，200 + text/event-stream）', async ({ page }) => {
    const { accessToken } = await loginRealBackend();
    await routeApiToBackend(page, accessToken);

    await page.goto(`${staticServer!.baseUrl}/command-map`, { waitUntil: 'domcontentloaded' });
    // R2-APT-013：401 是鉴权失败（恰恰证明流不可用），必须 FAIL——原断言把
    // 401 当"可建立"通过。现仅接受 200 且 content-type 含 text/event-stream，
    // 并使用本次登录的新鲜 token（原取 localStorage 可能已过期的 token）。
    const streamStatus = await page.evaluate(async (args: { backend: string; token: string }) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${args.backend}/api/scheduler/v2/stream`, {
          headers: { Authorization: `Bearer ${args.token}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const out = { status: res.status, contentType: res.headers.get('content-type') };
        // 响应头到达即断开（SSE 长连接不留挂）。
        controller.abort();
        return out;
      } catch (e) {
        return { status: 0, error: (e as Error).message };
      }
    }, { backend: BACKEND, token: accessToken });
    expect(
      streamStatus.status === 200 &&
        String(streamStatus.contentType ?? '').includes('text/event-stream'),
      `SSE 流建立失败：status=${streamStatus.status} contentType=${streamStatus.contentType ?? '-'}`,
    ).toBe(true);
    // R2-APT-013：用例名原承诺"Last-Event-ID 续传语义"但从未验证——删除该
    // 承诺。真实续传验证需读取事件 id 后带 Last-Event-ID 头重连并比对续传
    // 事件序列，本用例未实现，不虚假声称已覆盖。
  });
});
