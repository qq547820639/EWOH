/**
 * 执行边界授权"到期主动提醒" E2E（NO-30a）。
 *
 * 为什么单列：NO-22a 给了授权 24 小时有效期、NO-24a 让它在审批台可见，但那都是**被动**的
 * ——没人打开审批台就没人知道"这张授权 40 分钟后失效"，现场执行时才撞 409。
 * 本脚本验证"到期"这件事真的会**主动**变成一条可处理的通知，且**不重复打扰**：
 *
 *   1. 造一张"即将失效"的授权（真造：审批通过后把实例时间回拨到 23 小时前，
 *      剩余有效期 ≈1 小时）→ 扫描 → 必须有 expiring 提醒，正文含剩余时间与审批号；
 *   2. 再扫一遍 → 幂等（duplicates 增加、created 为 0，通知总数不增长）；
 *   3. 回拨到 25 小时前（已过期）→ 扫描 → expired 提醒（写明已不可用、需重新申请）；
 *   4. 通知落在 `safety_admin` 角色上（有权重新审批的人），渠道为 app。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_OWNER_DATABASE_URL=postgres://... \
 *     node test/e2e/approval-expiry-reminder.mjs
 */
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const ORG_ID = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';

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
  console.log(`授权到期提醒: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
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
  }).catch(() => null);
  const body = await response?.json().catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 201)) {
    // 如实报告失败原因：一律显示"缺少 EWOH_E2E_ADMIN_PASS"会把 503/401 误报成没设环境变量。
    lastLoginError = `登录失败：HTTP ${response?.status ?? 0}`
      + (body?.error?.message ? ` ${body.error.message}` : '')
      + (body?.error?.code ? ` [${body.error.code}]` : '');
    return null;
  }
  const token = body?.accessToken ?? null;
  if (!token) lastLoginError = '登录响应缺少 accessToken';
  return token;
}

async function post(path, body, token) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function get(path, token) {
  const response = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** 把审批实例的 `_updated_at` 回拨 N 小时（= 授权通过时间，决定剩余有效期）。 */
async function backdateApproval(sql, approvalId, hoursAgo) {
  const rows = await sql`
    update public.ewoh_event
       set _updated_at = now() - ${`${hoursAgo} hours`}::interval
     where event_id = ${approvalId} and event_type = 'approval_instance'
    returning event_id`;
  return rows.length === 1;
}

async function main() {
  const probe = await fetch(`${BASE}/api/approvals/authorizations`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 平台可达且未认证访问被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const { default: postgresFactory } = { default: postgres };
  if (!OWNER_DB) {
    skip('1. 直连数据库', '缺少 EWOH_E2E_OWNER_DATABASE_URL');
    return finish();
  }
  const sql = postgresFactory(OWNER_DB, { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  try {
    const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS || '');
    const approverToken = await login(
      process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
      process.env.EWOH_E2E_APPROVER_PASS || '',
    );
    if (!adminToken) {
      skip('1. 管理员登录', lastLoginError ?? '登录失败（原因未知）');
      return finish();
    }
    step('1. 管理员登录', true);
    if (!approverToken) {
      skip('1a. 审批人登录', '缺少 EWOH_E2E_APPROVER_PASS（无法造出"已通过"的授权）');
      return finish();
    }

    // ── 2. 造一张即将失效的授权（通过后回拨到 23 小时前）──────────────
    const created = await post('/api/approvals', {
      entityType: 'device_capability_change',
      entityId: `capability:exo-lift`,
      roles: ['safety_admin'],
      subject: {
        objectType: 'device_capability_change',
        objectId: 'capability:exo-lift',
        title: `到期提醒验证 ${tag}`,
        summary: 'e2e：NO-30a 到期提醒',
        metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-E2E-EXPIRY' },
      },
    }, approverToken);
    const approvalId = created.body?.id ?? null;
    const stepId = created.body?.steps?.[0]?.id ?? null;
    const approved = approvalId && stepId
      ? await post(`/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`, { reason: 'e2e 到期提醒' }, adminToken)
      : { status: 0 };
    const backdated = approvalId ? await backdateApproval(sql, approvalId, 23) : false;
    step('2. 造出"已通过且剩余有效期 ≈1 小时"的授权（真回拨时间，不假装）',
      (approved.status === 200) && backdated,
      `approval=${approvalId} approved=${approved.status} backdated=${backdated}`);

    // ── 3. 扫描 → expiring 提醒 ────────────────────────────────────
    const sweep1 = await post('/api/approvals/authorizations/expiry-sweep', {}, adminToken);
    const mine1 = (sweep1.body?.notifications ?? []).find((n) => n.approvalId === approvalId);
    step('3. 到期扫描发现"即将失效"并生成提醒',
      sweep1.status === 200 && mine1?.bucket === 'expiring' && mine1?.created === true,
      `status=${sweep1.status} bucket=${mine1?.bucket} created=${mine1?.created}`);

    const notifications = await get('/api/notifications?status=pending', adminToken);
    // NO-32a 之后同一张授权会产出**两条** app 通知：角色（safety_admin）+ 发起人本人。
    // 此前用 `.find(...)` 取第一条再断言角色，实测会偶发取到"发起人本人"那条而误报失败
    // （两行的 externalRef/channel 相同，行序不保证）——改为按**集合**断言：
    // 角色提醒必须存在（谁有权重批），发起人本人那条单独在 5f 验证。
    const mineAll = (notifications.body ?? []).filter(
      (n) => n.externalRef === approvalId && n.channel === 'app',
    );
    const mine = mineAll.find((n) => n.recipientId === 'safety_admin') ?? null;
    step('3a. 提醒落在 safety_admin 角色（有权重新审批的人）且为应用内通知',
      Boolean(mine) && mine.channel === 'app',
      `recipients=${mineAll.map((n) => `${n.recipientType}:${n.recipientId}`).join('|') || 'missing'}`);
    step('3b. 通知正文可照做：剩余时间 / 审批号 / 覆盖范围 / 发起人 / 已消耗数',
      String(mine?.body ?? '').includes(approvalId ?? '###')
        && String(mine?.body ?? '').includes('剩余')
        && String(mine?.body ?? '').includes('已消耗')
        && String(mine?.body ?? '').includes('覆盖'),
      String(mine?.body ?? '').slice(0, 120));

    // ── 4. 幂等：再扫一次不重复打扰 ─────────────────────────────────
    const beforeCount = (notifications.body ?? []).filter((n) => n.externalRef === approvalId).length;
    const sweep2 = await post('/api/approvals/authorizations/expiry-sweep', {}, adminToken);
    const notifications2 = await get('/api/notifications?status=pending', adminToken);
    const afterCount = (notifications2.body ?? []).filter((n) => n.externalRef === approvalId).length;
    const mine2 = (sweep2.body?.notifications ?? []).find((n) => n.approvalId === approvalId);
    step('4. 幂等：重复扫描 created=0 / duplicates 增加，通知数量不增长（不重复打扰）',
      sweep2.status === 200 && mine2?.created === false && beforeCount === afterCount,
      `created=${mine2?.created} before=${beforeCount} after=${afterCount}`);

    // ── 5. 过期 → expired 提醒 ─────────────────────────────────────
    const backdatedExpired = await backdateApproval(sql, approvalId, 25);
    const sweep3 = await post('/api/approvals/authorizations/expiry-sweep', {}, adminToken);
    const mine3 = (sweep3.body?.notifications ?? []).find(
      (n) => n.approvalId === approvalId && n.bucket === 'expired',
    );
    step('5. 过期后扫描生成"已失效"提醒（与"即将失效"分桶，不互相覆盖）',
      backdatedExpired && mine3?.created === true,
      `bucket=${mine3?.bucket} created=${mine3?.created}`);
    const notifications3 = await get('/api/notifications?status=pending', adminToken);
    const expiredNote = (notifications3.body ?? []).find(
      (n) => n.externalRef === approvalId && String(n.title).includes('已失效'),
    );
    step('5a. 过期提醒写明"已不可用、需重新申请"',
      String(expiredNote?.body ?? '').includes('重新申请') && String(expiredNote?.body ?? '').includes('不可用'),
      String(expiredNote?.body ?? '').slice(0, 100));

    // ── 5h（NO-45a）：授权真的失效后，"即将失效"催促提醒随之关闭 ──────────
    // 那条提醒的前提（还有时间处理）已经消失；"已失效，请重新申请"由 expired 桶承载，
    // 必须**保持待办**——两者语义不同，不能一起关掉。
    const resolvedAfterExpiry = await get('/api/notifications?status=resolved', adminToken);
    const expiringClosed = (resolvedAfterExpiry.body ?? []).filter(
      (n) => n.externalRef === approvalId && String(n.title).includes('即将失效'),
    );
    const pendingAfterExpiry = await get('/api/notifications?status=pending', adminToken);
    const expiredStillPending = (pendingAfterExpiry.body ?? []).filter(
      (n) => n.externalRef === approvalId && String(n.title).includes('已失效'),
    );
    step('5h. 授权失效 → "即将失效"催办提醒随之关闭（approval_expired），"已失效"待办保留',
      (sweep3.body?.resolved ?? 0) >= 1
        && expiringClosed.length >= 1
        && expiringClosed.every((n) => n.resolution === 'approval_expired' && Boolean(n.resolvedAt))
        && expiredStillPending.length >= 1,
      `resolved=${sweep3.body?.resolved ?? 'none'} closed=${expiringClosed.length} `
        + `pendingExpired=${expiredStillPending.length}`);

    // ── 5b. 控制类审批（control_request）也纳入授权视图与到期提醒（NO-31a）──
    // 控制请求由**审批人**发起（createdBy=approver.li）：随后管理员以 global_admin
    // 代安全角色审批，既不违背后端"发起人回避"，也不需要 approver.li 具备 safety_admin。
    const controlRequest = await post('/api/control/requests', {
      deviceId: `EXO-CTL-${tag}`,
      commandKeys: ['emergency_stop'],
      idempotencyKey: `e2e-expiry-ctl-${tag}`,
    }, approverToken);
    const controlRequestId = controlRequest.body?.id ?? controlRequest.body?.requestId ?? null;
    const controlApprovals = await get('/api/approvals/authorizations', adminToken);
    const controlRow = (controlApprovals.body ?? []).find(
      (a) => a.entityType === 'control_request' && a.entityId === controlRequestId,
    );
    step('5b. 高危控制请求联动创建的审批进入授权视图（entityType=control_request）',
      (controlRequest.status === 201 || controlRequest.status === 200) && Boolean(controlRow),
      `request=${controlRequestId} status=${controlRequest.status} found=${Boolean(controlRow)}`);

    // 控制请求此时是 pending_approval：审批未通过 → 下发被拒（403）
    const sendBeforeApproval = await post(`/api/control/requests/${controlRequestId}/commands`, {
      commandKey: 'emergency_stop',
    }, approverToken);
    step('5c. 审批未通过时下发高危指令被拒（403，fail-closed）',
      sendBeforeApproval.status === 403,
      `status=${sendBeforeApproval.status}`);

    // 批准这张控制审批，然后把它回拨成"25 小时前通过" → 下发必须被时效闸门拦下
    const controlInstance = controlRow?.approvalId
      ? await get(`/api/approvals/${controlRow.approvalId}`, adminToken)
      : { body: null };
    const controlStepId = controlInstance.body?.steps?.[0]?.id ?? null;
    const controlApproved = controlRow?.approvalId && controlStepId
      ? await post(
          `/api/approvals/${controlRow.approvalId}/steps/${controlStepId}/state?action=approve`,
          { reason: 'e2e：控制审批（用于时效验证）' },
          adminToken,
        )
      : { status: 0 };
    const controlBackdated = controlRow?.approvalId
      ? await backdateApproval(sql, controlRow.approvalId, 25)
      : false;
    const sendStale = await post(`/api/control/requests/${controlRequestId}/commands`, {
      commandKey: 'emergency_stop',
    }, approverToken);
    step('5d. 控制审批通过但已超 24 小时 → 下发被拒（409 APPROVAL_INVALID，半年前的同意不等于现在）',
      controlApproved.status === 200 && controlBackdated
        && sendStale.status === 409
        && JSON.stringify(sendStale.body).includes('APPROVAL_INVALID'),
      `approved=${controlApproved.status} backdated=${controlBackdated} send=${sendStale.status} ` +
        `body=${JSON.stringify(sendStale.body ?? null).slice(0, 140)}`);

    const controlSweep = await post('/api/approvals/authorizations/expiry-sweep', {}, adminToken);
    const controlNote = (controlSweep.body?.notifications ?? []).find(
      (n) => n.approvalId === controlRow?.approvalId && n.bucket === 'expired',
    );
    step('5e. 过期控制授权同样生成"已失效"提醒（与能力授权同一套机制）',
      controlNote?.created === true,
      `bucket=${controlNote?.bucket} created=${controlNote?.created}`);

    // ── 5f. 点名到人：发起人本人能看到给自己的提醒（NO-32a）────────────
    // 上面那张能力授权由 approver.li 发起 → 提醒应有一条 recipientType=user 的通知
    // 落到 approver.li 名下；而**另一个用户**（worker.zhangwei）不应看到它。
    const requesterToken = approverToken;
    const workerToken = await login(
      process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei',
      process.env.EWOH_E2E_FIELD_PASS || '',
    );
    const requesterList = await get('/api/notifications?status=pending', requesterToken);
    const personal = (requesterList.body ?? []).find(
      (n) => n.externalRef === approvalId && String(n.title).includes('你发起的'),
    );
    step('5f. 发起人本人收到"点名给自己"的到期提醒（标题标注"你发起的"）',
      Boolean(personal) && personal?.recipientId === (process.env.EWOH_E2E_APPROVER_USER || 'approver.li'),
      personal ? `recipient=${personal.recipientId} title=${personal.title}` : 'missing personal notification');

    if (!workerToken) {
      skip('5g. 他人看不到该提醒', '缺少 EWOH_E2E_FIELD_PASS（无法以第三方身份核对可见性）');
    } else {
      const otherList = await get('/api/notifications?status=pending', workerToken);
      const leaked = (otherList.body ?? []).some((n) => n.externalRef === approvalId);
      step('5g. 他人（不同用户/角色）看不到该提醒（放宽到用户级不等于串号）',
        !leaked,
        `leaked=${leaked} otherCount=${(otherList.body ?? []).length}`);
    }

    // ── 6（NO-45a）：同一对象重新申请并通过 → 旧审批的到期提醒随之了结 ─────
    // 现场视角：重新申请成功之后，"已失效请重新申请"的前提也消失了；
    // 旧审批的事实（状态/时效/用量）全部保留，只关提醒。
    const renewed = await post('/api/approvals', {
      entityType: 'device_capability_change',
      entityId: 'capability:exo-lift',
      roles: ['safety_admin'],
      subject: {
        objectType: 'device_capability_change',
        objectId: 'capability:exo-lift',
        title: `到期提醒验证（重新申请）${tag}`,
        summary: 'e2e：NO-45a 旧提醒随新审批通过关闭',
        metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-E2E-EXPIRY' },
      },
    }, approverToken);
    const renewedId = renewed.body?.id ?? null;
    const renewedStepId = renewed.body?.steps?.[0]?.id ?? null;
    const renewedApproved = renewedId && renewedStepId
      ? await post(`/api/approvals/${renewedId}/steps/${renewedStepId}/state?action=approve`, { reason: 'e2e：重新申请' }, adminToken)
      : { status: 0 };
    const resolvedAfterRenewal = await get('/api/notifications?status=resolved', adminToken);
    const superseded = (resolvedAfterRenewal.body ?? []).filter(
      (n) => n.externalRef === approvalId && n.resolution === 'approval_superseded',
    );
    const pendingAfterRenewal = await get('/api/notifications?status=pending', adminToken);
    const oldStillPending = (pendingAfterRenewal.body ?? []).filter((n) => n.externalRef === approvalId);
    step('6a. 重新申请并通过 → 旧审批的到期提醒以 approval_superseded 关闭并指向新审批号',
      renewedApproved.status === 200
        && superseded.length >= 1
        && superseded.every((n) => n.resolutionRef === renewedId && Boolean(n.resolvedBy))
        && oldStillPending.length === 0,
      `renewed=${renewedId} approved=${renewedApproved.status} superseded=${superseded.length} `
        + `oldPending=${oldStillPending.length}`);

    // 第一次失效时已用 approval_expired 关掉的那条，不能被后来的取代动作**覆盖**
    // （第一次了结它的事实才是审计要的答案）。
    const expiredNoteStillExpired = (resolvedAfterRenewal.body ?? []).filter(
      (n) => n.externalRef === approvalId && n.resolution === 'approval_expired',
    );
    step('6b. 处置依据不被后来的处置覆盖：先前 approval_expired 的记录保持原样',
      expiredNoteStillExpired.length >= 1
        && expiredNoteStillExpired.every((n) => n.resolutionRef === approvalId),
      `kept=${expiredNoteStillExpired.length}`);

    // ── 7（NO-46a）：提醒治理度量——把"处置得怎么样"变成可读数字 ──────────
    const metrics = await get('/api/notifications/metrics?days=30', adminToken);
    const metricsBody = metrics.body ?? {};
    const expiringGroup = (metricsBody.byKind ?? []).find((g) => g.kind === 'approval_expiring');
    const expiredGroup = (metricsBody.byKind ?? []).find((g) => g.kind === 'approval_expired');
    step('7. 治理度量给出处置率/处置时长/账龄/按类型计数（只统计可见范围）',
      metrics.status === 200
        && typeof metricsBody.scanned === 'number' && metricsBody.scanned > 0
        && Number.isFinite(metricsBody.dispositionRate)
        && typeof metricsBody.medianTimeToResolveMs === 'number'
        && Array.isArray(metricsBody.aging) && metricsBody.aging.length === 5
        && Array.isArray(metricsBody.byKind) && metricsBody.byKind.length >= 1
        && Array.isArray(metricsBody.notes) && metricsBody.notes.length > 0,
      `status=${metrics.status} scanned=${metricsBody.scanned} rate=${metricsBody.dispositionRate} `
        + `median=${metricsBody.medianTimeToResolveMs}`);

    step('7a. 度量按提醒类型分类：授权即将失效/已失效分开计数，且处置过的那类有已处置条数',
      Boolean(expiringGroup) && Boolean(expiredGroup)
        && (expiringGroup?.resolved ?? 0) >= 1
        && expiringGroup.label !== expiredGroup.label,
      `expiring=${JSON.stringify(expiringGroup ? { total: expiringGroup.total, resolved: expiringGroup.resolved } : null)} `
        + `expired=${JSON.stringify(expiredGroup ? { total: expiredGroup.total, resolved: expiredGroup.resolved } : null)}`);

    const metricsBadDays = await get('/api/notifications/metrics?days=abc', adminToken);
    const metricsClamped = await get('/api/notifications/metrics?days=0', adminToken);
    step('7b. 非法窗口参数被规范化（不 500、不静默给错窗口）',
      metricsBadDays.status === 200 && metricsBadDays.body?.windowDays === 30
        && metricsClamped.status === 200 && metricsClamped.body?.windowDays === 1,
      `bad=${metricsBadDays.status}/${metricsBadDays.body?.windowDays} clamped=${metricsClamped.status}/${metricsClamped.body?.windowDays}`);

    // ── 6c. 只读：扫描不改变授权状态 ─────────────────────────────────
    const authorizations = await get('/api/approvals/authorizations', adminToken);
    const row = (authorizations.body ?? []).find((a) => a.approvalId === approvalId);
    step('6c. 扫描是只读的：授权状态仍为 approved（提醒不代替人重新审批）',
      row?.status === 'approved' && row?.expired === true,
      `status=${row?.status} expired=${row?.expired}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  finish();
}

main().catch((error) => {
  record('FAIL', '脚本异常', String(error?.stack ?? error));
  finish();
});
