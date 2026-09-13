/* 分波次派工（部分执行）闭环验证 —— 真实后端 + 真实 PostgreSQL。
 *
 * 场景：班组长审批了一个多任务方案，但当前只有部分资源可用。
 * 旧行为是全有或全无：全派会因资源冲突整单失败，全不派则现场停工。
 * 本脚本验证分波次语义，并把**计划状态不得伪装**钉死：
 *
 *   1. 第一波只派 1 条 → 计划保持 approved（**不得**变成终态 dispatched），
 *      剩余数量显式回传；
 *   2. 波内混入已派工项 → 整波拒绝（DISPATCH_WAVE_INVALID），不做半应用；
 *   3. 最后一波派完剩余 → 才进入契约终态 dispatched，remaining=0；
 *   4. 波次感知的新鲜度：后续波次不因"本方案自身的派工副作用"而被判 PLAN_STALE。
 *
 * 前置：后端已启动，且库中有**多 assignment 的已审批方案**。
 *   先运行 node test/e2e/golden-path-verify.mjs 生成方案；本脚本自带
 *   复位-派工自举（若无可用方案则自行触发调度并审批一版）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 \
 *   EWOH_E2E_ADMIN_USER=admin EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_OPERATOR_USER=approver.li EWOH_E2E_OPERATOR_PASS=... \
 *     node test/e2e/partial-dispatch-wave.mjs
 *
 * 三态：PASS / FAIL / SKIP；有 SKIP 时退出码 2（未验证 ≠ 通过）。
 */
import http from 'node:http';
import { approveWithReplan } from './helpers/plan-freshness.mjs';
import { advanceTasksToPendingDispatch } from './helpers/task-readiness.mjs';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || 'admin-password';
const OPERATOR_USER = process.env.EWOH_E2E_OPERATOR_USER || 'approver.li';
const OPERATOR_PASS = process.env.EWOH_E2E_OPERATOR_PASS || '';

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, detail = '') => record('SKIP', name, detail);
const errText = (res) => String(res.body?.error?.message ?? res.body?.message ?? '').slice(0, 180);

/**
 * 限流信号：全局限流（RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_SEC，默认 300/60s）
 * 对"读列表"同样生效。若把 429 当成"库中没有数据"，脚本会把**未验证**伪装成
 * 业务结论（实测踩到：反复运行 e2e 后 list 接口 429 → 误报"没有可用方案"）。
 * 因此这里显式记录，并在失败路径上给出限流原因而不是"没有数据"。
 */
let rateLimited = false;

/** 调度触发冷却窗口（与后端 R2 去抖一致）：被去抖后等过它再重试一次。 */
const COOLDOWN_WAIT_MS = 31_000;


function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { json = buf; }
          if (res.statusCode === 429) rateLimited = true;
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function finish() {
  const passed = results.filter((r) => r.status === 'PASS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log('\n========================================');
  console.log(`Partial Dispatch Wave: ${passed.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP（共 ${results.length}）`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  if (skipped.length) {
    console.log('SKIPPED（未验证，非通过）:', skipped.map((s) => s.name).join('; '));
    if (!failed.length) process.exitCode = 2;
  }
}

/**
 * 找一个"可派工且 ≥2 条待派工 assignment"的方案；必要时自举一个。
 *
 * 注意状态词汇：**shadow 方案的 assignment 是 `proposed`**，审批后才变
 * `approved`。若只按 `approved` 过滤，会认为所有 shadow 方案都"没有待派工项"，
 * 从而永远自举不出候选（实测踩到）。
 */
async function findPlan(adminToken, opToken) {
  const PENDING = new Set(['proposed', 'approved']);

  /**
   * 排产前把看板上**未就绪**的任务推进到待派工 —— 真实调度员在排产/派工前会做的事。
   *
   * 为什么必须做（2026-09-13 实测）：契约 `task.yaml` 规定
   * draft → pending_confirm → pending_approval → pending_dispatch 必须由
   * creator / dispatcher / approver **逐步**推进。种子场景里「装配任务A」停在 `draft`，
   * 求解器会照常把它排进方案（它确实"可调度"），于是派工时返回
   * 409 `PLAN_TASK_NOT_DISPATCHABLE` 且**整波不下发**——这是产品**正确**的
   * fail-closed（派工不得代 creator/approver 越过闸门），不是缺陷。
   *
   * 不先备好看板，本场景会在"找不到候选方案"处 SKIP —— 那会把**真正的阻塞**
   * （任务未就绪）说成"没有方案"，属误导。详见 helpers/task-readiness.mjs。
   */
  const prepareBoard = async () => {
    const res = await request('GET', '/api/tasks', null, adminToken);
    const tasks = res.body?.tasks ?? res.body?.data ?? (Array.isArray(res.body) ? res.body : []);
    const blocked = tasks
      .filter((t) => ['draft', 'pending_confirm', 'pending_approval'].includes(String(t.status)))
      .map((t) => ({ taskId: t.id ?? t.taskId }));
    if (blocked.length === 0) return [];
    return advanceTasksToPendingDispatch(request, blocked, {
      operatorToken: adminToken,
      approverToken: opToken,
    });
  };

  const readied = await prepareBoard();
  if (readied.length > 0) {
    step('2b. 排产前备好看板：未就绪任务推进到待派工', true, readied.join(' | '));
  }

  /**
   * 扫描候选，**按可派工 assignment 数降序返回全部**（不是只取第一名）。
   *
   * 2026-09-13 修复：此前只取 pending 最多的那一个候选，若它不可审批
   * （典型：种子方案 `PLAN-OPT-001`——快照是造出来的，审批必然 PLAN_STALE，
   * 重排也救不回来）就直接放弃，调用方据此报"库中没有 ≥2 条待派工 assignment
   * 的方案"。那是**误导**：库里明明有刚生成的新方案（15 条 proposed），
   * 只是没被尝试到。改成逐个候选尝试，直到有一个真的能审批通过。
   */
  async function scanCandidates() {
    const list = await request('GET', '/api/scheduler/plans?limit=30', null, adminToken);
    const plans = list.body?.data ?? list.body?.plans ?? [];
    const candidates = [];
    for (const p of plans) {
      if (p.status !== 'shadow' && p.status !== 'approved') continue;
      const detail = await request('GET', `/api/scheduler/plans/${p.planId}`, null, adminToken);
      const pending = (detail.body?.assignments ?? []).filter((a) => PENDING.has(a.status));
      if (pending.length >= 2) {
        candidates.push({ plan: p, detail: detail.body, pending });
      }
    }
    return candidates.sort((a, b) => b.pending.length - a.pending.length);
  }

  /** 确保方案已审批（shadow → approved），并把 pending 刷新为 approved 集合。 */
  async function ensureApproved(candidate) {
    if (candidate.plan.status === 'shadow') {
      // NO-66c：过期不再直接放弃候选——先诊断、再按最新状态重排、然后审批新方案（有界 2 轮）。
      // 重排由**另一身份**发起（creator ≠ approver）。
      const approval = await approveWithReplan(
        {
          post: (url, body, tk) => request('POST', url, body ?? {}, tk),
          get: (url, tk) => request('GET', url, null, tk),
        },
        {
          planId: candidate.plan.planId,
          version: candidate.detail?.version,
          snapshotVersion: candidate.detail?.snapshotVersion,
          operatorToken: adminToken,
          approverToken: opToken,
          operator: process.env.EWOH_E2E_ADMIN_USER || 'admin',
          reason: 'e2e:wave 审批（过期则按最新状态重排后重试）',
          maxRounds: 2,
        },
      );
      if (!approval.ok) return null;
      candidate.plan = { ...candidate.plan, planId: approval.planId, status: 'approved' };
      const detail = await request('GET', `/api/scheduler/plans/${approval.planId}`, null, adminToken);
      candidate.detail = detail.body;
    }
    candidate.pending = (candidate.detail?.assignments ?? []).filter((a) => a.status === 'approved');
    return candidate.pending.length >= 2 ? candidate : null;
  }

  /** 逐个候选尝试审批，返回第一个真的能推进到"≥2 条 approved assignment"的。 */
  const tryCandidates = async (candidates) => {
    for (const candidate of candidates) {
      const approved = await ensureApproved(candidate);
      if (approved) return approved;
    }
    return null;
  };

  const existingCandidate = await tryCandidates(await scanCandidates());
  if (existingCandidate) return existingCandidate;

  // 自举：触发调度 → 取一个多 assignment 的新方案 → 审批。
  // 2026-09-13 修复：此前只触发一次、扫一次，命中"触发被冷却去抖"（30s 内已有人
  // 触发过 MANUAL run → 本次返回 debounced、不产生新方案）时就静默返回 null，
  // 调用方据此报 SKIP 并把原因写成"库中没有 ≥2 条待派工 assignment 的方案"——
  // 那是**误导**：库里其实有，只是这一轮没等到新方案。现在按 golden-path 已验证的
  // 模式：等过冷却窗口后重试一次，仍无才认输（真缺数据不会被掩盖）。
  const triggerAndScan = async () => {
    await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, adminToken);
    return scanCandidates();
  };
  const bootstrap = async () => {
    let fresh = await tryCandidates(await triggerAndScan());
    if (fresh) return fresh;
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
    fresh = await tryCandidates(await triggerAndScan());
    return fresh;
  };

  const existing = await tryCandidates(await scanCandidates());
  if (existing) return existing;

  // 看板刚被推进过 → 世界版本已变，**既有方案全部过期**（它们的快照早于本次推进），
  // 直接审批只会得到 PLAN_STALE。必须避开触发冷却、重新生成方案再审批
  // ——这正是故障重排闭环已验证的序列（推进 → 重排 → 审批新方案 → 派工）。
  if (readied.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
  }
  return bootstrap();
}

async function main() {
  const admin = await request('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (admin.status === 429) {
    skip('1. 管理员登录', '登录被限流（HTTP 429）；本地验证可临时提高 LOGIN_RATE_LIMIT_MAX 后重启。');
    return finish();
  }
  const adminToken = admin.body?.accessToken;
  step('1. 管理员登录', Boolean(adminToken), `status=${admin.status}`);
  if (!adminToken) return finish();

  let opToken = adminToken;
  if (OPERATOR_PASS) {
    const op = await request('POST', '/api/auth/login', { username: OPERATOR_USER, password: OPERATOR_PASS });
    if (op.body?.accessToken) {
      opToken = op.body.accessToken;
      step('2. 审批/派工身份登录', true, `user=${OPERATOR_USER}`);
    } else {
      skip('2. 审批/派工身份登录', `账号不可用（HTTP ${op.status}），回退用管理员`);
    }
  } else {
    skip('2. 审批/派工身份登录', '未提供 EWOH_E2E_OPERATOR_PASS，回退用管理员');
  }

  const found = await findPlan(adminToken, opToken);
  if (!found && rateLimited) {
    skip('3. 多 assignment 待派工方案',
      '读取方案列表时被**限流**（HTTP 429，RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_SEC，默认 300/60s）：'
      + '无法确认库中是否真的没有可用方案——限流不是"没有数据"。'
      + '处置：稍等一个窗口后重跑，或临时提高 RATE_LIMIT_MAX 后重启后端。');
    return finish();
  }
  if (!found) {
    skip('3. 多 assignment 待派工方案',
      '扫遍库中候选（含触发新调度后的新方案）仍没有"≥2 条可派工 assignment 且能审批通过"的方案。'
      + '常见成因：可调度任务已被前面的场景消费（golden-path / 回执闭环会消费），'
      + '或候选方案快照均已过期且重排失败。'
      + '处置：先复位场景数据再运行本场景：'
      + 'node db/runner/reset-scenario-data.js --org-id <org> --yes');
    return finish();
  }
  const planId = found.plan.planId;
  const ids = found.pending.map((a) => a.assignmentId);
  step('3. 多 assignment 待派工方案', true, `planId=${planId} pending=${ids.length}`);

  // 4. 第一波：只派 1 条
  const wave1 = await request('POST', `/api/scheduler/plans/${planId}/dispatch`, { assignmentIds: [ids[0]] }, opToken);
  // 派工同样有**快照新鲜度闸门**（`assertFreshForWave`）。本开发库数千待排任务 + 后台扫描，
  // 方案快照秒级失效 → 平台 409 PLAN_STALE 是**正确拒绝**（不是产品缺陷），但既然第一波
  // 没派出去，后面的"波次语义"断言全部无从验证：按诚实口径记 SKIP + 原因，不伪装成通过，
  // 也不把环境事实报成回归。非 PLAN_STALE 的 409/其它状态仍然是 FAIL。
  if (wave1.status === 409 && errText(wave1).includes('PLAN_STALE')) {
    skip('4. 第一波派工', '方案快照在派工前已失效（PLAN_STALE，平台正确拒绝）：'
      + '本开发库世界变化频繁（数千待排任务 + 后台扫描）；波次语义未验证'
      + '——处置：先复位场景数据（reset-scenario-data）后重跑本场景');
    return finish();
  }
  step('4. 第一波派工成功', wave1.status === 200, `status=${wave1.status} msg=${errText(wave1)}`);
  const d1 = wave1.body?.dispatch;
  step('5. 只派本波（范围可追溯）',
    Array.isArray(d1?.dispatchedAssignmentIds) && d1.dispatchedAssignmentIds.length === 1
      && d1.dispatchedAssignmentIds[0] === ids[0],
    `dispatched=${JSON.stringify(d1?.dispatchedAssignmentIds)}`);
  step('6. 部分派工时计划保持 approved（不得伪装成终态 dispatched）',
    d1?.planStatus === 'approved' && wave1.body?.status === 'approved',
    `dispatch.planStatus=${d1?.planStatus} plan.status=${wave1.body?.status}`);
  step('7. 剩余显式回传', d1?.remainingAssignments === ids.length - 1,
    `remaining=${d1?.remainingAssignments} expected=${ids.length - 1}`);

  // 8. 波内含已派工项 → 整波拒绝，且不产生副作用
  const bad = await request('POST', `/api/scheduler/plans/${planId}/dispatch`, { assignmentIds: [ids[0], ids[1]] }, opToken);
  step('8. 波内混入已派工项 → 整波拒绝（全有或全无）',
    bad.status === 409 && /DISPATCH_WAVE_INVALID/.test(errText(bad)),
    `status=${bad.status} msg=${errText(bad)}`);
  const afterBad = await request('GET', `/api/scheduler/plans/${planId}`, null, adminToken);
  const stillPending = (afterBad.body?.assignments ?? []).filter((a) => a.status === 'approved').length;
  step('9. 整波拒绝后无半应用', stillPending === ids.length - 1,
    `仍待派工=${stillPending} expected=${ids.length - 1}`);

  // 10. 最后一波：派完剩余 → 进入终态
  const rest = ids.slice(1);
  const wave2 = await request('POST', `/api/scheduler/plans/${planId}/dispatch`, { assignmentIds: rest }, opToken);
  step('10. 最后一波派工成功', wave2.status === 200, `status=${wave2.status} msg=${errText(wave2)}`);
  const d2 = wave2.body?.dispatch;
  step('11. 覆盖全部剩余 → 进入契约终态 dispatched',
    d2?.planStatus === 'dispatched' && d2?.remainingAssignments === 0 && wave2.body?.status === 'dispatched',
    `dispatch.planStatus=${d2?.planStatus} plan.status=${wave2.body?.status} remaining=${d2?.remainingAssignments}`);

  // 12. 已终结方案再次派工 → 明确拒绝
  const again = await request('POST', `/api/scheduler/plans/${planId}/dispatch`, null, opToken);
  step('12. 终态方案不再接受派工', again.status === 409,
    `status=${again.status} msg=${errText(again)}`);

  return finish();
}

main().catch((error) => {
  console.error('Partial dispatch wave failed:', error.message);
  process.exit(1);
});
