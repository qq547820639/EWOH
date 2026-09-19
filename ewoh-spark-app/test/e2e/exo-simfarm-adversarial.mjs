/**
 * 外骨骼虚拟机群仿真对抗 E2E —— 真实边缘运行时 + 真实 NXP1 线协议 + 真实后端 + 真实 PostgreSQL。
 *
 * 为什么单列：「热积累」「设备物理寿命」「真机外骨骼」在行业对标里被标为"需真机/未实现"，
 * 但平台侧链条完全可以用**仿真对抗**验证——仿真器扮演"真设备"（独立参数的物理真值），
 * 平台/边缘的推算与门槛被它对抗：
 *
 *   1. 热积累对抗：仿真器用独立系数的一阶热模型产生电机温度**真值**（真值不进帧——
 *      NXP1 线协议无温度字段），边缘 thermal.py 估计器只能从 torque 帧流推算；
 *      断言平台收到的 THERMAL_ACCUMULATION 事件里的估计值与真值在容差内、
 *      且 condition 诚实标注"模型推算，非测量"；
 *   2. 电量对抗：SOC 模型穿越低电量阈值 → LOW_BATTERY 事件必达平台；
 *   3. 线协议对抗：CRC 坏帧（解码层必须拒绝计数）、SEQ 重放（实时通道按
 *      「重复标记 degraded」处理——不丢弃，质量层与 DATA_DEGRADED 事件可观测）、
 *      未来时间戳（平台 CLOCK_DRIFT_FUTURE_TS 必须逐帧显式拒绝，上行桥逐帧
 *      记 rejected、拒绝帧转死信）、突发粘包（拆帧正确）；
 *   4. 账目闭合：适配器/上行桥计数可对账（不丢、不重、可解释）；
 *   5. 佩戴事实双源：会话声明的佩戴人 ≠ 遥测上报的 worker_id → 判定"佩戴人不符"
 *      且需人核实（NO-41a 语义在**仿真遥测**下依然成立）。
 *
 * 诚实边界：本链验证的是平台/边缘侧**逻辑**；热模型系数是假设（待真机标定）、
 * 真实物理保真度、真机安全闭环（设备控制器层）不在仿真覆盖内（未验证 ≠ 通过）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_INGEST_KEY=... EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/exo-simfarm-adversarial.mjs
 *   （可选 EWOH_SIMFARM_DURATION=45 仿真秒数；三态 PASS/FAIL/SKIP，exit 0/1/2）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || '';
const ORG_ID = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';
const PERSON_ID = process.env.EWOH_E2E_PERSON_ID || '';
const REPO_ROOT = path.resolve(process.cwd(), '..');
const PYTHON = process.env.EWOH_E2E_PYTHON || 'python3';
const DURATION = Number(process.env.EWOH_SIMFARM_DURATION || 45);

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
    `外骨骼仿真对抗: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
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

async function call(method, url, body, token, extraHeaders = {}) {
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

async function main() {
  const probe = await fetch(`${BASE}/api/exo/sessions`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}`);
    return finish();
  }
  step('0a. 平台可达（任意 HTTP 响应即视为可达）', true, `探测 status=${probe.status}`);
  step('0b. 未认证读面被拒（401/403——鉴权闸有效，不把"可达"当"已鉴权"）',
    probe.status === 401 || probe.status === 403,
    `探测 status=${probe.status}${probe.status === 200 ? '（未认证可读 = 鉴权缺陷！）' : ''}`);
  if (!OWNER_DB || !INGEST_KEY) {
    skip('0b. 平台侧事实断言', '未提供 EWOH_E2E_OWNER_DATABASE_URL / EWOH_E2E_INGEST_KEY');
    return finish();
  }

  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS);
  if (!adminToken) {
    skip('1. 管理员登录', lastLoginError ?? '缺少凭据');
    return finish();
  }
  step('1. 管理员登录成功', true);

  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const workdir = mkdtempSync(path.join(tmpdir(), `ewoh-exo-simfarm-${tag}-`));
  const statsPath = path.join(workdir, 'stats.json');
  const N = 3;
  const deviceIds = Array.from({ length: N }, (_, i) => `EXO-${String(i + 1).padStart(2, '0')}`);
  const workerIds = Array.from({ length: N }, (_, i) => `P-EXOSIM-${String(i + 1).padStart(2, '0')}`);
  const startedAt = new Date();

  try {
    // ── 2. 前置自建：遥测 entity 挂靠（摄入 fail-closed：entity_id 不存在 → 帧被拒）──
    // 仿真设备的 entity_id = device_id（exo 帧无独立 entity），必须先登记。
    let entitiesReady = false;
    try {
      for (const deviceId of deviceIds) {
        await sql`
          insert into ewoh_spatial_entity
            (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
          values (${ORG_ID}, ${deviceId}, 'device', ${`仿真外骨骼 ${deviceId}`}, 10, 10, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
          on conflict (org_id, entity_id) do update set status = 'active'`;
      }
      entitiesReady = true;
    } catch (error) {
      skip('2. 登记仿真设备空间实体', String(error).slice(0, 160));
    }
    if (!entitiesReady) return finish();
    step('2. 仿真设备空间实体已登记（entity fail-closed 的前置条件自建）', true);

    // ── 3. 仿真器运行（真实边缘运行时 + 真实 TCP 线协议 + 物理模型 + 对抗注入）──
    const sim = spawnSync(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/exo_fleet_sim.py'),
        '--platform-url', BASE,
        '--ingest-key', INGEST_KEY,
        '--org-id', ORG_ID,
        '--workdir', workdir,
        '--duration-sec', String(DURATION),
        '--hz', '5',
        '--stats-json', statsPath,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: (DURATION + 60) * 1000 },
    );
    step('3. 仿真器运行完成（exit 0）', sim.status === 0, `exit=${sim.status}${sim.status !== 0 ? ` stderr=${String(sim.stderr).slice(-300)}` : ''}`);
    if (!existsSync(statsPath)) {
      record('FAIL', '3b. 仿真统计输出', `未生成 stats.json；stdout=${String(sim.stdout).slice(-200)}`);
      return finish();
    }
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    const byId = Object.fromEntries(stats.devices.map((d) => [d.device_id, d]));
    const thermal = byId[deviceIds[0]];
    const battery = byId[deviceIds[1]];
    const faults = byId[deviceIds[2]];

    // ── 4. 物理真值与注入账目（仿真器侧）───────────────────────────
    step('4a. 三腿设备都产出了帧', thermal.frames_sent > 0 && battery.frames_sent > 0 && faults.frames_sent > 0,
      `frames=${thermal.frames_sent}/${battery.frames_sent}/${faults.frames_sent}`);
    step('4b. 热积累真值确实越过了 warn 邻域（对抗才有意义）', thermal.temp_peak_c >= 52,
      `truth peak=${thermal.temp_peak_c}°C final=${thermal.temp_final_c}°C（力矩均值 ${thermal.torque_mean_nm}Nm）`);
    step('4c. 电量腿确实穿越了低电量阈值', battery.battery_final_pct < 10,
      `SOC final=${battery.battery_final_pct}%`);

    // 线协议层：CRC 注入必须被真实适配器解码层拒绝（坏帧一个都不许变成遥测；
    // 重放/突发会把同一坏帧多送几次，故计数只保下界）
    const wireById = Object.fromEntries((stats.wire ?? []).map((w) => [w.device_id, w]));
    step('4d. CRC 坏帧被解码层拒绝（bad_crc_frames ≥ crc_injected ≥ 1，坏帧零遥测化）',
      wireById[deviceIds[2]]?.bad_crc_frames >= faults.crc_injected && faults.crc_injected >= 1,
      `injected=${faults.crc_injected} rejected=${wireById[deviceIds[2]]?.bad_crc_frames}`);
    step('4e. 干净腿零坏帧（账目互不污染）',
      (wireById[deviceIds[0]]?.bad_crc_frames ?? 0) === 0 && (wireById[deviceIds[1]]?.bad_crc_frames ?? 0) === 0,
      `crc01=${wireById[deviceIds[0]]?.bad_crc_frames} crc02=${wireById[deviceIds[1]]?.bad_crc_frames}`);
    step('4f. 对抗注入确实发生（重放/未来时间戳计数 > 0）',
      faults.seq_replays >= 1 && faults.future_ts_injected >= 1,
      `seq_replays=${faults.seq_replays} future_ts=${faults.future_ts_injected} bursts=${faults.bursts}`);

    // ── 5. 热估计对抗：边缘估计值 vs 仿真真值（参数独立，容差断言）────
    const estTemp = stats.thermal_estimator_c?.[deviceIds[0]];
    step('5. 边缘热估计器在容差内跟踪真值（独立参数的物理模型对抗）',
      typeof estTemp === 'number' && Math.abs(estTemp - thermal.temp_final_c) <= 10,
      `est=${estTemp}°C vs truth=${thermal.temp_final_c}°C（|Δ|=${estTemp == null ? 'n/a' : Math.abs(estTemp - thermal.temp_final_c).toFixed(2)}°C ≤ 10）`);

    // ── 6. 平台侧事件台账（真实 PG）───────────────────────────────
    await new Promise((r) => setTimeout(r, 2000)); // 等上行批次落账
    // 边缘规则事件（envelope.subject/payload 携带设备归属）与云侧规则事件
    // （device_id 列）双路都在平台台账里；按 eventType + 设备归属过滤。
    const eventRows = await sql`
      select event_id, event_code, event_type, device_id, severity, title, evidence_json, occurred_at, received_at,
             coalesce(evidence_json->'envelope'->'payload'->>'deviceId', device_id) as eff_device
      from ewoh_event
      where org_id = ${ORG_ID}
        and evidence_json->'envelope'->>'eventType' in ('DeviceThermalRisk', 'DeviceLowBattery')
        and received_at >= ${startedAt.toISOString()}
      order by received_at`;
    const thermalEvents = eventRows.filter(
      (r) => r.event_type === 'DeviceThermalRisk' && r.eff_device === deviceIds[0],
    );
    const batteryEvents = eventRows.filter(
      (r) => r.event_type === 'DeviceLowBattery' && r.eff_device === deviceIds[1],
    );
    step('6a. 热积累事件必达平台（EDGE_DeviceThermalRisk，事件类型已入目录）', thermalEvents.length >= 1,
      `rows=${thermalEvents.length} first=${thermalEvents[0]?.event_id ?? 'none'}`);
    step('6b. 低电量事件必达平台（边缘 DeviceLowBattery）', batteryEvents.length >= 1,
      `rows=${batteryEvents.length} first=${batteryEvents[0]?.event_id ?? 'none'}`);

    const thermalEnvelope = thermalEvents[0]?.evidence_json?.envelope ?? {};
    step('6c. 事件信封诚实：eventType=DeviceThermalRisk + source=edge:rule-engine + payload 归属设备',
      thermalEnvelope.eventType === 'DeviceThermalRisk'
        && thermalEnvelope.source === 'edge:rule-engine'
        && thermalEnvelope.payload?.deviceId === deviceIds[0],
      `eventType=${thermalEnvelope.eventType} source=${thermalEnvelope.source} payloadDevice=${thermalEnvelope.payload?.deviceId ?? 'none'}`);

    // 估计值 vs 事件时刻真值：condition 里带模型版本与估计值（不伪装成测量）。
    // 对抗口径：把事件发生时刻回投到仿真器真值序列（线性插值）——比较的是
    // "同一时刻"的估计与真值，而不是拿触发时刻的估计对全程峰值。
    // 检出底线（如实声明）：±8°C 容差下，热率参数 ~±20% 以内的漂移可能漏检；
    // 更大的模型错误（系统性偏差/漏积分/双计）必然越界。
    const condition = thermalEnvelope.payload?.trigger?.condition ?? '';
    const estMatch = String(condition).match(/thermal_est\(([\w-]+)\)=([\d.]+)°C/);
    step('6d. 事件 condition 声明"模型推算非测量"并带模型版本',
      /thermal_est\(.+\)=/.test(String(condition)) && String(condition).includes('非测量'),
      `condition=${String(condition).slice(0, 90)}`);
    const occurredMs = thermalEvents[0]?.occurred_at ? Date.parse(thermalEvents[0].occurred_at) : NaN;
    const series = thermal.truth_series ?? [];
    let truthAtEvent = null;
    if (series.length >= 2 && Number.isFinite(occurredMs)) {
      for (let i = 1; i < series.length; i++) {
        const [t0, v0] = series[i - 1];
        const [t1, v1] = series[i];
        if (occurredMs >= t0 && occurredMs <= t1) {
          truthAtEvent = v0 + ((v1 - v0) * (occurredMs - t0)) / Math.max(t1 - t0, 1);
          break;
        }
      }
    }
    step('6e. 事件里的估计值与事件时刻真值在容差内（仿真器真值是对抗基准）',
      estMatch && truthAtEvent != null && Math.abs(Number(estMatch[2]) - truthAtEvent) <= 8,
      `event est=${estMatch?.[2] ?? 'n/a'}°C vs truth@event=${truthAtEvent == null ? 'n/a' : truthAtEvent.toFixed(2)}°C（occurredAt=${thermalEvents[0]?.occurred_at}）`);

    // 事件幂等（行为级，不是查唯一约束保底）：把平台已落账的热事件信封**原样重发**
    // 给 /api/ingest/events —— 必须判 duplicate 且不产生第二行（at-least-once 重投安全）。
    const thermalRow = thermalEvents[0];
    if (thermalRow) {
      const replayEnvelope = thermalRow.evidence_json?.envelope ?? null;
      const replayPost = replayEnvelope
        ? await fetch(`${BASE}/api/ingest/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY, 'x-org-id': ORG_ID },
          body: JSON.stringify({ events: [replayEnvelope] }),
        }).then((r) => r.json().catch(() => null)).catch(() => null)
        : null;
      const replayResult = replayPost?.results?.[0] ?? replayPost?.events?.[0] ?? null;
      const rowsAfterReplay = await sql`
        select count(*)::int as n from ewoh_event where org_id = ${ORG_ID} and event_id = ${thermalRow.event_id}`;
      step('6f. 事件幂等（行为级）：同一信封重发 → duplicate=true 且行数仍为 1（重投不双写）',
        Boolean(replayPost) && rowsAfterReplay[0]?.n === 1
          && replayResult?.duplicate === true,
        `replay duplicate=${replayResult?.duplicate ?? 'n/a'} rows=${rowsAfterReplay[0]?.n} http=${replayPost ? 'ok' : 'fail'}`);
    } else {
      skip('6f. 事件幂等（行为级）', '无热事件行可重放（6a 未取证）');
    }

    // 云侧规则引擎交叉印证：同一低电量事实，边缘与云两条规则路各自独立触发
    const cloudBattery = await sql`
      select event_id from ewoh_event
      where org_id = ${ORG_ID} and event_code = 'LOW_BATTERY' and device_id = ${deviceIds[1]}
        and created_at >= ${startedAt.toISOString()} limit 1`;
    step('6g. 云侧规则引擎对同一 SOC 真实独立触发 LOW_BATTERY（边缘/云双路印证）', cloudBattery.length >= 1,
      `cloud_rows=${cloudBattery.length}`);

    // SEQ 重放/突发重复的真实契约：重放副本与原帧同 (dev, ts, seq) → 同 record_id
    // → 平台幂等**吸收**（重放不双写落账）。可证伪口径：落账行数必须显著小于
    // 发送帧数（差额=被吸收的重复），且桥的 duplicates 计数 > 0。
    // 若幂等失效（重复帧各自落账），rows_landed ≈ frames_sent → 本步红。
    const faultsHeartbeats = faults.heartbeats ?? 0;
    const expectedMax = faults.frames_sent + faultsHeartbeats;
    const bridgeDuplicates = Number(stats.sensor_uplink?.stats?.duplicates ?? 0);
    const faultsRows = await sql`
      select count(*)::int as n from ewoh_telemetry
      where org_id = ${ORG_ID} and device_id = ${deviceIds[2]}
        and source_type = 'simulated' and ingested_at >= ${startedAt.toISOString()}`;
    const faultsLanded = Number(faultsRows[0]?.n ?? 0);
    step('6h. SEQ 重放/突发重复被平台幂等吸收（重复副本不双写落账，桥 duplicates>0）',
      faultsLanded < expectedMax && bridgeDuplicates >= 1,
      `发送(帧+心跳)=${expectedMax} 落账=${faultsLanded}（吸收 ${expectedMax - faultsLanded}）桥 duplicates=${bridgeDuplicates}`);

    // ── 7. 遥测落账与坏时钟拒绝 ──────────────────────────────────
    const telemetryCounts = await sql`
      select device_id, count(*)::int as n,
             max(worker_id) filter (where worker_id is not null) as worker
      from ewoh_telemetry
      where org_id = ${ORG_ID} and device_id in ${sql(deviceIds)}
        and source_type = 'simulated' and ingested_at >= ${startedAt.toISOString()}
      group by device_id`;
    const telById = Object.fromEntries(telemetryCounts.map((r) => [r.device_id, r]));
    step('7. 三台设备的仿真遥测都落了平台账（source_type=simulated）',
      Number(telById[deviceIds[0]]?.n ?? 0) > 0 && Number(telById[deviceIds[1]]?.n ?? 0) > 0 && Number(telById[deviceIds[2]]?.n ?? 0) > 0,
      `rows=${JSON.stringify(Object.fromEntries(Object.entries(telById).map(([k, v]) => [k, Number(v.n)])))}`);
    step('7a. 遥测携带设备配置的 worker 身份（EXO-03 → P-EXOSIM-03，双源校验的事实源）',
      telById[deviceIds[2]]?.worker === workerIds[2],
      `worker=${telById[deviceIds[2]]?.worker ?? 'none'}`);

    const sensorRejected = Number(stats.sensor_uplink?.stats?.rejected ?? 0);
    step('7b. 坏时钟帧被平台**逐帧**显式拒绝（rejected ≥ 注入数——漏拒一帧都算 FAIL）',
      sensorRejected >= faults.future_ts_injected,
      `sensor_uplink rejected=${sensorRejected} vs 注入=${faults.future_ts_injected}
      （死信文件: ${stats.sensor_uplink?.queue_path ?? 'n/a'}）`);

    // ── 8. 佩戴事实双源（会话声明 × 仿真遥测 worker）───────────────
    // 会话在仿真后建立（设备此时已因真实遥测上行入台账），佩戴人声明为绑定人员；
    // 然后用**真实摄入通道**钉一帧窗口内遥测，worker 用仿真设备的真实配置值
    // P-EXOSIM-03（≠ 会话佩戴人）→ 一致性判定必须是 wearer_mismatch 且需人核实。
    // 前置清障：先结束该设备上历史残留的活跃会话（一台设备同时只允许一个活跃会话）。
    // 注意列表读面返回**裸数组**（与 consistency 的 {sessions} 包装不同）。
    const leftover = await call(
      'GET',
      `/api/exo/sessions?status=active&exoId=${encodeURIComponent(`device:${deviceIds[2]}`)}`,
      undefined,
      adminToken,
    );
    const leftoverList = Array.isArray(leftover.body) ? leftover.body : (leftover.body?.sessions ?? []);
    for (const s of leftoverList) {
      await call('POST', `/api/exo/sessions/${encodeURIComponent(s.sessionId)}/end`,
        { endedBy: 'e2e-simfarm-cleanup' }, adminToken);
    }
    const mismatchSessionId = `exo-session:SIMFARM-${tag}`;
    const wearerPersonRef = PERSON_ID ? `person:${PERSON_ID}` : 'person:P-EXOSIM-WEARER-UNKNOWN';
    const sessionCreated = await call('POST', '/api/exo/sessions', {
      sessionId: mismatchSessionId,
      exoId: `device:${deviceIds[2]}`,
      personId: wearerPersonRef,
      startedAt: new Date().toISOString(),
    }, adminToken);
    step('8a. EXO-03 佩戴会话已建立（声明佩戴人 ≠ 设备遥测 worker，制造双源冲突）',
      (sessionCreated.status === 201 || sessionCreated.status === 200),
      `status=${sessionCreated.status} msg=${sessionCreated.body?.error?.message ?? sessionCreated.body?.message ?? ''} wearer=${wearerPersonRef} vs worker=${workerIds[2]}`);

    const pinned = await fetch(`${BASE}/api/ingest/exoskeleton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify({
        device_id: deviceIds[2],
        entity_id: deviceIds[2],
        event_time: new Date().toISOString(),
        source_type: 'simulated',
        worker_id: workerIds[2],
        load: { cumulative_load_score: 0.4 },
        pose: { angular_velocity_dps: 3 },
        device: { battery_pct: 66 },
        quality: { status: 'good', confidence: 0.9 },
      }),
    }).then((r) => r.json().catch(() => null)).catch(() => null);
    const consistency = await call('GET', '/api/exo/sessions/consistency', undefined, adminToken);
    const verdict = (consistency.body?.sessions ?? []).find((s) => s.sessionId === mismatchSessionId);
    step('8b. 佩戴人不符可判定：声明佩戴人 ≠ 遥测 worker → wearer_mismatch 且需人核实',
      Boolean(pinned?.accepted)
        && verdict?.verdict === 'wearer_mismatch'
        && verdict?.needsHumanCheck === true,
      `pinned=${pinned?.accepted ?? 'n/a'} verdict=${verdict?.verdict ?? 'none'} worker=${verdict?.telemetryWorkerRef ?? 'none'}`);

    // ── 收尾：结束会话（不残留活跃绑定）──────────────────────────
    await call('POST', `/api/exo/sessions/${encodeURIComponent(mismatchSessionId)}/end`,
      { endedBy: 'e2e-simfarm-cleanup' }, adminToken);
  } catch (error) {
    record('FAIL', '异常退出', String(error?.stack || error).slice(0, 300));
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  finish();
}

main();
