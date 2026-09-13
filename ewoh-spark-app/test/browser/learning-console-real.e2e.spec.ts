import { test, expect, type Page } from '@playwright/test';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
const { resolveBackendUrl } = require('./runtime-target');

/**
 * 学习控制台 UI × **真实后端** 闭环（前端 → NestJS → PostgreSQL）。
 *
 * 为什么需要它：学习治理此前分别在两条互不相交的路径上被验证过——
 *   - HTTP 脚本（`test/e2e/learning-proposal-governance.mjs`）覆盖服务端语义
 *     （摄入→影子→提案→自批回避→审批激活→回滚）；
 *   - mock 浏览器用例（`learning-console.spec.js`）覆盖交互与诚信文案。
 * 二者都不证明"界面点下去真的驱动了真实后端并落到真实库"。本文件补上这一环：
 *
 *   1. 新租户基线读面 = 引擎内置常量（不是"已激活策略"）；
 *   2. 浏览器提交候选阈值 → 服务端用**库内遥测**生成影子证据（模拟外骨骼帧
 *      以 `source_type='simulated'` 落库，如实标注模拟数据）；
 *   3. 提案卡显示**提议人 = 当前登录身份**，且"批准"被 B5 生成人回避禁用并说明
 *      （真实后端把 proposedBy 回传给 UI，而不是前端自己推断）；
 *   4. 服务端复核：提案已影子评估但**尚未激活**（基线仍是引擎常量）；
 *   5. 由另一身份（global_admin）审批 → 刷新页面，基线显示已批准覆盖与来源；
 *   6. 回滚（清理路径）后基线复原。
 *
 * 运行（真实后端模式）：
 *   EWOH_E2E_OWNER_DATABASE_URL=postgresql://ewoh_owner:...@127.0.0.1:55432/ewoh \
 *   EWOH_E2E_RUNTIME_DATABASE_URL=postgresql://ewoh_api:...@127.0.0.1:55432/ewoh \
 *     npx playwright test --config playwright.config.ts test/browser/learning-console-real.e2e.spec.ts
 */

const BACKEND = resolveBackendUrl();
const ENGINE_DEFAULT_WORKLOAD = 0.8;
let owner: OwnerSql | undefined;
let fixture: E2EFixture | undefined;

test.use({ serviceWorkers: 'block' });

interface Session {
  accessToken: string;
  refreshToken?: string;
  user: { userId: string; username: string; roles: string[]; orgId: string };
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

/** 必须写 sessionStorage：应用侧会话读取只在 sessionStorage（写 localStorage 会看起来未登录）。 */
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

/** 模拟外骨骼遥测（明确标注 source_type='simulated'，不冒充真实观测）。 */
async function seedSimulatedTelemetry(sql: OwnerSql, orgId: string): Promise<void> {
  const rows = [
    { entityId: 'person:e2e-learn-a', loadScore: 0.85, fatigueTrend: 0.75 },
    { entityId: 'person:e2e-learn-b', loadScore: 0.95, fatigueTrend: 0.8 },
  ];
  for (const [index, row] of rows.entries()) {
    await sql`
      insert into public.ewoh_telemetry
        (org_id, device_id, entity_id, ts, load_score, fatigue_trend, source_type, record_id)
      values (${orgId}, ${`exo:browser-learn-${index}`}, ${row.entityId}, now(),
              ${row.loadScore}, ${row.fatigueTrend}, 'simulated', ${`rec:browser-learn-${index}`})
    `;
  }
}

test.beforeAll(async () => {
  test.skip(process.env.EWOH_BROWSER_LOCAL_FIXTURE !== '1',
    '需要真实后端模式（EWOH_E2E_OWNER_DATABASE_URL + EWOH_E2E_RUNTIME_DATABASE_URL）');
  owner = await connectOwner(process.env.EWOH_E2E_OWNER_DATABASE_URL!);
  fixture = await createE2EFixture(owner);
  await seedSimulatedTelemetry(owner, fixture.orgA.id);
});

test.afterAll(async () => {
  if (owner) {
    try { if (fixture) await cleanupE2EFixture(owner, fixture); }
    finally { await owner.end(); }
  }
});

test('真实后端：基线→提案（影子证据来自库内）→自批回避→他人审批激活→回滚', async ({ page }) => {
  const approver = await login(fixture!.approverA);
  const admin = await login(fixture!.globalAdminA);

  // 1) 新租户：基线 = 引擎内置常量，且如实标注"不是已生效策略"
  await openWithSession(page, approver, '/learning-console');
  await expect(page.getByRole('heading', { name: '学习控制台' })).toBeVisible();
  const effective = page.getByTestId('threshold-effective-workloadThreshold');
  await expect(effective).toContainText(String(ENGINE_DEFAULT_WORKLOAD), { timeout: 15_000 });
  await expect(page.getByTestId('threshold-source-workloadThreshold')).toContainText('引擎内置常量');

  // 2) 浏览器提交候选阈值（基线值必须来自服务端读面）
  await page.getByTestId('proposal-candidate').fill('0.9');
  await page.getByTestId('propose-submit').click();
  const result = page.getByTestId('propose-result');
  await expect(result).toContainText('提案已登记', { timeout: 15_000 });
  await expect(result).toContainText('不会自动生效');

  // 3) 提案卡：提议人 = 当前身份；批准被 B5 生成人回避禁用并说明
  const card = page.locator('[data-testid^="proposal-lp:"]').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText(approver.user.userId);
  await expect(card).toContainText('已影子评估，待人审');
  await expect(page.getByTestId(/^self-approval-/)).toContainText('需他人审批');
  await expect(page.getByRole('button', { name: '批准生效' }).first()).toBeDisabled();

  // 4) 服务端复核：提案已影子评估，但**尚未激活**（基线仍是引擎常量）
  const proposals = await api('/api/learning/proposals', { method: 'GET' }, approver.accessToken);
  expect(proposals.status).toBe(200);
  const created = (proposals.body as unknown as Array<Record<string, unknown>>)
    .find((p) => p.proposedBy === approver.user.userId);
  expect(created, '提案应带提议人归属').toBeTruthy();
  expect(created!.status).toBe('shadow_evaluated');
  const proposalId = String(created!.proposalId);

  const before = await api('/api/learning/thresholds', { method: 'GET' }, approver.accessToken);
  const beforeEntry = (before.body.entries as Array<Record<string, unknown>>)[0];
  expect(beforeEntry.source, '未审批的提案不得改变生效值').toBe('engine_default');
  expect(beforeEntry.effective).toBe(ENGINE_DEFAULT_WORKLOAD);

  // 5) 另一身份审批 → 刷新页面，UI 显示已批准覆盖 + 完整来源
  const approve = await api(`/api/learning/proposals/${encodeURIComponent(proposalId)}/approve`,
    { method: 'POST' }, admin.accessToken);
  expect(approve.status, `approve: ${JSON.stringify(approve.body)}`).toBe(201);

  await page.reload();
  await expect(page.getByTestId('threshold-effective-workloadThreshold')).toContainText('0.9', { timeout: 15_000 });
  const source = page.getByTestId('threshold-source-workloadThreshold');
  await expect(source).toContainText(proposalId);
  await expect(source).toContainText(admin.user.userId);
  await expect(source).toContainText('提议人');
  await expect(source).toContainText(approver.user.userId);

  // 6) 回滚复原（同时验证激活可逆）
  const rollback = await api(`/api/learning/proposals/${encodeURIComponent(proposalId)}/rollback`,
    { method: 'POST', body: JSON.stringify({ reason: 'browser e2e 清理：验证回滚复原' }) }, admin.accessToken);
  expect(rollback.status, `rollback: ${JSON.stringify(rollback.body)}`).toBe(201);

  const after = await api('/api/learning/thresholds', { method: 'GET' }, approver.accessToken);
  const afterEntry = (after.body.entries as Array<Record<string, unknown>>)[0];
  expect(afterEntry.source).toBe('engine_default');
  expect(afterEntry.effective).toBe(ENGINE_DEFAULT_WORKLOAD);
});
