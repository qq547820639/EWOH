/**
 * 能力停用 → 方案解释闭环 E2E（NO-15c）。
 *
 * 为什么单列这条链路：能力被人为停用后，任务会找不到候选设备（fail-closed 正确），
 * 但方案上如果只显示"capability_disabled ×2"，班组长仍不知道**是哪个能力、谁在何时
 * 因何停用**——而那正是处置所需的全部信息。本脚本验证从"人工停用"到"方案条目里能读到
 * 停用人与理由"的完整链路（跨 API → 台账 → 世界模型 → 资格 → 候选池 → 求解器 → 方案）。
 *
 * 步骤：
 *   1. 重置场景数据；登录管理员；
 *   2. 找一个**执行能力**（exo-lift 等）当前生效的设备（快照 devices[].capabilities）；
 *   3. 人工停用该能力（带理由）→ 断言快照 capabilities 不再含它、disabledCapabilities 含它；
 *   4. 生成一次调度方案 → 断言未派工违反项同时带 rejectReasons 与 capabilityNotes，
 *      且 notes 里能读到"哪个能力 + 停用操作者 + 理由"；
 *   5. 恢复能力（收尾）→ 断言快照恢复含该能力；
 *   6. 全程如实区分 PASS/FAIL/SKIP（缺凭证/无可用设备时 SKIP 并说明）。
 *
 * 运行：EWOH_E2E_BACKEND_URL=... EWOH_E2E_ADMIN_PASS=... node test/e2e/capability-disabled-plan-explain.mjs
 */
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || '';

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, detail = '') => record('SKIP', name, detail);

function request(method, path, data, token) {
  const url = new URL(`${BASE}${path}`);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = data ? JSON.stringify(data) : null;
  return new Promise((resolve, reject) => {
    const req = doRequest(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
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
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 经审批完成一次"放宽高风险能力"（NO-20a 的完整流程）。
 *
 * 语义：收紧不需要审批；**放宽**高风险要求（撤销原来要求的高风险能力）属执行边界变更，
 * 必须由安全管理员审批，且发起人回避（自批 403）。返回每一步的结果供断言。
 */
async function relaxWithApproval(params) {
  const { taskId, nextDeviceCapabilities, relaxedHighRisk = [], token, approverToken, label } = params;
  const url = `/api/tasks/${encodeURIComponent(taskId)}/requirements`;
  const blocked = await request('PATCH', url, { requiredDeviceCapabilities: nextDeviceCapabilities }, token);
  const created = await request('POST', '/api/approvals', {
    entityType: 'task_capability_change',
    entityId: taskId,
    roles: ['safety_admin'],
    subject: {
      objectType: 'task_capability_change',
      objectId: taskId,
      title: label,
      summary: `e2e：${label}`,
      metrics: {
        relaxedHighRiskCapabilities: [...relaxedHighRisk].sort().join(','),
        resultingDeviceCapabilities: [...nextDeviceCapabilities].sort().join(','),
        resultingStationCapabilities: '',
      },
    },
  }, approverToken);
  const approvalId = created.body?.id ?? null;
  const stepId = created.body?.steps?.[0]?.id ?? null;
  const selfApprove = approvalId && stepId
    ? await request('POST', `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'self' }, approverToken)
    : { status: 0 };
  const approved = approvalId && stepId
    ? await request('POST', `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'e2e 安全复核通过' }, token)
    : { status: 0 };
  const applied = approvalId
    ? await request('PATCH', url, { requiredDeviceCapabilities: nextDeviceCapabilities, approvalId }, token)
    : { status: 0 };
  return { blocked, created, approvalId, stepId, selfApprove, approved, applied };
}

/** 高风险能力（与契约 capabilityRisk=high 一致；用于计算"被放宽"的集合）。 */
const HIGH_RISK_CAPABILITIES = ['crane', 'exo-lift', 'interact.assist', 'forklift'];

/**
 * 设置任务能力要求（自动判断是否需要审批）。
 *
 * 被放宽 = 原来要求、变更后不再要求，且属于高风险——**只看真正被去掉的**：
 * 早先版本把"保留的高风险能力"也算进被放宽集合，导致审批指纹与真实变更不符、
 * 服务端按设计拒绝（APPROVAL_INVALID）。
 */
async function setRequirements(params) {
  const { taskId, next, current, token, approverToken, label } = params;
  const relaxed = current.filter(
    (c) => HIGH_RISK_CAPABILITIES.includes(String(c)) && !next.includes(String(c)),
  );
  const url = `/api/tasks/${encodeURIComponent(taskId)}/requirements`;
  if (relaxed.length === 0) {
    return request('PATCH', url, { requiredDeviceCapabilities: next }, token);
  }
  const flow = await relaxWithApproval({
    taskId,
    nextDeviceCapabilities: next,
    relaxedHighRisk: relaxed,
    token,
    approverToken,
    label: label ?? 'e2e 放宽高风险能力',
  });
  return flow.applied;
}

/**
 * 一次审批覆盖一批设备的"恢复高风险能力"（NO-21a）。
 *
 * 语义：恢复 exo-lift 一类高风险能力 = 设备重新具备高风险作业资格（重新投运是安全决定），
 * 必须由安全管理员审批；停用属收紧不需要审批。审批按**能力 + 设备名单**授权，
 * 因此一次维护动作只需一张审批（而不是逐台审批）。
 */
async function restoreDevicesWithApproval(params) {
  const { deviceIds, capability, token, approverToken, reason } = params;
  const urlOf = (deviceId) =>
    `/api/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(capability)}/status`;
  // 1) 无审批 → 期望被闸门拦下
  const blocked = await request('POST', urlOf(deviceIds[0]), { status: 'active', reason }, token);
  // 2) 创建覆盖整批设备的审批
  const created = await request('POST', '/api/approvals', {
    entityType: 'device_capability_change',
    entityId: `capability:${capability}`,
    roles: ['safety_admin'],
    subject: {
      objectType: 'device_capability_change',
      objectId: `capability:${capability}`,
      title: `恢复高风险能力：${capability}（${deviceIds.length} 台设备）`,
      summary: `e2e：${reason}`,
      metrics: {
        capabilityKey: capability,
        deviceIds: [...deviceIds].sort().join(','),
      },
    },
  }, approverToken);
  const approvalId = created.body?.id ?? null;
  const stepId = created.body?.steps?.[0]?.id ?? null;
  const selfApprove = approvalId && stepId
    ? await request('POST', `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'self' }, approverToken)
    : { status: 0 };
  const approved = approvalId && stepId
    ? await request('POST', `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'e2e 安全复核通过' }, token)
    : { status: 0 };
  // 3) 逐台带审批号恢复
  const applied = [];
  for (const deviceId of deviceIds) {
    const res = await request('POST', urlOf(deviceId), { status: 'active', reason, approvalId }, token);
    applied.push({ deviceId, status: res.status, changed: res.body?.changed, approvalId: res.body?.approvalId });
  }
  return { blocked, created, approvalId, stepId, selfApprove, approved, applied };
}

async function loginAs(username, password) {
  if (!password) return null;
  const res = await request('POST', '/api/auth/login', { username, password });
  if (res.status !== 200 && res.status !== 201) return null;
  return res.body?.accessToken ?? null;
}

/**
 * NO-22a：把审批实例"变旧"（把 `_updated_at` 回拨 N 小时）。
 *
 * 时效闸门读的是审批实例行的最后写入时间（= 最后一步放行时刻）。要验证"过期不放行"
 * 就必须真的造一张旧审批——而不是在测试里假设它过期。直接改库是**测试夹具**行为，
 * 与被测路径（API 校验）无关；无 owner 连接时返回 ok=false，调用方据此 SKIP/FAIL。
 */
async function backdateApproval(approvalId, hoursAgo) {
  const ownerUrl = process.env.EWOH_E2E_OWNER_DATABASE_URL;
  if (!ownerUrl || !approvalId) return { ok: false, detail: 'no-owner-url-or-id' };
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      update public.ewoh_event
         set _updated_at = now() - ${`${hoursAgo} hours`}::interval
       where event_id = ${approvalId}
         and event_type = 'approval_instance'
      returning event_id, _updated_at
    `;
    return { ok: rows.length === 1, detail: `${rows.length} row(s) → ${rows[0]?._updated_at?.toISOString?.() ?? ''}` };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loginAdmin() {
  if (!ADMIN_PASS) return null;
  const res = await request('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (res.status !== 200 && res.status !== 201) return null;
  return res.body?.accessToken ?? null;
}

/**
 * 找出**所有**持有某执行能力（非 observe.*）的设备。
 *
 * 必须全停：只停一台时其他设备仍能满足任务要求，方案不会出现未派工条目，
 * 也就验证不到"方案解释"这一段（2026-09-11 实测：单停一台 → annotated=0）。
 */
/**
 * 本脚本断言的是「恢复**高风险**能力必须持审批」这道闸门，所以必须优先选中
 * 高风险执行能力（`shared/device-capability.ts` 的 risk='high'）。
 *
 * 2026-09-11 实测：原实现取"设备列表里第一个非 observe.* 能力"，一旦快照顺序
 * 落在中风险能力（exo-lite / vacuum）上，闸门**本就不该拦**，于是
 * "无审批恢复 → 409""消费后再用 → 409"等 7 项断言全部误报失败——
 * 是脚本选材不稳，不是产品缺陷。
 */
const HIGH_RISK_EXECUTION_CAPABILITIES = ['exo-lift', 'crane', 'interact.assist'];

function pickExecutableTarget(snapshot) {
  const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
  const executable = devices
    .flatMap((d) => (Array.isArray(d.capabilities) ? d.capabilities : []))
    .filter((c) => !String(c).startsWith('observe.'));
  // 2026-09-12（第 64 轮）：**优先 `exo-lift`**，不要"谁在库里先出现就用谁"。
  // 实测教训：本开发库长期运行后 `interact.assist` 覆盖 127 台设备，而该能力大量
  // 出现在**从未声明过它**的设备上 → 方案未派工条目里出现的是"能力缺失（missing）"
  // 而不是"能力被人工停用（disabled）"，说明文案**正确地**不给"已被人工停用：谁/何时/为何"
  // （缺失 ≠ 停用）。场景却按"所有条目都应带停用留痕"断言 → 10 项 FAIL，
  // 看起来像解释链路坏了。固定目标能力让场景验证它真正要验证的语义；
  // 需要换目标时用 `EWOH_E2E_CAP_TARGET` 显式覆盖（现场/其它数据集）。
  const preferred = process.env.EWOH_E2E_CAP_TARGET
    ? [process.env.EWOH_E2E_CAP_TARGET]
    : ['exo-lift', ...HIGH_RISK_EXECUTION_CAPABILITIES.filter((c) => c !== 'exo-lift')];
  const capability =
    preferred.find((c) => executable.includes(c))
    ?? HIGH_RISK_EXECUTION_CAPABILITIES.find((c) => executable.includes(c))
    ?? executable[0];
  if (!capability) return null;
  const holders = devices
    .filter((d) => Array.isArray(d.capabilities) && d.capabilities.includes(capability))
    .map((d) => String(d.deviceId))
    .filter(Boolean);
  if (holders.length === 0) return null;
  return {
    capability: String(capability),
    deviceIds: holders,
    highRisk: HIGH_RISK_EXECUTION_CAPABILITIES.includes(String(capability)),
  };
}

/**
 * 找一台"曾经有高风险执行能力、当前被停用"的设备（用于恢复场景前置条件）。
 *
 * 读面：设备详情返回 `disabledCapabilities`（含被人工停用的能力）。
 * 只读取，不猜测；找不到就返回 null（调用方 SKIP）。
 */
async function findDisabledHighRiskCapability(token) {
  const listed = await request('GET', '/api/devices?limit=50', null, token);
  const devices = listed.body?.devices ?? listed.body?.items ?? [];
  for (const device of devices) {
    const deviceId = String(device?.deviceId ?? '');
    if (!deviceId) continue;
    const detail = await request('GET', `/api/devices/${encodeURIComponent(deviceId)}`, null, token);
    const disabled = Array.isArray(detail.body?.disabledCapabilities) ? detail.body.disabledCapabilities : [];
    const hit = HIGH_RISK_EXECUTION_CAPABILITIES.find((c) => disabled.includes(c));
    if (hit) return { deviceId, capability: hit };
  }
  return null;
}

async function fetchSnapshot(token) {
  const res = await request('GET', '/api/scheduler/snapshot', null, token);
  return { status: res.status, snapshot: res.body };
}

function findDevice(snapshot, deviceId) {
  const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
  return devices.find((d) => d.deviceId === deviceId) ?? null;
}

async function main() {
  console.log(`能力停用 → 方案解释 E2E @ ${BASE}`);
  /** 为验证解释链路临时改了能力要求的任务（收尾必须复原）。 */
  let capabilityTasks = [];
  const token = await loginAdmin();
  if (!token) {
    skip('1. 管理员登录', '未提供 EWOH_E2E_ADMIN_PASS，跳过（真实链路需要管理员权限）');
    finish();
    return;
  }
  step('1. 管理员登录', true);

  let before = await fetchSnapshot(token);
  let target = pickExecutableTarget(before.snapshot);
  if (!target) {
    // 场景前置条件必须由场景自己建立或**显式说明**（此前实测：上一轮被中断的运行会把
    // exo-lift 留在"已停用"状态 → 本轮找不到生效中的高风险能力，脚本却继续往下断言，
    // 报出一串与解释链路无关的 FAIL）。这里先尝试用**规范路径**（审批）恢复一台设备的能力，
    // 恢复不了就 SKIP 并写明原因——不把环境状态伪装成产品缺陷。
    const disabledCandidates = await findDisabledHighRiskCapability(token);
    // 恢复 = 高风险能力的"放宽"，必须由**另一身份**审批（自批会被拒）
    const approverTokenForRestore = await loginAs(
      process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
      process.env.EWOH_E2E_APPROVER_PASS,
    );
    if (disabledCandidates && approverTokenForRestore) {
      const restored = await restoreDevicesWithApproval({
        deviceIds: [disabledCandidates.deviceId],
        capability: disabledCandidates.capability,
        token,
        approverToken: approverTokenForRestore,
        reason: 'e2e：恢复场景前置条件（上一轮中断留下的停用状态）',
      });
      const restoredOk = restored.applied.every((r) => r.status === 200 && r.changed === true);
      record(
        restoredOk ? 'PASS' : 'SKIP',
        '1b. 场景前置条件：把上一轮遗留的"高风险能力已停用"按审批路径恢复',
        `${disabledCandidates.deviceId}/${disabledCandidates.capability} applied=${JSON.stringify(restored.applied)}`,
      );
      before = await fetchSnapshot(token);
      target = pickExecutableTarget(before.snapshot);
    } else if (disabledCandidates && !approverTokenForRestore) {
      record('SKIP', '1b. 场景前置条件恢复', '缺少 EWOH_E2E_APPROVER_PASS（无法按审批路径恢复被停用的高风险能力）');
    }
    if (!target) {
      skip(
        '2. 选择具备执行能力的设备',
        '当前快照没有**生效中**的执行能力（设备能力可能仍处于停用状态）——'
          + '本场景验证的是"停用后方案如何解释"，前置条件不满足时不应给出与链路无关的断言',
      );
      finish();
      return;
    }
  }
  const statusUrlOf = (deviceId) =>
    `/api/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(target.capability)}/status`;
  step('2. 选择具备执行能力的设备（需全停才验证得到解释）', true,
    `${target.capability}${target.highRisk ? '' : '（注意：非高风险，审批闸门断言不适用）'}`
    + ` · ${target.deviceIds.length} 台（${target.deviceIds.slice(0, 3).join(',')}${target.deviceIds.length > 3 ? '…' : ''}）`);
  if (!target.highRisk) {
    skip('2a. 高风险审批闸门断言', `快照里没有高风险执行能力（exo-lift/crane/interact.assist），`
      + `当前选中的 ${target.capability} 属中/低风险，审批闸门本就不适用`);
  }

  const REASON = 'e2e：NO-15c 停用解释链路验证（验证后恢复）';
  const disableResults = [];
  for (const deviceId of target.deviceIds) {
    const res = await request('POST', statusUrlOf(deviceId), { status: 'disabled', reason: REASON }, token);
    disableResults.push({ deviceId, status: res.status, changed: res.body?.changed, code: res.body?.error?.code });
  }
  const disableOk = disableResults.every((r) => r.status === 200 && r.changed === true);
  step('3. 人工停用执行能力（带理由；型号派生能力也必须可停）', disableOk,
    disableResults
      .map((r) => `${r.deviceId}:${r.status}/${String(r.changed)}${r.code ? `(${r.code})` : ''}`)
      .join(' '));

  // 让任务真的要求该能力：否则"停用"不会造成任何未派工（场景任务默认不要求设备能力）。
  // NO-16a：用**任务能力要求写入口**（PATCH /api/tasks/:id/requirements），不再直连库。
  const tasksRes = await request('GET', '/api/tasks', null, token);
  const allTasks = Array.isArray(tasksRes.body)
    ? tasksRes.body
    : (tasksRes.body?.items ?? []);
  // 选择可编辑任务时要排除**当前要求高风险能力**的任务：收紧到高风险能力不需要审批，
  // 但从高风险能力上"放宽/改写"必须走审批（409 HIGH_RISK_CAPABILITY_RELAXATION_…）。
  // 2026-09-12 实测：上一次被中断的 AGV 场景把 `E2E 搬运任务 …`（要求 transport.move，
  // 高危）留在库里，本场景挑中它 → 3b 的 PATCH 409 → 7b/7c/7d 连锁失败，
  // 看起来像"建议链路坏了"，其实是**任务选择没有排除高危前置条件**。
  const HIGH_RISK_CAPS = new Set(['exo-lift', 'interact.assist', 'transport.move', 'crane']);
  const editable = allTasks
    .filter((t) =>
      ['draft', 'pending_dispatch', 'pending', 'scheduled'].includes(String(t.status)),
    )
    .filter((t) => {
      const caps = Array.isArray(t.requiredDeviceCapabilities) ? t.requiredDeviceCapabilities : [];
      return !caps.some((c) => HIGH_RISK_CAPS.has(String(c)));
    })
    .slice(0, 2);
  const requirementResults = [];
  const approverTokenForSetup = await loginAs(
    process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
    process.env.EWOH_E2E_APPROVER_PASS || '',
  );
  for (const t of editable) {
    const taskId = String(t.id);
    const leftover = Array.isArray(t.requiredDeviceCapabilities) ? t.requiredDeviceCapabilities : [];
    // 归一化：清空遗留要求（若含高风险 → 必须经审批，顺带再次验证闸门），
    // 使场景不依赖上一次运行的残留状态（此前实测：遗留 crane+exo-lift 会让本轮第一步就被闸门拦下）。
    if (leftover.length > 0) {
      await setRequirements({
        taskId,
        next: [],
        current: leftover,
        token,
        approverToken: approverTokenForSetup,
        label: 'e2e 归一化：清空上一轮遗留的能力要求',
      });
    }
    const res = await setRequirements({
      taskId,
      next: [target.capability],
      current: [],
      token,
      approverToken: approverTokenForSetup,
      label: 'e2e：设置本轮能力要求',
    });
    requirementResults.push({ id: taskId, status: res.status, warnings: res.body?.warnings ?? [] });
    if (res.status === 200) capabilityTasks.push({ id: taskId, original: [] });
  }
  step('3b. 经 API 给任务写能力要求（PATCH /api/tasks/:id/requirements）',
    requirementResults.length > 0 && requirementResults.every((r) => r.status === 200) && capabilityTasks.length > 0,
    `tasks=${requirementResults.map((r) => `${r.id.slice(0, 8)}:${r.status}`).join(',')} capability=${target.capability} warnings=${requirementResults.flatMap((r) => r.warnings).length}`);
  // 非法输入必须拒绝（形状校验，不猜不截断）
  if (capabilityTasks.length > 0) {
    const invalid = await request(
      'PATCH',
      `/api/tasks/${encodeURIComponent(capabilityTasks[0].id)}/requirements`,
      { requiredDeviceCapabilities: 'exo-lift' },
      token,
    );
    step('3c. 能力要求形状非法 → 400（不隐式转换）', invalid.status === 400, `status=${invalid.status}`);
  }

  const afterDisable = await fetchSnapshot(token);
  const deviceAfter = findDevice(afterDisable.snapshot, target.deviceIds[0]);
  const capsAfter = Array.isArray(deviceAfter?.capabilities) ? deviceAfter.capabilities : [];
  const disabledAfter = Array.isArray(deviceAfter?.disabledCapabilities) ? deviceAfter.disabledCapabilities : [];
  step('4. 世界模型如实反映：可用能力移除 + 停用事实保留',
    !capsAfter.includes(target.capability) && disabledAfter.includes(target.capability),
    `capabilities=${capsAfter.join('|')} disabled=${disabledAfter.join('|')}`);

  const run = await request('POST', '/api/scheduler/runs', { strategy: 'scheduling_v2', trigger: 'MANUAL' }, token);
  step('5. 触发生成方案', run.status === 201 || run.status === 200, `status=${run.status}`);

  const planId = run.body?.planId ?? run.body?.plans?.[0]?.planId ?? null;
  const listed = planId ? null : await request('GET', '/api/scheduler/plans?limit=10', null, token);
  const candidates = planId
    ? [planId]
    : (Array.isArray(listed?.body) ? listed.body : (listed?.body?.items ?? [])).map((p) => p.planId);
  let violations = [];
  let foundPlanId = null;
  for (const id of candidates.slice(0, 5)) {
    const detail = await request('GET', `/api/scheduler/plans/${id}`, null, token);
    const list = Array.isArray(detail.body?.violations) ? detail.body.violations : [];
    if (list.length > 0) {
      violations = list;
      foundPlanId = id;
      break;
    }
  }
  const targetTaskIds = new Set(capabilityTasks.map((t) => t.id));
  const relevant = violations.filter(
    (v) => (targetTaskIds.size === 0 || targetTaskIds.has(String(v.taskId)))
      && Array.isArray(v.rejectReasons) && v.rejectReasons.length > 0,
  );
  if (!foundPlanId) {
    skip('6. 方案未派工条目解释', '本次生成没有未派工条目（候选充足），无法验证解释链路');
  } else {
    const annotated = (relevant.length > 0 ? relevant : violations).filter(
      (v) => Array.isArray(v.capabilityNotes) && v.capabilityNotes.length > 0,
    );
    const notes = annotated.flatMap((v) => v.capabilityNotes).join('；');
    const reasons = relevant.flatMap((v) => (Array.isArray(v.rejectReasons) ? v.rejectReasons : []));
    // 断言口径（第 64 轮校准）：**至少一条**条目给出完整的停用留痕
    // （能力 + 谁 + 为何），并且不得把"能力缺失"说成"被人工停用"。
    // 为什么不是"每条都要有停用留痕"：同一方案里既有"被停用的设备"（capability_disabled）
    // 也有"从来没有这个能力的设备"（missing_device_capability，正确文案是"缺失"），
    // 后者不带停用留痕是**对的**（缺失 ≠ 停用，原则 7）。
    step('6. 未派工条目带上能力停用细节（哪个能力/谁/为何）',
      annotated.length > 0
        && reasons.includes('capability_disabled')
        && notes.includes(target.capability)
        && notes.includes(ADMIN_USER)
        && notes.includes('NO-15c 停用解释链路验证')
        && !/能力缺失[^；]*已被人工停用/.test(notes),
      `plan=${foundPlanId} reasons=${[...new Set(reasons)].join('|')} notes=${notes.slice(0, 140)}`);
  }

  if (capabilityTasks.length > 0) {
    // 复原 = 撤销原来要求的 exo-lift（高风险）→ 属"放宽"，必须经安全管理员审批。
    // 发起人回避：由 approver.li 发起、管理员（代安全角色）批准。
    const restores = [];
    for (const t of capabilityTasks) {
      const flow = await relaxWithApproval({
        taskId: t.id,
        nextDeviceCapabilities: t.original,
        relaxedHighRisk: ['exo-lift'],
        token,
        approverToken: await loginAs(
          process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
          process.env.EWOH_E2E_APPROVER_PASS || '',
        ),
        label: 'e2e 收尾：复原任务能力要求',
      });
      restores.push({
        blocked: flow.blocked.status,
        approval: flow.created.status,
        selfApprove: flow.selfApprove.status,
        approved: flow.approved.status,
        applied: flow.applied.status,
      });
    }
    step('6b. 高风险能力复原经审批完成（无审批被拒 → 自批被拒 → 他人批准 → 带号落地）',
      restores.every((r) => r.blocked === 409 && (r.approval === 201 || r.approval === 200)
        && r.selfApprove === 403 && r.approved === 200 && r.applied === 200),
      JSON.stringify(restores));
  }

  // NO-21a：恢复 exo-lift（高风险）必须经安全审批——一次审批覆盖整批设备。
  const fleetRestore = await restoreDevicesWithApproval({
    deviceIds: target.deviceIds,
    capability: target.capability,
    token,
    approverToken: await loginAs(
      process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
      process.env.EWOH_E2E_APPROVER_PASS || '',
    ),
    reason: 'e2e：链路验证完成，恢复设备能力',
  });
  step('7. 恢复高风险能力无审批 → 409（恢复=重新投运，属安全决定）',
    fleetRestore.blocked.status === 409
      && JSON.stringify(fleetRestore.blocked.body).includes('HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL'),
    `status=${fleetRestore.blocked.status}`);
  step('7a. 一次审批覆盖整批设备（自批 403 → 他人批准 → 逐台带号恢复）',
    (fleetRestore.created.status === 201 || fleetRestore.created.status === 200)
      && fleetRestore.selfApprove.status === 403
      && fleetRestore.approved.status === 200
      && fleetRestore.applied.every((r) => r.status === 200 && r.changed === true && r.approvalId === fleetRestore.approvalId),
    `devices=${fleetRestore.applied.length} approval=${fleetRestore.approvalId} applied=${fleetRestore.applied.filter((r) => r.status === 200).length}`);
  const afterRestore = await fetchSnapshot(token);
  const deviceRestored = findDevice(afterRestore.snapshot, target.deviceIds[0]);
  const capsRestored = Array.isArray(deviceRestored?.capabilities) ? deviceRestored.capabilities : [];
  step('7b. 恢复后世界模型重新把该能力计入可用集',
    capsRestored.includes(target.capability),
    `capabilities=${capsRestored.join('|')}`);

  // ---- NO-22a：授权时效与消耗（过期不能用 / 用过的不能再用 / 重新审批可用）----
  {
    const probeDevice = target.deviceIds[0];
    const statusUrl = `/api/devices/${encodeURIComponent(probeDevice)}/capabilities/${encodeURIComponent(target.capability)}/status`;
    const approverToken = await loginAs(
      process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
      process.env.EWOH_E2E_APPROVER_PASS || '',
    );
    // (i) 先停用（收紧不需要审批），为下面几次恢复尝试准备一个"待恢复"对象
    const tighten = await request('POST', statusUrl, { status: 'disabled', reason: 'e2e：验证授权时效' }, token);

    // (ii) 新建审批并批准，然后把它"变旧"（25 小时前通过）→ 恢复必须被时效拦住
    const created = await request('POST', '/api/approvals', {
      entityType: 'device_capability_change',
      entityId: `capability:${target.capability}`,
      roles: ['safety_admin'],
      subject: {
        objectType: 'device_capability_change',
        objectId: `capability:${target.capability}`,
        title: `恢复高风险能力：${target.capability}（时效验证）`,
        summary: 'e2e：NO-22a 授权时效验证',
        metrics: { capabilityKey: target.capability, deviceIds: probeDevice },
      },
    }, approverToken);
    const staleApprovalId = created.body?.id ?? null;
    const staleStepId = created.body?.steps?.[0]?.id ?? null;
    const staleApproved = staleApprovalId && staleStepId
      ? await request('POST', `/api/approvals/${staleApprovalId}/steps/${staleStepId}/state?action=approve`, { reason: 'e2e 时效验证' }, token)
      : { status: 0 };
    const backdated = await backdateApproval(staleApprovalId, 25);
    const staleAttempt = staleApprovalId
      ? await request('POST', statusUrl, { status: 'active', reason: 'e2e：用过期审批恢复', approvalId: staleApprovalId }, token)
      : { status: 0, body: null };
    step('7c. 审批超过 24 小时有效期 → 409 且要求重新审批（旧审批不能当今天的凭证）',
      tighten.status === 200
        && staleApproved.status === 200
        && backdated.ok
        && staleAttempt.status === 409
        && JSON.stringify(staleAttempt.body).includes('超出有效期'),
      `tighten=${tighten.status} approved=${staleApproved.status} backdate=${backdated.detail} restore=${staleAttempt.status}`);

    // (ii-b) 授权视图（NO-24a）：实时核对"这张授权还能不能用、已经用在哪"
    const authorizations = await request('GET', '/api/approvals/authorizations', null, token);
    const rows = Array.isArray(authorizations.body) ? authorizations.body : [];
    const fleetRow = rows.find((row) => row.approvalId === fleetRestore.approvalId) ?? null;
    const staleRow = rows.find((row) => row.approvalId === staleApprovalId) ?? null;
    const fleetUsageKeys = Array.isArray(fleetRow?.usage) ? fleetRow.usage.map((u) => u.usageKey) : [];
    step('7f. 授权视图显示时效与消耗（有效授权 remainingMs>0、已用对象逐条可查）',
      authorizations.status === 200
        && fleetRow !== null
        && fleetRow.status === 'approved'
        && fleetRow.expired === false
        && Number(fleetRow.remainingMs) > 0
        && Date.parse(String(fleetRow.expiresAt)) - Date.parse(String(fleetRow.approvedAt)) === 24 * 3600 * 1000
        && fleetUsageKeys.includes(`capability:${target.capability}|device:${probeDevice}`),
      `rows=${rows.length} fleet=${fleetRow ? `${fleetRow.status}/expired=${fleetRow.expired}/usage=${fleetUsageKeys.length}` : 'missing'}`);
    step('7g. 被回拨成 25 小时前的审批在授权视图里如实标记已过期（不是隐藏、不是仍显示有效）',
      staleRow !== null
        && staleRow.status === 'approved'
        && staleRow.expired === true
        && Number(staleRow.remainingMs) === 0,
      `stale=${staleRow ? `expired=${staleRow.expired}/remaining=${staleRow.remainingMs}` : 'missing'}`);

    // (iii) 用 7a 那张"已经用于本设备"的批量审批再恢复一次 → 必须被消耗语义拦住
    const reuseAttempt = await request('POST', statusUrl, {
      status: 'active',
      reason: 'e2e：复用同一审批',
      approvalId: fleetRestore.approvalId,
    }, token);
    step('7d. 同一审批再次用于本设备的恢复 → 409 APPROVAL_ALREADY_CONSUMED（一次现场决定只放行一次）',
      reuseAttempt.status === 409
        && JSON.stringify(reuseAttempt.body).includes('APPROVAL_ALREADY_CONSUMED'),
      `status=${reuseAttempt.status} approval=${fleetRestore.approvalId}`);

    // (iv) 重新申请（全新的审批）→ 正常放行（闸门不堵死合法流程）
    const refill = await restoreDevicesWithApproval({
      deviceIds: [probeDevice],
      capability: target.capability,
      token,
      approverToken,
      reason: 'e2e：重新审批后恢复（收尾）',
    });
    step('7e. 重新申请审批后恢复成功（闸门不堵死合法流程）',
      refill.applied.every((r) => r.status === 200 && r.changed === true && r.approvalId === refill.approvalId),
      `devices=${refill.applied.length} approval=${refill.approvalId}`);
  }

  // ---- 7b. 反事实放宽建议（NO-17a）：要求一个**没有任何设备具备**的能力 ----
  // 反事实建议的前提是"零候选 + 确实因能力被挡"，所以必须**用运行时事实挑能力**，
  // 而不是硬编码某个能力名（2026-09-12 实测：库中已有设备声明 `vacuum` →
  // 硬编码的"无人具备"前提失效，7b/7b2/7d 三连 FAIL，看起来像产品缺陷其实是脚本前提过期）。
  // 这里从快照里读出"已被声明的能力集合"，再从词表里挑**未声明**的能力：
  // 单项用中风险（不触发高风险审批闸门），组合用两个未声明能力。
  const declaredCaps = new Set(
    (afterRestore?.snapshot?.devices ?? []).flatMap((d) => (Array.isArray(d.capabilities) ? d.capabilities : [])),
  );
  // 风险等级来自 `shared/device-capability.ts`（契约值，稳定）：只列中风险能力候选。
  const MEDIUM_CAPABILITY_CANDIDATES = ['exo-lite', 'vacuum', 'observe.pose', 'observe.position', 'observe.wearer'];
  const undeclaredMedium = MEDIUM_CAPABILITY_CANDIDATES.filter((c) => !declaredCaps.has(c));
  const relaxTask = editable[0] ?? allTasks[0];
  if (!relaxTask) {
    skip('7b. 放宽建议', '当前没有可编辑任务，无法验证建议链路');
  } else if (undeclaredMedium.length === 0) {
    skip('7b. 放宽建议', `词表内所有中风险能力都已被设备声明（declared=${[...declaredCaps].length} 项）——`
      + '反事实建议的前提不成立，无法构造"因能力被挡"的场景');
  } else {
    const taskId = String(relaxTask.id);
    // 用**未被任何设备声明**的中风险能力：必然零候选；且中风险建议不要求安全复核。
    const singleCapability = undeclaredMedium[0];
    const comboCapabilities = undeclaredMedium.slice(0, 2);
    const setCrane = await request(
      'PATCH',
      `/api/tasks/${encodeURIComponent(taskId)}/requirements`,
      { requiredDeviceCapabilities: [singleCapability] },
      token,
    );
    const candidatesRes = await request(
      'GET',
      `/api/scheduler/tasks/${encodeURIComponent(taskId)}/candidates`,
      null,
      token,
    );
    const suggestions = candidatesRes.body?.capabilityRelaxationSuggestions ?? [];
    const craneSuggestion = suggestions.find((x) => x.capability === singleCapability);
    // NO-67d 纪律扩展：建议引擎的反事实前提是"放宽后能产生合格候选"。当前世界若没有
    // （例如整 fleet 遥测老化/离线），引擎**正确地**不给建议——此时按环境前置条件记 SKIP，
    // 不按 FAIL 处理（7b2/7d 依赖同一条建议，一并跳过并写明原因）。
    const counterfactualViable = Boolean(craneSuggestion);
    const rejectReasonsSeen = [
      ...new Set((candidatesRes.body?.candidates ?? []).flatMap((c) => c.rejectReasons ?? [])),
    ];
    if (counterfactualViable) {
      step('7b. 零候选且因能力被挡 → 给出放宽建议（含新增候选数与设备实际能力）',
        setCrane.status === 200
          && candidatesRes.status === 200
          && Number(craneSuggestion.addedEligibleCount) > 0
          && Array.isArray(craneSuggestion.sampleDeviceCapabilities)
          && typeof craneSuggestion.note === 'string'
          && craneSuggestion.note.includes('仅建议')
          && craneSuggestion.note.includes('现场确认'),
        `capability=${singleCapability} declared=${declaredCaps.has(singleCapability)} `
          + `status=${candidatesRes.status} suggestions=${suggestions.map((x) => `${x.capability}+${x.addedEligibleCount}`).join(',') || '(none)'}`);
      // NO-19a：中风险能力 → 不要求安全复核，但要求与安全/工艺确认（不制造假警报）
      step(`7b2. 中风险能力（${singleCapability}）的建议按中风险提示（不误报为高风险）`,
        craneSuggestion?.risk === 'medium'
          && craneSuggestion?.requiresSafetyReview === false
          && String(craneSuggestion?.note ?? '').includes('中风险')
          && String(craneSuggestion?.note ?? '').includes('安全/工艺负责人确认'),
        `risk=${craneSuggestion?.risk} requiresSafetyReview=${craneSuggestion?.requiresSafetyReview}`);
    } else {
      const skipReason = '放宽后无合格候选（candidates 拒绝原因：'
        + `${rejectReasonsSeen.join('|') || '(无)'}）——环境前置条件不满足，非解释链路缺陷`;
      skip('7b. 放宽建议', skipReason);
      skip(`7b2. 中风险提示断言（${singleCapability}）`, skipReason);
      skip('7d. 组合建议断言', skipReason);
    }
    // 要求未被自动修改（只建议）
    const afterSuggest = await request('GET', `/api/tasks/${encodeURIComponent(taskId)}`, null, token);
    step('7c. 建议不自动放宽执行边界（任务要求保持不变）',
      attemptRequirements(afterSuggest.body).includes(singleCapability),
      `requirements=${JSON.stringify(attemptRequirements(afterSuggest.body))}`);
    // 组合建议（NO-18b）：同时要求两项都无人具备的能力 → 单项放宽都无效，
    // 必须给出"需同时放宽"的组合建议。
    const setCombo = await request(
      'PATCH',
      `/api/tasks/${encodeURIComponent(taskId)}/requirements`,
      { requiredDeviceCapabilities: comboCapabilities },
      token,
    );
    const comboCandidates = await request(
      'GET',
      `/api/scheduler/tasks/${encodeURIComponent(taskId)}/candidates`,
      null,
      token,
    );
    const combo = (comboCandidates.body?.capabilityRelaxationSuggestions ?? [])[0];
    if (!counterfactualViable) {
      // 7d 依赖 7b 的同一条反事实建议（上面已 SKIP，不重复 FAIL）
    } else
    step(`7d. 单项放宽无效 → 给出组合建议（同时放宽 ${comboCapabilities.join(' + ')}）`,
      setCombo.status === 200
        && comboCandidates.status === 200
        && combo?.kind === 'combination'
        && Array.isArray(combo?.capabilities)
        && comboCapabilities.every((c) => combo.capabilities.includes(c))
        && Number(combo.addedEligibleCount) > 0
        && String(combo.note).includes('同时'),
      `status=${comboCandidates.status} kind=${combo?.kind} caps=${(combo?.capabilities ?? []).join('+')} added=${combo?.addedEligibleCount}`);

    await request(
      'PATCH',
      `/api/tasks/${encodeURIComponent(taskId)}/requirements`,
      { requiredDeviceCapabilities: [] },
      token,
    );
  }

  // ---- 8. 高风险放宽的审批闸门（NO-20a）----
  const gateTask = editable[0] ?? allTasks[0];
  if (!gateTask) {
    skip('8. 高风险放宽审批闸门', '当前没有可编辑任务');
  } else {
    const gateTaskId = String(gateTask.id);
    const requirementsUrl = `/api/tasks/${encodeURIComponent(gateTaskId)}/requirements`;
    // 8a. 先收紧到 crane（收紧不需要审批）
    const tighten = await request('PATCH', requirementsUrl, { requiredDeviceCapabilities: ['crane'] }, token);
    // 8b. 无审批放宽高风险能力 → 409 + 可照做的指引
    const blocked = await request('PATCH', requirementsUrl, { requiredDeviceCapabilities: [] }, token);
    step('8a. 放宽高风险能力（crane）无审批 → 409 且给出审批指引',
      tighten.status === 200
        && blocked.status === 409
        && JSON.stringify(blocked.body).includes('HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL')
        && JSON.stringify(blocked.body).includes('安全管理员审批')
        && JSON.stringify(blocked.body).includes('task_capability_change'),
      `tighten=${tighten.status} blocked=${blocked.status}`);

    // 8c. 发起审批（必须由**他人**审批：发起人回避，global_admin 亦回避）
    const approverToken = await loginAs(
      process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
      process.env.EWOH_E2E_APPROVER_PASS || '',
    );
    if (!approverToken) {
      skip('8b. 发起并完成安全审批', '未提供 EWOH_E2E_APPROVER_PASS（无法以非发起人身份发起/审批）');
    } else {
      const created = await request('POST', '/api/approvals', {
        entityType: 'task_capability_change',
        entityId: gateTaskId,
        roles: ['safety_admin'],
        subject: {
          objectType: 'task_capability_change',
          objectId: gateTaskId,
          title: '放宽高风险能力要求：crane',
          summary: 'e2e：验证高风险放宽审批闸门',
          metrics: {
            relaxedHighRiskCapabilities: 'crane',
            resultingDeviceCapabilities: '',
            resultingStationCapabilities: '',
          },
        },
      }, approverToken);
      const approvalId = created.body?.id ?? created.body?.approvalId ?? null;
      const stepId = created.body?.steps?.[0]?.id ?? null;
      step('8b. 发起高风险放宽审批（entityType=task_capability_change）',
        (created.status === 201 || created.status === 200) && Boolean(approvalId) && Boolean(stepId),
        `status=${created.status} approval=${approvalId} step=${stepId}`);

      // 8d. 发起人自批必须被拒（职责分离）
      const selfApprove = stepId
        ? await request('POST', `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'self' }, approverToken)
        : { status: 0 };
      step('8c. 发起人自批被拒（职责分离，B5/R2-SMI-003）',
        selfApprove.status === 403 || selfApprove.status === 409,
        `status=${selfApprove.status}`);

      // 8e. 安全审批人（global_admin 越权放行）通过
      const approved = stepId
        ? await request('POST', `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'e2e 安全复核通过' }, token)
        : { status: 0 };
      step('8d. 安全审批通过（管理员代安全角色）',
        approved.status === 200 && String(approved.body?.status ?? '') === 'approved',
        `status=${approved.status} instance=${approved.body?.status}`);

      // 8f. 带审批号重试 → 放行，且返回/审计留下审批依据
      const applied = await request('PATCH', requirementsUrl, {
        requiredDeviceCapabilities: [],
        approvalId,
      }, token);
      step('8e. 携带已获批审批号重试 → 放宽生效（审计留审批依据）',
        applied.status === 200
          && applied.body?.approvalId === approvalId
          && Array.isArray(applied.body?.relaxedHighRiskCapabilities)
          && applied.body.relaxedHighRiskCapabilities.includes('crane'),
        `status=${applied.status} approvalId=${applied.body?.approvalId} relaxed=${(applied.body?.relaxedHighRiskCapabilities ?? []).join('+')}`);

      // 8g. 同一审批不能用于**范围更大**的放宽（指纹必须逐字一致）：
      // 先把要求恢复成 crane + exo-lift，再用"只批了 crane"的旧审批去放宽两者 → 必须拒绝
      const readd = await request('PATCH', requirementsUrl, { requiredDeviceCapabilities: ['crane', 'exo-lift'] }, token);
      const reuse = await request('PATCH', requirementsUrl, { requiredDeviceCapabilities: [], approvalId }, token);
      step('8f. 拿旧审批去放宽更大范围 → 拒绝（指纹不一致）',
        readd.status === 200 && reuse.status === 409 && JSON.stringify(reuse.body).includes('APPROVAL_INVALID'),
        `readd=${readd.status} reuse=${reuse.status}`);
      // 收尾：恢复本轮开始时的要求（若含高风险 → 走审批），使场景可重复运行且不留痕
      const gateOriginal = Array.isArray(gateTask.requiredDeviceCapabilities)
        ? gateTask.requiredDeviceCapabilities
        : [];
      const finalFlow = await relaxWithApproval({
        taskId: gateTaskId,
        nextDeviceCapabilities: gateOriginal,
        relaxedHighRisk: ['crane', 'exo-lift'].filter((c) =>
          ['crane', 'exo-lift'].includes(c) && !gateOriginal.includes(c),
        ),
        token,
        approverToken,
        label: 'e2e 收尾：恢复任务原始能力要求',
      });
      step('8g. 收尾恢复任务原始要求（必要时经审批，场景可重复运行）',
        finalFlow.applied.status === 200,
        `applied=${finalFlow.applied.status} final=${JSON.stringify(finalFlow.applied.body?.requiredDeviceCapabilities ?? null)}`);
    }
  }

  finish();
}

/** 任务能力要求的读取兜底（不同响应形状下都取到同一个事实）。 */
function attemptRequirements(task) {
  const raw = task?.requiredDeviceCapabilities ?? task?.required_device_capabilities;
  return Array.isArray(raw) ? raw : [];
}

function finish() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n========================================');
  console.log(`能力停用→方案解释: ${pass} PASS / ${fail} FAIL / ${skipCount} SKIP（共 ${results.length}）`);
  if (fail > 0) {
    console.log(`FAILED: ${results.filter((r) => r.status === 'FAIL').map((r) => r.name).join('; ')}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  record('FAIL', 'unexpected', error?.message ?? String(error));
  finish();
});
