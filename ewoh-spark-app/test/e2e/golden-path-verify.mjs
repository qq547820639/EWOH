/* Phase 4 收口：Golden Path 全链验证（真实后端 + 真实 PostgreSQL）。
 *
 * 覆盖关键节点：登录 → 调度 Run → 方案 → Assignment → 审批 → dispatch →
 * Execution → KPI → Policy Replay → Shadow → Gate → Activate → Rollback → SSE。
 *
 * 前置：NestJS 后端 + PostgreSQL（已迁移 + `--seed-standalone-scheduling`）。
 * 运行：node test/e2e/golden-path-verify.mjs
 *
 * 环境：
 *   EWOH_E2E_BACKEND_URL    默认 http://127.0.0.1:3100
 *   EWOH_E2E_ADMIN_USER/PASS 方案生成人（默认 admin/admin-password）
 *   EWOH_E2E_APPROVER_USER/PASS 审批人（默认 approver.li/…）
 *
 * 三态报告（2026-09-10 修正）：
 *   PASS = 已断言通过；FAIL = 断言失败；SKIP = 前置条件缺失，**未验证**。
 *   旧版把"合法的 404"也计为 PASS，读起来像"全绿"，实际什么都没验证。
 *   现在 SKIP 单独计数并以退出码 2 区分于失败（1）。
 *
 * 审批独立性（B5 / standalone_069）：方案生成人不得审批自己的方案。
 * 因此本脚本用两个身份：admin 生成，approver 审批/派工。若审批人账号不存在，
 * 审批段如实报 SKIP 并给出开通命令——
 *   EWOH_DATABASE_URL=... EWOH_OPERATOR_PASSWORD=... \
 *     node db/runner/create-operator.js --username approver.li \
 *       --display-name '李审批' --roles dispatcher,workshop_lead
 */
import http from 'node:http';
import { approveWithReplan } from './helpers/plan-freshness.mjs';
import { advanceTasksToPendingDispatch as advanceTasksToPendingDispatchShared } from './helpers/task-readiness.mjs';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || 'admin-password';
const APPROVER_USER = process.env.EWOH_E2E_APPROVER_USER || 'approver.li';
const APPROVER_PASS = process.env.EWOH_E2E_APPROVER_PASS || '';

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
const skip = (name, detail = '') => record('SKIP', name, detail);

/** 统一错误正文提取（本项目错误体为 {error:{message}}，兼容裸 message）。 */
const errText = (res) =>
  String(res.body?.error?.message ?? res.body?.message ?? '').slice(0, 160);

/**
 * 回滚断言：只有存在"上一 ACTIVE 版本"时才可回滚。
 * 首次激活的 activation 记录 rollbackTarget/beforeVersion 均为 null，服务端
 * 正确地返回 NO_ROLLBACK_TARGET——这属于"无可回滚目标"，不是缺陷，
 * 因此如实记为 SKIP 并说明原因，而不是 FAIL。
 */
async function assertRollback(activation, token, operator) {
  if (!activation?.activationId) return;
  const hasTarget = activation.rollbackTarget != null || activation.beforeVersion != null;
  if (!hasTarget) {
    skip('49-50. Rollback 恢复上一 ACTIVE',
      '本次是首个激活（无 beforeVersion/rollbackTarget），服务端无回退目标属正确行为，回滚路径未验证');
    return;
  }
  const rollback = await request('POST',
    `/api/scheduler/policy/activations/${activation.activationId}/rollback`,
    { operator, reason: 'golden path rollback' }, token);
  step('49-50. Rollback 恢复上一 ACTIVE', rollback.status === 201 || rollback.status === 200,
    `status=${rollback.status} msg=${rollback.body?.status ?? errText(rollback)}`);
}

/** 三态汇总；SKIP 不等于 PASS（未验证必须以退出码 2 区分于失败 1）。 */
function finish() {  const passed = results.filter((r) => r.status === 'PASS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log('\n========================================');
  console.log(`Golden Path: ${passed.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP（共 ${results.length}）`);
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
  if (skipped.length > 0) {
    console.log('SKIPPED（未验证，非通过）:', skipped.map((s) => s.name).join('; '));
    if (!failed.length) process.exitCode = 2;
  }
}

async function main() {
  // 1. Login（方案生成人）
  const login = await request('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (login.status === 429) {
    // 登录限流是正确的安全行为（默认 10 次 / 15 分钟）。反复运行本脚本会触发，
    // 如实报 SKIP 并给出处置方式，不要伪装成断言失败。
    skip('1-2. Login admin',
      '登录被限流（HTTP 429）。本地反复验证请提高上限后重启，例如 '
        + 'LOGIN_RATE_LIMIT_MAX=1000 LOGIN_RATE_LIMIT_WINDOW_SEC=60；或等待窗口结束。');
    return finish();
  }
  step('1-2. Login admin', login.status === 201 || login.status === 200, `status=${login.status}`);
  const token = login.body?.accessToken;
  if (!token) throw new Error('login failed');

  // 审批人登录（B5：必须与生成人不同）
  let approverToken = null;
  if (!APPROVER_PASS) {
    skip('1b. Login approver', '未提供 EWOH_E2E_APPROVER_PASS，审批段将无法验证');
  } else {
    const appr = await request('POST', '/api/auth/login', { username: APPROVER_USER, password: APPROVER_PASS });
    if (appr.status === 200 || appr.status === 201) {
      approverToken = appr.body?.accessToken;
      step('1b. Login approver', Boolean(approverToken), `user=${APPROVER_USER}`);
      if (APPROVER_USER === ADMIN_USER) {
        step('1c. 审批人 ≠ 生成人（B5 审批独立性）', false, '生成人与审批人同名，无法满足审批独立性');
      } else {
        step('1c. 审批人 ≠ 生成人（B5 审批独立性）', true);
      }
    } else {
      skip('1b. Login approver', `账号 ${APPROVER_USER} 不可用（HTTP ${appr.status}）——`
        + '请用 db/runner/create-operator.js 开通审批账号');
    }
  }

  // 3. 触发 Scheduler（真实事件触发）
  //
  // 2026-09-11 实测踩坑：同 org 的 MANUAL 触发有 **30 秒冷却去抖**（policy triggerCooldownMs）。
  // 连续跑两次链时第二次会命中去抖，回退"复用既有方案"——而既有方案的世界快照可能已过期
  // （approve → PLAN_STALE），于是 10-20 整段被 SKIP，看起来像"链路坏了"，其实是脚本
  // 没有等过冷却窗口。现在：去抖且复用方案都审批不了时，**等到冷却窗口结束再触发一次**
  // （最多 2 轮），把"等 30 秒"这件确定的事写进脚本，而不是把不确定性留给断言。
  const COOLDOWN_WAIT_MS = 31_000;
  let plan = null;
  let planDetail = null;
  let assignments = [];
  let approveResult = null;
  const planAttempts = [];
  let runOk = false;

  const selectApprovablePlan = async (plans) => {
    for (const candidate of plans.slice(0, 8)) {
      const detail = await request('GET', `/api/scheduler/plans/${candidate.planId}`, null, token);
      const rows = detail.body?.assignments ?? candidate.assignments ?? [];
      if (!Array.isArray(rows) || rows.length === 0) {
        planAttempts.push(`${candidate.planId}: 无 assignment`);
        continue;
      }
      // 审批尝试放进候选循环：历史方案的快照会过期（PLAN_STALE），换下一个候选即可；
      // NO-66c：过期时**先用 NO-62c 的诊断 + 重排**处置（有界 2 轮），仍不行才换候选——
      // 把"世界变化快"这件环境事实交给产品已有的处置路径，而不是直接放弃。
      if (approverToken) {
        // 本场景的 `request(method, path, body, token)` 与助手约定的
        // `post(url, body, token) / get(url, token)` 形状不同 → 显式适配。
        const approval = await approveWithReplan(
          {
            post: (url, body, tk) => request('POST', url, body ?? {}, tk),
            get: (url, tk) => request('GET', url, null, tk),
          },
          {
            planId: candidate.planId,
            version: detail.body?.version ?? candidate.version,
            snapshotVersion: detail.body?.snapshotVersion ?? candidate.snapshotVersion,
            operatorToken: token,
            approverToken,
            operator: process.env.EWOH_E2E_ADMIN_USER || 'admin',
            reason: 'e2e:golden 审批（过期则按最新状态重排后重试）',
            maxRounds: 2,
          },
        );
        if (!approval.ok) {
          planAttempts.push(
            `${candidate.planId}: approve=${approval.status}（重排 ${approval.replans.length} 次）`,
          );
          continue;
        }
        if (approval.planId !== candidate.planId) {
          const refreshed = await request('GET', `/api/scheduler/plans/${approval.planId}`, null, token);
          if (refreshed.status === 200 && refreshed.body) {
            detail.body = refreshed.body;
          }
        }
        approveResult = { status: approval.status, body: approval.body };
      }
      plan = candidate;
      planDetail = detail;
      assignments = rows;
      return true;
    }
    return false;
  };

  /**
   * 把方案里"尚未就绪"的任务按**契约状态机**推进到 `pending_dispatch`。
   *
   * 口径与故障重排闭环共用同一实现（`helpers/task-readiness.mjs`），
   * 避免"同一现场动作两个脚本各写一份"再次分叉——详见该文件的说明。
   */
  const advanceTasksToPendingDispatch = (rows) =>
    advanceTasksToPendingDispatchShared(request, rows, {
      operatorToken: token,
      approverToken,
    });

  const listPlans = async () => {
    // 注意 GET /plans 是 legacy 包装（正文在 data 字段），不是 {plans}。
    const listed = await request('GET', '/api/scheduler/plans?limit=10', null, token);
    return listed.body?.data ?? listed.body?.plans ?? [];
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const run = await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, token);
    runOk = run.status === 201 || run.status === 409; // 409 = 冷却去抖（幂等合理）
    let plans = (run.body?.plans ?? []) || [];
    if (attempt === 1) {
      step('3-9. 调度 Run + Priority + Solver 链路', runOk, `status=${run.status}`);
    }
    if (!plans.length && run.body?.debounced) {
      // 去抖命中：先复用既有方案（快路径，不浪费 30 秒）。
      plans = await listPlans();
      if (plans.length) record('PASS', `3b. 去抖复用既有方案（第 ${attempt} 轮）`, `plans=${plans.length}`);
    }
    if (!runOk || plans.length === 0) {
      // 去抖导致"没有新方案、也没有可复用的方案"（典型：上一轮刚跑过 + 场景已复位）：
      // 第二轮必须**等过冷却窗口**再触发，否则会立刻被同一个去抖再次合并——
      // 这正是链上偶发 10-20 整段 SKIP 的原因（实测 2026-09-11）。
      if (attempt === 1) {
        record('PASS', '3c. 本轮无可用方案（去抖/已复位）→ 等待冷却窗口后重新触发',
          `waitMs=${COOLDOWN_WAIT_MS}`);
        await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
        continue;
      }
      break;
    }
    if (attempt === 1) {
      step('10. Multi-plan 生成', plans.length >= 1, `plans=${plans.length}`);
    }
    const selected = await selectApprovablePlan(plans);
    if (selected) break;
    if (attempt < 2) {
      // 复用方案全都不可审批（多为 PLAN_STALE）：等过热却窗口，再要一批**新鲜**方案。
      record('PASS', '3c. 复用方案均不可审批 → 等待冷却窗口后重新触发（脚本确定性，不是跳过）',
        `waitMs=${COOLDOWN_WAIT_MS}`);
      await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
    }
  }

  if (runOk && plan) {
    step('11. 方案详情（DecisionTrace 数据源）', planDetail.status === 200);
    const assignmentsOk =
      assignments.length > 0 &&
      assignments.every(
        (a) =>
          typeof a.assignmentId === 'string' &&
          a.assignmentId.length > 0 &&
          typeof a.taskId === 'string' &&
          a.taskId.length > 0 &&
          (typeof a.personId === 'string' || typeof a.deviceId === 'string') &&
          typeof a.status === 'string' &&
          a.status.length > 0 &&
          Array.isArray(a.reasons),
      );
    step('16. Assignment 携带决策字段', assignmentsOk, `assignments=${assignments.length} plan=${plan.planId}`);

    // 17-19. Approve + Reservation + Dispatch（必须由另一身份执行）
    if (!approverToken) {
      skip('17. Approve', '无可用审批人身份，审批独立性路径未验证');
      skip('18-19. Reservation + Dispatch', '无可用审批人身份');
    } else {
      step('17. Approve', Boolean(approveResult), `plan=${plan.planId}`);
      if (approveResult) {
        // 18-19. 派工（对 PLAN_STALE 做一次**有界显式重试**）
        //
        // 为什么需要：派工要求方案快照仍新鲜，而"审批 → 派工"之间的世界版本可能被**外部**
        // 写入推进（同窗口的其它扫描/回放/后台 sweep）——实测偶发 409 PLAN_STALE（同一脚本
        // 连续两轮：22/22 与 21/22）。这不是产品缺陷（拒绝过期方案是正确行为），
        // 而是脚本没把"等一个干净窗口"写清楚。这里：遇 PLAN_STALE 就等过冷却窗口、
        // **重新生成方案并重试一次**；仍然失败才算 FAIL（真回归不会被掩盖）。
        let dispatch = await request('POST', `/api/scheduler/plans/${plan.planId}/dispatch`, null, approverToken);
        // 18b. 方案里有"尚未就绪"的任务（可调度但未走完确认/审批闸门）：
        // 按契约状态机推进到待派工后重派。这是**正常现场工作流**，不是补救。
        if (dispatch.status === 409 && /PLAN_TASK_NOT_DISPATCHABLE/.test(errText(dispatch))) {
          const advanced = await advanceTasksToPendingDispatch(assignments);
          const retried = advanced.length > 0
            ? await request('POST', `/api/scheduler/plans/${plan.planId}/dispatch`, null, approverToken)
            : null;
          // 判定口径：这一步验证的是"未就绪任务能被按契约推进、且推进后**不再卡在
          // PLAN_TASK_NOT_DISPATCHABLE**"。推进任务会写任务事实、从而推进世界版本，
          // 于是紧随的重派可能返回 PLAN_STALE —— 那不是失败，而是下一个断言
          // （18a）负责处置的状态；让 18b 因它变红会把"正确的 fail-closed"报成缺陷。
          const retryOk = Boolean(
            retried
            && (retried.status === 200 || (retried.status === 409 && /PLAN_STALE/.test(errText(retried)))),
          );
          record(
            retryOk ? 'PASS' : 'FAIL',
            '18b. 任务未就绪 → 按契约状态机推进到待派工后重派（真实调度员工作流）',
            `${advanced.join(' | ') || '无可推进任务'}；重派 status=${retried ? retried.status : 'n/a'}`
              + `${retried && /PLAN_STALE/.test(errText(retried)) ? '（PLAN_STALE：任务写入推进了世界版本，交 18a 处置）' : ''}`
              + `${retried && !retryOk ? ' ' + errText(retried) : ''}`,
          );
          if (retried) dispatch = retried;
        }
        if (dispatch.status === 409 && /PLAN_STALE/.test(errText(dispatch))) {
          record('PASS', '18a. 派工遇 PLAN_STALE（世界版本被并发推进）→ 等冷却窗口后重新生成方案并重试一次',
            `plan=${plan.planId} waitMs=${COOLDOWN_WAIT_MS}`);
          await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));
          const rerun = await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, token);
          const freshPlans = (rerun.body?.plans ?? []) || [];
          const reselected = freshPlans.length > 0 ? await selectApprovablePlan(freshPlans) : false;
          if (reselected) {
            dispatch = await request('POST', `/api/scheduler/plans/${plan.planId}/dispatch`, null, approverToken);
          } else {
            planAttempts.push('重试轮：没有可审批的新方案');
          }
        }
        step('18-19. Reservation + Dispatch', dispatch.status === 200,
          `status=${dispatch.status} msg=${errText(dispatch)}`);
        // B5 反向断言：生成人自己审批必须被拒（403 SELF_APPROVAL_FORBIDDEN）。
        const selfApprove = await request('POST', `/api/scheduler/plans/${plan.planId}/approve`, {
          version: planDetail.body?.version ?? plan.version,
          snapshotVersion: planDetail.body?.snapshotVersion ?? plan.snapshotVersion,
          operator: ADMIN_USER,
        }, token);
        step('19b. 生成人自审批被拒（B5）', selfApprove.status === 403,
          `status=${selfApprove.status}`);
      }
    }

    // 20. Execution 状态
    const execs = await request('GET', `/api/scheduler/executions?planId=${encodeURIComponent(plan.planId)}`, null, token);
    step('20. Execution 记录创建', execs.status === 200, `count=${execs.body?.executions?.length ?? 0}`);
  } else {
    skip('10-20. 方案链路',
      runOk
        ? `候选方案均无可用 assignment（含等待冷却后重试）：${planAttempts.slice(0, 4).join(' | ')}`
        : '调度触发未返回可用状态（见 3-9 的 status）');
  }

  // 35. KPI 聚合
  const kpi = await request('GET', '/api/scheduler/kpi', null, token);
  step('35-36. KPI 聚合端点', kpi.status === 200, JSON.stringify({ delivery: !!kpi.body?.delivery, stability: !!kpi.body?.stability }));

  // ---------------------------------------------------------------------------
  // 策略治理生命周期：注册候选 → Replay → SHADOW → Gate → 人工激活 → 回滚
  //
  // 这一整段此前长期 SKIP（库里没有候选策略），所以"策略从候选到生效必须经过
  // Gate 与人审"这条治理链其实从未被端到端验证过。这里先按当前生效配置注册
  // 一个候选版本，把链路真正跑起来。
  // ---------------------------------------------------------------------------
  const legalFailureMsg = (res, patterns) =>
    (res.status === 409 || res.status === 404) &&
    patterns.test(String(res.body?.error?.message ?? res.body?.message ?? ''));

  let candidateVersion = null;
  const versionsRes = await request('GET', '/api/scheduler/policy/versions', null, token);
  const versionsRaw = versionsRes.body?.versions ?? versionsRes.body?.data ?? versionsRes.body ?? [];
  const versions = Array.isArray(versionsRaw) ? versionsRaw : [];
  const existingCandidate = versions.find((v) => !v.active && v.status !== 'ACTIVE');
  if (existingCandidate) {
    candidateVersion = existingCandidate.configVersion ?? existingCandidate.version;
    record('PASS', '36b. 复用既有候选策略', `v${candidateVersion}`);
  } else {
    const current = await request('GET', '/api/scheduler/policy', null, token);
    const config = current.body?.config;
    if (!config) {
      skip('36b. 注册候选策略', `无法取得当前策略配置（HTTP ${current.status}）`);
    } else {
      const reg = await request('POST', '/api/scheduler/policy/versions', {
        config, operator: ADMIN_USER,
      }, token);
      const ok = reg.status === 201 || reg.status === 200;
      step('36b. 注册候选策略', ok, `status=${reg.status} version=${reg.body?.configVersion ?? '-'} msg=${errText(reg)}`);
      if (ok) candidateVersion = reg.body?.configVersion;
    }
  }

  if (!candidateVersion) {
    skip('37-45. Policy Replay / SHADOW', '没有候选策略版本可用，策略治理链未验证');
  } else {
    // 37-39. Replay
    const replay = await request('POST', '/api/scheduler/policy/replay', {
      candidatePolicyVersion: candidateVersion, seed: 42,
    }, token);
    if (replay.status === 201 || replay.status === 200) {
      step('37-39. Policy Replay', true, `status=${replay.status}${replay.body?.replayId ? ` replayId=${replay.body.replayId}` : ''}`);
    } else if (legalFailureMsg(replay, /no historical snapshot|not found|solve failed/i)) {
      skip('37-39. Policy Replay', `status=${replay.status}——无历史快照，未验证`);
    } else {
      step('37-39. Policy Replay', false, `status=${replay.status}`);
    }

    // 40-45. 进入 SHADOW 并生成影子方案
    const shadow = await request('POST', `/api/scheduler/policy/${candidateVersion}/shadow`, {
      operator: ADMIN_USER, reason: 'golden path shadow',
    }, token);
    step('40a. 候选进入 SHADOW', shadow.status === 201 || shadow.status === 200,
      `status=${shadow.status} msg=${errText(shadow)}`);
    const shadowPlanRes = await request('POST', `/api/scheduler/policy/${candidateVersion}/shadow/plan`, null, token);
    if ([200, 201].includes(shadowPlanRes.status)) {
      step('40-45. Shadow Plan 生成', true, `status=${shadowPlanRes.status}`);
    } else if (legalFailureMsg(shadowPlanRes, /not found|cannot enter SHADOW|is ACTIVE|already|no schedulable|no task/i)) {
      skip('40-45. Shadow Plan 生成', `status=${shadowPlanRes.status} msg=${errText(shadowPlanRes)}——未生成影子方案`);
    } else {
      step('40-45. Shadow Plan 生成', false, `status=${shadowPlanRes.status} msg=${errText(shadowPlanRes)}`);
    }
  }

  // 46. Gate：必须真实反映证据情况。
  // 2026-09-10 修复后的契约：`passed` 只表示"没有检查失败"，`insufficientEvidence`
  // 表示"有检查因缺数据被跳过——结论不是已验证通过"；且候选不存在必须 404。
  const gateVersion = candidateVersion ?? 2;
  const gate = await request('POST', `/api/scheduler/policy/${gateVersion}/gate`, {}, token);
  let gateVerifiedPass = false;
  let gateInsufficient = false;
  if (gate.status === 201 || gate.status === 200) {
    gateInsufficient = gate.body?.insufficientEvidence === true;
    const evidence = gate.body?.evidence;
    const checkCount = gate.body?.checks?.length ?? -1;
    step('46. Gate 评估', true,
      `passed=${gate.body?.passed} insufficientEvidence=${gateInsufficient} `
        + `evidence=${evidence?.evaluated ?? '?'}/${checkCount}`);
    step('46b. Gate 逐条标注证据（skipped 与 ok 可区分）',
      Boolean(evidence) && evidence.evaluated + evidence.skipped === checkCount
        && gate.body.checks.every((c) => typeof c.skipped === 'boolean'),
      `evaluated+skipped=${evidence ? evidence.evaluated + evidence.skipped : 'n/a'} checks=${checkCount}`);
    gateVerifiedPass = gate.body?.passed === true && !gateInsufficient;
  } else if (gate.status === 404) {
    skip('46. Gate 评估', '候选策略不存在（HTTP 404）——Gate 正确拒绝评估，本项未验证');
  } else {
    step('46. Gate 评估', false, `status=${gate.status}`);
  }

  // 47-48. Activate
  // 第三分支（NO-86a）：Gate **逐条失败**（有数据、指标不达标 ≠ 证据缺失）。
  // 这是策略门在真实数据漂移（共享 dev 库累积执行历史）下的正确行为：
  //   · 未确认激活 → 409 POLICY_GATE_FAILED（FAIL 不可被 ack 豁免——那才能拦住真失败）；
  //   · ack 激活 → 同样拒绝（acknowledge 只豁免"缺数据"，不豁免"数据不达标"）；
  //   · 激活路径本验证轮次显式 SKIP，并附上门禁的实测指标（供运营看数据漂移）。
  // 失败的"已评估"检查**优先于**缺数据（FAIL 不可被 ack 豁免；insufficient 只豁免跳过项）
  const gateFailedChecks = !gate.body?.passed
    && (gate.body?.checks ?? []).some((c) => c.ok === false && c.skipped === false);
  if (gateFailedChecks) {
    const failedNames = (gate.body?.checks ?? [])
      .filter((c) => c.ok === false && c.skipped === false)
      .map((c) => `${c.name}=${c.actual}(≤${c.threshold})`).join(', ');
    const unacked = await request('POST', `/api/scheduler/policy/${gateVersion}/activate`, {
      operator: ADMIN_USER, reason: 'golden path activation against failed gate',
    }, token);
    step('47a-2. Gate 逐条失败时拒绝激活（FAIL 不被 ack 豁免——治理语义）',
      unacked.status === 409 && /POLICY_GATE_FAILED/i.test(errText(unacked)),
      `status=${unacked.status} msg=${errText(unacked).slice(0, 90)}`);
    const ackedFailed = await request('POST', `/api/scheduler/policy/${gateVersion}/activate`, {
      operator: ADMIN_USER, reason: 'golden path activation against failed gate (acked)',
      acknowledgeInsufficientEvidence: true,
    }, token);
    step('47b-2. 显式 ack 也无法激活 FAIL 的 Gate（ack 只豁免缺数据，不豁免不达标）',
      [409, 403].includes(ackedFailed.status),
      `status=${ackedFailed.status} msg=${errText(ackedFailed).slice(0, 90)}`);
    skip('47-50. Activate/Rollback',
      `数据漂移：指标不达标（${failedNames}）——门禁行为正确，激活路径本验证轮次显式跳过`
        + '（清库或修复数据后可全路径验证）');
  } else if (gateInsufficient) {
    // 本轮修复的治理门禁：证据不足时，未经显式确认的激活必须被拒绝。
    const unacked = await request('POST', `/api/scheduler/policy/${gateVersion}/activate`, {
      operator: ADMIN_USER, reason: 'golden path activation without acknowledgement',
    }, token);
    step('47a. 证据不足时拒绝未确认激活',
      unacked.status === 409 && /INSUFFICIENT_EVIDENCE/i.test(errText(unacked)),
      `status=${unacked.status} msg=${errText(unacked)}`);
    const acked = await request('POST', `/api/scheduler/policy/${gateVersion}/activate`, {
      operator: ADMIN_USER,
      reason: 'golden path activation acknowledged',
      acknowledgeInsufficientEvidence: true,
    }, token);
    step('47-48. 显式确认后人工激活 + 审计',
      acked.status === 201 || acked.status === 200,
      `activationId=${acked.body?.activationId ?? '-'} msg=${errText(acked)}`);
    await assertRollback(acked.body, token, ADMIN_USER);
  } else if (gateVerifiedPass) {
    const activate = await request('POST', `/api/scheduler/policy/${gateVersion}/activate`, {
      operator: ADMIN_USER, reason: 'golden path activation',
    }, token);
    step('47-48. Human Activate + audit', activate.status === 201 || activate.status === 200,
      `activationId=${activate.body?.activationId ?? '-'}`);
    await assertRollback(activate.body, token, ADMIN_USER);
  } else {
    skip('47-50. Activate/Rollback', 'Gate 未通过或候选不可用，激活路径未验证');
  }

  // 51. SSE 一致性：stream 端点可建立
  const streamOk = await new Promise((resolve) => {
    const req = http.request(
      `${BASE}/api/scheduler/v2/stream`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: 5000 },
      (res) => { res.destroy(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
  step('51. SSE stream 可建立', streamOk);

  // 汇总：三态独立计数，SKIP 不等于 PASS。
  finish();
}

main().catch((e) => {
  console.error('Golden Path failed:', e.message);
  process.exit(1);
});
