import { test, expect, type Page } from '@playwright/test';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
const { resolveBackendUrl } = require('./runtime-target');

/**
 * 分波派工 UI × **真实后端** 闭环（前端 → NestJS → PostgreSQL）。
 *
 * 为什么需要它：分波派工此前分别在两条互不相交的路径上被验证过——
 *   - HTTP 脚本（`test/e2e/partial-dispatch-wave.mjs`）覆盖服务端语义；
 *   - mock 浏览器用例（`scheduling-wave-dispatch.spec.js`）覆盖交互与后果表达。
 * 二者都不证明"界面点下去真的驱动了真实后端并落到真实库"。本文件补上这一环。
 *
 * 场景（独立租户，运行结束回收）：
 *   1. 播种 2 个可调度任务 → 触发调度 → 由**另一身份**审批（B5 审批独立性）；
 *   2. 以 dispatcher 身份打开 /scheduling，在分波面板只勾 1 条 → 派发；
 *      断言确认文案写明条数/剩余/保持已审批；派发后结果为"已派发 1 · 剩余 1"；
 *   3. 用 API 复核服务端事实：方案仍为 approved、仅 1 条 dispatched；
 *   4. 再派剩余 1 条 → 方案进入终态 dispatched，且库内两条均已派工。
 *
 * 运行（真实后端模式）：
 *   EWOH_E2E_OWNER_DATABASE_URL=postgresql://ewoh_owner:...@127.0.0.1:55432/ewoh \
 *   EWOH_E2E_RUNTIME_DATABASE_URL=postgresql://ewoh_api:...@127.0.0.1:55432/ewoh \
 *     npx playwright test --config playwright.config.ts test/browser/scheduling-wave-real.e2e.spec.ts
 */

const BACKEND = resolveBackendUrl();
let owner: OwnerSql | undefined;
let fixture: E2EFixture | undefined;

test.use({ serviceWorkers: 'block' });

interface Session {
  accessToken: string;
  refreshToken?: string;
  user: unknown;
}

async function login(credentials: { username: string; password: string }): Promise<Session> {
  const response = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  expect(response.status, `login ${credentials.username}`).toBe(201);
  return response.json();
}

/**
 * 注入真实会话并打开页面。
 *
 * 必须写 **sessionStorage**：应用侧 `getAuthUser()` / `restoreFromSession()`
 * 都从 sessionStorage 读取（CLI-501/701 把 access token 与展示身份收敛到
 * sessionStorage）。写 localStorage 会让页面看起来"未登录"。
 */
async function openWithSession(page: Page, session: Session, route: string): Promise<void> {
  await page.addInitScript((auth: Session) => {
    window.sessionStorage.setItem('ewoh_access_token', auth.accessToken);
    window.sessionStorage.setItem('ewoh_auth_user', JSON.stringify(auth.user));
  }, session);
  await page.goto(`${BACKEND}${route}`);
}

async function api(path: string, init: RequestInit, token: string) {
  const response = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: body as Record<string, unknown> };
}

test.beforeAll(async () => {
  test.skip(process.env.EWOH_BROWSER_LOCAL_FIXTURE !== '1',
    '需要真实后端模式（EWOH_E2E_OWNER_DATABASE_URL + EWOH_E2E_RUNTIME_DATABASE_URL）');
  owner = await connectOwner(process.env.EWOH_E2E_OWNER_DATABASE_URL!);
  fixture = await createE2EFixture(owner);
  // 播种两次 → 2 个任务 / 2 名人员 / 2 个工位，使方案有 2 条 assignment，
  // 从而能真正验证"只派一波"。播种一次只有 1 条，派发即终结，测不到部分执行。
  await seedSchedulerFixture(owner, fixture.orgA.id);
  await seedSchedulerFixture(owner, fixture.orgA.id);
});

test.afterAll(async () => {
  if (owner) {
    try { if (fixture) await cleanupE2EFixture(owner, fixture); }
    finally { await owner.end(); }
  }
});

test('真实后端：分波派工 → 部分执行状态 → 波次收口为终态', async ({ page }) => {
  const admin = await login(fixture!.globalAdminA);
  const approver = await login(fixture!.approverA);
  const dispatcher = await login(fixture!.dispatcherA);

  // 1) 触发调度（生成 shadow 方案）
  const run = await api('/api/scheduler/runs', {
    method: 'POST',
    body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL' }),
  }, admin.accessToken);
  expect(run.status, `run: ${JSON.stringify(run.body)}`).toBe(201);
  const plans = (run.body.plans ?? []) as Array<Record<string, unknown>>;
  expect(plans.length, '应生成候选方案').toBeGreaterThan(0);
  const planId = String(plans[0].planId);

  const detail = await api(`/api/scheduler/plans/${planId}`, { method: 'GET' }, admin.accessToken);
  expect(detail.status).toBe(200);
  const assignments = (detail.body.assignments ?? []) as Array<Record<string, unknown>>;
  expect(assignments.length, '方案应有 ≥2 条 assignment 才能验证分波').toBeGreaterThanOrEqual(2);

  // 2) 由**另一身份**审批（B5：生成人不得自批）
  const approve = await api(`/api/scheduler/plans/${planId}/approve`, {
    method: 'POST',
    body: JSON.stringify({
      version: detail.body.version,
      snapshotVersion: detail.body.snapshotVersion,
      operator: 'browser-wave-e2e',
    }),
  }, approver.accessToken);
  expect(approve.status, `approve: ${JSON.stringify(approve.body)}`).toBe(200);

  // 3) 浏览器：以 dispatcher 身份进入排产调度，使用真实后端数据
  await openWithSession(page, dispatcher, '/scheduling');
  await expect(page.getByRole('heading', { name: '生产调度中心' })).toBeVisible();

  const panel = page.getByTestId(`wave-dispatch-${planId}`);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toBeDisabled();

  // 只勾选第一条：验证"部分执行"路径。
  // 注意：Checkbox 是 Radix 组件，DOM 上是 button[role=checkbox]（非 input），
  // 因此必须按 role 定位，按 id 前缀选 input 会一个都匹配不到（实测）。
  const boxes = page.getByRole('checkbox', { name: /^选择 / });
  await expect.poll(() => boxes.count()).toBeGreaterThanOrEqual(2);
  await boxes.first().check();
  await expect(page.getByTestId(`wave-selected-count-${planId}`)).toContainText('已选 1 条');

  await panel.click();
  const consequence = page.getByTestId(`wave-consequence-${planId}`);
  await expect(consequence).toContainText('本波派发 1 条');
  await expect(consequence).toContainText('未进入终态');
  await expect(consequence).toContainText('没有取消派工的接口');

  await page.getByTestId(`wave-confirm-submit-${planId}`).click();

  // 4) 界面结果：已派 1 · 剩余 N-1，且说明仍可继续分波
  const result = page.getByTestId(`wave-result-${planId}`);
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result).toContainText('本波已派发 1 条');
  await expect(result).toContainText(`剩余 ${assignments.length - 1} 条`);
  await expect(result).toContainText('可继续分波派发');

  // 5) 服务端事实复核：方案仍 approved，仅 1 条 dispatched（不是"界面说部分、库内已整单"）
  const afterWave1 = await api(`/api/scheduler/plans/${planId}`, { method: 'GET' }, admin.accessToken);
  expect(afterWave1.status).toBe(200);
  expect(afterWave1.body.status, '部分派工后计划必须保持 approved').toBe('approved');
  const rows1 = (afterWave1.body.assignments ?? []) as Array<Record<string, unknown>>;
  expect(rows1.filter((a) => a.status === 'dispatched')).toHaveLength(1);
  expect(rows1.filter((a) => a.status === 'approved')).toHaveLength(assignments.length - 1);

  // 6) 派完剩余 → 终态
  const remaining = rows1.filter((a) => a.status === 'approved').map((a) => String(a.assignmentId));
  const wave2 = await api(`/api/scheduler/plans/${planId}/dispatch`, {
    method: 'POST',
    body: JSON.stringify({ assignmentIds: remaining }),
  }, dispatcher.accessToken);
  expect(wave2.status, `wave2: ${JSON.stringify(wave2.body)}`).toBe(200);
  const dispatch2 = (wave2.body.dispatch ?? {}) as Record<string, unknown>;
  expect(dispatch2.planStatus).toBe('dispatched');
  expect(dispatch2.remainingAssignments).toBe(0);

  const finalPlan = await api(`/api/scheduler/plans/${planId}`, { method: 'GET' }, admin.accessToken);
  expect(finalPlan.body.status).toBe('dispatched');
  const rows2 = (finalPlan.body.assignments ?? []) as Array<Record<string, unknown>>;
  expect(rows2.every((a) => a.status === 'dispatched')).toBe(true);
});
