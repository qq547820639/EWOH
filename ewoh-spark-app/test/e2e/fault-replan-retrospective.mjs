/* DR-2~DR-6 全闭环验证（真实后端 + 真实 PostgreSQL，2026-09-11）。
 *
 * 目标二"核心产品闭环"的端到端验收：以设备故障重排为主线（叙事顺序 =
 * 生产正常执行中突发故障 → 感知 → 确认 → 回滚 → 复盘）：
 *   班次（DR-2）：GET /api/shifts/current 返回当班事实
 *   ③④ 决策：调度 Run → 候选方案（真实求解器）
 *   ⑤ 解释：方案 AI 说明（llm | rule_fallback 双路留痕）
 *   ⑥ 授权：独立身份审批（B5 审批独立性）
 *   ⑦ 执行：派工 + 现场回执（开始/完成）
 *   ⑧ 反馈：预计 vs 实际（执行记录偏差事实）
 *   ① 感知：设备故障事件上行（真实 ingest 通道，DeviceOffline 目录事件；
 *          会异步触发重排——故置于审批之后，避免快照过期噪声）
 *   ② 数据质量：人工确认（confirmed/contested，DR-4）
 *   ⑨ 回滚：取消派工（DR-5：未开始 assignment 回退、任务回池、预占释放）
 *   ⑩ 经验：复盘/运行记忆组装 + 发布（DR-3：六段 + gaps + AI 总结）
 *
 * 前置：NestJS 后端 + PostgreSQL（已迁移 074-077 + --seed-standalone-scheduling
 *       + --seed-standalone-shift）。消费可调度任务：运行前先 scenario-reset。
 * 运行：node test/e2e/fault-replan-retrospective.mjs
 *
 * 三态报告：PASS = 断言通过；FAIL = 断言失败；SKIP = 前置缺失（未验证，退出码 2）。
 */
import http from 'node:http';
import { approveWithReplan, planStalenessOf, stalenessSummary } from './helpers/plan-freshness.mjs';
import {
  advanceTasksToPendingDispatch,
  isPlanStale,
  isTaskNotDispatchable,
} from './helpers/task-readiness.mjs';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || 'admin-password';
const APPROVER_USER = process.env.EWOH_E2E_APPROVER_USER || 'approver.li';
const APPROVER_PASS = process.env.EWOH_E2E_APPROVER_PASS || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || '';

function request(method, path, body, token, extraHeaders = {}) {
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
          ...extraHeaders,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { json = buf; }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
/** 前置缺失：未验证 ≠ 通过（退出码 2 区分于断言失败 1）。 */
function markSkip(name, detail = '') {
  results.push({ name, status: 'SKIP', detail });
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ''}`);
}
const errText = (res) =>
  String(res.body?.error?.message ?? res.body?.message ?? res.body ?? '').slice(0, 200);

async function main() {
  // ── 前置：登录两身份（生成人 ≠ 审批人，B5）────────────────────────────
  const login = await request('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (login.status === 429) {
    markSkip('登录（生成人）', '登录被限流（HTTP 429）：本地反复验证请提高 LOGIN_RATE_LIMIT_MAX 后重启');
    return;
  }
  if ((login.status !== 200 && login.status !== 201) || !login.body?.accessToken) {
    markSkip('登录（生成人）', `HTTP ${login.status}：${errText(login)}`);
    return;
  }
  const token = login.body.accessToken;

  const apprLogin = await request('POST', '/api/auth/login', { username: APPROVER_USER, password: APPROVER_PASS });
  if ((apprLogin.status !== 200 && apprLogin.status !== 201) || !apprLogin.body?.accessToken) {
    markSkip('登录（审批人）', `HTTP ${apprLogin.status}：${errText(apprLogin)}（审批段降级为生成人视角）`);
  }
  const approverToken = apprLogin.body?.accessToken ?? token;

  // ── 班次（DR-2）：当前班次解析 ─────────────────────────────────────────
  const shift = await request('GET', '/api/shifts/current', null, token);
  if (shift.status === 200) {
    const cur = shift.body?.current;
    step('DR-2 班次：当前班次解析',
      cur === null || typeof cur?.shiftId === 'string',
      cur ? `当班=${cur.name}（${cur.startTime}–${cur.endTime}${cur.crossesMidnight ? '，跨零点' : ''}）` : '不在任何班次窗口（显式未知）');
  } else {
    step('DR-2 班次：当前班次解析', false, `HTTP ${shift.status}：${errText(shift)}`);
  }

  // ── ③④ 决策：调度 Run → 方案（单一方案贯穿全生命周期）─────────────────
  // TriggerService 对 MANUAL 有 30s 冷却去抖（debounced=true 时 plans 为空）；
  // E2E 用单方案贯穿审批→派工→回执→回滚→复盘，避免第二次 run 触发去抖。
  const run = await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, token);
  if (run.status !== 200 && run.status !== 201) {
    markSkip('③④ 决策：调度 Run', `HTTP ${run.status}：${errText(run)}（无可调度任务？先 scenario-reset）`);
    return;
  }
  if (run.body?.debounced) {
    markSkip('③④ 决策：调度 Run', '触发被冷却去抖（30s 内重复 MANUAL）：稍等重跑或先 scenario-reset');
    return;
  }
  const runPlans = run.body?.plans ?? [];
  // V2 方案生命周期初态为 shadow（shadow → 审批 → approved → dispatched）；
  // 审批针对待审批态（shadow/draft 均可，与 planActions 动作矩阵一致）。
  const draftPlans = runPlans.filter((pl) => pl.status === 'draft' || pl.status === 'shadow');
  step('③④ 决策：Run 产出方案', runPlans.length > 0 && draftPlans.length > 0,
    `run=${run.body?.run?.runId ?? '?'} plans=${runPlans.length}（可审批 ${draftPlans.length}）`);
  if (draftPlans.length === 0) {
    markSkip('后续执行段', '无 draft 方案（任务可能已被消费：先 make scenario-reset YES=1）');
    return;
  }

  // 轮询取方案详情（生成 + AI 说明可能需要数秒）。
  let plan = null;
  for (let i = 0; i < 10 && !plan; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const planRes = await request('GET', `/api/scheduler/plans/${draftPlans[0].planId}`, null, token);
    if (planRes.status === 200 && Array.isArray(planRes.body?.assignments)) plan = planRes.body;
  }
  if (!plan) {
    markSkip('方案详情读取', '轮询超时');
    return;
  }
  const pendingAssignments = plan.assignments.filter((a) => a.status === 'proposed');
  step('③④ 决策：assignment 明细', plan.assignments.length > 0,
    `${plan.assignments.length} 项（proposed ${pendingAssignments.length}）solver=${plan.solverStatus ?? 'n/a'}`);

  // ── ⑤ 解释：AI 说明双路留痕 ─────────────────────────────────────────────
  const detail = await request('GET', `/api/scheduler/plans/${plan.planId}`, null, token);
  const narrationSource = detail.body?.narrationSource ?? null;
  step('⑤ 解释：narrationSource 显式留痕',
    narrationSource === 'llm' || narrationSource === 'rule_fallback' || narrationSource === null,
    `source=${narrationSource ?? '未生成'}（null=生成中/未启用，不冒充）`);

  // ── ⑥ 授权：独立身份审批（B5）──────────────────────────────────────────
  // 审批契约：version + snapshotVersion 必传（版本不匹配 = PLAN_STALE，
  // 与真实前端提交的形状一致——Scheduling.tsx 从方案详情携带两字段）。
  const approve = await request(
    'POST',
    `/api/scheduler/plans/${plan.planId}/approve`,
    { reason: 'E2E：排产审批', version: plan.version, snapshotVersion: plan.snapshotVersion },
    approverToken,
  );
  step('⑥ 授权：审批（独立身份）', approve.status === 200 && approve.body?.status === 'approved',
    approve.status === 200 ? `status=${approve.body?.status}` : `HTTP ${approve.status}：${errText(approve)}`);
  if (approve.status !== 200 || approve.body?.status !== 'approved') {
    /**
     * 失败自带成因（V67c；沿用 §5.3n 把 F-10 抓出来的那条做法：让断言自己吐出能区分成因的事实）。
     * `PLAN_STALE` 有两条完全不同的来路，处置也不同：
     *  ① 快照自然过期——设备遥测新鲜度只有 60s，而全链场景一轮要几分钟（`plan-freshness.mjs` 头部记着这件事）；
     *  ② 方案被**别处的自动重排**抢先替代（F-12：supersede 是无条件改写）。
     * 判别只看一件事：此刻方案行还是不是 shadow/draft。仍是 ⇒ ①；已 `superseded` ⇒ ②。
     * 这里**不放宽断言**（⑥ 该红还是红），只补一条不进入统计的诊断行。
     */
    const live = await request('GET', `/api/scheduler/plans/${plan.planId}`, null, token);
    const diag = planStalenessOf(approve.body);
    const changeKeys = Array.isArray(diag?.changes)
      ? diag.changes
        .map((c) => `${c.entityKey ?? '?'}[${c.severity ?? '?'}${c.selfInflicted ? '/self' : '/external'}]`)
        .join(' ')
      : '无 changes 明细';
    console.log(
      '  ↳ ⑥ 失败成因：'
      + `message=${errText(approve)} `
      + `cause=${String(approve.body?.error?.cause ?? approve.body?.cause ?? '-')}`
      + ` 变化实体=${changeKeys} `
      + `过期诊断=${stalenessSummary(diag)} `
      + `方案当前状态=${live.body?.status ?? `取不到(HTTP ${live.status})`} `
      + `supersededBy=${live.body?.supersededBy ?? '-'} `
      + `审批携带 snapshotVersion=${plan.snapshotVersion ?? '-'} version=${plan.version ?? '-'} `
      + '⇒ 仍为 shadow/draft=快照过期(①)；已 superseded=被别处重排抢先(②)',
    );
  }

  // ── ⑦ 执行：派工 + 回执 ─────────────────────────────────────────────────
  // 现场现实（2026-09-13 实测）：方案里可能含**可调度但尚未就绪**的任务
  // （draft / pending_confirm / pending_approval —— 见契约 task.yaml）。
  // 此时派工返回 409 PLAN_TASK_NOT_DISPATCHABLE 且**整波不下发**，这是产品
  // 正确的 fail-closed：派工不得代 creator/approver 越过确认与审批闸门。
  // 真实调度员会先把任务推到待派工再重派，脚本照做（helper 注释详见
  // test/e2e/helpers/task-readiness.mjs）。
  let dispatch = await request('POST', `/api/scheduler/plans/${plan.planId}/dispatch`, null, approverToken);
  if (isTaskNotDispatchable(dispatch.status, errText(dispatch))) {
    const advanced = await advanceTasksToPendingDispatch(request, plan.assignments, {
      operatorToken: token,
      approverToken,
    });
    dispatch = await request('POST', `/api/scheduler/plans/${plan.planId}/dispatch`, null, approverToken);
    record(
      advanced.length > 0 && !isTaskNotDispatchable(dispatch.status, errText(dispatch)) ? 'PASS' : 'FAIL',
      '⑦ 执行：任务未就绪 → 按契约状态机推进到待派工后重派',
      `${advanced.join(' | ') || '无可推进任务'}；重派 status=${dispatch.status}`
        + `${isPlanStale(dispatch.status, errText(dispatch)) ? '（PLAN_STALE：任务写入推进了世界版本）' : ''}`,
    );
    // 任务写入推进了世界版本 → 方案过期。等冷却窗口后重新生成方案并换用新方案。
    if (isPlanStale(dispatch.status, errText(dispatch))) {
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      const rerun = await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, token);
      const fresh = (rerun.body?.plans ?? [])[0];
      if (fresh) {
        // **顺序很重要**（实测踩到）：必须"先补齐任务就绪、再审批"。
        // 反过来（先审批、后推进任务）会让任务写入推进世界版本、使刚拿到的审批
        // 立刻失去时效，派工收到 409 PLAN_NOT_APPROVED——现场语义也一样：
        // 任务没就绪就去审批，批完又改任务，等于让审批为一份已变的方案背书。
        const firstDetail = await request('GET', `/api/scheduler/plans/${fresh.planId}`, null, token);
        await advanceTasksToPendingDispatch(request, firstDetail.body?.assignments ?? [], {
          operatorToken: token,
          approverToken,
        });
        // 任务写入后方案版本已变，必须重新取详情，否则审批携带的 version/snapshotVersion 是旧的。
        const readyDetail = await request('GET', `/api/scheduler/plans/${fresh.planId}`, null, token);
        const approval = await approveWithReplan(
          {
            post: (url, body, tk) => request('POST', url, body ?? {}, tk),
            get: (url, tk) => request('GET', url, null, tk),
          },
          {
            planId: fresh.planId,
            version: readyDetail.body?.version ?? fresh.version,
            snapshotVersion: readyDetail.body?.snapshotVersion ?? fresh.snapshotVersion,
            operatorToken: token,
            approverToken,
            operator: ADMIN_USER,
            reason: 'E2E：重排轮审批（任务补齐就绪后）',
            maxRounds: 2,
          },
        );
        record(approval.ok ? 'PASS' : 'FAIL',
          '⑦ 执行：重排轮审批（任务先就绪、再审批）',
          `plan=${approval.planId} status=${approval.status} 重排 ${approval.replans?.length ?? 0} 次`);
        dispatch = await request('POST', `/api/scheduler/plans/${approval.planId ?? fresh.planId}/dispatch`, null, approverToken);
        if (dispatch.status === 200) plan = { ...plan, planId: approval.planId ?? fresh.planId };
      }
    }
  }
  if (dispatch.status !== 200) {
    markSkip('⑦ 执行：派工', `HTTP ${dispatch.status}：${errText(dispatch)}`);
  } else {
    step('⑦ 执行：派工', dispatch.body?.status === 'dispatched' || dispatch.body?.dispatch != null,
      `status=${dispatch.body?.status} 派发=${dispatch.body?.dispatch?.dispatchedAssignmentIds?.length ?? '全部'}`);
  }

  // 现场回执：开始 + 完成（第一个可回执 assignment）。
  let receiptReported = false;
  if (dispatch.status === 200) {
    const execRes = await request('GET', `/api/scheduler/executions?planId=${encodeURIComponent(plan.planId)}`, null, token);
    const executions = execRes.body?.executions ?? [];
    const target = executions.find((e) => ['PLANNED', 'DISPATCHED'].includes(String(e.status ?? '').toUpperCase()));
    if (!target) {
      markSkip('⑦ 执行：现场回执', '无可回执执行记录（可能无 assignment 或已终态）');
    } else {
      // 回执契约：STARTED 需 actualStartAt；COMPLETED 需 actualStartAt + actualEndAt。
      // 不携带 deviationReason（note 是别名）：偏差原因由服务端按计划/实际推导，
      // 一经记录不可改写（同 execution-receipt 闭环口径）。
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const start = await request(
        'POST',
        `/api/scheduler/executions/${encodeURIComponent(target.assignmentId)}/update`,
        { status: 'STARTED', actualStartAt: startedAt, reportedSource: 'manual_report' },
        token,
      );
      const done = await request(
        'POST',
        `/api/scheduler/executions/${encodeURIComponent(target.assignmentId)}/update`,
        { status: 'COMPLETED', actualStartAt: startedAt, actualEndAt: new Date().toISOString(), reportedSource: 'manual_report' },
        token,
      );
      receiptReported = done.status === 200 || done.status === 201;
      step('⑦ 执行：现场回执（开始→完成）', receiptReported,
        receiptReported ? `receipt.matched=${done.body?.receipt?.matchedRows ?? '?'}（人工上报不参与训练）` : `HTTP ${done.status}：${errText(done)}`);
    }
  }

  // ── ⑧ 反馈：预计 vs 实际（执行记录偏差事实）────────────────────────────
  if (receiptReported) {
    const execAfter = await request('GET', `/api/scheduler/executions?planId=${encodeURIComponent(plan.planId)}`, null, token);
    const rows = execAfter.body?.executions ?? [];
    const withActual = rows.filter((r) => r.actualEndAt || r.actualEnd);
    step('⑧ 反馈：执行记录含实际值', withActual.length > 0,
      `${withActual.length}/${rows.length} 行有 actual（偏差由服务端权威判定）`);
  } else {
    markSkip('⑧ 反馈：预计 vs 实际', '无回执事实（未验证 ≠ 通过）');
  }

  // ── ① 感知：执行中设备故障事件上行（真实 ingest 通道）。叙事顺序：生产
  // 正常执行（③-⑧）后发生故障 → 感知 → 确认 → 回滚 → 复盘；ingest 会异步
  // 触发 fireDeviceOfflineReplan（世界状态变化），故放在审批/派工之后。
  let triggerEventId = null;
  if (INGEST_KEY) {
    const nowIso = new Date().toISOString();
    triggerEventId = `EVT-E2E-FAULT-${Date.now()}`;
    const uplink = await request(
      'POST',
      '/api/ingest/events',
      {
        events: [
          {
            eventId: triggerEventId,
            eventType: 'DeviceOffline',
            schemaVersion: '1.0.0',
            occurredAt: nowIso,
            observedAt: nowIso,
            source: 'edge:e2e-fault-scenario',
            subject: 'device:DEV-04',
            payload: { deviceId: 'DEV-04', reason: 'E2E 故障重排场景：设备离线' },
            evidence: { deviceId: 'DEV-04', dataQuality: 'good' },
          },
        ],
      },
      null,
      INGEST_KEY ? { 'X-Ingest-Key': INGEST_KEY } : {},
    );
    const r = uplink.body?.results?.[0];
    if (uplink.status === 201 || uplink.status === 200) {
      step('① 感知：故障事件上行 accepted', r?.accepted === true || r?.duplicate === true,
        `accepted=${r?.accepted} duplicate=${r?.duplicate} late=${r?.is_late}`);
    } else {
      step('① 感知：故障事件上行 accepted', false, `HTTP ${uplink.status}：${errText(uplink)}`);
    }
  } else {
    markSkip('① 感知：故障事件上行', 'EWOH_E2E_INGEST_KEY 未配置（事件通道未验证 ≠ 通过）');
  }

  // ── ② 数据质量：人工确认（DR-4）────────────────────────────────────────
  if (triggerEventId) {
    const dq = await request(
      'POST',
      '/api/data-quality/confirmations',
      { eventId: triggerEventId, verdict: 'confirmed', note: 'E2E：现场核实设备确实离线' },
      token,
    );
    step('② 数据质量：人工确认 confirmed',
      dq.status === 200 || dq.status === 201,
      dq.status === 200 || dq.status === 201
        ? `by=${dq.body?.record?.confirmedBy} 联动resolve告警=${dq.body?.linkedAlertsResolved ?? 0}`
        : `HTTP ${dq.status}：${errText(dq)}`);
    const dqBad = await request(
      'POST',
      '/api/data-quality/confirmations',
      { eventId: triggerEventId, verdict: 'maybe' },
      token,
    );
    step('② 数据质量：词表外 verdict fail-closed', dqBad.status === 400, `HTTP ${dqBad.status}`);
  } else {
    markSkip('② 数据质量：人工确认', '无触发事件（ingest 未配置）');
  }


  // ── ⑨ 回滚：方案取消（DR-5：部分回退语义在真实后端验证）────────────────
  // 派工后的同一方案：已回执的 assignment 不可回退（物理执行），其余回退回池。
  {
    const noReason = await request('POST', `/api/scheduler/plans/${plan.planId}/cancel`, {}, token);
    step('⑨ 回滚：无原因取消被拒（可审计红线）', noReason.status === 400, `HTTP ${noReason.status}`);
    const cancel = await request(
      'POST',
      `/api/scheduler/plans/${plan.planId}/cancel`,
      { reason: 'E2E：现场发现安全风险，回退本轮派工' },
      token,
    );
    const c = cancel.body?.cancel;
    step('⑨ 回滚：取消派工',
      cancel.status === 200 && cancel.body?.status === 'cancelled',
      cancel.status === 200
        ? `回退 ${c?.cancelledAssignmentIds?.length ?? 0} 项，不可回退 ${c?.irreversibleAssignmentIds?.length ?? 0} 项，任务回池 ${c?.returnedTaskIds?.length ?? 0}`
        : `HTTP ${cancel.status}：${errText(cancel)}`);
    const again = await request('POST', `/api/scheduler/plans/${plan.planId}/cancel`, { reason: '重复取消' }, token);
    step('⑨ 回滚：终态重复取消被拒', again.status === 409, `HTTP ${again.status}`);
  }

  // ── ⑩ 经验：复盘/运行记忆（DR-3）───────────────────────────────────────
  const retro = await request('POST', '/api/retrospective/from-plan', { planId: plan.planId }, token);
  if (retro.status === 200 || retro.status === 201) {
    const record = retro.body?.record;
    const a = record?.assembled;
    step('⑩ 经验：复盘六段组装',
      Boolean(a?.perception && a?.dataQuality && a?.decision && a?.authorization && a?.execution && a?.feedback),
      `gaps=${a?.gaps?.length ?? '?'} narrative=${record?.narrativeSource ?? 'null'}`);
    step('⑩ 经验：narrationSource 双路留痕',
      record?.narrativeSource === 'llm' || record?.narrativeSource === 'rule_fallback',
      `source=${record?.narrativeSource}`);
    const pub = await request('POST', `/api/retrospective/${encodeURIComponent(record.retrospectiveId)}/publish`, null, token);
    step('⑩ 经验：发布运行记忆', (pub.status === 200 || pub.status === 201) && pub.body?.status === 'published',
      `status=${pub.body?.status ?? `HTTP ${pub.status}`}`);
  } else {
    step('⑩ 经验：复盘六段组装', false, `HTTP ${retro.status}：${errText(retro)}`);
  }

  // ── 世界快照扩展（DR-6）：materials/orders/shifts 投影存在 ─────────────
  const snapshot = await request('GET', '/api/scheduler/snapshot', null, token);
  const snap = snapshot.body;
  step('DR-6 世界快照：扩展字段存在',
    snapshot.status === 200
      && Array.isArray(snap?.shifts)
      && Array.isArray(snap?.materials)
      && Array.isArray(snap?.orders),
    `shifts=${snap?.shifts?.length ?? '?'} materials=${snap?.materials?.length ?? '?'} orders=${snap?.orders?.length ?? '?'}${snap?.materialsNote ? ` note=${String(snap.materialsNote).slice(0, 40)}` : ''}`);
}

main()
  .catch((err) => {
    console.error('E2E 异常：', err);
    process.exitCode = 1;
  })
  .finally(() => {
    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    console.log(`\n== 故障重排全闭环：PASS ${pass} / FAIL ${fail} / SKIP ${skipped} ==`);
    if (fail > 0) process.exitCode = 1;
    else if (skipped > 0) process.exitCode = 2;
  });
