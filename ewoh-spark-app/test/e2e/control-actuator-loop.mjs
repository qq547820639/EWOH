/**
 * 平台授权 → 边缘执行 → 回执 闭环 E2E（NO-60a）。
 *
 * 为什么单列：平台侧早就有控制命令域（高危命令必须审批、有 attempt 台账、有回执接口），
 * 边缘侧本轮（NO-59b）也有了执行机构适配器；但**两者之间没有通道**——平台 sendCommand
 * 只往库里写一行 `sent`，命令永远到不了设备，也不会有回执。本脚本验证这条链路真的通了，
 * 且每一步都 fail-closed：
 *
 *   1. 高危请求创建（`dispatch_task` 在平台与边缘**同一份高危词表**里）→ pending_approval；
 *   2. 审批未通过就下发 → 403（不许绕过审批）；
 *   3. 审批通过后下发（命令带 payload：目标工位）→ 台账 status=sent；
 *   4. 边缘网关轮询 `/api/control/commands/pending` → 拿到命令 + **平台签发的授权号**
 *      `control:<requestId>` + payload（租户/设备隔离：别的设备号取不到）；
 *   5. 边缘命令代理（真实子进程 `tools/edge_control_agent.py --once`）执行：
 *      先 ack 投递确认（gateway_received），再回执执行结果（executed）；
 *   6. 平台侧事实核对：attempt=executed、payload 留在命令上、`ewoh_control_result`
 *      （gateway_ack + command_receipt）、审计（control.command.ack）；
 *   7. **改坏授权号 → 边缘拒绝投递且不碰设备**（授权号只能由平台签发）；
 *   8. 重复 ack → alreadyAcked（边缘 at-least-once 幂等），不重复写结果行；
 *   9. **NO-62b 投递优先级**：同一设备上排队中的 `stop`（安全停机）必须排在
 *      `pause`/`return_to_dock` 之前，即使它**最后**下发——排序是安全语义；
 *   10. **NO-62a 投递前授权复核**（故障注入）：授权范围被改写（指纹不符）/ 请求在
 *      投递窗口内被撤销 → 命令被平台**撤回**（status=revoked + 原因码 + delivery_rejected
 *      结果行），边缘拿不到、设备不动——投递路径不再 fail-open。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_INGEST_KEY=... EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/control-actuator-loop.mjs
 */
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || 'local-verify-ingest-key-0001';
/**
 * NO-65a：授权范围指纹的 HMAC 密钥（与平台 `EWOH_CONTROL_FINGERPRINT_SECRET` 同源）。
 * 场景把它传给边缘代理 → 边缘**验签**后才碰设备（验不过拒绝投递）。
 */
const FINGERPRINT_SECRET = process.env.EWOH_CONTROL_FINGERPRINT_SECRET || 'local-verify-fingerprint-secret-0001';
const AGENT_ENV = { ...process.env, EWOH_CONTROL_FINGERPRINT_SECRET: FINGERPRINT_SECRET };
const ORG_ID = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';
const REPO_ROOT = path.resolve(process.cwd(), '..');
const PYTHON = process.env.EWOH_E2E_PYTHON || 'python3';

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
  console.log(
    `平台授权→边缘执行→回执: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
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
    lastLoginError = `登录失败：HTTP ${response?.status ?? 0}`
      + (body?.error?.message ? ` ${body.error.message}` : '')
      + (body?.error?.code ? ` [${body.error.code}]` : '');
    return null;
  }
  return body?.accessToken ?? null;
}

async function request(method, url, body, token, extraHeaders = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}
const post = (url, body, token, extraHeaders) => request('POST', url, body ?? {}, token, extraHeaders);
const get = (url, token, extraHeaders) => request('GET', url, undefined, token, extraHeaders);

function errText(res) {
  return res.body?.error?.message ?? res.body?.error?.code ?? res.body?.message ?? '';
}

async function main() {
  const probe = await fetch(`${BASE}/api/control/commands/pending?deviceId=x`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}`);
    return finish();
  }
  step('0. 平台可达（网关命令面要求密钥）', probe.status === 401 || probe.status === 403,
    `未认证探测 status=${probe.status}`);
  if (!OWNER_DB) {
    skip('0b. 落库事实断言', '未提供 EWOH_E2E_OWNER_DATABASE_URL');
    return finish();
  }

  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS);
  const approverToken = await login(
    process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
    process.env.EWOH_E2E_APPROVER_PASS,
  );
  if (!adminToken || !approverToken) {
    skip('1. 登录（管理员 + 审批人）', lastLoginError ?? '缺少凭据');
    return finish();
  }
  step('1. 管理员 + 审批人登录成功', true);

  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const deviceId = `AGV-E2E-${tag}`;
  const idempotencyKey = `idem-control-${tag}`;
  const targetStationId = `ST-E2E-${tag}`;
  let requestId = null;
  // 本场景创建的**全部**控制请求号（主链路 + NO-62a/b 的两个附加设备）：
  // 清理必须按显式 id 列表，不能靠 like 模式猜（平台生成的 request_id 不含 tag）。
  const createdRequestIds = [];

  try {
    // ── 2. 高危请求：执行机构搬运必须走审批 ──────────────────────────
    // 现场发起（调度员/班组长），平台安全审批（另一身份）——
    // 控制审批的步骤要求 `safety_admin` 角色，admin（global_admin）可批；
    // 发起人自己批会被"发起人回避"拦下（4a 断言）。
    const created = await post('/api/control/requests', {
      deviceId,
      commandKeys: ['dispatch_task'],
      idempotencyKey,
    }, approverToken);
    requestId = created.body?.id ?? created.body?.requestId ?? null;
    if (requestId) createdRequestIds.push(requestId);
    step('2. 高危控制请求（dispatch_task）创建 → pending_approval（平台与边缘同一份高危词表）',
      (created.status === 201 || created.status === 200)
        && created.body?.status === 'pending_approval'
        && Boolean(requestId),
      `status=${created.status} request=${requestId} rowStatus=${created.body?.status}`);

    // ── 3. 审批闸门：未通过不得下发 ─────────────────────────────────
    const beforeApproval = await post(`/api/control/requests/${requestId}/commands`, {
      commandKey: 'dispatch_task',
      payload: { targetStationId },
    }, adminToken);
    step('3. 审批未通过时下发被拒（403 fail-closed，不许绕过审批）',
      beforeApproval.status === 403,
      `status=${beforeApproval.status} msg=${errText(beforeApproval)}`);

    // ── 4. 审批通过（另一身份）──────────────────────────────────────
    const authorizations = await get('/api/approvals/authorizations', adminToken);
    const approvalRow = (authorizations.body ?? []).find(
      (a) => a.entityType === 'control_request' && a.entityId === requestId,
    );
    const instance = approvalRow?.approvalId
      ? await get(`/api/approvals/${approvalRow.approvalId}`, adminToken)
      : { body: null };
    const stepId = instance.body?.steps?.[0]?.id ?? null;
    // 审批必须由**另一身份**执行（creator ≠ approver，INV-005 自批回避）：
    // 请求由 admin 创建 → 这里用 approver.li 审批（用 admin 批会 403，这是正确行为）。
    const selfApprove = approvalRow?.approvalId && stepId
      ? await post(
          `/api/approvals/${approvalRow.approvalId}/steps/${stepId}/state?action=approve`,
          { reason: 'e2e：自批回避探针' },
          approverToken,
        )
      : { status: 0, body: null };
    step('4a. 生成人自批被拒（403：审批独立性）',
      selfApprove.status === 403,
      `status=${selfApprove.status} msg=${errText(selfApprove)}`);

    const approved = approvalRow?.approvalId && stepId
      ? await post(
          `/api/approvals/${approvalRow.approvalId}/steps/${stepId}/state?action=approve`,
          { reason: 'e2e：执行机构搬运授权' },
          adminToken,
        )
      : { status: 0, body: null };
    step('4. 审批通过（另一身份；生成可追溯授权）',
      approved.status === 200 && Boolean(approvalRow?.approvalId),
      `approval=${approvalRow?.approvalId} approve=${approved.status} msg=${errText(approved)}`);

    // ── 5. 下发命令（带 payload）────────────────────────────────────
    const missingPayload = await post(`/api/control/requests/${requestId}/commands`, {
      commandKey: 'dispatch_task',
    }, approverToken);
    step('5. 缺 payload 的搬运命令被拒（400：不说"去哪"的命令不许发出去）',
      missingPayload.status === 400,
      `status=${missingPayload.status} msg=${errText(missingPayload)}`);

    const sent = await post(`/api/control/requests/${requestId}/commands`, {
      commandKey: 'dispatch_task',
      payload: { targetStationId, taskId: `T-E2E-${tag}` },
    }, approverToken);
    const attempts = sent.body?.attempts ?? [];
    const attempt = attempts.find((a) => a.commandKey === 'dispatch_task');
    step('6. 审批通过后下发成功：台账 status=sent 且 payload 留痕（命令可追溯去哪）',
      (sent.status === 200 || sent.status === 201)
        && attempt?.status === 'sent'
        && attempt?.payload?.targetStationId === targetStationId,
      `status=${sent.status} attempt=${attempt?.attemptId} payload=${JSON.stringify(attempt?.payload ?? null)}`);

    // ── 7. 边缘网关轮询：拿到命令 + 平台签发授权号 ───────────────────
    const pendingMine = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(deviceId)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const pendingCmd = (pendingMine.body?.commands ?? [])[0];
    step('7. 边缘轮询拿到命令：授权号由平台签发 control:<requestId> + payload 原样',
      pendingMine.status === 200
        && pendingCmd?.requestId === requestId
        && pendingCmd?.authorizationRef === `control:${requestId}`
        && pendingCmd?.payload?.targetStationId === targetStationId,
      `status=${pendingMine.status} ref=${pendingCmd?.authorizationRef} payload=${JSON.stringify(pendingCmd?.payload ?? null)}`);

    const pendingOther = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(`${deviceId}-OTHER`)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    step('7b. 别的设备号取不到这条命令（设备隔离，不是"谁的活都能领"）',
      (pendingOther.body?.commands ?? []).length === 0,
      `other=${(pendingOther.body?.commands ?? []).length}`);

    // ── 8. 边缘命令代理执行（真实子进程）────────────────────────────
    const agent = spawnSync(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/edge_control_agent.py'),
        '--once',
        '--device', deviceId,
        '--platform-url', BASE,
        '--ingest-key', INGEST_KEY,
        '--org-id', ORG_ID,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000, env: AGENT_ENV },
    );
    const agentLine = (agent.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let agentStats = null;
    try {
      agentStats = JSON.parse(agentLine);
    } catch {
      agentStats = null;
    }
    step('8. 边缘代理执行命令：投递确认→执行→回执（子进程退出码 0）',
      agent.status === 0 && agentStats?.executed === 1 && agentStats?.execution_failed === 0,
      `exit=${agent.status} stats=${agentLine.slice(0, 200)}${agent.status === 0 ? '' : ` stderr=${String(agent.stderr).slice(-200)}`}`);

    // ── 9. 平台侧事实核对 ───────────────────────────────────────────
    const detail = await get(`/api/control/requests/${requestId}`, adminToken);
    // 该读面返回 `{ request, status }`（聚合状态与请求体分开）
    const detailRequest = detail.body?.request ?? detail.body;
    const finalAttempt = (detailRequest?.attempts ?? []).find((a) => a.commandKey === 'dispatch_task');
    step('9. 平台台账终态 executed（网关 ack → 执行回执），payload 仍在命令上',
      detail.status === 200
        && finalAttempt?.status === 'executed'
        && finalAttempt?.payload?.targetStationId === targetStationId
        && detailRequest?.status !== 'pending_gateway',
      `status=${finalAttempt?.status} requestRowStatus=${detailRequest?.status}`);

    const resultRows = await sql`
      select result_type, result_code, success, result_json
      from ewoh_control_result
      where request_id = ${requestId} order by _created_at`;
    const ackRow = resultRows.find((r) => r.result_type === 'gateway_ack');
    const receiptRow = resultRows.find((r) => r.result_type === 'command_receipt');
    step('9b. 结果表区分"投递确认"与"执行回执"（gateway_ack + command_receipt，不混为一谈）',
      Boolean(ackRow) && Boolean(receiptRow)
        && ackRow.result_code === 'delivered'
        && receiptRow.result_code === 'executed'
        && receiptRow.success === true,
      `rows=${resultRows.map((r) => `${r.result_type}:${r.result_code}`).join(',')}`);

    const commandRows = await sql`
      select command_id, status, payload, response_json
      from ewoh_control_command
      where request_id = ${requestId} and command_key = 'dispatch_task'
      order by attempt_no`;
    if (commandRows.length === 0) {
      record('FAIL', '9c. 命令落库', '没有命令行：链路在此之前已断（见上面失败项）');
      return finish();
    }
    step('9c. 命令落库：payload 与投递/执行痕迹都在（谁能回答"这条命令到底做了什么"）',
      commandRows.length === 1
        && commandRows[0].status === 'executed'
        && commandRows[0].payload?.targetStationId === targetStationId
        && commandRows[0].response_json?.adapterAccepted === true,
      `rows=${commandRows.length} status=${commandRows[0]?.status} adapterAccepted=${commandRows[0]?.response_json?.adapterAccepted}`);

    const auditRows = await sql`
      select action, before_json, after_json from ewoh_audit_log
      where org_id = ${ORG_ID} and action in ('control.command.send', 'control.command.ack')
        and (before_json::text like ${`%${requestId}%`} or after_json::text like ${`%${requestId}%`})
      order by _created_at`;
    step('9d. 下发与投递确认都有审计（设备动作可追责）',
      auditRows.some((r) => r.action === 'control.command.send')
        && auditRows.some((r) => r.action === 'control.command.ack'),
      `actions=${[...new Set(auditRows.map((r) => r.action))].join(',')}`);

    // ── 9e. 已执行命令重复 ack → 409（终态不可回退）─────────────────
    const ackExecuted = await post(
      `/api/control/commands/${commandRows[0].command_id}/ack`,
      { delivered: true },
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    step('9e. 已执行命令再次投递确认 → 409（终态不可回退）',
      ackExecuted.status === 409,
      `status=${ackExecuted.status} msg=${errText(ackExecuted)}`);

    // ── 10. 授权号由平台按 requestId 派生：构造不出"不匹配"，但可以验证
    //        没有对应请求的命令**根本不会被投递**（join 丢弃）→ 边缘不会执行孤儿命令 ──
    const tamperedId = commandRows[0].command_id;
    await sql`
      update ewoh_control_command set status = 'sent'
      where command_id = ${tamperedId}`;
    await sql`
      update ewoh_control_command set request_id = ${`${requestId}-ORPHAN`}
      where command_id = ${tamperedId}`;
    const orphanRun = spawnSync(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/edge_control_agent.py'),
        '--once',
        '--device', deviceId,
        '--platform-url', BASE,
        '--ingest-key', INGEST_KEY,
        '--org-id', ORG_ID,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000, env: AGENT_ENV },
    );
    const orphanLine = (orphanRun.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let orphanStats = null;
    try {
      orphanStats = JSON.parse(orphanLine);
    } catch {
      orphanStats = null;
    }
    const orphanStatus = await sql`
      select status, error_code from ewoh_control_command where command_id = ${tamperedId}`;
    step('10. 没有对应请求的孤立命令不会被投递（边缘拿不到、也不执行"来源不明"的命令）',
      orphanRun.status === 0
        && orphanStats?.polled === 0
        && orphanStatus[0]?.status === 'sent'
        && orphanStatus[0]?.error_code === null,
      `agentExit=${orphanRun.status} polled=${orphanStats?.polled} status=${orphanStatus[0]?.status}`);

    // ══ NO-62b：投递优先级（安全停机插队）════════════════════════════
    // 独立设备号：不干扰主链路的 pending/ack/回执断言。
    const prioDevice = `AGV-E2E-PRIO-${tag}`;
    const prioKeys = ['pause', 'return_to_dock', 'stop'];
    const prioRequests = [];
    for (const key of prioKeys) {
      const createdPrio = await post('/api/control/requests', {
        deviceId: prioDevice,
        commandKeys: [key],
        idempotencyKey: `idem-prio-${key}-${tag}`,
      }, approverToken);
      const prioRequestId = createdPrio.body?.id ?? createdPrio.body?.requestId ?? null;
      if (!prioRequestId) {
        prioRequests.push({ key, id: null });
        continue;
      }
      // pause/return_to_dock/stop 都不是高危命令 → 无需审批即可下发（安全动作不被审批链卡住）
      const sentPrio = await post(`/api/control/requests/${prioRequestId}/commands`, {
        commandKey: key,
      }, approverToken);
      createdRequestIds.push(prioRequestId);
      prioRequests.push({ key, id: prioRequestId, sent: sentPrio.status });
    }
    const prioPending = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(prioDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const prioOrder = (prioPending.body?.commands ?? []).map((c) => c.commandKey);
    const prioPriorities = (prioPending.body?.commands ?? []).map((c) => c.priority);
    step('12. NO-62b 安全停机插队：stop（最后下发）排在 pause/return_to_dock 之前',
      prioRequests.every((r) => r.id && (r.sent === 200 || r.sent === 201))
        && JSON.stringify(prioOrder) === JSON.stringify(['stop', 'pause', 'return_to_dock'])
        && prioPriorities[0] === 0
        && prioPending.body?.queued === 3
        && typeof prioPending.body?.oldestSentAt === 'string',
      `order=${JSON.stringify(prioOrder)} priorities=${JSON.stringify(prioPriorities)} queued=${prioPending.body?.queued} oldest=${prioPending.body?.oldestSentAt}`);

    const fpOf = (c) => String(c?.authorizationFingerprint ?? '');
    step('12b. NO-65a pending 携带**可验证的**授权范围（签名指纹 + scope），边缘据此验签',
      (pendingMine.body?.commands ?? []).length > 0
        && (pendingMine.body?.commands ?? []).every((c) =>
          /^hmac-sha256:v2:[0-9a-f]{32}$/.test(fpOf(c))
          && c.authorizationScope?.requestId === c.requestId
          && c.authorizationScope?.commandKey === c.commandKey
          && typeof c.authorizationScope?.deviceId === 'string',
        ),
      `fingerprint=${fpOf(pendingCmd)} scope=${JSON.stringify(pendingCmd?.authorizationScope ?? null)}`);

    // ══ NO-65a：签名指纹（边缘验签后才碰设备）═════════════════════════
    // 独立设备号：构造"平台已签发 + 中转环节把参数改掉"的场景。
    const sigDevice = `AGV-E2E-SIG-${tag}`;
    const sigRequest = await post('/api/control/requests', {
      deviceId: sigDevice,
      commandKeys: ['dispatch_task'],
      idempotencyKey: `idem-sig-${tag}`,
    }, approverToken);
    const sigRequestId = sigRequest.body?.id ?? sigRequest.body?.requestId ?? null;
    if (sigRequestId) createdRequestIds.push(sigRequestId);
    const sigAuths = await get('/api/approvals/authorizations', adminToken);
    const sigRow = (sigAuths.body ?? []).find(
      (a) => a.entityType === 'control_request' && a.entityId === sigRequestId,
    );
    const sigInstance = sigRow?.approvalId
      ? await get(`/api/approvals/${sigRow.approvalId}`, adminToken)
      : { body: null };
    const sigStepId = sigInstance.body?.steps?.[0]?.id ?? null;
    if (sigRow?.approvalId && sigStepId) {
      await post(
        `/api/approvals/${sigRow.approvalId}/steps/${sigStepId}/state?action=approve`,
        { reason: 'e2e：签名指纹场景' },
        adminToken,
      );
    }
    const sigSent = await post(`/api/control/requests/${sigRequestId}/commands`, {
      commandKey: 'dispatch_task',
      payload: { targetStationId, taskId: `T-SIG-${tag}` },
    }, approverToken);
    // 注入：把**参数**改掉（模拟"命令在库里/中转环节被改写"）。
    // 预期：**平台侧复核**先发现（指纹覆盖 payload），把命令撤回并不再投递；
    // 边缘侧验签（同一密钥）是第二道防线，由 pytest 的 `SignedFingerprintBoundaryTest`
    // 用桩平台覆盖（e2e 里无法篡改平台→网关的响应，除非引入代理）。
    const sigCmdRow = await sql`
      select command_id, authorization_fingerprint from ewoh_control_command
      where request_id = ${sigRequestId} order by _created_at desc limit 1`;
    const sigCommandId = sigCmdRow[0]?.command_id ?? null;
    const sigFingerprint = String(sigCmdRow[0]?.authorization_fingerprint ?? '');
    await sql`
      update ewoh_control_command
         set payload = ${sql.json({ targetStationId: 'ST-TAMPERED', taskId: `T-SIG-${tag}` })}
       where command_id = ${sigCommandId}`;
    const sigPending = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(sigDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const sigRowAfter = await sql`
      select status, revoked_reason, error_code from ewoh_control_command where command_id = ${sigCommandId}`;
    const sigResult = await sql`
      select result_type, result_code from ewoh_control_result where command_id = ${sigCommandId}`;
    // 再让边缘代理跑一轮：被撤回的命令**根本不会**到设备上
    const sigRun = spawnSync(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/edge_control_agent.py'),
        '--once',
        '--device', sigDevice,
        '--platform-url', BASE,
        '--ingest-key', INGEST_KEY,
        '--org-id', ORG_ID,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000, env: AGENT_ENV },
    );
    const sigLine = (sigRun.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let sigStats = null;
    try {
      sigStats = JSON.parse(sigLine);
    } catch {
      sigStats = null;
    }
    const sigDeviceRow = await sql`
      select status from ewoh_control_command where command_id = ${sigCommandId}`;
    step('16. NO-65a 参数被改写 → 平台复核即撤回（v2 指纹不符），边缘拿不到、设备不动',
      (sigSent.status === 200 || sigSent.status === 201)
        && /^hmac-sha256:v2:[0-9a-f]{32}$/.test(sigFingerprint)
        && (sigPending.body?.commands ?? []).length === 0
        && sigPending.body?.revoked === 1
        && sigRowAfter[0]?.status === 'revoked'
        && sigRowAfter[0]?.revoked_reason === 'fingerprint_mismatch'
        && sigResult[0]?.result_type === 'delivery_rejected'
        && sigResult[0]?.result_code === 'fingerprint_mismatch'
        && sigStats?.polled === 0
        && sigStats?.executed === 0
        && sigDeviceRow[0]?.status === 'revoked',
      `send=${sigSent.status} fp=${sigFingerprint.slice(0, 22)}… commands=${(sigPending.body?.commands ?? []).length} `
        + `revoked=${sigPending.body?.revoked} row=${sigRowAfter[0]?.status}/${sigRowAfter[0]?.revoked_reason} `
        + `agentPolled=${sigStats?.polled}`);

    // ══ NO-65b：一车一活（在飞运动命令挡住第二条）══════════════════════
    const busyDevice = `AGV-E2E-BUSY-${tag}`;
    const busyIds = [];
    for (const suffix of ['A', 'B']) {
      const created = await post('/api/control/requests', {
        deviceId: busyDevice,
        commandKeys: ['dispatch_task'],
        idempotencyKey: `idem-busy-${suffix}-${tag}`,
      }, approverToken);
      const rid = created.body?.id ?? created.body?.requestId ?? null;
      if (rid) createdRequestIds.push(rid);
      const auths = await get('/api/approvals/authorizations', adminToken);
      const row = (auths.body ?? []).find(
        (a) => a.entityType === 'control_request' && a.entityId === rid,
      );
      const inst = row?.approvalId ? await get(`/api/approvals/${row.approvalId}`, adminToken) : { body: null };
      const stepId = inst.body?.steps?.[0]?.id ?? null;
      if (row?.approvalId && stepId) {
        await post(
          `/api/approvals/${row.approvalId}/steps/${stepId}/state?action=approve`,
          { reason: `e2e：一车一活 ${suffix}` },
          adminToken,
        );
      }
      await post(`/api/control/requests/${rid}/commands`, {
        commandKey: 'dispatch_task',
        payload: { targetStationId, taskId: `T-BUSY-${suffix}-${tag}` },
      }, approverToken);
      busyIds.push(rid);
    }
    // 第一条先投给设备（网关确认投递 = 设备忙），第二条必须被暂缓
    const busyPending1 = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(busyDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const firstCmd = (busyPending1.body?.commands ?? [])[0];
    const busyFirstAck = firstCmd
      ? await post(
          `/api/control/commands/${firstCmd.commandId}/ack`,
          { delivered: true },
          null,
          { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
        )
      : { status: 0 };
    const busyPending2 = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(busyDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    step('17. NO-65b 一车一活：设备在飞时第二条运动命令**暂缓投递**（暂缓≠失败，命令保持 sent）',
      (busyFirstAck.status === 200 || busyFirstAck.status === 201)
        && (busyPending2.body?.commands ?? []).length === 0
        && (busyPending2.body?.deferred ?? []).length === 1
        && busyPending2.body.deferred[0]?.reason === 'device_busy'
        && String(busyPending2.body.deferred[0]?.blockedBy ?? '').includes(String(firstCmd?.commandId ?? '')),
      `firstAck=${busyFirstAck.status} delivered=${(busyPending2.body?.commands ?? []).length} `
        + `deferred=${JSON.stringify(busyPending2.body?.deferred ?? [])}`);

    // ── 17b. NO-66a 人面读面：同一事实对现场可见（不是只有网关能读）──────────
    const humanView = await get(
      `/api/control/requests?deviceId=${encodeURIComponent(busyDevice)}&limit=10`,
      adminToken,
    );
    const humanCmd = (humanView.body?.commands ?? []).find(
      (c) => c.commandId === firstCmd?.commandId,
    );
    const humanQueued = (humanView.body?.commands ?? []).find(
      (c) => c.deliveryState === 'queued_device_busy',
    );
    step('17b. NO-66a 人面执行边界读面：在飞/排队/占用者对现场可见（含租户与角色收敛）',
      humanView.status === 200
        && humanView.body?.summary?.inFlight === 1
        && humanView.body?.summary?.queued === 1
        && String(humanView.body?.summary?.busyBlocker ?? '').includes(String(firstCmd?.commandId ?? ''))
        && humanCmd?.deliveryState === 'gateway_received'
        && humanCmd?.fingerprintScheme === 'hmac-sha256:v2'
        && humanCmd?.fingerprintVerified === true
        && String(humanQueued?.deliveryNote ?? '').includes('一车一活'),
      `status=${humanView.status} summary=${JSON.stringify(humanView.body?.summary ?? null)} `
        + `queuedNote=${String(humanQueued?.deliveryNote ?? '').slice(0, 40)}`);

    const humanNoAuth = await get(
      `/api/control/requests?deviceId=${encodeURIComponent(busyDevice)}`,
      null,
    );
    step('17c. 人面读面必须认证（无令牌 401；未认证的现场读面等于跨租户泄露）',
      humanNoAuth.status === 401 || humanNoAuth.status === 403,
      `status=${humanNoAuth.status}`);

    // ── 17d. NO-65b 的另一半：在飞那条落到终态后，被暂缓的必须照常放行（暂缓不是死胡同）──
    // 上面 17/17b 只钉住"暂缓发生了"（commands=0、deferred=1、人面看得见排队原因），
    // 那一格此前只到"形状"。这里补的是**收敛**：把在飞命令用网关回执推到 executed，
    // 再轮一次同一个网关端点 ⇒ 第二条必须出现在 commands、deferred 清空。
    // 17 与 17d 是同一端点在一先一后两个时刻的相反结果 ⇒ 本断言不是恒真。
    const busyReceipt = firstCmd
      ? await post(
          `/api/control/commands/${firstCmd.commandId}/receipt`,
          { result: 'executed', receipt: { e2e: 'NO-65b 释放' } },
          null,
          { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
        )
      : { status: 0 };
    const busyPending3 = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(busyDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const released = (busyPending3.body?.commands ?? []).filter(
      (c) => String(c.commandId) !== String(firstCmd?.commandId ?? ''),
    );
    step('17d. NO-65b 暂缓会释放：在飞命令执行完毕后的下一次轮询里，第二条进入投递队列且 deferred 清空',
      (busyReceipt.status === 200 || busyReceipt.status === 201)
        && released.length === 1
        && String(released[0]?.commandKey ?? '') === 'dispatch_task'
        && (busyPending3.body?.deferred ?? []).length === 0,
      `receipt=${busyReceipt.status} released=${released.map((c) => c.commandId).join(',')} `
        + `deferred=${JSON.stringify(busyPending3.body?.deferred ?? [])}`);

    // ══ NO-62a：投递前授权复核（故障注入）════════════════════════════
    // 说明：这里用 owner 连接**直接改状态**注入"授权在投递窗口内失效"。
    // 真实流程里这段窗口由审批撤销/到期与人工重排触发；本场景要验证的是
    // **投递路径本身的复核逻辑**（而不是撤销端点会不会改状态），所以直接构造该状态。
    const revokeDevice = `AGV-E2E-REVOKE-${tag}`;
    const revokeRequest = await post('/api/control/requests', {
      deviceId: revokeDevice,
      commandKeys: ['dispatch_task'],
      idempotencyKey: `idem-revoke-${tag}`,
    }, approverToken);
    const revokeRequestId = revokeRequest.body?.id ?? revokeRequest.body?.requestId ?? null;
    if (revokeRequestId) createdRequestIds.push(revokeRequestId);
    const revokeAuths = await get('/api/approvals/authorizations', adminToken);
    const revokeApprovalRow = (revokeAuths.body ?? []).find(
      (a) => a.entityType === 'control_request' && a.entityId === revokeRequestId,
    );
    const revokeInstance = revokeApprovalRow?.approvalId
      ? await get(`/api/approvals/${revokeApprovalRow.approvalId}`, adminToken)
      : { body: null };
    const revokeStepId = revokeInstance.body?.steps?.[0]?.id ?? null;
    const revokeApproved = revokeApprovalRow?.approvalId && revokeStepId
      ? await post(
          `/api/approvals/${revokeApprovalRow.approvalId}/steps/${revokeStepId}/state?action=approve`,
          { reason: 'e2e：授权复核场景' },
          adminToken,
        )
      : { status: 0, body: null };
    const revokeSent = await post(`/api/control/requests/${revokeRequestId}/commands`, {
      commandKey: 'dispatch_task',
      payload: { targetStationId, taskId: `T-REVOKE-${tag}` },
    }, approverToken);
    step('13. NO-62a 前置：高危请求已审批并下发（命令 status=sent）',
      revokeApproved.status === 200 && (revokeSent.status === 200 || revokeSent.status === 201),
      `request=${revokeRequestId} approve=${revokeApproved.status} send=${revokeSent.status}`);

    // 注入 1：授权范围被改写（指纹与平台复核结果不符）
    const revokeCmdRow = await sql`
      select command_id, authorization_fingerprint from ewoh_control_command
      where request_id = ${revokeRequestId} order by _created_at desc limit 1`;
    const revokeCommandId = revokeCmdRow[0]?.command_id ?? null;
    await sql`
      update ewoh_control_command set authorization_fingerprint = 'deadbeefdeadbeef'
      where command_id = ${revokeCommandId}`;
    const revokedPending = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(revokeDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const revokedRow = await sql`
      select status, revoked_reason, error_code from ewoh_control_command where command_id = ${revokeCommandId}`;
    const revokedResult = await sql`
      select result_type, result_code, success from ewoh_control_result
      where command_id = ${revokeCommandId} and result_type = 'delivery_rejected'`;
    step('14. NO-62a 授权范围被改写 → 命令被撤回（不投递 + 原因码 + 结果行），设备拿不到命令',
      (revokedPending.body?.commands ?? []).length === 0
        && revokedPending.body?.revoked === 1
        && revokedRow[0]?.status === 'revoked'
        && revokedRow[0]?.revoked_reason === 'fingerprint_mismatch'
        && revokedResult[0]?.result_code === 'fingerprint_mismatch'
        && revokedResult[0]?.success === false,
      `commands=${(revokedPending.body?.commands ?? []).length} revoked=${revokedPending.body?.revoked} `
        + `status=${revokedRow[0]?.status}/${revokedRow[0]?.revoked_reason} result=${revokedResult[0]?.result_code}`);

    // 注入 2：请求在投递窗口内被撤销（授权链断在"已下发未投递"之间）
    const revoke2 = await post('/api/control/requests', {
      deviceId: revokeDevice,
      commandKeys: ['dispatch_task'],
      idempotencyKey: `idem-revoke2-${tag}`,
    }, approverToken);
    const revoke2RequestId = revoke2.body?.id ?? revoke2.body?.requestId ?? null;
    if (revoke2RequestId) createdRequestIds.push(revoke2RequestId);
    const revoke2Auths = await get('/api/approvals/authorizations', adminToken);
    const revoke2Row = (revoke2Auths.body ?? []).find(
      (a) => a.entityType === 'control_request' && a.entityId === revoke2RequestId,
    );
    const revoke2Instance = revoke2Row?.approvalId
      ? await get(`/api/approvals/${revoke2Row.approvalId}`, adminToken)
      : { body: null };
    const revoke2StepId = revoke2Instance.body?.steps?.[0]?.id ?? null;
    const revoke2Approved = revoke2Row?.approvalId && revoke2StepId
      ? await post(
          `/api/approvals/${revoke2Row.approvalId}/steps/${revoke2StepId}/state?action=approve`,
          { reason: 'e2e：授权链断点场景' },
          adminToken,
        )
      : { status: 0, body: null };
    const revoke2Sent = await post(`/api/control/requests/${revoke2RequestId}/commands`, {
      commandKey: 'dispatch_task',
      payload: { targetStationId, taskId: `T-REVOKE2-${tag}` },
    }, approverToken);
    await sql`
      update ewoh_control_request set status = 'revoked' where request_id = ${revoke2RequestId}`;
    const revoked2Pending = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(revokeDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const revoked2Row = await sql`
      select c.status, c.revoked_reason from ewoh_control_command c
      where c.request_id = ${revoke2RequestId} order by c._created_at desc limit 1`;
    step('15. NO-62a 请求在投递窗口内被撤销 → 同样拒绝投递（authorization_revoked）',
      revoke2Approved.status === 200
        && (revoke2Sent.status === 200 || revoke2Sent.status === 201)
        && (revoked2Pending.body?.commands ?? []).length === 0
        && revoked2Row[0]?.status === 'revoked'
        && revoked2Row[0]?.revoked_reason === 'authorization_revoked',
      `request=${revoke2RequestId} send=${revoke2Sent.status} commands=${(revoked2Pending.body?.commands ?? []).length} `
        + `status=${revoked2Row[0]?.status}/${revoked2Row[0]?.revoked_reason}`);

    // ── 19. NO-67b 投递配额：本分钟用尽 → 显式排队（不是失败、不是静默丢弃）──────
    // 本地验证把配额设为 3/min（.env.local-standalone）；这里造 4 条普通命令：
    // 3 条进入投递窗口，第 4 条排队等下一分钟。安全动作不受配额约束（由单测覆盖）。
    const quotaDevice = `AGV-E2E-QUOTA-${tag}`;
    const quotaRequestIds = [];
    for (let i = 0; i < 4; i += 1) {
      const created = await post('/api/control/requests', {
        deviceId: quotaDevice,
        commandKeys: ['pause'],
        idempotencyKey: `idem-quota-${i}-${tag}`,
      }, approverToken);
      const rid = created.body?.id ?? created.body?.requestId ?? null;
      if (!rid) continue;
      createdRequestIds.push(rid);
      quotaRequestIds.push(rid);
      await post(`/api/control/requests/${rid}/commands`, { commandKey: 'pause' }, approverToken);
    }
    const quotaPending = await get(
      `/api/control/commands/pending?deviceId=${encodeURIComponent(quotaDevice)}`,
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const quotaDeferred = (quotaPending.body?.deferred ?? []).filter((d) => d.reason === 'quota');
    step('19. NO-67b 投递配额：本分钟用尽后普通命令排队（reason=quota，命令保持 sent）',
      quotaRequestIds.length === 4
        && (quotaPending.body?.commands ?? []).length === 3
        && quotaDeferred.length === 1
        && String(quotaDeferred[0]?.blockedBy ?? '').includes('quota:')
        && quotaPending.body?.quota?.perMinute === 3
        && quotaPending.body?.quota?.remaining === 0,
      `requests=${quotaRequestIds.length} delivered=${(quotaPending.body?.commands ?? []).length} `
        + `quotaDeferred=${quotaDeferred.length} quota=${JSON.stringify(quotaPending.body?.quota ?? null)}`);

    // ── 20. NO-68a 投递积压：超 SLA 未交付 → 巡检把它变成叫到人的提醒 ──────────
    // 现场问题："设备不动，但没人知道命令根本没投出去"。这里把一条命令的 sent_at
    // 回拨到 SLA 之外（注入"下发后迟迟未投递"），调巡检读面，断言提醒真的产生了。
    const backlogDevice = `AGV-E2E-BACKLOG-${tag}`;
    const backlogRequest = await post('/api/control/requests', {
      deviceId: backlogDevice,
      commandKeys: ['pause'],
      idempotencyKey: `idem-backlog-${tag}`,
    }, approverToken);
    const backlogRequestId = backlogRequest.body?.id ?? backlogRequest.body?.requestId ?? null;
    if (backlogRequestId) createdRequestIds.push(backlogRequestId);
    await post(`/api/control/requests/${backlogRequestId}/commands`, { commandKey: 'pause' }, approverToken);
    await sql`
      update ewoh_control_command set sent_at = now() - interval '30 minutes', delivered_at = null
       where request_id = ${backlogRequestId}`;
    const sweep = await post('/api/control/delivery-backlog/sweep', {}, adminToken);
    const backlogNotifications = await sql`
      select notification_id, title from ewoh_notification
       where external_ref = ${backlogDevice} order by _created_at desc limit 5`;
    const backlogAudit = await sql`
      select action from ewoh_audit_log
       where action = 'control.delivery_backlog_sweep' order by audit_seq desc limit 2`;
    step('20. NO-68a 投递积压巡检：超 SLA 未交付 → 按设备发出提醒（内容可照着排障）+ 审计',
      (sweep.status === 200 || sweep.status === 201)
        && Number(sweep.body?.devicesWithBacklog) >= 1
        && Number(sweep.body?.created) >= 1
        && backlogNotifications.some((row) => String(row.notification_id).includes('delivery_backlog'))
        && backlogAudit.length > 0,
      `sweep=${sweep.status} devices=${sweep.body?.devicesWithBacklog} created=${sweep.body?.created} `
        + `notifications=${backlogNotifications.length} audit=${backlogAudit.length}`);

    // ── 20b. NO-70a 升级链：积压 30 分钟 = 6× SLA(5min) > 3× 阈值 → 必须升级 ──────
    const escalatedNotifications = await sql`
      select notification_id, recipient_id, severity, title
        from ewoh_notification
       where external_ref = ${backlogDevice}
         and notification_id like '%delivery_backlog_escalated%'
       limit 10`;
    const pmNotified = escalatedNotifications.some(
      (row) => String(row.recipient_id) === 'production_manager',
    );
    const criticalSeverity = escalatedNotifications.some(
      (row) => String(row.severity) === 'critical',
    );
    step('20b. NO-70a 升级链：积压超 3× SLA → 桶升 escalated + 加发 production_manager（critical）',
      Number(sweep.body?.escalationMultiplier) === 3
        && Number(sweep.body?.escalatedDevices) >= 1
        && escalatedNotifications.length > 0
        && pmNotified
        && criticalSeverity,
      `escalated=${escalatedNotifications.length} pmNotified=${pmNotified} `
        + `critical=${criticalSeverity} multiplier=${sweep.body?.escalationMultiplier}`);

    // ── 11. 重复 ack 幂等 ───────────────────────────────────────────
    // 命令必须挂在一个**非终态**请求下才能被确认投递（NO-62a：终态请求下的命令
    // 一律拒绝投递确认——主链路请求此刻已是 executed）。这里为幂等探针单独建一个
    // 低风险 pause 请求，并用**它自己的 pause 命令**做探针。
    //
    // 2026-09-13 修正：此前把主链路的 dispatch_task（高危）命令改挂到这张低危单上
    // 再 ack——NO-62a 投递复核升级为"按当前词表对**本条命令键**判级"后，这会被
    // 正确拒绝（approval_missing：高危命令借低危单投递 = 授权链 fail-open 的口子，
    // 闸门拦得对）。幂等探针的本意只是测"同一命令 ack 两次的幂等语义"，
    // 用真正的 pause 命令即可，不必绕闸门。
    const ackDevice = `AGV-E2E-ACK-${tag}`;
    const ackRequest = await post('/api/control/requests', {
      deviceId: ackDevice,
      commandKeys: ['pause'],
      idempotencyKey: `idem-ack-${tag}`,
    }, approverToken);
    const ackRequestId = ackRequest.body?.id ?? ackRequest.body?.requestId ?? null;
    if (ackRequestId) createdRequestIds.push(ackRequestId);
    const ackCmdCreated = await post(
      `/api/control/requests/${ackRequestId}/commands`,
      { commandKey: 'pause' },
      approverToken,
    );
    // `POST /requests/:id/commands` 返回整个请求（attempts 里带 attemptId=命令号）。
    const ackCommandId = (ackCmdCreated.body?.attempts ?? []).at(-1)?.attemptId
      ?? ackCmdCreated.body?.commandId
      ?? null;
    const noKey = await post(`/api/control/commands/${ackCommandId}/ack`, { delivered: true }, null);
    const firstAck = await post(
      `/api/control/commands/${ackCommandId}/ack`,
      { delivered: true },
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const secondAck = await post(
      `/api/control/commands/${ackCommandId}/ack`,
      { delivered: true },
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    step('11. 网关命令面必须带边缘密钥（无密钥 401）；重复 ack 幂等（第二次 alreadyAcked，不重复写结果行）',
      noKey.status === 401
        && (firstAck.status === 200 || firstAck.status === 201)
        && secondAck.body?.alreadyAcked === true,
      `noKey=${noKey.status} first=${firstAck.status} second=${secondAck.status} `
        + `alreadyAcked=${secondAck.body?.alreadyAcked} ackRequest=${ackRequestId} msg=${errText(firstAck)}`);

    // ── 11b. 终态请求下的命令不接受投递确认（NO-62a 的反向断言）─────────
    // 复用同一条合成命令：挂到**已 executed** 的主链路请求下 → ack 必须 409，
    // 且命令被撤回（不是"静默接受一次失效授权下的投递"）。
    await sql`
      update ewoh_control_command set status = 'sent', request_id = ${requestId}
      where command_id = ${tamperedId}`;
    const ackTerminal = await post(
      `/api/control/commands/${tamperedId}/ack`,
      { delivered: true },
      null,
      { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID },
    );
    const terminalRow = await sql`
      select status, revoked_reason from ewoh_control_command where command_id = ${tamperedId}`;
    step('11b. 终态请求下的命令拒绝投递确认（409 + 撤回，不是"静默接受失效授权"）',
      ackTerminal.status === 409
        && terminalRow[0]?.status === 'revoked'
        && terminalRow[0]?.revoked_reason === 'request_terminal',
      `status=${ackTerminal.status} row=${terminalRow[0]?.status}/${terminalRow[0]?.revoked_reason} msg=${errText(ackTerminal)}`);
  } finally {
    try {
      // 本场景创建的全部控制行（主链路 + 优先级设备 + 授权复核设备）都要清掉，
      // 否则下一次运行会看到上一轮的残留（"环境脏"被误报成产品缺陷）。
      const ids = [...new Set(createdRequestIds.filter(Boolean))];
      if (ids.length > 0) {
        await sql`delete from ewoh_control_result where request_id = any(${ids})`;
        await sql`delete from ewoh_control_command where request_id = any(${ids})`;
        await sql`delete from ewoh_control_request where request_id = any(${ids})`;
      }
    } catch (error) {
      console.warn(`[cleanup] 控制命令清理失败（不掩盖断言结果）：${error?.message ?? error}`);
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
