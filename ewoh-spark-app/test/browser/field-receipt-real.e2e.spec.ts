import { test, expect, type Page } from '@playwright/test';
import * as bcrypt from 'bcryptjs';
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
 * 现场回执 UI × **真实后端** 闭环（前端 → NestJS → PostgreSQL）。
 *
 * 为什么需要它：现场作业台此前只在两条互不相交的路径上被验证——
 *   - HTTP 脚本覆盖回执服务端语义（执行表/反馈/来源与训练资格）；
 *   - mock 浏览器用例覆盖可信度与边界表达。
 * 本文件证明"界面点下去真的驱动真实后端并落到真实库"。
 *
 * 场景（独立租户，结束回收）：
 *   1. 播种任务/人员/设备 → 调度 → 独立身份审批 → 派工，生成执行记录；
 *   2. 创建**绑定到该业务人员**的 worker 账号（`ewoh_user.person_id`）；
 *   3. 以该账号打开 /field-operations：应看到分配给自己的任务；
 *   4. 通过界面报告开始 → 完成，界面读到服务端回执摘要；
 *   5. API 复核：执行记录终态 COMPLETED、反馈行 `receipt_source=simulated`、
 *      `production_training_eligible=false`（人工/模拟回执永不参与生产训练）；
 *   6. 未绑定账号打开同一页面：明确提示未绑定，且**不**展示他人任务。
 */

const BACKEND = resolveBackendUrl();
let owner: OwnerSql | undefined;
let fixture: E2EFixture | undefined;
let boundWorker: { username: string; password: string } | undefined;
let seededPersonId = '';

test.use({ serviceWorkers: 'block' });

interface Session { accessToken: string; user: unknown }

async function login(credentials: { username: string; password: string }): Promise<Session> {
  const response = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  // 先把正文读成文本再一次解析：响应体只能消费一次，若在断言消息里调用
  // response.text()（消息总会被求值），后续 response.json() 必然抛
  // "Body is unusable"（第一版正是如此）。
  const text = await response.text();
  expect(response.status, `login ${credentials.username}: ${text}`).toBe(201);
  return JSON.parse(text) as Session;
}

/** 参见 scheduling-wave-real：会话必须写 sessionStorage。 */
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
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
  const seeded = await seedSchedulerFixture(owner, fixture.orgA.id);
  seededPersonId = seeded.personId;

  // 绑定账号：`ewoh_user.person_id` 是"本人可报"的唯一依据（随 JWT 签发）。
  // 必须经 owner 连接写入——业务运行角色对 ewoh_user 无任何直接授权（fail-closed RLS）。
  boundWorker = {
    username: `e2e_bound_${seededPersonId.slice(0, 8)}`,
    password: 'E2E-Bound-Worker-Aa1!',
  };
  await owner.unsafe(
    `insert into public.ewoh_user
       (username, password_hash, display_name, org_id, roles, is_global_admin, status, person_id)
     values ($1, $2, 'E2E 绑定工人', $3::uuid, '["worker"]'::jsonb, false, 'active', $4)`,
    [boundWorker.username, bcrypt.hashSync(boundWorker.password, 12), fixture.orgA.id, seededPersonId],
  );
});

test.afterAll(async () => {
  if (owner) {
    try { if (fixture) await cleanupE2EFixture(owner, fixture); }
    finally { await owner.end(); }
  }
});

test('真实后端：绑定工人可在界面回执自己的任务，未绑定账号不推断任务', async ({ page }) => {
  const admin = await login(fixture!.globalAdminA);
  const approver = await login(fixture!.approverA);
  const dispatcher = await login(fixture!.dispatcherA);

  // 1) 生成 → 审批（另一身份）→ 派工，制造一条待回执执行
  const run = await api('/api/scheduler/runs', {
    method: 'POST', body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL' }),
  }, admin.accessToken);
  expect(run.status, `run: ${JSON.stringify(run.body)}`).toBe(201);
  const plans = (run.body.plans ?? []) as Array<Record<string, unknown>>;
  expect(plans.length).toBeGreaterThan(0);
  const planId = String(plans[0].planId);

  const detail = await api(`/api/scheduler/plans/${planId}`, { method: 'GET' }, admin.accessToken);
  const approve = await api(`/api/scheduler/plans/${planId}/approve`, {
    method: 'POST',
    body: JSON.stringify({
      version: detail.body.version,
      snapshotVersion: detail.body.snapshotVersion,
      operator: 'browser-field-e2e',
    }),
  }, approver.accessToken);
  expect(approve.status, `approve: ${JSON.stringify(approve.body)}`).toBe(200);

  const dispatch = await api(`/api/scheduler/plans/${planId}/dispatch`, { method: 'POST', body: '{}' }, dispatcher.accessToken);
  expect(dispatch.status, `dispatch: ${JSON.stringify(dispatch.body)}`).toBe(200);

  // 2) 现场账号登录：JWT 必须带出人员绑定
  const worker = await login(boundWorker!);
  expect((worker.user as { personId?: string }).personId, '登录响应应带出人员绑定').toBe(seededPersonId);

  await openWithSession(page, worker, '/field-operations');
  await expect(page.getByRole('heading', { name: '现场作业台' })).toBeVisible();
  await expect(page.getByText('已识别业务人员：', { exact: false })).toBeVisible();

  // 3) 界面回执：回执面板默认收起，先展开（与现场页的"先看提醒再操作"顺序一致）
  await page.getByRole('button', { name: '打开回执面板' }).click();
  // 展开后按钮文案翻转为"收起回执面板"——用它可以确认面板确实展开了；
  // 注意不要断言 "执行回执与结果"：那是 FactoryOperations 内嵌组件的小标题，
  // 现场页用的是自己的"现场回执"分区（本页不从全厂执行台账取数）。
  await expect(page.getByRole('button', { name: '收起回执面板' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '现场回执' })).toBeVisible();
  const receipt = page.getByTestId(/^execution-receipt-/).first();
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await receipt.getByRole('button', { name: '报告开始' }).click();
  await expect(receipt.getByText('服务端回执：执行中', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(receipt.getByText('服务端未将此回执认定为生产训练样本。')).toBeVisible();

  await receipt.getByRole('button', { name: '报告完成' }).click();
  await expect(receipt.getByText('服务端回执：已完成', { exact: false })).toBeVisible({ timeout: 15_000 });

  // 4) 服务端事实复核：执行终态 + 反馈来源/训练资格（模拟回执永不入训练集）
  const execs = await api(`/api/scheduler/executions?planId=${encodeURIComponent(planId)}`, { method: 'GET' }, admin.accessToken);
  expect(execs.status).toBe(200);
  const rows = (execs.body.executions ?? []) as Array<Record<string, unknown>>;
  expect(rows.length).toBeGreaterThan(0);
  const done = rows.find((r) => r.status === 'COMPLETED');
  expect(done, '应有一条执行记录收敛到 COMPLETED').toBeTruthy();
  expect(done!.actualStartAt, '应保存实际开始时间').toBeTruthy();
  expect(done!.actualEndAt, '应保存实际结束时间').toBeTruthy();

  const samples = await api('/api/scheduler/predictions/task-duration/samples', { method: 'GET' }, admin.accessToken);
  expect(samples.status).toBe(200);
  // 本租户反馈全部来自人工/模拟回执 → 可训练样本必须为 0（独立设备回执才可训练）
  expect(samples.body.trainable, '人工/模拟回执不得成为生产训练样本').toBe(0);

  // 5) 未绑定账号：明确告知且不展示任务。
  // 用 globalAdminA（有页面访问权、但无 person 绑定）而不是 viewerA——
  // viewer 角色连 /field-operations 都进不去，那验证的是页面级 RBAC，
  // 不是本页"未绑定即不推断任务"的行为。
  const unbound = await login(fixture!.globalAdminA);
  expect((unbound.user as { personId?: string | null }).personId ?? null).toBeNull();
  await openWithSession(page, unbound, '/field-operations');
  await expect(page.getByText('当前账号未绑定业务人员', { exact: false })).toBeVisible();
  await expect(page.getByTestId(/^execution-receipt-/)).toHaveCount(0);
  await expect(page.getByText('账号未绑定业务人员，本页不推断你的任务，因此不显示提醒。')).toBeVisible();
});
