/**
 * 外骨骼会话闭环 E2E（NO-33a）。
 *
 * 补齐愿景里"人员通过平台、移动端和**外骨骼**参与执行"的产品面：后端会话 API 早已
 * 存在（ADR-032/033），但一直没有页面消费。本脚本验证真实后端上的会话生命周期语义：
 *
 *   1. 开始会话（设备 + 人员，显式绑定）→ 列表里出现**进行中**且带起止与人员；
 *   2. 同一台外骨骼的第二个活跃会话 → **冲突显式拒绝**（一台设备同时只能一个活跃会话）；
 *   3. 结束会话：`endedBy` 必填（结束事实完整，§33 不悬空）；
 *   4. 中止会话：终态不可复开，理由写入会话事实；
 *   5. 已结束的会话再结束 = 幂等（不报错、不产生第二条事实）；
 *   8. NO-36b：预计 vs 实际——超时结束的偏差判定 + 没填预计时如实说"无法比较"；
 *   9. NO-36a：执行边界的提交时刻——任务指派写入时，佩戴中的设备只能指派给佩戴者
 *      （指派给别人 / 不指派人都被 409 拒绝，且不落库）；
 *   10. NO-37a：平台侧主动提醒——超过预计结束/长时间未收工的会话必须能主动通知到
 *      班组长与**佩戴者本人账号**，且重复扫描幂等、收工后不再提醒；
 *   11. NO-38a：偏差复盘（运行记忆）——预计 vs 实际的聚合口径必须诚实：
 *      只统计已收工会话、缺时间戳的会话计入不可比、样本不足时**不给比率**；
 *   12. NO-39a：反方向的执行边界——设备已被**在飞任务**指派给别人时，开始会话必须被
 *      409 拒绝；受派人本人佩戴则允许（人机同体）；回退派工后约束解除（不残留假封锁）；
 *   13. NO-40a：会话 ↔ 任务绑定——设备上下文给出在飞任务与可继承的计划结束时间，
 *      绑定后会话继承预计结束（来源 task_plan_end），手填优先（来源 operator）；
 *   14. NO-41a：佩戴事实双源校验——真机上行的遥测（含 worker_id）与会话声明交叉比对：
 *      一致 / 佩戴人不符 / 缺遥测（无佐证，不是"没在戴"）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *     node test/e2e/exo-session-loop.mjs
 */
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const INGEST_ORG = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';

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
  console.log(`\n========================================`);
  console.log(`外骨骼会话闭环: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
  process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
}

let lastLoginError = null;

async function login(username, password) {
  lastLoginError = null;
  if (!password) {
    lastLoginError = '未提供密码（env EWOH_E2E_ADMIN_PASS）';
    return null;
  }
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch((error) => ({ status: 0, json: async () => null, error }));
  const body = await response.json().catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 201)) {
    // 登录失败的原因必须如实说：此前一律显示"缺少 EWOH_E2E_ADMIN_PASS"，
    // 实测把 503（认证存储不可用）误报成"环境变量没设"，浪费过排查时间。
    lastLoginError = `登录失败：HTTP ${response?.status ?? 0}`
      + (body?.error?.message ? ` ${body.error.message}` : '')
      + (body?.error?.code ? ` [${body.error.code}]` : '');
    return null;
  }
  const token = body?.accessToken ?? null;
  if (!token) lastLoginError = '登录响应缺少 accessToken';
  return token;
}

// NO-67d：本场景创建的所有会话（收尾自证"全部终结"的清单）——模块级，call 可写。
const createdSessionIds = [];
const trackSession = (id) => { if (id) createdSessionIds.push(id); };

async function call(method, path, body, token) {
  // NO-67d：单点跟踪本场景创建的会话（收尾自证的清单来源）
  if (method === 'POST' && path === '/api/exo/sessions' && body && typeof body.sessionId === 'string') {
    trackSession(body.sessionId);
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** 错误信息提取：Nest 全局过滤器返回 `{ error: { code, message } }`，旧接口有顶层 `message`。 */
function errText(payload) {
  return String(payload?.error?.message ?? payload?.message ?? '');
}

function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['sessions', 'data', 'items']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function main() {
  const probe = await fetch(`${BASE}/api/exo/sessions`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 平台可达且未认证访问被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const token = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS || '');
  if (!token) {
    skip('1. 管理员登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  step('1. 管理员登录', true);

  const tag = Date.now().toString(36);
  // 契约要求规范身份：外骨骼是 `device:<id>`，人员是 `person:<id>`（ADR-032）
  const exoId = `device:EXO-E2E-${tag}`;
  const exoIdB = `device:EXO-E2E-${tag}-B`;
  const personId = `person:P-E2E-${tag}`;
  // 契约要求 sessionId 以 `exo-session:` 开头（ADR-032 规范身份）
  const sessionId = `exo-session:E2E-${tag}`;
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();

  // 现场账号令牌（10b 用于"点名到人"，15f 用于断言"更正他人会话"被权限拦住）。
  let wearerToken = null;
  // workshop_lead 令牌（15g：wearer_mismatch 提醒的**实际收件人角色**；无凭据则回退 wearerToken）。
  let approverToken = null;
  if (process.env.EWOH_E2E_APPROVER_PASS) {
    approverToken = await login(
      process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
      process.env.EWOH_E2E_APPROVER_PASS,
    );
  }

  const started = await call('POST', '/api/exo/sessions', {
    sessionId,
    exoId,
    personId,
    startedAt,
  }, token);
  step('2. 开始会话（显式绑定设备 + 人员）', started.status === 201 || started.status === 200, `status=${started.status}`);

  const sessions = await call('GET', '/api/exo/sessions', undefined, token);
  const mine = listOf(sessions.body).find((s) => s.sessionId === sessionId);
  step('2a. 会话出现在列表里且为"进行中"，绑定信息完整',
    mine?.status === 'active' && mine?.exoId === exoId && mine?.personId === personId,
    `status=${mine?.status} exo=${mine?.exoId} person=${mine?.personId}`);

  // ── 3. 同一台设备的第二个活跃会话 → 显式冲突 ─────────────────────
  const conflicting = await call('POST', '/api/exo/sessions', {
    sessionId: `${sessionId}-2`,
    exoId,
    personId,
    startedAt: new Date().toISOString(),
  }, token);
  step('3. 同一台外骨骼的第二个活跃会话被拒（一台设备同时只允许一个活跃会话）',
    conflicting.status === 409 || conflicting.status === 400,
    `status=${conflicting.status}`);

  // ── 4. 结束会话（endedBy 必填）─────────────────────────────────
  const endWithoutActor = await call('POST', `/api/exo/sessions/${sessionId}/end`, { endedBy: '   ' }, token);
  step('4. 结束会话缺 endedBy → 400（结束事实完整，不悬空）',
    endWithoutActor.status === 400,
    `status=${endWithoutActor.status}`);

  const ended = await call('POST', `/api/exo/sessions/${sessionId}/end`, { endedBy: 'lead.chen' }, token);
  step('4a. 正常结束：状态 ended + 实际结束时间 + 结束人',
    (ended.status === 200 || ended.status === 201)
      && ended.body?.status === 'ended'
      && Boolean(ended.body?.actualEndAt)
      && ended.body?.endedBy === 'lead.chen',
    `status=${ended.body?.status} endedBy=${ended.body?.endedBy}`);

  // ── 5. 终态幂等 + 不可复开 ─────────────────────────────────────
  const reEnd = await call('POST', `/api/exo/sessions/${sessionId}/end`, { endedBy: 'lead.chen' }, token);
  step('5. 已结束会话再次结束 = 幂等返回（不报错、不产生第二条事实）',
    (reEnd.status === 200 || reEnd.status === 201) && reEnd.body?.status === 'ended',
    `status=${reEnd.status} session=${reEnd.body?.status}`);

  const reopen = await call('POST', `/api/exo/sessions/${sessionId}/abort`, { endedBy: 'lead.chen', reason: '试图复开' }, token);
  step('5a. 终态不可复开：对已结束会话执行"中止"被拒（ADR-032）',
    reopen.status === 400,
    `status=${reopen.status}`);

  // ── 6. 中止路径：理由写入会话事实 ──────────────────────────────
  const abortSessionId = `${sessionId}-abort`;
  await call('POST', '/api/exo/sessions', {
    sessionId: abortSessionId,
    exoId: exoIdB,
    personId,
    startedAt: new Date().toISOString(),
  }, token);
  const aborted = await call('POST', `/api/exo/sessions/${abortSessionId}/abort`, {
    endedBy: 'lead.chen',
    reason: '人员提前离岗，未走正常收工流程',
  }, token);
  step('6. 中止会话：状态 aborted 且理由写入事实（现场"没正常收工"可追溯）',
    (aborted.status === 200 || aborted.status === 201)
      && aborted.body?.status === 'aborted'
      && String(aborted.body?.reason ?? '').includes('提前离岗'),
    `status=${aborted.body?.status} reason=${aborted.body?.reason}`);

  const finalList = await call('GET', '/api/exo/sessions', undefined, token);
  const finalRows = listOf(finalList.body).filter((s) => String(s.sessionId).startsWith(sessionId));
  step('6a. 历史保留两类终态（ended + aborted）且都能查到',
    finalRows.some((s) => s.status === 'ended') && finalRows.some((s) => s.status === 'aborted'),
    `statuses=${finalRows.map((s) => s.status).join('|')}`);

  // ── 7. 会话进入世界模型并被资格判定当硬约束（NO-34a）────────────────
  // 用**台账里真实存在**的外骨骼设备（快照 devices 里 capabilities 含 exo-lift 的），
  // 否则快照里没有对应设备，投影也（正确地）不会给它挂会话。
  const snapshotBefore = await call('GET', '/api/scheduler/snapshot', undefined, token);
  const exoDevice = (snapshotBefore.body?.devices ?? []).find(
    (d) => Array.isArray(d.capabilities) && d.capabilities.includes('exo-lift'),
  );
  if (!exoDevice?.deviceId) {
    skip('7. 会话进入世界模型', '台账里没有具备 exo-lift 的外骨骼设备（无法验证佩戴约束）');
  } else {
    // 场景自清理：该设备可能残留上次运行/中断留下的活跃会话（一台设备只允许一个
    // 活跃会话），先全部结束，保证本场景可重复运行（实测被残留会话卡住过）。
    const existing = await call('GET', `/api/exo/sessions?status=active&exoId=${encodeURIComponent(`device:${exoDevice.deviceId}`)}`, undefined, token);
    for (const leftover of listOf(existing.body)) {
      if (leftover?.sessionId) {
        await call('POST', `/api/exo/sessions/${encodeURIComponent(leftover.sessionId)}/end`, { endedBy: 'e2e-cleanup' }, token);
      }
    }
    const realSessionId = `exo-session:NO34-${tag}`;
    const boundPerson = `person:P-NO34-${tag}`;
    const started2 = await call('POST', '/api/exo/sessions', {
      sessionId: realSessionId,
      exoId: `device:${exoDevice.deviceId}`,
      personId: boundPerson,
      startedAt: new Date().toISOString(),
    }, token);
    const snapshotDuring = await call('GET', '/api/scheduler/snapshot', undefined, token);
    const deviceDuring = (snapshotDuring.body?.devices ?? []).find((d) => d.deviceId === exoDevice.deviceId);
    step('7. 活跃会话进入世界模型（快照设备带 activeExoSession 与佩戴人）',
      (started2.status === 201 || started2.status === 200)
        && deviceDuring?.activeExoSession?.sessionId === realSessionId
        && deviceDuring?.activeExoSession?.personId === boundPerson,
      `device=${exoDevice.deviceId} session=${deviceDuring?.activeExoSession?.sessionId ?? 'missing'}`);

    // 候选资格：佩戴中的设备必须被拒，且原因词表里给得出中文
    // 选一个**非终态**且要求 exo-lift 的任务：历史运行留下的已取消任务仍在快照里，
    // 拿它们验证"派工约束"没有意义（实测踩过：挑中了上一轮 7c 取消掉的任务）。
    const terminalStatuses = new Set(['completed', 'cancelled', 'canceled', 'failed', 'closed']);
    let taskWithExoLift = (snapshotDuring.body?.tasks ?? []).find(
      (t) =>
        Array.isArray(t.requiredDeviceCapabilities) &&
        t.requiredDeviceCapabilities.includes('exo-lift') &&
        !terminalStatuses.has(String(t.status ?? '').toLowerCase()),
    );
    // 依赖历史/种子任务会让本场景"看运气"（实测：上一次运行把任务取消掉后，
    // 这里就只剩 SKIP）。改为**自己造一个**要求 exo-lift 的任务，场景自足可重复。
    let createdProbeTaskId = null;
    if (!taskWithExoLift?.id) {
      const created = await call('POST', '/api/tasks', {
        title: `NO-34a 佩戴约束探针 ${tag}`,
        taskType: 'assembly',
        priority: 'low',
        requiredDeviceCapabilities: ['exo-lift'],
      }, token);
      createdProbeTaskId = created.body?.id ?? created.body?.taskId ?? null;
      if (createdProbeTaskId) taskWithExoLift = { id: createdProbeTaskId };
    }
    if (!taskWithExoLift?.id) {
      skip('7a. 佩戴中设备被资格判定拒绝', '无法创建要求 exo-lift 的探针任务（无法验证资格拒绝）');
    } else {
      // 真实路由是 /api/scheduler/tasks/:id/candidates，且候选条目的 deviceId 是
      // **调度主键（uuid）**，业务设备号在快照的 deviceId 字段里（两者是显式 join 键）。
      const candidates = await call(
        'GET',
        `/api/scheduler/tasks/${encodeURIComponent(taskWithExoLift.id)}/candidates`,
        undefined,
        token,
      );
      const rejected = (candidates.body?.candidates ?? []).find(
        (c) => c.deviceId === exoDevice.id,
      );
      const reasons = rejected?.rejectReasons ?? [];
      step('7a. 佩戴中的外骨骼被资格判定拒绝（device_in_active_session，硬约束不是提示）',
        candidates.status === 200 && reasons.includes('device_in_active_session'),
        `task=${taskWithExoLift.id} reasons=${reasons.join('|') || 'none'}`);
      if (createdProbeTaskId) {
        await call('POST', `/api/tasks/${encodeURIComponent(createdProbeTaskId)}/state?action=cancel`, {}, token);
      }
    }

    // 结束会话后约束解除（不残留假封锁）
    await call('POST', `/api/exo/sessions/${realSessionId}/end`, { endedBy: 'lead.chen' }, token);
    const snapshotAfter = await call('GET', '/api/scheduler/snapshot', undefined, token);
    const deviceAfter = (snapshotAfter.body?.devices ?? []).find((d) => d.deviceId === exoDevice.deviceId);
    step('7b. 结束会话后世界模型不再标记佩戴中（约束解除、不残留）',
      deviceAfter?.activeExoSession === null || deviceAfter?.activeExoSession === undefined,
      `activeExoSession=${JSON.stringify(deviceAfter?.activeExoSession ?? null)}`);
    // ── 7c. 人机同体：任务锁定给佩戴者 → 该设备不再被会话拒（NO-35a）──────
    const snapshotPeople = snapshotDuring.body?.persons ?? [];
    const wearerPerson = snapshotPeople.find((p) => p.id && p.id !== 'undefined');
    if (!wearerPerson?.id) {
      skip('7c. 锁定给佩戴者后可用', '快照里没有可用人员（无法验证人机同体配对）');
    } else {
      // 用**真实人员**重建会话（上面的会话佩戴人是虚构 id，无法被任务锁定）
      await call('POST', `/api/exo/sessions/${realSessionId}/end`, { endedBy: 'lead.chen' }, token);
      const boundSessionId = `exo-session:NO35-${tag}`;
      await call('POST', '/api/exo/sessions', {
        sessionId: boundSessionId,
        exoId: `device:${exoDevice.deviceId}`,
        personId: `person:${wearerPerson.id}`,
        startedAt: new Date().toISOString(),
      }, token);

      const task = await call('POST', '/api/tasks', {
        title: `NO-35a 佩戴者同体验证 ${tag}`,
        taskType: 'assembly',
        priority: 'low',
        assigneeId: wearerPerson.id,
        requiredDeviceCapabilities: ['exo-lift'],
      }, token);
      const taskId = task.body?.id ?? task.body?.taskId ?? null;
      if (!taskId) {
        skip('7c. 锁定给佩戴者后可用', `创建任务失败（status=${task.status}）`);
      } else {
        const boundCandidates = await call(
          'GET',
          `/api/scheduler/tasks/${encodeURIComponent(taskId)}/candidates`,
          undefined,
          token,
        );
        const deviceRow = (boundCandidates.body?.candidates ?? []).find(
          (c) => c.deviceId === exoDevice.id && c.personId === wearerPerson.id,
        );
        step('7c. 任务锁定给佩戴者 → 佩戴中的外骨骼不再因会话被拒（人机同体合法）',
          Boolean(deviceRow) && !(deviceRow?.rejectReasons ?? []).includes('device_in_active_session'),
          `task=${taskId} person=${wearerPerson.id} reasons=${(deviceRow?.rejectReasons ?? []).join('|') || 'none'}`);
        // 收尾：任务置终态（避免影响后续场景的计数）
        await call('POST', `/api/tasks/${encodeURIComponent(taskId)}/state?action=cancel`, {}, token);
        await call('POST', `/api/exo/sessions/${boundSessionId}/end`, { endedBy: 'lead.chen' }, token);
      }
    }


    // ── 8. NO-36b：预计 vs 实际（运行记忆）────────────────────────────
    // 用**真实设备 + 真实人员**建一条带预计结束时间的会话，然后超时收工。
    const wearerForTiming = (snapshotDuring.body?.persons ?? []).find((p) => p.id && p.id !== 'undefined');
    if (!wearerForTiming?.id) {
      skip('8. 预计 vs 实际', '快照里没有可用人员（无法建立可比较的会话）');
    } else {
      const timingSessionId = `exo-session:NO36-${tag}`;
      const startedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const expectedEndAt = new Date(Date.now() - 60 * 60_000).toISOString();
      const started3 = await call('POST', '/api/exo/sessions', {
        sessionId: timingSessionId,
        exoId: `device:${exoDevice.deviceId}`,
        personId: `person:${wearerForTiming.id}`,
        startedAt,
        expectedEndAt,
      }, token);
      const ended3 = await call('POST', `/api/exo/sessions/${encodeURIComponent(timingSessionId)}/end`, {
        endedBy: 'lead.chen',
      }, token);
      const timing = ended3.body?.timing ?? {};
      step('8. 超时收工：接口给出偏差事实（over + 正偏差 + 总时长），不靠前端自己算',
        (started3.status === 201 || started3.status === 200)
          && ended3.body?.status === 'ended'
          && timing.deviationState === 'over'
          && typeof timing.deviationMs === 'number' && timing.deviationMs > 30 * 60_000
          && typeof timing.durationMs === 'number' && timing.durationMs > 3_000_000,
        `state=${timing.deviationState} deviationMs=${timing.deviationMs} durationMs=${timing.durationMs}`);

      // 没填预计结束时间 → unknown（"没记录"绝不等于准时）
      const noPlan = await call('GET', `/api/exo/sessions/${encodeURIComponent(sessionId)}`, undefined, token);
      step('8a. 没填预计结束时间的会话 → deviationState=unknown（缺失 ≠ 准时）',
        noPlan.status === 200 && noPlan.body?.timing?.deviationState === 'unknown',
        `state=${noPlan.body?.timing?.deviationState}`);

      // ── 9. NO-36a：任务指派写入是执行边界的第二道口子 ───────────────
      // 会话（真实佩戴者）仍然活跃在上面这条 timingSessionId 上？——已结束；
      // 重新开一条活跃会话，验证"佩戴中的设备只能指派给佩戴者"。
      const guardSessionId = `exo-session:NO36G-${tag}`;
      const started4 = await call('POST', '/api/exo/sessions', {
        sessionId: guardSessionId,
        exoId: `device:${exoDevice.deviceId}`,
        personId: `person:${wearerForTiming.id}`,
        startedAt: new Date().toISOString(),
      }, token);
      if (!(started4.status === 201 || started4.status === 200)) {
        skip('9. 指派写入的执行边界', `无法建立活跃会话（status=${started4.status}）`);
      } else {
        const stranger = 'e2e-stranger-' + tag;
        const conflictTask = await call('POST', '/api/tasks', {
          title: `NO-36a 会话冲突验证 ${tag}`,
          taskType: 'assembly',
          priority: 'low',
          assigneeId: stranger,
          deviceId: exoDevice.id,
        }, token);
        step('9. 把佩戴中的设备指派给别人 → 409 EXO_SESSION_ASSIGNMENT_CONFLICT（不落库）',
          conflictTask.status === 409
            && errText(conflictTask.body).includes('EXO_SESSION_ASSIGNMENT_CONFLICT'),
          `status=${conflictTask.status} msg=${errText(conflictTask.body).slice(0, 90)}`);

        const missingAssignee = await call('POST', '/api/tasks', {
          title: `NO-36a 缺指派人验证 ${tag}`,
          taskType: 'assembly',
          priority: 'low',
          deviceId: exoDevice.id,
        }, token);
        step('9a. 有会话却不指派人员 → 同样 409（不猜谁去用）',
          missingAssignee.status === 409 && errText(missingAssignee.body).includes('没有指定人员'),
          `status=${missingAssignee.status} msg=${errText(missingAssignee.body).slice(0, 70)}`);

        const wearerTask = await call('POST', '/api/tasks', {
          title: `NO-36a 佩戴者同体验证 ${tag}`,
          taskType: 'assembly',
          priority: 'low',
          assigneeId: wearerForTiming.id,
          deviceId: exoDevice.id,
        }, token);
        const wearerTaskId = wearerTask.body?.id ?? wearerTask.body?.taskId ?? null;
        step('9b. 指派给佩戴者本人 → 允许（人机同体是物理上可执行的组合）',
          (wearerTask.status === 201 || wearerTask.status === 200) && Boolean(wearerTaskId),
          `status=${wearerTask.status} task=${wearerTaskId}`);
        if (wearerTaskId) {
          await call('POST', `/api/tasks/${encodeURIComponent(wearerTaskId)}/state?action=cancel`, {}, token);
        }
        await call('POST', `/api/exo/sessions/${encodeURIComponent(guardSessionId)}/end`, { endedBy: 'lead.chen' }, token);
      }

      // ── 10. NO-37a：平台侧主动提醒（班组长 + 佩戴者本人）──────────────
      // 造一条"超过预计结束"的活跃会话：佩戴者是**真实绑定账号的人员**
      // （worker.zhangwei ↔ person 63000000-...-001），这样能验证"提醒发到人身上"。
      const reminderPersonId = process.env.EWOH_E2E_PERSON_ID || '63000000-0000-4000-8000-000000000001';
      const reminderSessionId = `exo-session:NO37-${tag}`;
      // 先清掉该设备可能残留的活跃会话，保证可重复运行。
      const leftover = await call(
        'GET',
        `/api/exo/sessions?status=active&exoId=${encodeURIComponent(`device:${exoDevice.deviceId}`)}`,
        undefined,
        token,
      );
      for (const row of listOf(leftover.body)) {
        if (row?.sessionId) {
          await call('POST', `/api/exo/sessions/${encodeURIComponent(row.sessionId)}/end`, { endedBy: 'e2e-cleanup' }, token);
        }
      }
      const started5 = await call('POST', '/api/exo/sessions', {
        sessionId: reminderSessionId,
        exoId: `device:${exoDevice.deviceId}`,
        personId: `person:${reminderPersonId}`,
        startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        expectedEndAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }, token);
      const sweep = await call('POST', '/api/exo/sessions/reminder-sweep', {}, token);
      step('10. 主动提醒扫描：超过预计结束的会话 → 班组长 + 佩戴者本人各一条（幂等 id）',
        (started5.status === 201 || started5.status === 200)
          && sweep.status === 200
          && (sweep.body?.overdue ?? 0) >= 1
          && (sweep.body?.created ?? 0) >= 2
          && (sweep.body?.notifications ?? []).some(
            (n) => n.recipientType === 'user' && n.sessionId === reminderSessionId && n.bucket === 'overdue',
          ),
        `status=${sweep.status} overdue=${sweep.body?.overdue} created=${sweep.body?.created} unresolved=${JSON.stringify(sweep.body?.unresolvedWearers ?? [])}`);

      const sweepAgain = await call('POST', '/api/exo/sessions/reminder-sweep', {}, token);
      step('10a. 重复扫描幂等：只累计 duplicates，不重复提醒（一次超时只叫一次）',
        sweepAgain.status === 200
          && (sweepAgain.body?.created ?? -1) === 0
          && (sweepAgain.body?.duplicates ?? 0) >= 2,
        `created=${sweepAgain.body?.created} duplicates=${sweepAgain.body?.duplicates}`);

      // 佩戴者本人登录后应能在通知中心读到点名给自己的提醒（账号↔人员绑定生效）。
      wearerToken = await login(
        process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei',
        process.env.EWOH_E2E_FIELD_PASS || '',
      );
      if (!wearerToken) {
        skip('10b. 佩戴者本人收到提醒', `现场账号登录失败：${lastLoginError ?? '未知原因'}`);
      } else {
        const wearerNotifications = await call('GET', '/api/notifications?status=pending', undefined, wearerToken);
        const mine = (wearerNotifications.body?.notifications ?? listOf(wearerNotifications.body)).filter(
          (n) => String(n.notificationId ?? '').startsWith('NTF-EXO-'),
        );
        step('10b. 佩戴者本人（账号↔人员绑定）能读到点名给自己的会话提醒',
          wearerNotifications.status === 200 && mine.length >= 1,
          `count=${mine.length} id=${mine[0]?.notificationId ?? 'none'}`);
      }

      // 收工后不再提醒（提醒基于活跃事实，不是历史噪音）。
      const endReminder = await call('POST', `/api/exo/sessions/${encodeURIComponent(reminderSessionId)}/end`, { endedBy: 'lead.chen' }, token);
      const sweepAfterEnd = await call('POST', '/api/exo/sessions/reminder-sweep', {}, token);
      const afterEndForSession = (sweepAfterEnd.body?.notifications ?? []).filter(
        (n) => n.sessionId === reminderSessionId,
      );
      step('10c. 收工后不再产生该会话的提醒（终态不提醒，避免永久噪音）',
        sweepAfterEnd.status === 200 && afterEndForSession.length === 0,
        `remaining=${afterEndForSession.length}`);

      // ── 10h（NO-45a）：前缀里的 `_` 只匹配字面量（SQL LIKE 通配符必须转义）──
      // 会话号允许出现 `_`（例如 `exo-session:LINE_A-1`）。若关闭提醒时把前缀直接拼进
      // LIKE 模式，`_` 会当成"任意单字符"，于是**另一条会话的提醒也会被一起关掉**。
      // 这里造一对"只差一个字符"的会话：A 用 `_`，B 用 `X`，只有 A 的提醒该被关闭。
      const likeSessionA = `exo-session:NO45_A-${tag}`;
      const likeSessionB = `exo-session:NO45XA-${tag}`;
      const likePersonA = `person:P-NO45A-${tag}`;
      const likePersonB = `person:P-NO45B-${tag}`;
      const likeDevice = `device:${exoDevice.deviceId}`;
      const overdueStart = new Date(Date.now() - 5 * 3_600_000).toISOString();
      const overdueExpectedEnd = new Date(Date.now() - 60 * 60_000).toISOString();
      const startedLikeA = await call('POST', '/api/exo/sessions', {
        sessionId: likeSessionA, exoId: likeDevice, personId: likePersonA,
        startedAt: overdueStart, expectedEndAt: overdueExpectedEnd,
      }, token);
      // 一台设备同时只允许一个活跃会话（NO-33a 的硬约束），因此对照会话用**另一台设备**：
      // 前缀只由会话号决定，与设备无关，正好隔离出"LIKE 转义"这一个变量。
      const startedLikeB = await call('POST', '/api/exo/sessions', {
        sessionId: likeSessionB, exoId: `device:EXO-NO45B-${tag}`, personId: likePersonB,
        startedAt: overdueStart, expectedEndAt: overdueExpectedEnd,
      }, token);
      let likeEscapeOk = false;
      let likeEscapeDetail = '未建立对照会话';
      if ((startedLikeA.status === 201 || startedLikeA.status === 200)
        && (startedLikeB.status === 201 || startedLikeB.status === 200)) {
        await call('POST', '/api/exo/sessions/reminder-sweep', {}, token);
        const endA = await call('POST', `/api/exo/sessions/${encodeURIComponent(likeSessionA)}/end`, { endedBy: 'lead.chen' }, token);
        const bAfter = await call('GET', '/api/notifications?status=pending', undefined, token);
        const bStillPending = (bAfter.body?.notifications ?? listOf(bAfter.body)).filter(
          (n) => n.externalRef === likeSessionB && String(n.notificationId ?? '').startsWith('NTF-EXO-'),
        );
        const bResolved = await call('GET', '/api/notifications?status=resolved', undefined, token);
        const bWronglyResolved = (bResolved.body?.notifications ?? listOf(bResolved.body)).filter(
          (n) => n.externalRef === likeSessionB && String(n.notificationId ?? '').startsWith('NTF-EXO-'),
        );
        likeEscapeOk = (endA.body?.resolvedNotificationCount ?? 0) >= 1
          && bStillPending.length >= 1
          && bWronglyResolved.length === 0;
        likeEscapeDetail = `closedA=${endA.body?.resolvedNotificationCount ?? 'none'} `
          + `bPending=${bStillPending.length} bResolved=${bWronglyResolved.length}`;
        // 收尾：释放对照会话占用的设备（避免污染后续场景）
        await call('POST', `/api/exo/sessions/${encodeURIComponent(likeSessionB)}/end`, { endedBy: 'lead.chen' }, token);
      }
      step('10h. 关闭提醒时 LIKE 前缀转义：`_` 只匹配字面量，不误伤"只差一个字符"的兄弟会话',
        likeEscapeOk, likeEscapeDetail);

      // ── 10d–10f（NO-44a）：处置即闭环——提醒必须有终态，且不静默消失 ──────
      step('10d. 收工顺带关闭该会话的待处置提醒（同一事务，返回关闭条数）',
        (endReminder.status === 200 || endReminder.status === 201)
          && (endReminder.body?.resolvedNotificationCount ?? 0) >= 1,
        `status=${endReminder.status} closed=${endReminder.body?.resolvedNotificationCount ?? 'none'}`);

      const endReminderAgain = await call('POST', `/api/exo/sessions/${encodeURIComponent(reminderSessionId)}/end`, { endedBy: 'lead.wang' }, token);
      step('10e. 重复收工不重复处置：幂等路径不返回关闭计数（未发生处置 ≠ 关闭了 0 条）',
        (endReminderAgain.status === 200 || endReminderAgain.status === 201)
          && endReminderAgain.body?.resolvedNotificationCount === undefined,
        `status=${endReminderAgain.status} closed=${endReminderAgain.body?.resolvedNotificationCount ?? 'absent'}`);

      // 未知状态过滤必须显式拒绝：此前 `?status=resolved` 被静默忽略、返回全部，
      // 调用方以为自己在查"已处置"（实测踩过，本轮修）。
      const bogusStatus = await call('GET', '/api/notifications?status=paused', undefined, token);
      step('10g. 未登记的通知状态过滤 → 400（不静默按"全部"返回）',
        bogusStatus.status === 400,
        `status=${bogusStatus.status} msg=${errText(bogusStatus.body).slice(0, 60)}`);

      if (!wearerToken) {
        skip('10f. 提醒进入"已处置"而非消失', '现场账号未登录（无法按收件人视角验证）');
      } else {
        const resolvedList = await call('GET', '/api/notifications?status=resolved', undefined, wearerToken);
        const mineResolved = (resolvedList.body?.notifications ?? listOf(resolvedList.body)).filter(
          (n) => n.externalRef === reminderSessionId && String(n.notificationId ?? '').startsWith('NTF-EXO-'),
        );
        const pendingAfter = await call('GET', '/api/notifications?status=pending', undefined, wearerToken);
        const stillPending = (pendingAfter.body?.notifications ?? listOf(pendingAfter.body)).filter(
          (n) => n.externalRef === reminderSessionId,
        );
        step('10f. 提醒进入"已处置"而非消失：带处置类型/处置人/时间，且不再挂在待办里',
          resolvedList.status === 200
            && mineResolved.length >= 1
            && mineResolved.every(
              (n) => n.resolution === 'session_ended' && n.resolvedBy === 'lead.chen' && Boolean(n.resolvedAt),
            )
            && stillPending.length === 0,
          `resolved=${mineResolved.length} pending=${stillPending.length} by=${mineResolved[0]?.resolvedBy ?? 'none'}`);
      }

      // ── 11. NO-38a：偏差复盘（预计 vs 实际的运行记忆）──────────────────
      // 上面已经造过"超时收工"（步骤 8，偏差 +1 小时）与"没填预计"（步骤 8a）的会话，
      // 因此这里应当看到：可比样本 ≥1、不可比 ≥1、比率/说明按门槛给出。
      const deviation = await call('GET', '/api/exo/sessions/deviation-summary?days=30&groupBy=device', undefined, token);
      const totals = deviation.body?.totals ?? {};
      step('11. 偏差复盘：只统计已收工会话，并给出可比/不可比计数与口径说明',
        deviation.status === 200
          && typeof totals.sessions === 'number' && totals.sessions > 0
          && typeof totals.comparable === 'number' && totals.comparable >= 1
          && typeof totals.notComparable === 'number' && totals.notComparable >= 1
          && Array.isArray(deviation.body?.notes) && deviation.body.notes.length > 0,
        `status=${deviation.status} sessions=${totals.sessions} comparable=${totals.comparable} notComparable=${totals.notComparable} groups=${(deviation.body?.groups ?? []).length}`);

      const byPerson = await call('GET', '/api/exo/sessions/deviation-summary?days=30&groupBy=person', undefined, token);
      step('11a. 分组口径可切换（按人员），且每个分组都带样本与说明字段',
        byPerson.status === 200
          && byPerson.body?.groupBy === 'person'
          && (byPerson.body?.groups ?? []).length >= 1
          && (byPerson.body.groups ?? []).every(
            (g) => typeof g.comparable === 'number' && Array.isArray(g.notes) && typeof g.insufficientSample === 'boolean',
          ),
        `status=${byPerson.status} groups=${(byPerson.body?.groups ?? []).length}`);

      const badWindow = await call('GET', '/api/exo/sessions/deviation-summary?days=not-a-number', undefined, token);
      step('11b. 非法窗口参数被规范化（不 500、不静默给错结论）',
        badWindow.status === 200 && badWindow.body?.windowDays === 30,
        `status=${badWindow.status} windowDays=${badWindow.body?.windowDays}`);

      // ── 12. NO-39a：反方向边界（在飞任务 vs 开始会话）──────────────────
      // 先清掉该设备上的活跃会话，保证判定只受"任务"影响（可重复运行）。
      const activeOnDevice = await call(
        'GET',
        `/api/exo/sessions?status=active&exoId=${encodeURIComponent(`device:${exoDevice.deviceId}`)}`,
        undefined,
        token,
      );
      for (const row of listOf(activeOnDevice.body)) {
        if (row?.sessionId) {
          await call('POST', `/api/exo/sessions/${encodeURIComponent(row.sessionId)}/end`, { endedBy: 'e2e-cleanup' }, token);
        }
      }
      const people = (snapshotDuring.body?.persons ?? []).filter((p) => p?.id && p.id !== 'undefined');
      const assigneePersonId = people[0]?.id ?? `P-ASSIGNEE-${tag}`;
      const otherPersonId = people[1]?.id ?? `P-OTHER-${tag}`;

      const guardTask = await call('POST', '/api/tasks', {
        title: `NO-39a 在飞任务边界 ${tag}`,
        taskType: 'assembly',
        priority: 'low',
        assigneeId: assigneePersonId,
        deviceId: exoDevice.id,
      }, token);
      const guardTaskId = guardTask.body?.id ?? guardTask.body?.taskId ?? null;
      let guardTaskInFlight = false;
      if (!guardTaskId) {
        skip('12. 在飞任务 → 会话开始被拒', `无法创建任务（status=${guardTask.status}）`);
      } else {
        for (const action of ['submit', 'skip_approval', 'dispatch']) {
          const moved = await call('POST', `/api/tasks/${encodeURIComponent(guardTaskId)}/state?action=${action}`, {}, token);
          if (!(moved.status === 200 || moved.status === 201)) {
            skip('12. 在飞任务 → 会话开始被拒', `任务动作 ${action} 未成功（status=${moved.status}）`);
            break;
          }
          guardTaskInFlight = action === 'dispatch';
        }
      }

      if (guardTaskInFlight) {
        const conflictSessionId = `exo-session:NO39-CONFLICT-${tag}`;
        const blockedStart = await call('POST', '/api/exo/sessions', {
          sessionId: conflictSessionId,
          exoId: `device:${exoDevice.deviceId}`,
          personId: `person:${otherPersonId}`,
          startedAt: new Date().toISOString(),
        }, token);
        step('12. 设备已被在飞任务指派给别人 → 开始会话 409 EXO_SESSION_TASK_CONFLICT（反方向边界）',
          blockedStart.status === 409
            && errText(blockedStart.body).includes('EXO_SESSION_TASK_CONFLICT')
            && errText(blockedStart.body).includes(guardTaskId),
          `status=${blockedStart.status} msg=${errText(blockedStart.body).slice(0, 120)}`);

        const wearerSessionId = `exo-session:NO39-WEARER-${tag}`;
        const wearerStart = await call('POST', '/api/exo/sessions', {
          sessionId: wearerSessionId,
          exoId: `device:${exoDevice.deviceId}`,
          personId: `person:${assigneePersonId}`,
          startedAt: new Date().toISOString(),
        }, token);
        step('12a. 在飞任务的受派人本人佩戴 → 允许（同一个人，人机同体）',
          wearerStart.status === 201 || wearerStart.status === 200,
          `status=${wearerStart.status} person=${assigneePersonId}`);
        await call('POST', `/api/exo/sessions/${encodeURIComponent(wearerSessionId)}/end`, { endedBy: 'lead.chen' }, token);

        // 回退派工（dispatched → pending_dispatch，即不再"在飞"）后约束解除——
        // 约束来自任务状态而不是"曾经有过任务"，不允许残留假封锁。
        const rolledBack = await call('POST', `/api/tasks/${encodeURIComponent(guardTaskId)}/state?action=rollback_dispatch`, {}, token);
        const afterRollbackSessionId = `exo-session:NO39-AFTER-${tag}`;
        const afterRollbackStart = await call('POST', '/api/exo/sessions', {
          sessionId: afterRollbackSessionId,
          exoId: `device:${exoDevice.deviceId}`,
          personId: `person:${otherPersonId}`,
          startedAt: new Date().toISOString(),
        }, token);
        step('12b. 回退派工（不再在飞）后约束解除：他人可以开始会话（不残留假封锁）',
          (rolledBack.status === 200 || rolledBack.status === 201)
            && (afterRollbackStart.status === 201 || afterRollbackStart.status === 200),
          `rollback=${rolledBack.status} start=${afterRollbackStart.status}`);
        await call('POST', `/api/exo/sessions/${encodeURIComponent(afterRollbackSessionId)}/end`, { endedBy: 'lead.chen' }, token);
        await call('POST', `/api/tasks/${encodeURIComponent(guardTaskId)}/state?action=cancel`, {}, token);
      }

      // ── 13. NO-40a：会话 ↔ 任务绑定（继承计划结束时间）──────────────────
      // 造一张带"计划结束时间"的在飞任务（受派人 = 佩戴者），然后用设备上下文
      // 拿到建议绑定，验证会话确实继承计划结束时间并记录来源。
      const linkPersonId = people[0]?.id ?? `P-LINK-${tag}`;
      const planEnd = new Date(Date.now() + 2 * 3_600_000).toISOString();
      const linkTask = await call('POST', '/api/tasks', {
        title: `NO-40a 任务绑定 ${tag}`,
        taskType: 'assembly',
        priority: 'low',
        assigneeId: linkPersonId,
        deviceId: exoDevice.id,
        planEnd,
      }, token);
      const linkTaskId = linkTask.body?.id ?? linkTask.body?.taskId ?? null;
      let linkTaskInFlight = false;
      if (!linkTaskId) {
        skip('13. 任务绑定与预计结束继承', `无法创建任务（status=${linkTask.status}）`);
      } else {
        for (const action of ['submit', 'skip_approval', 'dispatch']) {
          const moved = await call('POST', `/api/tasks/${encodeURIComponent(linkTaskId)}/state?action=${action}`, {}, token);
          if (!(moved.status === 200 || moved.status === 201)) {
            skip('13. 任务绑定与预计结束继承', `任务动作 ${action} 未成功（status=${moved.status}）`);
            linkTaskInFlight = false;
            break;
          }
          linkTaskInFlight = action === 'dispatch';
        }
      }

      if (linkTaskInFlight) {
        const context = await call(
          'GET',
          `/api/exo/sessions/device-context?exoId=${encodeURIComponent(`device:${exoDevice.deviceId}`)}&personId=${encodeURIComponent(`person:${linkPersonId}`)}`,
          undefined,
          token,
        );
        const suggestion = context.body?.suggestion ?? {};
        step('13. 设备上下文给出绑定建议（唯一在飞任务 + 受派人匹配 + 可继承计划结束时间）',
          context.status === 200
            && (context.body?.inFlightTasks ?? []).some((t) => t.taskId === linkTaskId)
            && suggestion.taskId === linkTaskId
            && suggestion.assigneeMatches === true
            && suggestion.expectedEndAt === planEnd,
          `status=${context.status} tasks=${(context.body?.inFlightTasks ?? []).length} suggestion=${suggestion.taskId ?? 'none'}`);

        const boundSessionId = `exo-session:NO40-${tag}`;
        const boundStart = await call('POST', '/api/exo/sessions', {
          sessionId: boundSessionId,
          exoId: `device:${exoDevice.deviceId}`,
          personId: `person:${linkPersonId}`,
          startedAt: new Date().toISOString(),
          taskId: linkTaskId,
        }, token);
        step('13a. 绑定任务后会话继承任务计划结束时间（来源 task_plan_end，不是现场填写）',
          (boundStart.status === 201 || boundStart.status === 200)
            && boundStart.body?.taskId === linkTaskId
            && boundStart.body?.expectedEndSource === 'task_plan_end'
            && boundStart.body?.expectedEndAt === planEnd,
          `status=${boundStart.status} taskId=${boundStart.body?.taskId} source=${boundStart.body?.expectedEndSource} expectedEnd=${boundStart.body?.expectedEndAt}`);

        // 手填优先：现场给了明确承诺就用现场值（来源 operator）。
        await call('POST', `/api/exo/sessions/${encodeURIComponent(boundSessionId)}/end`, { endedBy: 'lead.chen' }, token);
        const manualEnd = new Date(Date.now() + 45 * 60_000).toISOString();
        const manualSessionId = `exo-session:NO40M-${tag}`;
        const manualStart = await call('POST', '/api/exo/sessions', {
          sessionId: manualSessionId,
          exoId: `device:${exoDevice.deviceId}`,
          personId: `person:${linkPersonId}`,
          startedAt: new Date().toISOString(),
          taskId: linkTaskId,
          expectedEndAt: manualEnd,
        }, token);
        step('13b. 现场手填预计结束优先于任务计划（来源 operator，不覆盖现场判断）',
          (manualStart.status === 201 || manualStart.status === 200)
            && manualStart.body?.expectedEndSource === 'operator'
            && manualStart.body?.expectedEndAt === manualEnd,
          `status=${manualStart.status} source=${manualStart.body?.expectedEndSource}`);
        await call('POST', `/api/exo/sessions/${encodeURIComponent(manualSessionId)}/end`, { endedBy: 'lead.chen' }, token);

        // 错的关联要显式拒绝：把会话绑到"另一台设备"的任务上。
        const otherDeviceTask = await call('POST', '/api/tasks', {
          title: `NO-40a 设备不匹配 ${tag}`,
          taskType: 'assembly',
          priority: 'low',
          assigneeId: linkPersonId,
        }, token);
        const otherDeviceTaskId = otherDeviceTask.body?.id ?? otherDeviceTask.body?.taskId ?? null;
        if (otherDeviceTaskId) {
          const mismatch = await call('POST', '/api/exo/sessions', {
            sessionId: `exo-session:NO40X-${tag}`,
            exoId: 'device:EXO-OTHER-' + tag,
            personId: `person:${linkPersonId}`,
            startedAt: new Date().toISOString(),
            taskId: otherDeviceTaskId,
          }, token);
          // 另一台设备不在台账 → 无设备号可比对，关联本身合法（不误报）；
          // 这里断言的是"要么成功（无设备可比），要么显式冲突（有设备且不一致）"，
          // 不允许 500 或静默错关联。
          step('13c. 关联到不存在/不匹配的任务不会 500，也不会静默错关联',
            mismatch.status === 201 || mismatch.status === 200 || mismatch.status === 409 || mismatch.status === 400,
            `status=${mismatch.status} msg=${errText(mismatch.body).slice(0, 80)}`);
          if (mismatch.status === 201 || mismatch.status === 200) {
            await call('POST', `/api/exo/sessions/${encodeURIComponent(`exo-session:NO40X-${tag}`)}/end`, { endedBy: 'lead.chen' }, token);
          }
          await call('POST', `/api/tasks/${encodeURIComponent(otherDeviceTaskId)}/state?action=cancel`, {}, token);
        }
        await call('POST', `/api/tasks/${encodeURIComponent(linkTaskId)}/state?action=cancel`, {}, token);
      }

      // ── 14. NO-41a：佩戴事实双源校验（会话声明 × 真实遥测）──────────────
      // 用真实摄入通道上报两帧：一帧声明佩戴者=会话佩戴者（应判"一致"），
      // 一帧声明另一个人（应判"佩戴人不符"且需人核实）。全程不伪造平台侧数据。
      const ingestKey = process.env.EWOH_E2E_INGEST_KEY || '';
      // 佩戴者用**已绑定登录账号**的人员（EWOH_E2E_PERSON_ID ↔ worker.zhangwei）：
      // 只有绑定存在，"点名到人"的提醒才发得出去（NO-37a 的账号↔人员绑定）。
      const boundPersonId = process.env.EWOH_E2E_PERSON_ID || '';
      const consistencyPersonId = boundPersonId || people[0]?.id || `P-CONSIST-${tag}`;
      const otherConsistencyPerson = people.find((p) => p.id !== consistencyPersonId)?.id ?? `P-OTHERC-${tag}`;
      // 摄入是 fail-closed 的：帧的 `entity_id` 必须是**已登记的空间实体**。
      // 这里按产品路径的约定临时登记一个（幂等），否则帧会被 400 拒绝、
      // 一致性校验读到的是很久以前的旧帧（实测踩过：被判成 stale_telemetry）。
      const ingestEntityId = `person:no41-${tag}`;
      let entityReady = false;
      if (OWNER_DB) {
        const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
        try {
          await sql`
            insert into ewoh_spatial_entity
              (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
            values (${INGEST_ORG}, ${ingestEntityId}, 'person', ${`NO-41a 遥测一致性探针 ${tag}`}, 10, 20, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
            on conflict (org_id, entity_id) do update set status = 'active'`;
          entityReady = true;
        } catch (error) {
          skip('14. 佩戴事实双源校验', `登记空间实体失败：${String(error).slice(0, 120)}`);
        } finally {
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      }
      if (!ingestKey) {
        skip('14. 佩戴事实双源校验', '未提供 EWOH_E2E_INGEST_KEY（无法走真实遥测通道）');
      } else if (!entityReady) {
        skip('14. 佩戴事实双源校验', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法登记帧所需的空间实体）');
      } else {
        const consistencySessionId = `exo-session:NO41-${tag}`;
        const started6 = await call('POST', '/api/exo/sessions', {
          sessionId: consistencySessionId,
          exoId: `device:${exoDevice.deviceId}`,
          personId: `person:${consistencyPersonId}`,
          startedAt: new Date().toISOString(),
        }, token);
        const baseConsistency = await call('GET', '/api/exo/sessions/consistency', undefined, token);
        const before = (baseConsistency.body?.sessions ?? []).find((s) => s.sessionId === consistencySessionId);

        const ingest = (workerId) =>
          fetch(`${BASE}/api/ingest/exoskeleton`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-ingest-key': ingestKey },
            body: JSON.stringify({
              device_id: exoDevice.deviceId,
              entity_id: ingestEntityId,
              event_time: new Date().toISOString(),
              source_type: 'simulated',
              worker_id: workerId,
              load: { cumulative_load_score: 0.4 },
              pose: { angular_velocity_dps: 3 },
              device: { battery_pct: 66 },
              quality: { status: 'good', confidence: 0.9 },
            }),
          });

        const samePersonFrame = await ingest(consistencyPersonId);
        const sameBody = await samePersonFrame.json().catch(() => null);
        const afterSame = await call('GET', '/api/exo/sessions/consistency', undefined, token);
        const sameVerdict = (afterSame.body?.sessions ?? []).find((s) => s.sessionId === consistencySessionId);
        step('14. 遥测上报的佩戴人 = 会话佩戴者 → 判定"与遥测一致"（两源互相印证）',
          (started6.status === 201 || started6.status === 200)
            && (samePersonFrame.status === 200 || samePersonFrame.status === 201)
            && sameBody?.accepted === true
            && sameVerdict?.verdict === 'consistent'
            && sameVerdict?.needsHumanCheck === false,
          `ingest=${samePersonFrame.status} accepted=${sameBody?.accepted} before=${before?.verdict ?? 'none'} after=${sameVerdict?.verdict ?? 'none'}`);

        const otherFrame = await ingest(otherConsistencyPerson);
        const otherBody = await otherFrame.json().catch(() => null);
        const afterOther = await call('GET', '/api/exo/sessions/consistency', undefined, token);
        const mismatch = (afterOther.body?.sessions ?? []).find((s) => s.sessionId === consistencySessionId);
        step('14a. 遥测上报的佩戴人是别人 → 判定"佩戴人不符"且需人核实（平台不替任何一方下结论）',
          (otherFrame.status === 200 || otherFrame.status === 201)
            && otherBody?.accepted === true
            && mismatch?.verdict === 'wearer_mismatch'
            && mismatch?.needsHumanCheck === true,
          `ingest=${otherFrame.status} accepted=${otherBody?.accepted} verdict=${mismatch?.verdict ?? 'none'} worker=${mismatch?.telemetryWorkerRef ?? 'none'}`);

        // NO-42a：证据维度的冲突必须能**主动叫到人**（复用 NO-37a 的幂等提醒通道）。
        const telemetrySweep = await call('POST', '/api/exo/sessions/reminder-sweep', {}, token);
        const telemetryNotifications = (telemetrySweep.body?.notifications ?? []).filter(
          (n) => n.sessionId === consistencySessionId && String(n.bucket).startsWith('telemetry_'),
        );
        const hasRoleNotice = telemetryNotifications.some(
          (n) => n.recipientType === 'role' && n.bucket === 'telemetry_wearer_mismatch',
        );
        const hasWearerNotice = telemetryNotifications.some(
          (n) => n.recipientType === 'user' && n.bucket === 'telemetry_wearer_mismatch',
        );
        step('14c. 遥测冲突进入主动提醒：佩戴人不一致 → 班组长（+ 绑定账号存在时点名佩戴者本人）',
          telemetrySweep.status === 200
            && (telemetrySweep.body?.telemetry?.wearerMismatch ?? 0) >= 1
            && hasRoleNotice
            && (!boundPersonId || hasWearerNotice),
          `status=${telemetrySweep.status} mismatch=${telemetrySweep.body?.telemetry?.wearerMismatch} role=${hasRoleNotice} wearer=${hasWearerNotice} notes=${telemetryNotifications.length}`);

        const telemetrySweepAgain = await call('POST', '/api/exo/sessions/reminder-sweep', {}, token);
        const againTelemetry = (telemetrySweepAgain.body?.notifications ?? []).filter(
          (n) => n.sessionId === consistencySessionId && String(n.bucket).startsWith('telemetry_'),
        );
        step('14d. 同一次冲突重复扫描不重复打扰（created=false，幂等键 NTF-EXO-…-telemetry-…）',
          telemetrySweepAgain.status === 200 && againTelemetry.length > 0 && againTelemetry.every((n) => n.created === false),
          `created=${againTelemetry.filter((n) => n.created).length} total=${againTelemetry.length}`);

        step('14b. 一致性响应自带口径说明（缺遥测=无佐证；不一致由人核实）',
          Array.isArray(afterOther.body?.notes)
            && afterOther.body.notes.join('').includes('无佐证')
            && afterOther.body.notes.join('').includes('人核实')
            && typeof afterOther.body?.freshWindowMs === 'number',
          `notes=${(afterOther.body?.notes ?? []).length} freshWindowMs=${afterOther.body?.freshWindowMs}`);

        // ── 15. NO-43a：按实际佩戴人更正（人核实之后必须能落成事实）────────
        // 平台自己不做这个决定（遥测只是证据），但现场核实完必须有一条命令能把它变成
        // 事实：旧会话按"交接"收工并留下理由与指向，新会话按实际佩戴人重开。
        const barePerson = (value) => String(value ?? '').replace(/^person:/, '');
        const correctPath = `/api/exo/sessions/${encodeURIComponent(consistencySessionId)}/correct-wearer`;

        const noPerson = await call('POST', correctPath, {}, token);
        step('15. 更正佩戴人缺 personId → 400（"改成空"不是合法更正）',
          noPerson.status === 400,
          `status=${noPerson.status} msg=${errText(noPerson.body).slice(0, 80)}`);

        const samePerson = await call('POST', correctPath, { personId: consistencyPersonId }, token);
        const afterSameAttempt = await call('GET', '/api/exo/sessions', undefined, token);
        const stillThere = listOf(afterSameAttempt.body).find((s) => s.sessionId === consistencySessionId);
        step('15a. 更正成当前佩戴人 → 400 EXO_SESSION_WEARER_UNCHANGED，且不产生第二条事实',
          samePerson.status === 400
            && errText(samePerson.body).includes('EXO_SESSION_WEARER_UNCHANGED')
            && stillThere?.status === 'active',
          `status=${samePerson.status} session=${stillThere?.status} msg=${errText(samePerson.body).slice(0, 60)}`);

        const corrected = await call('POST', correctPath, {
          personId: otherConsistencyPerson,
          endedBy: 'lead.chen',
          reason: `NO-43a 现场核实：实际佩戴人 ${otherConsistencyPerson}`,
        }, token);
        const correctedBody = corrected.body ?? {};
        const successorId = correctedBody?.started?.sessionId ?? null;
        step('15b. 按实际佩戴人更正：旧会话以"交接"收工（理由 + 结束人 + 指向新会话），新会话是实际佩戴人',
          (corrected.status === 201 || corrected.status === 200)
            && correctedBody?.corrected === true
            && correctedBody?.ended?.status === 'ended'
            && String(correctedBody?.ended?.reason ?? '').includes('NO-43a')
            && correctedBody?.ended?.endedBy === 'lead.chen'
            && Boolean(correctedBody?.ended?.actualEndAt)
            && correctedBody?.started?.status === 'active'
            && barePerson(correctedBody?.started?.personId) === barePerson(otherConsistencyPerson)
            && successorId !== consistencySessionId
            // 更正链路双向可见：旧 → 新（correctedTo）、新 → 旧（correctedFrom）
            && correctedBody?.ended?.correctedTo === successorId
            && correctedBody?.started?.correctedFrom === consistencySessionId
            // NO-44a：旧会话的冲突提醒随更正关闭（交接后旧提醒不再挂着）
            && (correctedBody?.resolvedNotificationCount ?? 0) >= 1,
          `status=${corrected.status} successor=${successorId ?? 'none'} to=${correctedBody?.started?.personId ?? 'none'}`);

        const afterCorrection = await call('GET', '/api/exo/sessions/consistency', undefined, token);
        const successorVerdict = (afterCorrection.body?.sessions ?? []).find((s) => s.sessionId === successorId);
        const originalVerdict = (afterCorrection.body?.sessions ?? []).find((s) => s.sessionId === consistencySessionId);
        step('15c. 更正后一致性翻转：新会话与遥测一致，旧会话不再参与校验（终态不悬空）',
          successorVerdict?.verdict === 'consistent'
            && successorVerdict?.needsHumanCheck === false
            && !originalVerdict,
          `successor=${successorVerdict?.verdict ?? 'none'} original=${originalVerdict?.verdict ?? 'gone'}`);

        const history = await call('GET', '/api/exo/sessions', undefined, token);
        const endedOriginal = listOf(history.body).find((s) => s.sessionId === consistencySessionId);
        step('15d. 更正不覆盖历史：原佩戴人的会话仍在台账且为 ended（谁戴过、谁核实都可追溯）',
          endedOriginal?.status === 'ended'
            && barePerson(endedOriginal?.personId) === barePerson(consistencyPersonId)
            && Boolean(endedOriginal?.actualEndAt),
          `status=${endedOriginal?.status ?? 'missing'} person=${endedOriginal?.personId ?? 'missing'}`);

        // NO-44a：更正关闭的提醒必须能反查到"这次交接"（resolutionRef=新会话），
        // 否则事后无法回答"这条提醒是怎么了结的"。
        //
        // 2026-09-13 修正视角：这条 `telemetry_wearer_mismatch` 提醒的收件人是
        // **workshop_lead 角色**（+ 被误报佩戴人的绑定账号；该人若无绑定账号则
        // 如实只有角色行）。此前用 worker（wearerToken）去读——worker 不是收件人，
        // 通知中心按收件人过滤后读不到，count=0。那是**权限语义正确**的表现，
        // 不是闭环断了。改为用 workshop_lead 账号（审批人账号即该角色）读。
        if (!approverToken && !wearerToken) {
          skip('15g. 更正关闭的提醒指向新会话', '无可用收件人账号（无法按收件人视角验证）');
        } else {
          const viewerToken = approverToken ?? wearerToken;
          const correctedResolved = await call('GET', '/api/notifications?status=resolved', undefined, viewerToken);
          const crossChecked = (correctedResolved.body?.notifications ?? listOf(correctedResolved.body)).filter(
            (n) => n.externalRef === consistencySessionId && n.resolution === 'session_corrected',
          );
          step('15g. 更正关闭的提醒带"已随佩戴人更正关闭"并指向新会话（可反查这次交接）',
            correctedResolved.status === 200
              && crossChecked.length >= 1
              && crossChecked.every((n) => n.resolutionRef === successorId && n.resolvedBy === 'lead.chen'),
            `count=${crossChecked.length} ref=${crossChecked[0]?.resolutionRef ?? 'none'}`);
        }

        // 权限边界：更正会替**另一个人**建立"正在佩戴"的事实，比收工更敏感——
        // 现场账号（任何已认证用户）不得执行，且被拒时不能留下任何副作用。
        if (!wearerToken) {
          skip('15f. 现场账号无权更正他人会话', '现场账号未登录（无法验证权限边界）');
        } else {
          const denied = await call('POST', correctPath, {
            personId: otherConsistencyPerson,
            reason: 'NO-43a 越权尝试',
          }, wearerToken);
          const afterDenied = await call('GET', '/api/exo/sessions/consistency', undefined, token);
          const stillActive = (afterDenied.body?.sessions ?? []).some((s) => s.sessionId === successorId);
          step('15f. 现场账号无权替他人更正（403）且被拒后不产生副作用（新会话仍在进行中）',
            (denied.status === 403 || denied.status === 401) && stillActive,
            `status=${denied.status} successorActive=${stillActive}`);
        }

        // 更正产生的新会话必须还能走常规收工，否则设备会被"更正"永久占住。
        const endSuccessor = await call('POST', `/api/exo/sessions/${encodeURIComponent(successorId)}/end`, {
          endedBy: 'lead.chen',
          reason: 'NO-43a 更正后收工（释放设备）',
        }, token);
        step('15e. 更正产生的新会话可按常规流程收工（更正不是死胡同，设备被释放）',
          (endSuccessor.status === 201 || endSuccessor.status === 200) && endSuccessor.body?.status === 'ended',
          `status=${endSuccessor.status} session=${endSuccessor.body?.status ?? 'none'}`);
      }

      // 第 15 组依赖真实遥测证据；前置不可用时必须显式 SKIP，
      // 不能"没跑"却看起来像通过（否则覆盖率的数字是假的）。
      if (!ingestKey || !entityReady) {
        skip('15. 按实际佩戴人更正', '前置：遥测双源校验未执行（更正以真实遥测证据为前提）');
      }
    }
  }

  // ---- 16. NO-67d 清理自证：本场景创建的会话**全部终结**（活跃会话=残留）----
  // 一台设备只允许一个活跃会话——中断的运行留下 active 会话会让下次运行被拒，
  // 现场表现为"设备明明空着却被告知已有会话"。这里在收尾处自查：本场景
  // 创建的会话（sessionId 含本次 tag）没有仍处于 active 的。
  try {
    if (!OWNER_DB) {
      record('SKIP', '16. 清理自证', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法直查会话表）');
      finish();
      return;
    }
    if (createdSessionIds.length === 0) {
      record('PASS', '16. 清理自证（本场景未创建需终结的会话）', true);
    } else {
      const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
      try {
        // postgres.js 原生支持数组参数（= any($1)）
        const leftoverActive = await sql`
          select session_id from ewoh_exo_session
           where session_id = any(${createdSessionIds})
             and status = 'active' limit 5`;
        if (leftoverActive.length === 0) {
          record('PASS', '16. 清理自证（本场景会话无活跃残留）', `${createdSessionIds.length} 个会话全部终结`);
        } else {
          record(
            'FAIL',
            '16. 清理自证',
            `活跃会话残留 ${leftoverActive.length} 条（${leftoverActive.map((r) => r.session_id).join(',')}）`,
          );
        }
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }
  } catch (error) {
    // 无法自查（如 DB 不可达）也必须可见，不能只 warn（NO-64 教训）
    record('FAIL', '16. 清理自证', `自查失败：${error?.message ?? error}`);
  }

  finish();
}

main().catch((error) => {
  record('FAIL', '脚本异常', String(error?.stack ?? error));
  finish();
});
