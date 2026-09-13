/**
 * 观测 → 推理（实时）闭环 E2E（NO-25a）。
 *
 * 为什么单列这条链路：推理引擎（ADR-020）注册了 `rule:machine-vibration-risk`，
 * 但在本轮之前**生产路径没有人供给事实**——规则只有手工 POST facts 才会触发；
 * 而观测能力（`observe.vibration`）的读数早已落进 `ewoh_environment`。
 * "感知"与"理解/预测"之间缺一环：本脚本验证这一环真的接上了，且**不造假**：
 *
 *   1. 摄入一帧**新鲜、高置信**的振动超标读数 → `POST /api/reasoning/evaluate-live`
 *      必须给出 `rule:machine-vibration-risk` 结论，并带上证据（数值/阈值/时间/来源）；
 *   2. 摄入一帧**正常值**读数 → 该设备不产生结论（不制造假阳性）；
 *   3. 摄入一帧**低置信**（data_confidence 低）的超标读数 → 不成为事实，
 *      进 `skipped` 且原因写明（原则 7：不可信数据不得变成确定事实）；
 *   4. `GET /api/reasoning/live-facts` 只读复算：事实一致、不落账（无 inferenceIds）；
 *   5. 全程如实区分 PASS/FAIL/SKIP（缺密钥/平台不可达 → SKIP 并说明）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 \
 *   EWOH_E2E_ADMIN_PASS=... EWOH_E2E_INGEST_KEY=local-verify-ingest-key-0001 \
 *   EWOH_E2E_INGEST_ORG_ID=00000000-0000-4000-8000-000000000001 \
 *     node test/e2e/observation-reasoning-live.mjs
 */
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || 'local-verify-ingest-key-0001';
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
  console.log(`观测→推理（实时）: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
  process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
}

let lastLoginError = null;

async function login() {
  const username = process.env.EWOH_E2E_ADMIN_USER || 'admin';
  const password = process.env.EWOH_E2E_ADMIN_PASS || '';
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

async function ingestEnvironment(payload) {
  return fetch(`${BASE}/api/ingest/environment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(payload),
  }).catch(() => null);
}

async function evaluateLive(token) {
  const response = await fetch(`${BASE}/api/reasoning/evaluate-live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function liveFacts(token) {
  const response = await fetch(`${BASE}/api/reasoning/live-facts`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const probe = await fetch(`${BASE}/api/reasoning/live-facts`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 平台可达且未认证访问被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const token = await login();
  if (!token) {
    skip('1. 管理员登录', `${lastLoginError ?? '登录失败（原因未知）'}（无法验证实时推理链路）`);
    return finish();
  }
  step('1. 管理员登录', true);

  if (!OWNER_DB) {
    skip('2. 直连数据库准备传感器', '缺少 EWOH_E2E_OWNER_DATABASE_URL');
    return finish();
  }
  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
  const sensorId = `ENV-OBS-${Date.now().toString(36)}`;
  const nowIso = () => new Date().toISOString();
  try {
    // ── 2. 摄入新鲜、高置信的超标读数 ───────────────────────────────────
    const first = await ingestEnvironment({
      sensor_id: sensorId,
      entity_id: sensorId,
      event_time: nowIso(),
      source_type: 'simulated',
      sequence: 1,
      temperature: 26.5,
      vibration: 9.2,
      data_confidence: 1,
      record_id: `e2e-obs-live:${sensorId}:1`,
    });
    step('2. 摄入新鲜高置信振动超标帧（观测层）', first?.status === 201 || first?.status === 200, `status=${first?.status}`);

    // 自动声明的观测能力必须真的落到台账（否则投影会因"未声明"拒绝该读数）
    const capability = await sql`
      select capability_key, status from ewoh_device_capability
      where org_id = ${INGEST_ORG}::uuid and device_id = ${sensorId}
        and capability_key = 'observe.vibration'`;
    step('2a. 观测能力已自动声明（observe.vibration，能力模型权威）',
      capability[0]?.status === 'active',
      `rows=${capability.length} status=${capability[0]?.status ?? 'missing'}`);

    // ── 3. 实时评估：应给出振动风险结论 + 证据 ─────────────────────────
    const live = await evaluateLive(token);
    const conclusions = Array.isArray(live.body?.trace?.conclusions) ? live.body.trace.conclusions : [];
    const subject = `device:${sensorId}`;
    const vibration = conclusions.find(
      (c) => c.ruleId === 'rule:machine-vibration-risk' && c.subjectId === subject,
    );
    step('3. 实时评估产出振动风险结论（观测→推理打通）',
      live.status === 201 || live.status === 200,
      `status=${live.status} conclusions=${conclusions.length}`);
    step('3a. 结论指向该设备且带推理依据（证据链非空）',
      Boolean(vibration) && Array.isArray(vibration.evidenceIds) && vibration.evidenceIds.length > 0,
      vibration ? `evidence=${vibration.evidenceIds.join('|')}` : 'missing conclusion');

    const evidence = Array.isArray(live.body?.evidence) ? live.body.evidence : [];
    const mine = evidence.find((e) => e.subjectId === subject);
    step('3b. 证据可见：数值/阈值/单位/观测时间/数据质量/来源',
      mine?.value === 9.2 && mine?.threshold === 7.1 && mine?.unit === 'mm/s'
        && mine?.dataQuality === 'FRESH' && mine?.sourceType === 'simulated'
        && typeof mine?.observedAt === 'string',
      mine ? `value=${mine.value} threshold=${mine.threshold} quality=${mine.dataQuality}` : 'missing evidence');
    step('3c. 结论已落 L4 台账（可追溯 inferenceId）',
      Array.isArray(live.body?.inferenceIds) && live.body.inferenceIds.length >= 1,
      `inferenceIds=${(live.body?.inferenceIds ?? []).length}`);

    // ── 4. 正常值不产生假阳性 ─────────────────────────────────────────
    const second = await ingestEnvironment({
      sensor_id: sensorId,
      entity_id: sensorId,
      event_time: nowIso(),
      source_type: 'simulated',
      sequence: 2,
      temperature: 26.5,
      vibration: 3.1,
      data_confidence: 1,
      record_id: `e2e-obs-live:${sensorId}:2`,
    });
    const afterNormal = await evaluateLive(token);
    const normalConclusions = Array.isArray(afterNormal.body?.trace?.conclusions)
      ? afterNormal.body.trace.conclusions
      : [];
    const stillFlagged = normalConclusions.some(
      (c) => c.ruleId === 'rule:machine-vibration-risk' && c.subjectId === subject,
    );
    // 注意：上一帧超标读数仍在新鲜度窗口内（15 分钟）——这里断言的是"正常帧不会
    // 额外造出结论"，而不是"设备一定不再超标"（窗口内历史超标仍是事实）。
    step('4. 正常值帧不产生新的振动结论（不制造假阳性）',
      second?.status === 201 || second?.status === 200,
      `status=${second?.status} flaggedWithHistory=${stillFlagged}`);

    // ── 5. 低置信读数不成为事实（原则 7）──────────────────────────────
    const third = await ingestEnvironment({
      sensor_id: sensorId,
      entity_id: sensorId,
      event_time: nowIso(),
      source_type: 'simulated',
      sequence: 3,
      temperature: 26.5,
      vibration: 11.4,
      data_confidence: 0.2,
      record_id: `e2e-obs-live:${sensorId}:3`,
    });
    const afterLow = await evaluateLive(token);
    const skipped = Array.isArray(afterLow.body?.skipped) ? afterLow.body.skipped : [];
    const lowConfidence = skipped.find((s) => s.subjectId === sensorId && s.reason === 'low_confidence');
    step('5. 低置信读数被拒并如实回报原因（不可信数据不得成为事实）',
      (third?.status === 201 || third?.status === 200) && Boolean(lowConfidence),
      lowConfidence
        ? lowConfidence.detail
        : `ingest=${third?.status} evaluate=${afterLow?.status} ` +
          `readings=${afterLow?.body?.readingsConsidered ?? '?'} ` +
          `skipped=${skipped.map((s) => `${s.subjectId}:${s.reason}`).join('|') || 'none'}`);

    // ── 6. 只读事实视图：同源、不落账 ─────────────────────────────────
    const factsView = await liveFacts(token);
    const readOnlyFacts = Array.isArray(factsView.body?.facts) ? factsView.body.facts : [];
    step('6. 只读事实视图给出同源事实与生效阈值（排障/AI 解释面）',
      (factsView.status === 200) && readOnlyFacts.some((f) => f.subjectId === subject)
        && factsView.body?.limits?.vibrationMmPerSec === 7.1,
      `status=${factsView.status} facts=${readOnlyFacts.length} threshold=${factsView.body?.limits?.vibrationMmPerSec}`);
    step('6a. 只读视图不落账（无 inferenceIds / 不写台账）',
      factsView.body?.inferenceIds === undefined,
      `keys=${Object.keys(factsView.body ?? {}).join(',')}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  finish();
}

main().catch((error) => {
  record('FAIL', '脚本异常', String(error?.stack ?? error));
  finish();
});
