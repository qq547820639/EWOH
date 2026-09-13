/**
 * 方案过期可解释 + 一键重排 E2E（NO-62c）。
 *
 * 为什么单列：第 61 轮记录了"长时间求解（数分钟）vs 设备遥测新鲜度 60s → 方案到达即过期"
 * 这条真实约束，但用户侧的体验是**审批被拒 → 弹一句"请重新计算"**：既不知道变了什么，
 * 也不知道是不是自己造成的（例如刚派了本方案的第一波）。本脚本验证诊断真的可用：
 *
 *   1. 生成方案 → `GET /api/scheduler/plans/{id}/staleness` 形状完整
 *      （stale/changes/snapshotFound/checkedAt/replanAvailable）；
 *   2. **制造一个确定的世界状态变化**（新建一个任务）→ 诊断必须报 stale，且差异里
 *      逐项列出该任务（`task:<id>`，change=added，人话标签）；
 *   3. 此时审批 → 409 `PLAN_STALE` 的**响应体带 staleness 差异**（不再只有一句状态码）；
 *   4. 重排入口存在（`replanAvailable=true`）且**不绕过审批**：新方案仍是 draft，
 *      仍需独立审批人确认（本脚本只断言状态与可用性，不代批）。
 *
 * 诚实边界：不清洗整个调度域，只清理本脚本自己创建的任务与方案引用；
 * "当前是否恰好新鲜"受环境噪声影响，因此**不断言初次检查必须 fresh**，
 * 只断言"确定性变化必须被诊断出来"（可复现）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/plan-staleness-loop.mjs
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const ORG = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, detail = '') => record('SKIP', name, detail);
function finish() {
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n========================================');
  console.log(
    `方案过期可解释: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
  );
  process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
}

let lastLoginError = null;
async function login(username, password) {
  lastLoginError = null;
  if (!password) {
    lastLoginError = `未提供 ${username} 的密码`;
    return null;
  }
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  const body = await response?.json().catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 201)) {
    lastLoginError = `登录失败：HTTP ${response?.status ?? 0}`;
    return null;
  }
  return body?.accessToken ?? null;
}

async function request(method, url, body, token) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => null);
  const text = await response?.text().catch(() => '');
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response?.status ?? 0, body: parsed };
}
const get = (url, token) => request('GET', url, undefined, token);
const post = (url, body, token) => request('POST', url, body, token);
const errText = (res) => String(res.body?.message ?? res.body?.error?.message ?? res.body ?? '').slice(0, 200);

async function waitFor(probe, timeoutMs, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const adminPass = process.env.EWOH_E2E_ADMIN_PASS;
  const approverPass = process.env.EWOH_E2E_APPROVER_PASS;

  const probe = await fetch(`${BASE}/api/scheduler/plans`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}`);
    return finish();
  }
  if (!OWNER_DB) {
    skip('0. 落库清理能力', '未提供 EWOH_E2E_OWNER_DATABASE_URL');
    return finish();
  }
  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const taskId = randomUUID();
  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', adminPass);
  const approverToken = await login(
    process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
    approverPass,
  );
  if (!adminToken || !approverToken) {
    skip('1. 登录（管理员 + 审批人）', lastLoginError ?? '缺少凭据');
    await sql.end({ catch: () => undefined });
    return finish();
  }
  step('1. 管理员 + 审批人登录成功', true);

  try {
    // ── 2. 生成方案 ─────────────────────────────────────────────────
    // 触发冷却（2026-09-13）：本场景在链里紧跟 control-actuator（审批联动重排）之后
    // 运行，MANUAL run 会被 30s 去抖合并（返回 debounced、不产方案）→ plan=null。
    // 那是产品的幂等语义，不是缺陷。等过冷却窗口后重试一次，仍无才认输
    // （与 golden-path 的处置同模式）。
    const COOLDOWN_WAIT_MS = 31_000;
    let run = await post('/api/scheduler/runs', {
      trigger: 'MANUAL',
      operator: process.env.EWOH_E2E_ADMIN_USER || 'admin',
    }, adminToken);
    let planId = run.body?.plans?.[0]?.planId ?? run.body?.run?.planIds?.[0] ?? null;
    if (!planId && (run.body?.debounced || (run.body?.plans ?? []).length === 0)) {
      await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
      run = await post('/api/scheduler/runs', {
        trigger: 'MANUAL',
        operator: process.env.EWOH_E2E_ADMIN_USER || 'admin',
      }, adminToken);
      planId = run.body?.plans?.[0]?.planId ?? run.body?.run?.planIds?.[0] ?? null;
    }
    const plan = planId ? await get(`/api/scheduler/plans/${encodeURIComponent(planId)}`, adminToken) : { body: null };
    const planBody = plan.body ?? null;
    step('2. 生成方案并从调度 run 里取到方案号（诊断对象存在）',
      (run.status === 200 || run.status === 201 || run.status === 202) && Boolean(planId) && Boolean(planBody?.snapshotVersion),
      `run=${run.status} plan=${planId} snapshot=${planBody?.snapshotVersion} msg=${errText(run)}`);
    if (!planId || !planBody?.snapshotVersion) return finish();

    // ── 3. 诊断读面形状 ─────────────────────────────────────────────
    const first = await get(`/api/scheduler/plans/${encodeURIComponent(planId)}/staleness`, adminToken);
    const report = first.body?.staleness ?? null;
    step('3. GET /plans/{id}/staleness 形状完整（stale/changes/snapshotFound/checkedAt/replanAvailable）',
      first.status === 200
        && typeof first.body?.stale === 'boolean'
        && typeof first.body?.replanAvailable === 'boolean'
        && typeof first.body?.checkedAt === 'string'
        && report?.snapshotFound === true
        && Array.isArray(report?.changes)
        && typeof report?.summary === 'string',
      `status=${first.status} stale=${first.body?.stale} changes=${report?.changes?.length} summary=${String(report?.summary).slice(0, 60)}`);

    // ── 4. 制造确定的世界状态变化（新建任务）→ 必须被诊断出来 ─────────
    await sql`
      insert into ewoh_production_task
        (id, org_id, title, task_type, priority, base_priority, status, source, plan_start, plan_end)
      values (${taskId}::uuid, ${ORG}::uuid, ${`e2e staleness probe ${tag}`}, 'production', 'high', 'P1',
              'executing', 'simulated', now(), now() + interval '2 hours')
      on conflict (id) do nothing`;
    const second = await get(`/api/scheduler/plans/${encodeURIComponent(planId)}/staleness`, adminToken);
    const secondReport = second.body?.staleness ?? null;
    const taskChange = (secondReport?.changes ?? []).find(
      (c) => c.entityKey === `task:${taskId}` || c.entityId === taskId,
    );
    step('4. 新建任务后诊断报 stale 且逐项列出该任务（change=added + 人话标签）',
      second.body?.stale === true
        && Boolean(taskChange)
        && taskChange?.change === 'added'
        && String(taskChange?.label ?? '').includes('新增')
        && secondReport?.snapshotFound === true,
      `stale=${second.body?.stale} changes=${secondReport?.changes?.length} task=${JSON.stringify(taskChange ?? null).slice(0, 160)}`);

    // ── 5. 审批 409 必须带差异（不再只有一句状态码）─────────────────
    const approve = await post(
      `/api/scheduler/plans/${encodeURIComponent(planId)}/approve`,
      {
        version: planBody.version,
        snapshotVersion: planBody.snapshotVersion,
        operator: process.env.EWOH_E2E_ADMIN_USER || 'admin',
        reason: 'e2e：过期诊断验证',
      },
      approverToken,
    );
    // 统一错误信封：{ error: { code, message, details, planStaleness, replanAvailable } }
    const conflictError = approve.body?.error ?? approve.body ?? {};
    step('5. 过期方案的审批被拒（409 PLAN_STALE）且响应体带差异明细与重排可用性',
      approve.status === 409
        && String(conflictError.message ?? '').includes('PLAN_STALE')
        && conflictError.code === 'PLAN_STALE'
        && Array.isArray(conflictError.planStaleness?.changes)
        && conflictError.planStaleness.changes.length > 0
        && conflictError.planStaleness.changes.some((c) => c.entityId === taskId)
        && conflictError.replanAvailable === true,
      `status=${approve.status} code=${conflictError.code} changes=${conflictError.planStaleness?.changes?.length} `
        + `hasProbeTask=${conflictError.planStaleness?.changes?.some((c) => c.entityId === taskId)} `
        + `replan=${conflictError.replanAvailable}`);

    // ── 6. 重排入口存在，且重排出的仍是待审批方案（不绕过审批）────────
    const replanned = await post(
      `/api/scheduler/plans/${encodeURIComponent(planId)}/replan`,
      { operator: process.env.EWOH_E2E_ADMIN_USER || 'admin', reason: 'e2e：按最新状态重排' },
      adminToken,
    );
    const newPlanId = replanned.body?.planId ?? replanned.body?.plan?.planId ?? null;
    const newPlan = newPlanId
      ? await get(`/api/scheduler/plans/${encodeURIComponent(newPlanId)}`, adminToken)
      : { body: null };
    step('6. 重排产出新方案且仍为待审批（重排不绕过审批链）',
      (replanned.status === 200 || replanned.status === 201)
        && Boolean(newPlanId)
        && newPlanId !== planId
        && ['draft', 'shadow'].includes(String(newPlan.body?.status ?? '')),
      `status=${replanned.status} newPlan=${newPlanId} planStatus=${newPlan.body?.status} msg=${errText(replanned)}`);

    // ── 7. 新方案绑定的是**新快照**（重排不是复用旧快照）──────────────
    step('7. 新方案绑定新快照版本（重排真的重新采集世界状态）',
      Boolean(newPlan.body?.snapshotVersion)
        && newPlan.body.snapshotVersion !== planBody.snapshotVersion,
      `old=${planBody.snapshotVersion} new=${newPlan.body?.snapshotVersion}`);
  } finally {
    try {
      await sql`delete from ewoh_resource_reservation where task_id = ${String(taskId)}`;
      await sql`delete from ewoh_scheduling_plan_assignment where task_id = ${String(taskId)}`;
      await sql`delete from ewoh_scheduling_feedback where task_id = ${String(taskId)}`;
      await sql`delete from ewoh_production_task where id = ${taskId}::uuid`;
      // NO-67d：清理必须**自证生效**（删除后数一遍）。此前踩过的坑：清理语句写错表名/列名，
      // 异常被 warn 吞掉 → 残留被下一个场景捡到，伪装成产品缺陷。
      const leftover = await sql`
        select
          (select count(*)::int from ewoh_production_task where id = ${taskId}::uuid) as tasks,
          (select count(*)::int from ewoh_scheduling_plan_assignment where task_id = ${String(taskId)}) as assignments,
          (select count(*)::int from ewoh_resource_reservation where task_id = ${String(taskId)}) as reservations`;
      const row = leftover[0] ?? { tasks: 0, assignments: 0, reservations: 0 };
      if (Number(row.tasks) + Number(row.assignments) + Number(row.reservations) > 0) {
        record(
          'FAIL',
          '8. 收尾清理自证',
          `残留 tasks=${row.tasks} assignments=${row.assignments} reservations=${row.reservations}`,
        );
      } else {
        record('PASS', '8. 收尾清理自证（本场景造的任务/派工/预占都已删除）', true);
      }
    } catch (error) {
      // 清理异常本身也必须可见：不能只 warn（NO-64 的教训）。
      record('FAIL', '8. 收尾清理', `清理或自证失败：${error?.message ?? error}`);
    }
    await sql.end({ catch: () => undefined });
  }
  return finish();
}

main().catch((error) => {
  console.error('E2E 执行异常:', error);
  record('FAIL', 'E2E 脚本异常', String(error?.message ?? error));
  finish();
});
