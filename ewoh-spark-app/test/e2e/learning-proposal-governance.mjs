/* 学习段治理闭环验证 —— 真实后端 + 真实 PostgreSQL + 真实摄入通道。
 *
 * 场景（工厂现场）：EHS/班组长认为「人员过载」规则的负荷阈值不合适。
 * 旧实现有两处结构性缺陷：
 *   A. 提案台账只有 approved_by，没有提议人字段 → 「提案人不得自批」这条
 *      回避规则**无从执行**（与方案 B5 治理同族，standalone_073 修复）。
 *   B. 提议者看不到当前生效的到底是什么值 → 只能猜基线（新增只读基线读面）。
 *
 * 本脚本用**模拟外骨骼传感器 → 真实摄入 API → ewoh_telemetry → 服务端影子
 * 重放**这条真实数据路径，把整段闭环钉死：
 *
 *   1. 基线读面可用，且如实区分「引擎内置常量」与「已批准提案覆盖」；
 *   2. 摄入 2 帧高负荷遥测（模拟传感器）→ 提案自动获得服务端重建的影子证据
 *      （客户端 facts 不作证据，R2-SBZ-004）；
 *   3. 提议人归属取服务端会话——请求体伪造 proposedBy 无效；
 *   4. 提议人自批 → 403 SELF_APPROVAL_FORBIDDEN，且提案状态**未被写入**；
 *   5. 他人（global_admin）审批 → 基线读面显示 approved_proposal 覆盖 +
 *      提案/提议人/审批人来源；
 *   6. 回滚 → 基线回到原值（激活可逆，且基线不撒谎）。
 *
 * 前置：
 *   - 后端已启动（默认 http://127.0.0.1:3100），库中已应用 standalone_073；
 *   - 摄入密钥已配置（默认取本地开发密钥 local-verify-ingest-key-0001，
 *     绑定租户 00000000-0000-4000-8000-000000000001）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 \
 *   EWOH_E2E_ADMIN_USER=admin EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_USER=approver.li EWOH_E2E_APPROVER_PASS=... \
 *     node test/e2e/learning-proposal-governance.mjs
 *
 * 三态：PASS / FAIL / SKIP；有 SKIP 时退出码 2（未验证 ≠ 通过）。
 */
import http from 'node:http';
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const ADMIN_USER = process.env.EWOH_E2E_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.EWOH_E2E_ADMIN_PASS || 'admin-password';
const APPROVER_USER = process.env.EWOH_E2E_APPROVER_USER || 'approver.li';
const APPROVER_PASS = process.env.EWOH_E2E_APPROVER_PASS || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || 'local-verify-ingest-key-0001';
const INGEST_ORG = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';
/**
 * 只有该连接用于**注册模拟空间实体**（摄入通道要求 entity_id 已存在）。
 * 与真实摄入 API 的关系：实体是"孪生体登记"，帧数据仍走真实摄入通道。
 * 未提供时本段如实 SKIP，不跨租户/不绕过实体校验造数。
 */
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
/** 引擎内置负荷阈值（shared/reasoning-trace.ts DEFAULT_WORKLOAD_THRESHOLD）。 */
const ENGINE_DEFAULT_WORKLOAD = 0.8;
const SIM_ENTITY_IDS = ['person:e2e-gov-a', 'person:e2e-gov-b'];

const results = [];
function record(status, name, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const step = (name, ok, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail);
const skip = (name, detail = '') => record('SKIP', name, detail);
const errText = (res) => String(res.body?.error?.message ?? res.body?.message ?? '').slice(0, 200);

function finish() {
  const passed = results.filter((r) => r.status === 'PASS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log('\n========================================');
  console.log(`Learning Proposal Governance: ${passed.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP（共 ${results.length}）`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
  if (skipped.length) {
    console.log('SKIPPED（未验证，非通过）:', skipped.map((s) => s.name).join('; '));
    if (!failed.length) process.exitCode = 2;
  }
}

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
          ...extraHeaders,
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

const workloadEntry = (baseline) =>
  (baseline?.entries ?? []).find((e) => e.ruleId === 'rule:worker-overload' && e.parameter === 'workloadThreshold');

async function loginAs(username, password) {
  const res = await request('POST', '/api/auth/login', { username, password });
  if (res.status === 429) return { rateLimited: true, res };
  if (res.status !== 200 && res.status !== 201) return { res };
  return { res, token: res.body?.accessToken, user: res.body?.user };
}

async function main() {
  const runTag = Date.now().toString(36);
  const proposalId = `lp:e2e-gov-${runTag}`;

  // ---- 0. 前置：后端可达（未认证应被拒，404 = 路由未部署）----
  const health = await request('GET', '/api/learning/thresholds');
  if (health.status === 404) {
    record('FAIL', '0. 基线读面存在', 'GET /api/learning/thresholds 返回 404——路由未部署（服务端未同步 standalone_073 版本）');
    return finish();
  }
  step('0. 后端可达且基线读面要求认证（非 404）',
    health.status === 401 || health.status === 403,
    `未认证探测 status=${health.status}`);

  // ---- 1. 登录（提议人 = 班组长；审批人 = 全局管理员）----
  if (!APPROVER_PASS) {
    skip('1. 登录提议人', '未提供 EWOH_E2E_APPROVER_PASS（无法验证提议人归属与自批回避）');
    return finish();
  }
  const proposer = await loginAs(APPROVER_USER, APPROVER_PASS);
  if (proposer.rateLimited) {
    skip('1. 登录提议人', '登录被限流（HTTP 429）。本地反复验证请提高上限后重启，例如 LOGIN_RATE_LIMIT_MAX=1000 LOGIN_RATE_LIMIT_WINDOW_SEC=60。');
    return finish();
  }
  step('1. 登录提议人', Boolean(proposer.token), `${APPROVER_USER} status=${proposer.res.status}`);
  if (!proposer.token) return finish();

  const admin = await loginAs(ADMIN_USER, ADMIN_PASS);
  if (admin.rateLimited) {
    skip('1b. 登录审批人', '登录被限流（HTTP 429）');
    return finish();
  }
  step('1b. 登录审批人', Boolean(admin.token), `${ADMIN_USER} status=${admin.res.status}`);
  if (!admin.token) return finish();

  // B5：回避校验要求两个身份不同；同名账号无法验证该规则。
  if (proposer.user?.userId === admin.user?.userId) {
    record('FAIL', '1c. 提议人 ≠ 审批人', '两个账号解析为同一 userId，无法验证生成人回避');
    return finish();
  }
  step('1c. 提议人 ≠ 审批人', true);

  // ---- 2. 基线读面：如实区分引擎常量与已批准覆盖 ----
  const baselineRes = await request('GET', '/api/learning/thresholds', null, proposer.token);
  step('2. 读取阈值基线', baselineRes.status === 200, `status=${baselineRes.status} ${errText(baselineRes)}`);
  const before = workloadEntry(baselineRes.body);
  if (beforeResolved(before) === false) return finish();
  const beforeValue = before.effective;
  step('2b. 基线声明来源（engine_default / approved_proposal）',
    before.source === 'engine_default' || before.source === 'approved_proposal',
    `effective=${beforeValue} source=${before.source}`);
  step('2c. 基线标注读取时间与引擎版本',
    typeof baselineRes.body?.readAt === 'string' && typeof baselineRes.body?.engineVersion === 'string',
    `readAt=${baselineRes.body?.readAt} engineVersion=${baselineRes.body?.engineVersion}`);
  step('2d. 引擎内置常量与引擎实现一致',
    before.engineDefault === ENGINE_DEFAULT_WORKLOAD,
    `engineDefault=${before.engineDefault}`);

  // ---- 3. 真实摄入通道写入模拟外骨骼遥测（影子证据的来源）----
  if (proposer.user?.orgId && INGEST_ORG && proposer.user.orgId !== INGEST_ORG) {
    skip('3. 摄入模拟遥测',
      `摄入密钥绑定租户 ${INGEST_ORG}，登录租户 ${proposer.user.orgId} 不同——影子窗口按租户隔离，本脚本不跨租户造数。`
      + '请为登录租户配置摄入密钥（INGEST_API_KEYS）后重跑。');
    return finish();
  }
  const frames = [
    // 基线 0.8 命中、候选 0.9 不命中 → 影子差集里能看到 removedSubjects
    { entity_id: SIM_ENTITY_IDS[0], device_id: 'exo:e2e-gov-1', load_score: 0.85, fatigue_trend: 0.75 },
    // 基线/候选都命中 → 阈值提高后仍触发，验证差集不是"清空一切"
    { entity_id: SIM_ENTITY_IDS[1], device_id: 'exo:e2e-gov-2', load_score: 0.95, fatigue_trend: 0.8 },
  ].map((frame) => ({
    ...frame,
    // 原则 7/11：模拟数据必须可识别，不得冒充真实观测（source_type 落库）。
    source_type: 'simulated',
  }));
  if (!OWNER_DB) {
    skip('3. 注册模拟空间实体',
      '未提供 EWOH_E2E_OWNER_DATABASE_URL：摄入通道要求 entity_id 已在 ewoh_spatial_entity 登记'
      + '（模拟设备登记 = source_type=simulated），本脚本不绕过实体校验造数，故摄入与后续段未验证。');
    return finish();
  }
  try {
    await registerSimulatedEntities(OWNER_DB, proposer.user.orgId, SIM_ENTITY_IDS);
    step('3. 注册模拟空间实体（source_type=simulated，孪生体登记）', true, SIM_ENTITY_IDS.join(', '));
  } catch (error) {
    record('FAIL', '3. 注册模拟空间实体', error?.message ?? String(error));
    return finish();
  }
  let ingestOk = true;
  // 身份映射（ADR-006/NO-02b）：外骨骼帧的**人员归属**来自 edge-device 映射，
  // 没有映射时 telemetry.entity_id 为 NULL，影子评估会（正确地）跳过该行。
  // 这不是可省的旁路——它就是"设备数据归到谁头上"的真实登记步骤。
  let mappingsOk = true;
  for (const [index, deviceId] of ['exo:e2e-gov-1', 'exo:e2e-gov-2'].entries()) {
    const res = await request('POST', '/api/identity/mappings', {
      mappingId: `map:e2e-gov-${index}`,
      version: 1,
      source: { system: 'edge-device', id: deviceId, idKind: 'device' },
      target: { entityId: SIM_ENTITY_IDS[index] },
      authority: 'registration',
    }, proposer.token);
    const ok = res.status === 200 || res.status === 201;
    if (!ok) {
      mappingsOk = false;
      record('FAIL', `3b. 登记设备↔人员身份映射 ${deviceId}`, `status=${res.status} ${errText(res)}`);
    }
  }
  if (mappingsOk) step('3b. 登记设备↔人员身份映射（edge-device → person）', true, '2 条');
  if (!mappingsOk) return finish();

  for (const frame of frames) {
    const res = await request(
      'POST',
      '/api/ingest/exoskeleton',
      { ...frame, event_time: new Date().toISOString(), quality: { confidence: 1 } },
      null,
      { 'x-ingest-key': INGEST_KEY },
    );
    const accepted = res.status === 200 || res.status === 201;
    if (!accepted || res.body?.accepted === false) {
      ingestOk = false;
      record('FAIL', `3. 摄入模拟遥测 ${frame.entity_id}`,
        `status=${res.status} ${errText(res)} accepted=${res.body?.accepted}`);
    }
  }
  if (ingestOk) step('3. 摄入模拟遥测（真实摄入 API → ewoh_telemetry）', true, `${frames.length} 帧`);
  else return finish();

  // ---- 4. 提案：提议人归属取服务端会话（请求体伪造无效）----
  const candidate = beforeValue >= 0.9 ? 0.7 : 0.9;
  const forgedProposer = 'attacker:forged-proposer';
  const proposeRes = await request('POST', '/api/learning/proposals', {
    proposalId,
    kind: 'rule_threshold',
    change: {
      ruleId: 'rule:worker-overload',
      parameter: 'workloadThreshold',
      baselineValue: beforeValue,
      candidateValue: candidate,
    },
    // 伪造字段：服务端必须忽略（提议人取 userContext.userId）。
    proposedBy: forgedProposer,
    approvedBy: forgedProposer,
  }, proposer.token);
  step('4. 提案受理', proposeRes.status === 200 || proposeRes.status === 201,
    `status=${proposeRes.status} ${errText(proposeRes)}`);
  const proposal = proposeRes.body?.proposal ?? proposeRes.body;
  if (!proposal?.proposalId) return finish();

  step('4b. 提议人归属取服务端会话（请求体 proposedBy 被忽略）',
    proposal.proposedBy === proposer.user?.userId && proposal.proposedBy !== forgedProposer,
    `proposedBy=${proposal.proposedBy} forged=${forgedProposer}`);
  step('4c. 基线值取自服务端基线读面（不猜）',
    proposal.change?.baselineValue === beforeValue,
    `baselineValue=${proposal.change?.baselineValue} 基线读面=${beforeValue}`);

  // 影子证据由服务端从库内事实源重建：摄入 → 证据可见。
  if (proposal.status === 'shadow_evaluated') {
    step('4d. 影子证据来自库内事实（摄入的遥测进入窗口）',
      Number(proposal.shadowEval?.factsCount) >= frames.length,
      `factsCount=${proposal.shadowEval?.factsCount} baselineFires=${proposal.shadowEval?.baselineFires} candidateFires=${proposal.shadowEval?.candidateFires}`);
    step('4e. 影子评估给出差集结论（阈值改变确有影响面）',
      Array.isArray(proposal.shadowEval?.removedSubjects) || Array.isArray(proposal.shadowEval?.addedSubjects),
      `removed=${JSON.stringify(proposal.shadowEval?.removedSubjects)} added=${JSON.stringify(proposal.shadowEval?.addedSubjects)}`);
    // 端到端归属：摄入帧 → 身份映射 → 影子事实主体 = 映射到的人员。
    const subjects = new Set([
      ...(proposal.shadowEval?.removedSubjects ?? []),
      ...(proposal.shadowEval?.addedSubjects ?? []),
    ]);
    const attributed = [...subjects].some((s) => SIM_ENTITY_IDS.includes(s));
    const expectDiff = candidate > beforeValue;
    step('4f. 传感器数据按身份映射归属到人员（阈值提高后该人员不再触发）',
      expectDiff ? subjects.has(SIM_ENTITY_IDS[0]) : attributed,
      `主体=${JSON.stringify([...subjects])}`);
  } else {
    skip('4d. 影子证据来自库内事实',
      `提案状态为 ${proposal.status}（库内窗口无可重建事实）。摄入的遥测可能落在其他租户/时间窗，`
      + '故本段未验证（不伪装成通过）。');
    return finish();
  }

  // ---- 5. 生成人回避：提议人自批被拒，且状态未被写入 ----
  const selfApprove = await request('POST', `/api/learning/proposals/${encodeURIComponent(proposalId)}/approve`, {}, proposer.token);
  const selfMsg = errText(selfApprove);
  step('5. 提议人自批被拒（403 SELF_APPROVAL_FORBIDDEN）',
    selfApprove.status === 403 && /SELF_APPROVAL_FORBIDDEN/i.test(selfMsg),
    `status=${selfApprove.status} ${selfMsg}`);
  const afterSelf = await request('GET', `/api/learning/proposals/${encodeURIComponent(proposalId)}`, null, proposer.token);
  step('5b. 自批被拒后提案状态未被写入（仍待人审）',
    (afterSelf.body?.status ?? afterSelf.body?.proposal?.status) === 'shadow_evaluated',
    `status=${afterSelf.body?.status ?? afterSelf.body?.proposal?.status}`);

  // ---- 6. 他人审批 → 覆盖生效，基线读面给出完整来源 ----
  const approve = await request('POST', `/api/learning/proposals/${encodeURIComponent(proposalId)}/approve`, {}, admin.token);
  step('6. 他人审批通过', approve.status === 200 || approve.status === 201,
    `status=${approve.status} ${errText(approve)}`);
  const approved = approve.body?.proposal ?? approve.body;
  step('6b. 审批人归属取服务端会话',
    approved?.approvedBy === admin.user?.userId,
    `approvedBy=${approved?.approvedBy} admin=${admin.user?.userId}`);

  const activatedRes = await request('GET', '/api/learning/thresholds', null, proposer.token);
  const activated = workloadEntry(activatedRes.body);
  step('6c. 基线读面显示已批准覆盖生效',
    activated?.source === 'approved_proposal' && activated?.effective === candidate,
    `effective=${activated?.effective} source=${activated?.source} 期望 ${candidate}`);
  step('6d. 覆盖来源可追溯（提案 / 提议人 / 审批人）',
    activated?.provenance?.proposalId === proposalId
      && activated?.provenance?.proposedBy === proposer.user?.userId
      && activated?.provenance?.approvedBy === admin.user?.userId,
    `provenance=${JSON.stringify(activated?.provenance ?? null).slice(0, 200)}`);
  step('6e. 覆盖携带影子证据来源标注',
    Boolean(activated?.provenance?.shadowFactsProvenance?.source),
    `source=${activated?.provenance?.shadowFactsProvenance?.source}`);

  // ---- 7. 回滚 → 基线回到原值（激活可逆，基线不撒谎）----
  const rollback = await request('POST', `/api/learning/proposals/${encodeURIComponent(proposalId)}/rollback`,
    { reason: 'e2e 治理验证：验证后可逆回滚（理由必填）' }, admin.token);
  step('7. 回滚已生效覆盖', rollback.status === 200 || rollback.status === 201,
    `status=${rollback.status} ${errText(rollback)}`);
  const restoredRes = await request('GET', '/api/learning/thresholds', null, proposer.token);
  const restored = workloadEntry(restoredRes.body);
  step('7b. 回滚后基线恢复原值/原来源',
    restored?.effective === beforeValue && restored?.source === (before.source === 'approved_proposal' ? 'approved_proposal' : 'engine_default'),
    `effective=${restored?.effective} source=${restored?.source}（回滚前 ${beforeValue}/${before.source}）`);
  step('7c. 回滚后溯源披露历史计数（提案不消失，审计留痕）',
    Number(restored?.counts?.rolledBack) >= 1,
    `counts=${JSON.stringify(restored?.counts ?? null)}`);

  finish();
}

/**
 * 登记两台"模拟人员实体"（幂等）。显式 source_type='simulated'（原则 11/7：
 * 模拟数据必须可识别，不得冒充真实观测）；帧数据本身仍只走真实摄入 API。
 */
async function registerSimulatedEntities(ownerUrl, orgId, entityIds) {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    for (const entityId of entityIds) {
      await sql`
        insert into public.ewoh_spatial_entity
          (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
        values (${orgId}, ${entityId}, 'person', ${`e2e simulated ${entityId}`}, 10, 20, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
        on conflict (org_id, entity_id) do update
          set status = 'active', source_type = 'simulated', name = excluded.name
      `;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** 基线条目结构合法性（缺字段时给出明确失败而不是 undefined 级联）。 */function beforeResolved(entry) {
  if (!entry) {
    record('FAIL', '2. 基线读面返回 worker-overload 条目', '未找到 rule:worker-overload / workloadThreshold 条目');
    finish();
    return false;
  }
  if (typeof entry.effective !== 'number') {
    record('FAIL', '2. 基线读面返回可用生效值', `effective=${JSON.stringify(entry.effective)} source=${entry.source}`);
    finish();
    return false;
  }
  return true;
}

main().catch((error) => {
  record('FAIL', 'unexpected', error?.message ?? String(error));
  finish();
});
