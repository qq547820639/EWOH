import { test, expect, type Page } from '@playwright/test';
import { cleanupE2EFixture, connectOwner, createE2EFixture, seedSchedulerFixture, type E2EFixture, type OwnerSql } from '../helpers/e2e-db';
const { resolveBackendUrl, browserCredentials } = require('./runtime-target');

const BACKEND = resolveBackendUrl();
let owner: OwnerSql | undefined;
let fixture: E2EFixture | undefined;

async function loginRealBackend() {
  const credentials = fixture?.globalAdminA ?? browserCredentials();
  const response = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  expect(response.status, 'Real backend login').toBe(201);
  return response.json();
}

async function openCommandMap(page: Page) {
  const session = await loginRealBackend();
  await page.addInitScript((auth) => {
    localStorage.setItem('ewoh_access_token', auth.accessToken);
    localStorage.setItem('ewoh_refresh_token', auth.refreshToken);
    localStorage.setItem('ewoh_auth_user', JSON.stringify(auth.user));
  }, session);
  await page.goto(`${BACKEND}/command-map`);
  await expect(page.getByPlaceholder(/搜索实体/)).toBeVisible();
  return session;
}

test.use({ serviceWorkers: 'block' });

test.beforeAll(async () => {
  if (process.env.EWOH_BROWSER_LOCAL_FIXTURE === '1') {
    owner = await connectOwner(process.env.EWOH_E2E_OWNER_DATABASE_URL!);
    fixture = await createE2EFixture(owner);
  }
});

test.afterAll(async () => {
  if (owner) {
    try { if (fixture) await cleanupE2EFixture(owner, fixture); }
    finally { await owner.end(); }
  }
});

test.describe('Command Map 真实后端浏览器 E2E', () => {
  test('A: 登录后 Command Map 可加载（真实后端数据层）', async ({ page }) => {
    await openCommandMap(page);
    await expect(page.locator('body')).toContainText('EWOH 指挥地图');
    await expect(page).toHaveURL(/\/command-map/);
  });

  test('B: 真实调度链路——创建 Run → 方案 → 审批 → dispatch（真实 PG）', async ({ page }) => {
    if (owner && fixture) await seedSchedulerFixture(owner, fixture.orgA.id);
    const session = await openCommandMap(page);
    const chain = await page.evaluate(async (token: string) => {
      const post = async (pathname: string, data?: unknown) => {
        const response = await fetch(pathname, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: data ? JSON.stringify(data) : undefined,
        });
        return { status: response.status, body: await response.json() };
      };
      const run = await post('/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' });
      const plan = run.body.plans?.[0];
      if (!plan) return { run, approve: null, dispatch: null };
      const approve = await post(`/api/scheduler/plans/${plan.planId}/approve`, {
        version: plan.version, snapshotVersion: plan.snapshotVersion, operator: 'browser-e2e',
      });
      const dispatch = approve.body.status === 'approved'
        ? await post(`/api/scheduler/plans/${plan.planId}/dispatch`) : null;
      return { run, approve, dispatch };
    }, session.accessToken);
    expect(chain.run.status, JSON.stringify(chain.run.body)).toBe(201);
    expect(chain.run.body.plans?.length).toBeGreaterThan(0);
    expect(chain.approve?.status, JSON.stringify(chain.approve?.body)).toBe(200);
    expect(chain.approve?.body.status).toBe('approved');
    expect(chain.dispatch?.status, JSON.stringify(chain.dispatch?.body)).toBe(200);
    expect(chain.dispatch?.body.status).toBe('dispatched');
    const executions = await page.request.get(`${BACKEND}/api/scheduler/executions`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      params: { planId: chain.run.body.plans[0].planId },
    });
    expect(executions.status()).toBe(200);
    expect((await executions.json()).executions.length).toBeGreaterThan(0);
  });

  test('C: KPI / Execution / Policy 端点经真实后端可用', async ({ page }) => {
    const session = await openCommandMap(page);
    const result = await page.evaluate(async (token: string) => {
      const call = async (pathname: string, data?: unknown) => {
        const response = await fetch(pathname, {
          method: data ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: data ? JSON.stringify(data) : undefined,
        });
        return { status: response.status, body: await response.json() };
      };
      return {
        kpi: await call('/api/scheduler/kpi'),
        execs: await call('/api/scheduler/executions'),
        replay: await call('/api/scheduler/policy/replay', { candidatePolicyVersion: 1, seed: 42 }),
      };
    }, session.accessToken);
    expect(result.kpi.status).toBe(200);
    expect(result.kpi.body.delivery).toBeDefined();
    expect(result.kpi.body.stability).toBeDefined();
    expect(result.execs.status).toBe(200);
    expect(Array.isArray(result.execs.body.executions)).toBe(true);
    if ([200, 201].includes(result.replay.status)) {
      expect(result.replay.body.replayId).toBeTruthy();
      expect(result.replay.body.seed).toBe(42);
    } else {
      expect([400, 404, 409], JSON.stringify(result.replay.body)).toContain(result.replay.status);
      expect(result.replay.body.error?.message ?? result.replay.body.message).toEqual(expect.any(String));
    }
  });

  test('D: SSE v2/stream 可建立（200 + text/event-stream）', async () => {
    const session = await loginRealBackend();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${BACKEND}/api/scheduler/v2/stream`, {
        headers: { Authorization: `Bearer ${session.accessToken}` }, signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      controller.abort();
      clearTimeout(timeout);
    }
  });
});
