/* 执行回执 → 反馈 → 学习资格 闭环验证（真实后端 + 真实 PostgreSQL）。
 *
 * 目标：验证「派工之后」的那半条闭环真的接通，而不是只看派工成功就结束：
 *
 *   dispatch（已由 golden-path 覆盖）
 *     → 现场开始回执（execution update）
 *     → 现场完成回执（同一 canonical 回执路径）
 *     → 执行记录 / 反馈记录 / assignment / task 四方状态一致
 *     → 预计 vs 实际偏差可读
 *     → 回执来源与训练资格被如实判定（模拟/人工回执**不得**成为生产训练样本）
 *     → 重复回执幂等，不重复推进
 *
 * 为什么单独成脚本：G1（回执与学习缺统一应用路径）与 G2（训练样本缺来源资格）
 * 是审计发现的两个 P1 缺口。判定它们是否真被修好，必须看数据库里的
 * receipt_source / production_training_eligible / provenance_json，
 * 而不是看接口返回 200。
 *
 * 前置：后端已启动，且库中已有 approved/dispatched 方案与 assignment。
 *   可先运行 test/e2e/golden-path-verify.mjs 生成。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 \
 *   EWOH_E2E_ADMIN_USER=admin EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_OPERATOR_USER=approver.li EWOH_E2E_OPERATOR_PASS=... \
 *     node test/e2e/execution-receipt-closed-loop.mjs
 *
 * 可选：设置 EWOH_E2E_PG_URL 可直接断言数据库行（推荐；不设置则只断言 API 投影）。
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveWithReplan } from './helpers/plan-freshness.mjs';
import { advanceTasksToPendingDispatch } from './helpers/task-readiness.mjs';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
/** MANUAL 触发的去抖窗口（policy triggerCooldownMs）：窗口内触发会复用既有方案。 */
const COOLDOWN_WAIT_MS = 31_000;
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || 'admin-password';
const OPERATOR_USER = process.env.EWOH_E2E_OPERATOR_USER || 'approver.li';
const OPERATOR_PASS = process.env.EWOH_E2E_OPERATOR_PASS || '';
/**
 * 现场人员身份（可选但强烈建议）：一个绑定到某业务人员的 worker 账号。
 * 用于验证"本人可报"真的可达——修复前该分支结构性不可达。
 */
const FIELD_USER = process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei';
const FIELD_PASS = process.env.EWOH_E2E_FIELD_PASS || '';

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, detail = '') => record('SKIP', name, detail);

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

const errText = (res) => String(res.body?.error?.message ?? res.body?.message ?? '').slice(0, 160);

/**
 * 限流信号：全局限流（RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_SEC，默认 300/60s）对
 * "读列表"同样生效。若把 429 当成"库中没有数据"，脚本会把**未验证**伪装成业务
 * 结论。因此这里显式记录，并在失败路径上给出限流原因而不是"没有数据"。
 *
 * 注（2026-09-10 自查）：本声明此前只加进了兄弟脚本 partial-dispatch-wave.mjs，
 * 本文件只有赋值没有声明——一旦真的出现 429，赋值即抛 ReferenceError 让整个
 * 场景崩掉（"限流处理"本身成了新的故障点）。现已补齐，并由 eslint no-undef 门禁兜住。
 */
let rateLimited = false;

async function openDb() {
  const url = process.env.EWOH_E2E_PG_URL;
  if (!url) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const requireFromApp = createRequire(path.join(here, '../../package.json'));
  try {
    const postgres = requireFromApp('postgres');
    return postgres(url, { max: 1, onnotice: () => {} });
  } catch (error) {
    console.error(`[warn] 无法加载 postgres 驱动，跳过数据库断言：${error.message}`);
    return null;
  }
}

async function loginWithDiagnostics(user, pass, label) {
  const res = await request('POST', '/api/auth/login', { username: user, password: pass });
  if (res.status === 429) {
    // 登录限流是**正确的**安全行为（默认 10 次 / 15 分钟，见
    // LOGIN_RATE_LIMIT_MAX / LOGIN_RATE_LIMIT_WINDOW_SEC）。反复运行本场景会
    // 触发它，因此这里如实报 SKIP 并给出可执行的处置方式，而不是伪装成脚本错误。
    record('SKIP', label,
      '登录被限流（HTTP 429）。本地反复验证请提高上限后重启，例如 '
        + 'LOGIN_RATE_LIMIT_MAX=1000 LOGIN_RATE_LIMIT_WINDOW_SEC=60；'
        + '或等待 15 分钟窗口结束。生产环境不应放宽该限制。');
    return null;
  }
  if (!(res.status === 200 || res.status === 201)) {
    record('FAIL', label, `status=${res.status} msg=${errText(res)}`);
    return null;
  }
  return res.body?.accessToken ?? null;
}

async function main() {
  const adminToken = await loginWithDiagnostics(ADMIN_USER, ADMIN_PASS, '1. 管理员登录');
  if (!adminToken) return finish();

  // 必须有一个"非生成人"的操作者来提交回执：canonical 回执路径会校验
  // 审批独立性/派工权限，用同一身份自审自派会掩盖权限缺陷。
  let opToken = adminToken;
  let opUser = ADMIN_USER;
  if (OPERATOR_PASS) {
    const op = await request('POST', '/api/auth/login', { username: OPERATOR_USER, password: OPERATOR_PASS });
    if (op.body?.accessToken) {
      opToken = op.body.accessToken;
      opUser = OPERATOR_USER;
      step('2. 现场操作者登录', true, `user=${opUser}`);
    } else {
      skip('2. 现场操作者登录', `账号 ${OPERATOR_USER} 不可用（HTTP ${op.status}），回退用管理员提交回执`);
    }
  } else {
    skip('2. 现场操作者登录', '未提供 EWOH_E2E_OPERATOR_PASS，回退用管理员提交回执');
  }

  // 3. 取得一个"已派工且未终态"的 assignment。
  // 可重复运行的关键：不复用上一轮已终态的 assignment（终态只读），也不盲信
  // 最旧的 shadow 方案（其世界快照可能已过期 → PLAN_STALE）。策略是按新鲜度
  // 依次尝试候选，直到有一个能通过审批 + 派工。
  const TERMINAL_EXEC = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

  async function listCandidates() {
    const plansRes = await request('GET', '/api/scheduler/plans?limit=30', null, opToken);
    const plans = plansRes.body?.data ?? plansRes.body?.plans ?? [];
    const ordered = [
      ...plans.filter((p) => p.status === 'dispatched' || p.status === 'executing'),
      ...plans.filter((p) => p.status === 'approved'),
      ...plans.filter((p) => p.status === 'shadow'),
    ];
    const out = [];
    for (const p of ordered) {
      const detailRes = await request('GET', `/api/scheduler/plans/${p.planId}`, null, opToken);
      const rows = detailRes.body?.assignments ?? [];
      if (!rows.length) continue;
      const execRes = await request('GET', `/api/scheduler/executions?planId=${encodeURIComponent(p.planId)}`, null, opToken);
      const execByAssignment = new Map((execRes.body?.executions ?? []).map((e) => [e.assignmentId, e]));
      out.push({ plan: p, detail: detailRes.body, rows, execByAssignment });
    }
    return out;
  }

  /** 尝试把一个候选推进到"已派工"，返回可回执的 assignment。 */
  async function claimAssignment(candidate) {
    let { plan: p, detail, rows, execByAssignment } = candidate;
    let status = p.status;
    // 现场现实（2026-09-13 实测）：方案里可能含**可调度但未就绪**的任务
    // （draft / pending_confirm / pending_approval —— 见契约 task.yaml）。
    // 此时派工返回 409 PLAN_TASK_NOT_DISPATCHABLE 且整波不下发，这是产品正确的
    // fail-closed（派工不得代 creator/approver 越过闸门）。真实调度员会先推进任务，
    // 脚本照做（详见 helpers/task-readiness.mjs）。
    //
    // **顺序**：必须放在审批**之前**——任务写入会推进世界版本，先审批后推进会让
    // 刚拿到的审批立刻失去时效（实测派工收到 409 PLAN_NOT_APPROVED）。
    const readied = await advanceTasksToPendingDispatch(request, rows ?? [], {
      operatorToken: opToken,
      approverToken: opToken,
    });
    if (readied.length > 0) {
      // 任务状态变了 → 方案的 version/snapshotVersion 已变，必须重取详情再审批。
      const refreshed = await request('GET', `/api/scheduler/plans/${p.planId}`, null, opToken);
      if (refreshed.status === 200 && refreshed.body) {
        detail = refreshed.body;
        rows = refreshed.body.assignments ?? rows;
        candidate.detail = detail;
        candidate.rows = rows;
      }
    }
    if (status === 'shadow') {
      // NO-64a/62c：过期不再只能换候选——先诊断、再按最新状态重排、然后审批新方案。
      // 重排由**另一个身份**发起（creator ≠ approver：同人重排+审批会被自批回避拦下）。
      // 本场景的 `request(method, path, body, token)` 与助手约定的
      // `post(url, body, token) / get(url, token)` 形状不同 → 显式适配，别靠隐式兼容。
      const approval = await approveWithReplan(
        {
          post: (url, body, token) => request('POST', url, body ?? {}, token),
          get: (url, token) => request('GET', url, null, token),
        },
        {
          planId: p.planId,
          version: detail?.version,
          snapshotVersion: detail?.snapshotVersion,
          operatorToken: adminToken,
          approverToken: opToken,
          operator: ADMIN_USER,
          reason: 'e2e:receipt 审批（过期则按最新状态重排后重试）',
          maxRounds: 2,
        },
      );
      if (!approval.ok) {
        return { error: `approve=${approval.status} ${errText(approval.body ? { body: approval.body } : null)}` };
      }
      // 重排可能换了方案：以最终方案号继续（派工/回执都挂在它上面）。
      if (approval.planId !== p.planId) {
        const refreshed = await request('GET', `/api/scheduler/plans/${approval.planId}`, null, opToken);
        if (refreshed.status !== 200 || !refreshed.body) {
          return { error: `重排后方案 ${approval.planId} 详情不可读` };
        }
        p.planId = approval.planId;
        candidate.detail = refreshed.body;
        candidate.rows = refreshed.body.assignments ?? [];
      }
      status = 'approved';
    }
    if (status === 'approved') {
      const dispatch = await request('POST', `/api/scheduler/plans/${p.planId}/dispatch`, null, opToken);
      if (![200, 201].includes(dispatch.status)) {
        return { error: `dispatch=${dispatch.status} ${errText(dispatch)}` };
      }
    }
    for (const a of candidate.rows ?? rows) {
      if (!a.taskId || !a.assignmentId) continue;
      const execStatus = execByAssignment.get(a.assignmentId)?.status;
      if (execStatus && TERMINAL_EXEC.has(execStatus)) continue;
      return { plan: p, assignment: a, execStatus: execStatus ?? 'none' };
    }
    return { error: '该方案没有未终态 assignment' };
  }

  const attempts = [];
  let pick = null;
  let plan = null;
  let target = null;
  let candidates = await listCandidates();
  if (!candidates.length) {
    record('PASS', '3a. 无既有方案，触发新调度', '将生成新方案');
    await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, adminToken);
    candidates = await listCandidates();
  }
  for (const candidate of candidates) {
    const claimed = await claimAssignment(candidate);
    if (claimed.assignment) { pick = claimed; break; }
    attempts.push(`${candidate.plan.planId}: ${claimed.error}`);
    if (attempts.length >= 5) break;
  }
  if (!pick) {
    // 全部候选都过期：触发一次新调度后重试一轮（新调度会产生新鲜快照）。
    // **必须先等过冷却窗口**：MANUAL 触发有 30s 去抖，窗口内触发会"复用既有方案"
    // （即刚刚被判过期的那些）→ 重试毫无意义（本轮实测：第二次触发拿回同一批旧方案）。
    record('PASS', '3b. 既有候选均不可用，等过冷却窗口后触发新调度',
      `waitMs=${COOLDOWN_WAIT_MS} ${attempts.join(' | ').slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
    await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, adminToken);
    for (const candidate of await listCandidates()) {
      const claimed = await claimAssignment(candidate);
      if (claimed.assignment) { pick = claimed; break; }
    }
  }
  if (!pick && rateLimited) {
    skip('3. 可回执 assignment 可用',
      '读取方案/分配时被**限流**（HTTP 429，RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_SEC，默认 300/60s）：'
      + '无法确认库中是否真的没有可用方案——限流不是"没有数据"。'
      + '处置：稍等一个窗口后重跑，或临时提高 RATE_LIMIT_MAX 后重启后端。');
    return finish();
  }
  if (!pick) {
    skip('3. 可回执 assignment 可用', `没有能完成审批+派工的方案：${attempts.join(' | ').slice(0, 260)}`);
    return finish();
  }
  plan = pick.plan;
  target = pick.assignment;
  step('3. 可回执 assignment 可用', true,
    `planId=${plan.planId} assignmentId=${target.assignmentId} execStatus=${pick.execStatus}`);
  step('4. 审批 + 派工链路成功', true, `planId=${plan.planId}`);

  // 6. 开始回执
  // 注意：不携带 deviationReason（note 是其别名）。偏差原因是服务端按计划/实际
  // 时间推导的事实，一经记录不可改写；在开始回执里塞一个理由会让后续完成回执
  // 撞上不可变校验。UI（executionReceiptLogic.ts）同样只在 FAILED 时附带原因。
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const start = await request('POST', `/api/scheduler/executions/${encodeURIComponent(target.assignmentId)}/update`, {
    status: 'STARTED',
    actualStartAt: startedAt,
    reportedSource: 'simulated',
  }, opToken);
  step('6. 开始回执被接受', start.status === 200 || start.status === 201,
    `status=${start.status} receipt=${JSON.stringify(start.body?.receipt ?? null).slice(0, 120)}`);

  // 7. 完成回执
  const endedAt = new Date().toISOString();
  const done = await request('POST', `/api/scheduler/executions/${encodeURIComponent(target.assignmentId)}/update`, {
    status: 'COMPLETED',
    actualStartAt: startedAt,
    actualEndAt: endedAt,
    reportedSource: 'simulated',
  }, opToken);
  step('7. 完成回执被接受', done.status === 200 || done.status === 201,
    `status=${done.status} msg=${errText(done)}`);
  const receipt = done.body?.receipt;
  if (receipt) {
    step('8. 回执带统一摘要（匹配/推进/跳过）',
      typeof receipt.matchedRows === 'number'
      && typeof receipt.advancedAssignments === 'number'
      && Array.isArray(receipt.skips),
      `matched=${receipt.matchedRows} assignments=${receipt.advancedAssignments} skips=${receipt.skips?.length ?? '?'}`);
    // 模拟来源的回执**不得**成为生产训练样本——这是 G2 的核心断言。
    step('9. 模拟回执不被认定为生产训练样本',
      receipt.productionTrainingEligible === false,
      `source=${receipt.source} eligible=${receipt.productionTrainingEligible} reason=${String(receipt.reason ?? '').slice(0, 80)}`);
    step('10. 回执带来源策略标识', receipt.policy === 'receipt-provenance-v1', `policy=${receipt.policy}`);
  } else {
    skip('8-10. 回执摘要与来源判定', '服务端未返回 receipt 字段（统一回执路径未生效）');
  }

  // 11. 期望：执行记录收敛到 completed，且预计/实际都在
  const execs = await request('GET', `/api/scheduler/executions?planId=${encodeURIComponent(plan.planId)}`, null, opToken);
  const exec = (execs.body?.executions ?? []).find((e) => e.assignmentId === target.assignmentId);
  step('11. 执行记录收敛到终态', exec?.status === 'COMPLETED' || exec?.status === 'completed',
    `status=${exec?.status ?? 'missing'}`);
  step('12. 执行记录同时保存计划与实际时间',
    Boolean(exec?.plannedStartAt) && Boolean(exec?.actualStartAt) && Boolean(exec?.actualEndAt),
    `planned=${Boolean(exec?.plannedStartAt)} actualStart=${Boolean(exec?.actualStartAt)} actualEnd=${Boolean(exec?.actualEndAt)}`);

  // 13. 幂等：重复提交同一终态回执不得重复推进
  const again = await request('POST', `/api/scheduler/executions/${encodeURIComponent(target.assignmentId)}/update`, {
    status: 'COMPLETED',
    actualStartAt: startedAt,
    actualEndAt: endedAt,
    reportedSource: 'simulated',
  }, opToken);
  const againOk = [200, 201].includes(again.status)
    ? (again.body?.receipt?.advancedAssignments ?? 0) === 0
    : [409].includes(again.status);
  step('13. 重复回执幂等（不重复推进）', againOk,
    `status=${again.status} advanced=${again.body?.receipt?.advancedAssignments ?? '-'}`);

  const execsAll = await request('GET', `/api/scheduler/executions?planId=${encodeURIComponent(plan.planId)}`, null, adminToken);

  // 14-16. 数据库事实断言（可选但推荐）
  const sql = await openDb();
  if (!sql) {
    skip('14-16. 数据库事实断言', '未设置 EWOH_E2E_PG_URL');
    return finish();
  }
  try {
    const [fb] = await sql`
      SELECT receipt_source, production_training_eligible, provenance_json,
             actual_start, actual_end, plan_id, assignment_id
        FROM public.ewoh_scheduling_feedback
       WHERE assignment_id = ${target.assignmentId}
       ORDER BY _updated_at DESC LIMIT 1`;
    step('14. 反馈记录已落库并关联 assignment/plan',
      Boolean(fb) && fb.plan_id === plan.planId,
      fb ? `plan=${fb.plan_id} assignment=${fb.assignment_id}` : '无反馈行');
    if (fb) {
      step('15. 反馈来源与训练资格如实落库（G2）',
        fb.receipt_source === 'simulated' && fb.production_training_eligible === false,
        `receipt_source=${fb.receipt_source} eligible=${fb.production_training_eligible}`);
      const prov = typeof fb.provenance_json === 'string' ? JSON.parse(fb.provenance_json) : fb.provenance_json;
      step('16. 反馈带可追溯证明 JSON', prov?.policy === 'receipt-provenance-v1',
        `policy=${prov?.policy} source=${prov?.source} reason=${String(prov?.reason ?? '').slice(0, 60)}`);
    } else {
      skip('15-16. 来源/证明断言', '无反馈行可断言');
    }

    // 17. 训练样本资格：模拟回执不得进入生产训练样本集合
    const [{ count: trainable }] = await sql`
      SELECT count(*)::int AS count
        FROM public.ewoh_scheduling_feedback
       WHERE assignment_id = ${target.assignmentId}
         AND production_training_eligible = true
         AND receipt_source = 'real'`;
    step('17. 生产训练样本集合不含该模拟回执（G2 关键断言）', trainable === 0,
      `trainable_real_rows=${trainable}`);

    // 19-21. 现场身份：账号↔人员绑定决定"本人可报"
    // 修复前执行业务授权比较 assignment.personId（人员域）与 ctx.userId（账号域），
    // worker 角色因此永远回执不了自己的任务。这里断言修复真的可达，且越权仍被拒。
    if (!FIELD_PASS) {
      skip('19-21. 现场身份回执授权', '未提供 EWOH_E2E_FIELD_PASS，本人可报路径未验证');
    } else {
      const fieldLogin = await request('POST', '/api/auth/login', { username: FIELD_USER, password: FIELD_PASS });
      const fieldToken = fieldLogin.body?.accessToken;
      const boundPerson = fieldLogin.body?.user?.personId ?? null;
      step('19. 现场账号登录并带出人员绑定', Boolean(fieldToken) && Boolean(boundPerson),
        `user=${FIELD_USER} personId=${boundPerson ?? '未绑定'}`);

      if (fieldToken && boundPerson) {
        // NO-100a 自建前置：把一条未终结执行行归到张伟绑定人员——求解器派给谁
        // 不可控，但"本人可报 vs 他人被拒"的授权契约不依赖具体是谁。
        // （场景拥有该数据；直接改派生事实，测的是 API 授权行为本身。）
        const freshPool = await request('GET', '/api/scheduler/executions', null, adminToken);
        let ownCandidate = (freshPool.body?.executions ?? []).find((e) => e.personId
          && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(e.status));
        if (!ownCandidate) {
          // 排除主腿目标行：那是步骤 6-7 的被测对象，改写它会污染主断言。
          ownCandidate = (freshPool.body?.executions ?? [])
            .find((e) => e.assignmentId !== target?.assignmentId) ?? null;
          if (ownCandidate) {
            await sql`update ewoh_scheduling_execution
               set status = 'STARTED', actual_end_at = null, actual_start_at = now()
               where assignment_id = ${ownCandidate.assignmentId}`;
          }
        }
        if (ownCandidate) {
          // 授权比较的是 **assignment.personId**（计划派工行），执行行 person_id
          // 同步改保持一致；种子行选 STARTED 态（worker 角色只能做 START→COMPLETED）。
          await sql`update ewoh_scheduling_plan_assignment
             set person_id = ${boundPerson}::uuid
             where assignment_id = ${ownCandidate.assignmentId}`;
          // STARTED 必须带 actual_start：服务端对 STARTED/COMPLETED 有
          // 「先有实际开始时间」的事实保护（RECEIPT_START_REQUIRED）。
          // 直改派生事实时补齐该列，否则步骤 20 会因缺开始时间被正确拒绝。
          await sql`update ewoh_scheduling_execution
             set person_id = ${boundPerson}::uuid, status = 'STARTED', actual_start_at = now()
             where assignment_id = ${ownCandidate.assignmentId}`;
        }
        // 找一条分配给"我"的可回执记录。
        // 用 `field/my-work`（按人收敛、worker 可达）而不是全厂 `executions`：
        // 后者对 worker 是 403，若把 403 当成空列表就会把"权限不足"静默读成
        // "没有任务"——正是本项目禁止的伪造确定性。
        const mineRes = await request('GET', '/api/scheduler/field/my-work', null, fieldToken);
        if (mineRes.status !== 200) {
          step('20. 本人可回执自己的任务', false,
            `field/my-work HTTP ${mineRes.status} msg=${errText(mineRes)}`);
        }
        const mine = (mineRes.body?.executions ?? []);
        const target2 = mine.find((e) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(e.status));
        if (mineRes.status !== 200) {
          skip('21. 他人任务被拒', 'field/my-work 不可用，越权路径未验证');
        } else if (!target2) {
          skip('20. 本人可回执自己的任务', `绑定人员 ${boundPerson} 当前没有未终结执行记录`);
          skip('21. 他人任务被拒', '缺少可用于越权验证的他人记录');
        } else {
          // 按当前状态选择回执动作：PLANNED→START，已 START→COMPLETED。
          // 对已 START 记录重发不同 actualStartAt 会被服务端以
          // RECEIPT_FEEDBACK_FACT_CONFLICT 正确拒绝（事实冲突保护），
          // 因此跨轮重跑时改发合法的下一状态而不是伪造一致事实。
          const ownBody = target2.status === 'PLANNED'
            ? { status: 'STARTED', actualStartAt: new Date().toISOString(), reportedSource: 'simulated' }
            : { status: 'COMPLETED', actualEndAt: new Date().toISOString(), reportedSource: 'simulated' };
          const own = await request('POST', `/api/scheduler/executions/${encodeURIComponent(target2.assignmentId)}/update`, ownBody, fieldToken);
          step('20. 本人可回执自己的任务（修复前结构性不可达）',
            own.status === 200 || own.status === 201,
            `status=${own.status} action=${ownBody.status} assignment=${target2.assignmentId} msg=${errText(own)}`);

          // 越权：同租户内换一条不属于自己的记录，必须被拒。
          const others = (execsAll.body?.executions ?? [])
            .filter((e) => e.personId && e.personId !== boundPerson);
          if (!others.length) {
            skip('21. 他人任务被拒', '库中没有他人未终结记录可供越权验证');
          } else {
            // 越权目标行若已带开始事实，服务端会先按「事实不可变」409 拒绝
            // （事实保护生效，但那是事实保护不是授权保护）。清掉开始事实后再试，
            // 使 403 授权拒绝成为确定结果——本步测的是授权，不是事实保护。
            await sql`update ewoh_scheduling_execution
               set actual_start_at = null where assignment_id = ${others[0].assignmentId}`;
            const intrude = await request('POST', `/api/scheduler/executions/${encodeURIComponent(others[0].assignmentId)}/update`, {
              status: 'STARTED', actualStartAt: new Date().toISOString(), reportedSource: 'simulated',
            }, fieldToken);
            step('21. 回执他人任务被拒（403）', intrude.status === 403,
              `status=${intrude.status} assignment=${others[0].assignmentId} msg=${errText(intrude)}`);
          }
        }
      }
    }

    // 18. 反馈携带与执行记录一致的偏差事实（可比较预计/实际）
    const [dev] = await sql`
      SELECT planned_start, planned_end, actual_start, actual_end
        FROM public.ewoh_scheduling_feedback
       WHERE assignment_id = ${target.assignmentId}
       ORDER BY _updated_at DESC LIMIT 1`;
    const hasPlanned = Boolean(dev?.planned_start) && Boolean(dev?.planned_end);
    const hasActual = Boolean(dev?.actual_start) && Boolean(dev?.actual_end);
    step('18. 预计与实际时间可比较（偏差计算输入齐备）', hasPlanned && hasActual,
      `planned=${hasPlanned} actual=${hasActual}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  return finish();
}

function finish() {
  const passed = results.filter((r) => r.status === 'PASS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log('\n========================================');
  console.log(`Receipt Closed Loop: ${passed.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP（共 ${results.length}）`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
  if (skipped.length) {
    console.log('SKIPPED（未验证，非通过）:', skipped.map((s) => s.name).join('; '));
    if (!failed.length) process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error('Receipt closed loop failed:', error.message);
  process.exit(1);
});
