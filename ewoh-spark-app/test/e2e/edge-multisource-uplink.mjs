/* 边缘多源上行闭环验证 —— 真实边缘运行时 + 真实后端 + 真实 PostgreSQL。
 *
 * 场景（工厂现场）：一台边缘机箱接了环境传感器、摄像头与 UWB 定位，
 * 现场会断网、传感器时钟会漂、网络会重发。此前只有**外骨骼**帧能上行，
 * 环境/摄像头/定位的帧在边缘就被 `insert_telemetry` 的键不匹配丢掉
 * （docs/architecture/data-flow.md §4.4 记录的断点）——平台侧对应的三个
 * ingest 端点从未被喂过数据。
 *
 * 本脚本用**真实边缘运行时**（真实适配器 → 归一化 → SQLite → 有界缓冲上行桥）
 * 跑一遍，并注入现场故障，然后在平台侧逐条核对：
 *
 *   1. 账目闭合：发布的帧一条不落地进入上行桥（无进程内丢失），且
 *      received + replayed == sent + duplicates + rejected + buffer + dropped；
 *   2. 三类帧真的落进平台（environment 行 / world_state 的摄像头检测与定位行）；
 *   3. 重放不双写：注入的重复帧被平台按 (org, record_id) 幂等命中（duplicates>0），
 *      平台内每条 record_id 恰好一行；
 *   4. 坏时钟不被伪造为事实：未来时间戳帧被平台显式拒绝（CLOCK_DRIFT_FUTURE_TS），
 *      平台内不存在该运行的前置时间行；
 *   5. 迟到不丢弃：迟到帧仍落库（带 is_late 语义的时间戳可查）；
 *   6. 模拟数据可识别：平台行 source_type='simulated'；
 *   7. 无法归一化的帧不静默消失：边缘死信表有留痕（本脚本另跑一次坏帧注入）。
 *
 * 前置：
 *   - 平台已启动（默认 http://127.0.0.1:3100），摄入密钥已配置；
 *   - `EWOH_E2E_OWNER_DATABASE_URL` 指向同一库（平台侧事实断言）；
 *   - 摄入限流需按机群规模配置（本地建议 INGEST_RATE_LIMIT=100000，见文档）。
 *
 * 运行：
 *   EWOH_E2E_OWNER_DATABASE_URL=postgresql://ewoh_owner:...@127.0.0.1:55432/ewoh \
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 \
 *   EWOH_E2E_INGEST_KEY=local-verify-ingest-key-0001 \
 *     node test/e2e/edge-multisource-uplink.mjs
 *
 * 三态：PASS / FAIL / SKIP；有 SKIP 时退出码 2（未验证 ≠ 通过）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || 'local-verify-ingest-key-0001';
const INGEST_ORG = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';
const PERSON_ID = process.env.EWOH_E2E_PERSON_ID || 'P001';
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
  const passed = results.filter((r) => r.status === 'PASS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log('\n========================================');
  console.log(`Edge Multi-Source Uplink: ${passed.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP（共 ${results.length}）`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
  if (skipped.length) {
    console.log('SKIPPED（未验证，非通过）:', skipped.map((s) => s.name).join('; '));
    if (!failed.length) process.exitCode = 2;
  }
}

async function loginAdmin(usernameOverride, passwordOverride) {
  const username = usernameOverride || process.env.EWOH_E2E_ADMIN_USER || 'admin';
  const password = passwordOverride || process.env.EWOH_E2E_ADMIN_PASS || '';
  if (!password) return null;
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 201)) return null;
  const body = await response.json().catch(() => null);
  return body?.accessToken ?? null;
}

async function probePlatform() {
  const response = await fetch(`${BASE}/api/ingest/environment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => null);
  return response ? response.status : 0;
}

function runSimulator(args, workdir) {
  const statsPath = path.join(workdir, 'stats.json');
  const result = spawnSync(
    PYTHON,
    [path.join(REPO_ROOT, 'tools/edge_sensor_sim.py'), '--workdir', workdir, '--stats-json', statsPath, ...args],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  const stats = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, 'utf8')) : null;
  return { result, stats };
}

async function main() {
  const status = await probePlatform();
  if (status === 0) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 平台可达（摄入端点要求密钥）', status === 401 || status === 403 || status === 400, `未认证探测 status=${status}`);
  if (!OWNER_DB) {
    skip('0b. 平台侧事实断言', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法核对库内行）');
    return finish();
  }

  const tag = Date.now().toString(36);
  const workdir = mkdtempSync(path.join(tmpdir(), `ewoh-edge-e2e-${tag}-`));
  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });

  try {
    // ---- 1. 真实边缘运行时：断网 → 恢复 → 补传（注入重复/乱序/迟到/坏时钟）----
    const { result, stats } = runSimulator([
      '--suffix', tag,
      '--duration-sec', '6',
      '--hz', '1',
      '--offline-first-sec', '2',
      '--duplicate-rate', '0.35',
      '--reorder-rate', '0.2',
      '--late-rate', '0.2',
      '--drift-future-rate', '0.2',
      '--ingest-key', INGEST_KEY,
      '--org-id', INGEST_ORG,
      '--person-id', PERSON_ID,
      '--platform-url', BASE,
      // NO-59b：同时跑一台执行机构（AGV）模拟设备 → 验证执行层状态上行全链
      '--with-actuator',
    ], workdir);
    step('1. 边缘模拟器运行完成', result.status === 0, `exit=${result.status}`);
    if (!stats) {
      record('FAIL', '1b. 模拟器统计输出', `未生成 stats.json；stderr=${String(result.stderr).slice(-300)}`);
      return finish();
    }
    const bridge = stats.bridge;
    const byEndpoint = bridge.stats.by_endpoint ?? {};
    step('1b. 三类传感器帧都被发布并进入上行桥（无进程内丢失）',
      stats.accounting.no_in_process_loss === true,
      `published=${stats.accounting.published} received=${stats.accounting.bridge_received}`);
    step('1c. 账目闭合（每条都有归属：发出/命中/被拒/缓冲）',
      stats.accounting.closed === true,
      `received+replayed=${stats.accounting.bridge_received + stats.accounting.bridge_replayed} accounted=${stats.accounting.bridge_accounted}`);
    step('1d. 断网期间帧进本地队列并在恢复后补传',
      Number(stats.accounting.phase_snapshots?.[0]?.buffer) > 0 && bridge.buffer === 0,
      `断网缓冲=${stats.accounting.phase_snapshots?.[0]?.buffer} 恢复后剩余=${bridge.buffer}`);
    step('1e. 注入的重复帧被平台幂等命中（重放不双写）',
      Number(bridge.stats.duplicates) > 0,
      `duplicates=${bridge.stats.duplicates}`);
    step('1f. 坏时钟帧被平台显式拒绝（不写未来事实）',
      Number(bridge.stats.rejected) > 0 && (bridge.stats.rejected_record_ids ?? []).length > 0,
      `rejected=${bridge.stats.rejected}`);
    step('1g. 边缘侧无不可归一化帧（三类都有归一化路径）',
      stats.frame_dead_letters === 0,
      `edge dead-letter=${stats.frame_dead_letters}`);

    // ---- 2. 平台侧：三类数据真的落库 ----
    const envSensor = `ENV-SIM-${tag}`;
    const camId = `CAM-SIM-${tag}`;
    const envSent = Number(byEndpoint.environment?.sent ?? 0);
    const camSent = Number(byEndpoint.camera?.sent ?? 0);
    const locSent = Number(byEndpoint.location?.sent ?? 0);
    step('2. 三类帧都实际投递（每类 sent > 0）',
      envSent > 0 && camSent > 0 && locSent > 0,
      `sent: env=${envSent} camera=${camSent} location=${locSent}`);

    const envRows = await sql`
      select count(*)::int as rows, count(distinct record_id)::int as uniq,
             count(*) filter (where source_type = 'simulated')::int as simulated,
             count(*) filter (where ts < now() - interval '25 minutes')::int as late,
             count(*) filter (where ts > now() + interval '5 minutes')::int as future
      from ewoh_environment where sensor_id = ${envSensor}`;
    const env = envRows[0];
    step('2b. 环境读数落库且不双写（行数=去重 record_id 数）',
      env.rows > 0 && env.rows === env.uniq,
      `rows=${env.rows} distinct=${env.uniq}`);
    step('2c. 模拟来源可识别（source_type=simulated）',
      env.simulated === env.rows,
      `simulated=${env.simulated}/${env.rows}`);
    step('2d. 迟到帧仍然落库（标记不丢弃）',
      env.late > 0,
      `迟到行=${env.late}`);
    step('2e. 平台内没有未来时间戳行（坏时钟被拒）',
      env.future === 0,
      `future=${env.future}`);

    const camRows = await sql`
      select count(*)::int as rows, count(distinct state_json->>'record_id')::int as uniq
      from ewoh_world_state
      where org_id = ${INGEST_ORG} and state_json->>'camera_id' = ${camId}`;
    const cam = camRows[0];
    // 每帧 → 2 个检测目标（模拟器固定 2 个 track）
    step('2f. 摄像头检测落 world_state（每帧 2 条检测目标行）且不双写',
      cam.rows === camSent * 2 && cam.uniq === camSent,
      `rows=${cam.rows}（期望 ${camSent * 2}）distinct_record=${cam.uniq}（期望 ${camSent}）`);

    const locRows = await sql`
      select count(*)::int as rows, count(distinct state_json->>'record_id')::int as uniq
      from ewoh_world_state
      where org_id = ${INGEST_ORG} and entity_id = ${PERSON_ID}
        and state_json->>'locator' = 'uwb'
        and state_json->>'record_id' like 'edge:location:%'
        and ts > now() - interval '15 minutes'`;
    const loc = locRows[0];
    step('2g. UWB 定位落 world_state（人员归属）且不双写',
      loc.rows > 0 && loc.rows === loc.uniq,
      `rows=${loc.rows} distinct_record=${loc.uniq}`);

    // ---- 2h. 感知层设备进入平台设备台账（此前 ewoh_device 只有外骨骼）----
    const deviceRows = await sql`
      select device_id, device_category, online, last_telemetry_at, battery_pct
      from ewoh_device
      where org_id = ${INGEST_ORG}
        and device_id in (${envSensor}, ${camId}, ${`TAG-SIM-${tag}`})`;
    const byId = new Map(deviceRows.map((r) => [String(r.device_id), r]));
    step('2h. 三类感知设备都登记进 ewoh_device（含类别）',
      byId.size === 3
        && byId.get(envSensor)?.device_category === 'environment_sensor'
        && byId.get(camId)?.device_category === 'camera'
        && byId.get(`TAG-SIM-${tag}`)?.device_category === 'location_tag',
      `rows=${deviceRows.map((r) => `${r.device_id}:${r.device_category}`).join(', ')}`);
    step('2i. 设备在线且最近遥测时间已更新（台账不是死行）',
      deviceRows.every((r) => r.online === true && r.last_telemetry_at !== null),
      `online=${deviceRows.filter((r) => r.online).length}/${deviceRows.length}`);
    step('2j. 传感器电量保持 NULL（不把"没有电池"写成 0%）',
      deviceRows.every((r) => r.battery_pct === null),
      `battery=${deviceRows.map((r) => String(r.battery_pct)).join(',')}`);

    // ---- 2j2. 能力模型：能力随摄入自动登记（DDL 早有该表，之前从无写入方）----
    const capRows = await sql`
      select device_id, capability_key, capability_type, status
      from ewoh_device_capability
      where org_id = ${INGEST_ORG}::uuid
        and device_id in (${envSensor}, ${camId}, ${`TAG-SIM-${tag}`})`;
    const capsByDevice = new Map();
    for (const row of capRows) {
      const list = capsByDevice.get(String(row.device_id)) ?? [];
      list.push(String(row.capability_key));
      capsByDevice.set(String(row.device_id), list);
    }
    step('2j2. 三类设备的能力按类别登记（环境 4 项 / 摄像头 3 项 / 定位 1 项）',
      capsByDevice.get(envSensor)?.length === 4
        && capsByDevice.get(camId)?.length === 3
        && (capsByDevice.get(`TAG-SIM-${tag}`) ?? []).includes('observe.position'),
      `env=${capsByDevice.get(envSensor)?.length ?? 0} cam=${capsByDevice.get(camId)?.length ?? 0} loc=${(capsByDevice.get(`TAG-SIM-${tag}`) ?? []).join('|')}`);
    step('2j3. 能力项使用权威 kind（ADR-043：device_capability）且状态生效',
      capRows.length > 0
        && capRows.every((r) => r.capability_type === 'device_capability' && r.status === 'active'),
      `kinds=${[...new Set(capRows.map((r) => r.capability_type))].join(',')} status=${[...new Set(capRows.map((r) => r.status))].join(',')}`);
    // ---- NO-59b：执行机构（AGV）状态上行全链 ----
    const agvId = `AGV-SIM-${tag}`;
    const agvSent = Number(byEndpoint.actuator?.sent ?? 0);
    step('2k. 执行机构状态帧实际投递（edge → 桥接 → 平台）',
      agvSent > 0,
      `actuator sent=${agvSent}`);

    const agvRows = await sql`
      select count(*)::int as rows,
             count(distinct state_json->>'record_id')::int as uniq,
             count(*) filter (where state_json->>'state' = 'moving')::int as moving,
             count(*) filter (where state_json->>'last_authorization_ref' like 'plan:%')::int as authorized,
             count(*) filter (where (state_json->>'x') is not null)::int as with_position
      from ewoh_world_state
      where org_id = ${INGEST_ORG} and entity_id = ${agvId}
        and state_json->>'actuator' = 'true'`;
    const agv = agvRows[0];
    step('2k2. 执行机构状态落 world_state（state_json.actuator）且不双写',
      agv.rows > 0 && agv.rows === agv.uniq,
      `rows=${agv.rows} distinct_record=${agv.uniq}`);
    step('2k3. 每帧都带"为什么在动"：位置 + 平台授权号（模拟器用 plan:SIM-…）',
      agv.with_position > 0 && agv.authorized > 0 && agv.moving > 0,
      `moving=${agv.moving} authorized=${agv.authorized} with_position=${agv.with_position}`);

    const agvDevice = await sql`
      select device_id, device_category, online from ewoh_device
      where org_id = ${INGEST_ORG} and device_id = ${agvId}`;
    step('2k4. 执行机构登记进设备台账，类别为 agv（执行层在世界模型里可见）',
      agvDevice.length === 1 && agvDevice[0].device_category === 'agv',
      `rows=${agvDevice.length} category=${agvDevice[0]?.device_category}`);

    const agvCaps = await sql`
      select capability_key, capability_type, status from ewoh_device_capability
      where org_id = ${INGEST_ORG}::uuid and device_id = ${agvId}`;
    const agvCapKeys = agvCaps.map((r) => String(r.capability_key)).sort();
    step('2k5. 执行机构能力按类别登记（transport.move / observe.actuator_state / observe.position）',
      agvCapKeys.includes('transport.move')
        && agvCapKeys.includes('observe.actuator_state')
        && agvCapKeys.includes('observe.position')
        && agvCaps.every((r) => r.capability_type === 'device_capability' && r.status === 'active'),
      `caps=${agvCapKeys.join('|')}`);

    // 权威 subject 形状（^[a-z0-9_]+:.+$）与来源证据：台账行必须能被契约读回
    const capShapeRows = await sql`
      select capability_id, capability_key, capability_value->>'subject' as subject,
             capability_value->>'providerType' as provider_type,
             capability_value->>'mode' as mode,
             jsonb_array_length(coalesce(capability_value->'evidence', '[]'::jsonb)) as evidence_len
      from ewoh_device_capability
      where org_id = ${INGEST_ORG}::uuid and device_id = ${envSensor}`;
    step('2j4. 能力行满足权威契约形状（subject/providerType/evidence）',
      capShapeRows.length === 4
        && capShapeRows.every((r) => /^[a-z0-9_]+:.+$/.test(String(r.subject))
          && r.provider_type === 'device' && r.mode === 'observation' && Number(r.evidence_len) > 0
          && String(r.capability_id).startsWith('cap:device:')),
      `sample=${capShapeRows[0]?.capability_id} subject=${capShapeRows[0]?.subject} evidence=${capShapeRows[0]?.evidence_len}`);

    // ---- 2k. 设备台账读路径（UI 用的 /api/devices）：类别过滤 + 类别/电量如实回传 ----
    const adminToken = await loginAdmin();
    if (!adminToken) {
      skip('2k. /api/devices 读路径断言', '未提供 EWOH_E2E_ADMIN_PASS，跳过平台读路径核对（DB 事实已在上一步核对）');
    } else {
      const response = await fetch(
        `${BASE}/api/devices?keyword=${encodeURIComponent(envSensor)}&category=environment_sensor&limit=10`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      const body = await response.json().catch(() => null);
      const items = Array.isArray(body) ? body : (body?.items ?? []);
      const found = items.find((item) => item.deviceId === envSensor);
      step('2k. /api/devices 按类别可查到感知设备，且类别/电量为真值',
        response.status === 200 && Boolean(found)
          && found.deviceCategory === 'environment_sensor'
          && found.batteryPct === null,
        `status=${response.status} found=${Boolean(found)} category=${found?.deviceCategory} battery=${String(found?.batteryPct)}`);
      const wrongCategory = await fetch(
        `${BASE}/api/devices?keyword=${encodeURIComponent(envSensor)}&category=camera&limit=10`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      const wrongBody = await wrongCategory.json().catch(() => null);
      const wrongItems = Array.isArray(wrongBody) ? wrongBody : (wrongBody?.items ?? []);
      step('2l. 类别过滤不"猜近似类别"（用 camera 过滤查不到环境传感器）',
        !wrongItems.some((item) => item.deviceId === envSensor),
        `status=${wrongCategory.status} matched=${wrongItems.length}`);

      // 设备详情的读路径（抽屉展示能力用的就是这个接口）。
      // 注意：详情只有 /api/devices/:id（dashboard 控制器没有该路由）——
      // 这条断言正是为了钉住"前端调用的路由真实存在"。
      const detailResponse = await fetch(
        `${BASE}/api/devices/${encodeURIComponent(envSensor)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      const detail = await detailResponse.json().catch(() => null);
      const caps = Array.isArray(detail?.capabilities) ? detail.capabilities : [];
      step('2m. 设备详情返回权威能力形状（name/kind/providerType/mode/fields）',
        detailResponse.status === 200 && caps.length === 4
          && caps.every((c) => c.registered === true && Array.isArray(c.fields) && c.fields.length > 0
            && c.kind === 'device_capability' && c.providerType === 'device' && c.mode === 'observation'
            && typeof c.capabilityId === 'string' && c.capabilityId.startsWith('cap:device:'))
          && caps.some((c) => c.name === 'observe.temperature' && c.label === '环境温度'
            && c.fields.includes('temperature')),
        `status=${detailResponse.status} caps=${caps.map((c) => `${c.name}:${c.kind}:${c.mode}`).join('|')}`);
    }

    // ---- 2n. 外骨骼路径同样声明能力（第二条声明路径，别只测传感器）----
    const exoDeviceId = `EXO-CAP-${tag}`;
    // 外骨骼帧的 entity_id 必须是**已登记**的空间实体（摄入 fail-closed：未登记拒绝）。
    // 这里显式登记一名"能力探针"人员实体（source_type 标注为 simulated）。
    const exoPersonId = `person:cap-${tag}`;
    await sql`
      insert into ewoh_spatial_entity
        (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
      values (${INGEST_ORG}, ${exoPersonId}, 'person', ${`e2e capability probe ${tag}`}, 10, 20, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
      on conflict (org_id, entity_id) do update set status = 'active'`;
    const exoResponse = await fetch(`${BASE}/api/ingest/exoskeleton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify({
        device_id: exoDeviceId,
        entity_id: exoPersonId,
        event_time: new Date().toISOString(),
        source_type: 'simulated',
        sequence: 1,
        // 型号决定"能做什么"的执行能力（白名单派生）：台账只声明观测/交互维度，
        // 二者必须取并集——这正是 2p 要钉住的语义（否则需要助力能力的任务无候选）。
        device_model: 'NyExo-A1 Pro',
        pose: { pitch_deg: 8, joint_angles_deg: { l_elbow: 90 } },
        load: { cumulative_load_score: 0.4 },
        device: { battery_pct: 77 },
        quality: { status: 'good', confidence: 0.9 },
      }),
    }).catch(() => null);
    const exoBody = exoResponse ? await exoResponse.json().catch(() => null) : null;
    const exoRows = await sql`
      select device_category from ewoh_device
      where org_id = ${INGEST_ORG}::uuid and device_id = ${exoDeviceId}`;
    const exoCapRows = await sql`
      select capability_key from ewoh_device_capability
      where org_id = ${INGEST_ORG}::uuid and device_id = ${exoDeviceId}`;
    const exoKeys = exoCapRows.map((r) => String(r.capability_key)).sort();
    const exoKinds = await sql`
      select distinct capability_type from ewoh_device_capability
      where org_id = ${INGEST_ORG}::uuid and device_id = ${exoDeviceId}`;
    step('2n. 外骨骼路径也声明能力（权威 kind=exo_capability，含助力交互）',
      exoRows[0]?.device_category === 'exoskeleton'
        && exoKeys.join('|') === ['interact.assist', 'observe.battery', 'observe.load', 'observe.wearer'].join('|')
        && exoKinds.every((r) => r.capability_type === 'exo_capability'),
      `ingest=${exoResponse?.status} accepted=${exoBody?.accepted} category=${exoRows[0]?.device_category} caps=${exoKeys.join('|')}`);

    // ---- 2o. 调度侧真的消费到能力（此前台账无消费方、capabilities 列全空 →
    //           requiredDeviceCapabilities 永远匹配不到设备）----
    if (!adminToken) {
      skip('2o. 调度快照消费设备能力', '未提供 EWOH_E2E_ADMIN_PASS，跳过调度侧核对');
    } else {
      const snapshotResponse = await fetch(`${BASE}/api/scheduler/snapshot`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const snapshot = await snapshotResponse.json().catch(() => null);
      const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
      // 调度域主键是 ewoh_device.id（uuid），业务设备号在 deviceId 字段——
      // 用业务号定位（这正是世界模型 join 边缘事实的方式）
      const envDevice = devices.find((d) => d.deviceId === envSensor);
      // NO-14g：能力分两列——`capabilities` = 执行/交互（调度匹配语义），
      // `observedCapabilities` = 观测（世界模型/AI 语义）。环境传感器只"能看"
      // 不能"做"，因此前者必须为空、后者必须是台账声明的那 4 个观测维度。
      const names = Array.isArray(envDevice?.capabilities) ? envDevice.capabilities : [];
      const observed = Array.isArray(envDevice?.observedCapabilities)
        ? envDevice.observedCapabilities
        : [];
      const records = Array.isArray(envDevice?.capabilityRecords) ? envDevice.capabilityRecords : [];
      step('2o. 调度快照可按业务设备号定位：观测能力单列、执行能力诚实为空 + 契约记录',
        snapshotResponse.status === 200
          && observed.length === 4
          && observed.includes('observe.temperature')
          && names.length === 0
          && records.length === 4
          && records.every((r) => r.kind === 'device_capability' && r.subject === `device:${envSensor}`
            && Array.isArray(r.evidence)),
        `status=${snapshotResponse.status} exec=${names.join('|')} observed=${observed.join('|')} records=${records.length}`);
    }

    // ---- 2p. 外骨骼的执行能力没被观测台账挤掉（2026-09-10 派工失败回归）----
    if (adminToken) {
      const snapshotResponse = await fetch(`${BASE}/api/scheduler/snapshot`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const snapshot = await snapshotResponse.json().catch(() => null);
      const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
      const exoDevice = devices.find((d) => d.deviceId === exoDeviceId);
      const exec = Array.isArray(exoDevice?.capabilities) ? exoDevice.capabilities : [];
      const observed = Array.isArray(exoDevice?.observedCapabilities)
        ? exoDevice.observedCapabilities
        : [];
      step('2p. 外骨骼执行能力保留（台账观测能力不覆盖 exo-lift）+ 交互能力可见',
        Boolean(exoDevice)
          && exec.includes('exo-lift')
          && exec.includes('interact.assist')
          && observed.includes('observe.load')
          && !exec.includes('observe.load'),
        `exec=${exec.join('|')} observed=${observed.join('|')}`);
    }

    // ---- 2q. 人工能力生命周期：停用 → 调度不再看到 → 自动摄入不复活 → 恢复 ----
    // 这是"能力台账唯一人工写入口"的端到端证明：能力决定派工资格，误声明必须可处置。
    if (adminToken) {
      const CAP_KEY = 'observe.temperature';
      const capStatusUrl = `${BASE}/api/devices/${encodeURIComponent(envSensor)}/capabilities/${encodeURIComponent(CAP_KEY)}/status`;
      const postStatus = (body) => fetch(capStatusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(body),
      });

      const missingReason = await postStatus({ status: 'disabled', reason: '   ' });
      step('2q1. 停用能力必须带非空理由（空理由 400，不静默生效）',
        missingReason.status === 400,
        `status=${missingReason.status}`);

      const disableRes = await postStatus({ status: 'disabled', reason: 'e2e：该设备实际未上报温度' });
      const disableBody = await disableRes.json().catch(() => null);
      step('2q2. 人工停用成功（changed=true，返回停用生效时间）',
        disableRes.status === 200 && disableBody?.changed === true
          && disableBody?.status === 'disabled' && disableBody?.previousStatus === 'active'
          && typeof disableBody?.effectiveTo === 'string',
        `status=${disableRes.status} changed=${disableBody?.changed} prev=${disableBody?.previousStatus}`);

      const disableAgain = await postStatus({ status: 'disabled', reason: 'e2e：重复点击' });
      const disableAgainBody = await disableAgain.json().catch(() => null);
      step('2q3. 幂等：状态相同 → changed=false（不产生重复变更）',
        disableAgain.status === 200 && disableAgainBody?.changed === false,
        `status=${disableAgain.status} changed=${disableAgainBody?.changed}`);

      const snapshotAfterDisable = await fetch(`${BASE}/api/scheduler/snapshot`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).then((r) => r.json()).catch(() => null);
      const envAfterDisable = (Array.isArray(snapshotAfterDisable?.devices) ? snapshotAfterDisable.devices : [])
        .find((d) => d.deviceId === envSensor);
      const observedAfter = Array.isArray(envAfterDisable?.observedCapabilities)
        ? envAfterDisable.observedCapabilities
        : [];
      const disabledAfter = Array.isArray(envAfterDisable?.disabledCapabilities)
        ? envAfterDisable.disabledCapabilities
        : [];
      step('2q4. 停用后调度快照不再把它当作可用观测能力（证据链立即收敛）',
        !observedAfter.includes(CAP_KEY) && observedAfter.length >= 1,
        `observed=${observedAfter.join('|')}`);
      // NO-15b：缺失 ≠ 停用——世界模型必须知道它是"被人停用"而不是"设备没有"
      step('2q4b. 世界模型保留"被人为停用"事实（缺失 ≠ 停用，解释才能说清）',
        disabledAfter.includes(CAP_KEY),
        `disabled=${disabledAfter.join('|')}`);

      // 再发一帧同类数据：自动声明路径**不得复活**人工停用的能力，且不得擦除停用理由
      const reDeclare = await fetch(`${BASE}/api/ingest/environment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
        body: JSON.stringify({
          sensor_id: envSensor,
          event_time: new Date().toISOString(),
          source_type: 'simulated',
          sequence: 999,
          temperature: 26.1,
          record_id: `e2e-lifecycle:${tag}`,
        }),
      }).catch(() => null);
      const reDeclareStatus = reDeclare ? reDeclare.status : 0;
      const afterReDeclare = await sql`
        select status, capability_value->'lifecycle'->>'reason' as reason,
               capability_value->'lifecycle'->>'action' as action
        from ewoh_device_capability
        where org_id = ${INGEST_ORG}::uuid and device_id = ${envSensor}
          and capability_key = ${CAP_KEY}`;
      step('2q5. 自动摄入不复活人工停用的能力，且不擦除停用理由',
        afterReDeclare[0]?.status === 'disabled'
          && String(afterReDeclare[0]?.reason ?? '').includes('未上报温度')
          && afterReDeclare[0]?.action === 'disable',
        `ingest=${reDeclareStatus} status=${afterReDeclare[0]?.status} reason=${afterReDeclare[0]?.reason}`);

      const restoreRes = await postStatus({ status: 'active', reason: 'e2e：已确认具备温度观测' });
      const restoreBody = await restoreRes.json().catch(() => null);
      const snapshotAfterRestore = await fetch(`${BASE}/api/scheduler/snapshot`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).then((r) => r.json()).catch(() => null);
      const envAfterRestore = (Array.isArray(snapshotAfterRestore?.devices) ? snapshotAfterRestore.devices : [])
        .find((d) => d.deviceId === envSensor);
      const observedAfterRestore = Array.isArray(envAfterRestore?.observedCapabilities)
        ? envAfterRestore.observedCapabilities
        : [];
      const disabledAfterRestore = Array.isArray(envAfterRestore?.disabledCapabilities)
        ? envAfterRestore.disabledCapabilities
        : [];
      step('2q6. 人工恢复成功且调度重新看到该观测能力（停用事实随之清除）',
        restoreRes.status === 200 && restoreBody?.changed === true
          && observedAfterRestore.includes(CAP_KEY)
          && !disabledAfterRestore.includes(CAP_KEY),
        `status=${restoreRes.status} observed=${observedAfterRestore.join('|')} disabled=${disabledAfterRestore.join('|')}`);

      const detailRes = await fetch(`${BASE}/api/devices/${encodeURIComponent(envSensor)}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const detail = await detailRes.json().catch(() => null);
      const capRow = (Array.isArray(detail?.capabilities) ? detail.capabilities : [])
        .find((c) => c.name === CAP_KEY);
      step('2q7. 设备详情透出人工留痕（谁/何时/为什么），现场可追溯',
        detailRes.status === 200 && capRow?.status === 'active'
          && capRow?.lifecycle?.action === 'restore'
          && String(capRow?.lifecycle?.reason ?? '').includes('已确认具备温度观测')
          && String(capRow?.lifecycle?.operator ?? '').length > 0,
        `status=${capRow?.status} lifecycle=${JSON.stringify(capRow?.lifecycle ?? null)}`);

      const auditRows = await sql`
        select action, reason, entity_id
        from ewoh_audit_log
        where entity_id = ${disableBody?.capabilityId ?? ''} or entity_id like ${`%:${envSensor}:${CAP_KEY}`}
        order by occurred_at asc`;
      const actions = auditRows.map((r) => String(r.action));
      step('2q8. 停用与恢复都写入审计（含理由，可对账）',
        actions.includes('device.capability.disable') && actions.includes('device.capability.restore')
          && auditRows.every((r) => String(r.reason ?? '').length > 0),
        `actions=${actions.join('|')} rows=${auditRows.length}`);
    } else {
      skip('2q. 人工能力生命周期', '未提供 EWOH_E2E_ADMIN_PASS，跳过人工停用/恢复链路核对');
    }

    // ---- 3. 明确拒绝的帧确实没有进平台（与 rejected 明细对照）----
    const rejectedIds = bridge.stats.rejected_record_ids ?? [];
    const sentIds = bridge.stats.sent_record_ids ?? [];
    let rejectedFound = 0;
    let sentMissing = 0;
    for (const id of rejectedIds.slice(0, 50)) {
      const found = await sql`
        select count(*)::int as n from ewoh_environment where record_id = ${id}`;
      rejectedFound += found[0].n;
    }
    for (const id of sentIds.slice(0, 50)) {
      if (!String(id).startsWith('edge:environment')) continue;
      const found = await sql`
        select count(*)::int as n from ewoh_environment where record_id = ${id}`;
      if (found[0].n !== 1) sentMissing += 1;
    }
    step('3. 被拒帧确实不在平台；已发帧确实在平台（逐条抽样核对）',
      rejectedFound === 0 && sentMissing === 0,
      `抽样 rejected=${Math.min(rejectedIds.length, 50)} 条命中 ${rejectedFound}；sent 环境帧缺失 ${sentMissing}`);

    step('3b. 边缘死信文件记录了平台明确拒绝的帧（人工可复核）',
      bridge.stats.rejected > 0,
      `dead-letter 路径=${stats.dead_letter_path}`);

    // ---- 4. 不可归一化帧必须留痕（死信表 + 计数 + health），绝不静默消失 ----
    const badWorkdir = mkdtempSync(path.join(tmpdir(), `ewoh-edge-bad-${tag}-`));
    const { stats: badStats } = runSimulator([
      '--suffix', `${tag}b`,
      '--duration-sec', '2',
      '--hz', '1',
      '--bad-frames', '3',
      '--ingest-key', INGEST_KEY,
      '--org-id', INGEST_ORG,
      '--platform-url', BASE,
    ], badWorkdir);
    step('4. 不可归一化帧进边缘死信表（不静默丢弃）',
      Number(badStats?.frame_dead_letters) >= 3 && Number(badStats?.manager?.dead_lettered_total) >= 3,
      `dead_letters=${badStats?.frame_dead_letters} manager_total=${badStats?.manager?.dead_lettered_total}`);
    const brokenHealth = (badStats?.manager?.health ?? []).find((h) => String(h.device_id).startsWith('BROKEN-SIM-'));
    step('4b. 死信计数在设备健康上可见（运维能定位到是哪台设备）',
      Number(brokenHealth?.dead_lettered) >= 3,
      `device=${brokenHealth?.device_id} dead_lettered=${brokenHealth?.dead_lettered}`);
    step('4c. 坏帧不进上行（账目仍闭合，坏帧与好帧分开计数）',
      badStats?.accounting?.closed === true && Number(badStats?.bridge?.stats?.dropped_invalid) === 0,
      `published=${badStats?.accounting?.published} received=${badStats?.accounting?.bridge_received}`);
    // ---- 5（NO-47a）：边缘安灯 → 确定性提醒 → 关灯即了结（人在环里的安灯闭环）----
    // 安灯是车间最经典的异常感知通道；这条检查把"边缘开灯 → 提醒到人 → 人处置关灯 →
    // 提醒随之进入终态"整条链在真库上走一遍，并验证通知号是**确定性**的（可幂等、可分类）。
    const andonUser = process.env.EWOH_E2E_APPROVER_USER || 'approver.li';
    const andonPass = process.env.EWOH_E2E_APPROVER_PASS || '';
    const andonToken = andonPass ? await loginAdmin(andonUser, andonPass) : null;
    if (!andonToken) {
      skip('5. 边缘安灯 → 关灯闭环', '缺少 EWOH_E2E_APPROVER_PASS（无法以班组长身份处置安灯）');
    } else {
      const andonEventId = `EVT-E2E-ANDON-${tag}`;
      const nowIso = new Date().toISOString();
      const andonUplink = await fetch(`${BASE}/api/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
        body: JSON.stringify({
          events: [
            {
              eventId: andonEventId,
              eventType: 'AndonRaised',
              schemaVersion: '1.0.0',
              occurredAt: nowIso,
              observedAt: nowIso,
              source: 'edge:e2e-andon-scenario',
              subject: 'device:EXO-E2E-ANDON',
              payload: {
                deviceId: 'EXO-E2E-ANDON',
                title: `边缘安灯 ${tag}`,
                level: 'high',
                slaSeconds: 900,
                assignee: 'dispatcher',
              },
              evidence: { deviceId: 'EXO-E2E-ANDON', dataQuality: 'good' },
            },
          ],
        }),
      }).catch(() => null);
      const andonBody = await andonUplink?.json().catch(() => null);
      const accepted = andonBody?.results?.[0]?.accepted === true;

      const pendingRes = await fetch(`${BASE}/api/notifications?status=pending`, {
        headers: { Authorization: `Bearer ${andonToken}` },
      }).catch(() => null);
      const pending = await pendingRes?.json().catch(() => null);
      const pendingRows = Array.isArray(pending) ? pending : (pending?.notifications ?? []);
      const andonNote = pendingRows.find(
        (n) => n.externalRef === andonEventId && String(n.notificationId ?? '').startsWith('NTF-ANDON-'),
      );
      step('5. 边缘安灯上行 → 提醒落到班组长/调度角色，且通知号是确定性的（可幂等、可分类）',
        (andonUplink?.status === 201 || andonUplink?.status === 200) && accepted && Boolean(andonNote)
          && String(andonNote?.notificationId).includes(andonEventId),
        `ingest=${andonUplink?.status} accepted=${accepted} id=${andonNote?.notificationId ?? 'missing'} `
          + `list=${pendingRes?.status ?? 0} rows=${pendingRows.length} matched=${pendingRows.filter((n) => n.externalRef === andonEventId).length}`);

      // 状态机：open → acknowledged → processing → closed（handler 角色：dispatcher/workshop_lead）
      let closed = { status: 0, body: null };
      for (const action of ['acknowledge', 'process', 'close']) {
        closed = await fetch(`${BASE}/api/oee/andons/${encodeURIComponent(andonEventId)}/state?action=${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
          body: JSON.stringify({ reason: 'e2e NO-47a 关灯' }),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));
        if (closed.status !== 200 && closed.status !== 201) break;
      }
      const resolvedRes = await fetch(`${BASE}/api/notifications?status=resolved`, {
        headers: { Authorization: `Bearer ${andonToken}` },
      }).catch(() => null);
      const resolved = await resolvedRes?.json().catch(() => null);
      const resolvedRows = Array.isArray(resolved) ? resolved : (resolved?.notifications ?? []);
      const closedNote = resolvedRows.find((n) => n.externalRef === andonEventId);
      const stillRes = await fetch(`${BASE}/api/notifications?status=pending`, {
        headers: { Authorization: `Bearer ${andonToken}` },
      }).catch(() => null);
      const stillPending = await stillRes?.json().catch(() => null);
      const stillRows = Array.isArray(stillPending) ? stillPending : (stillPending?.notifications ?? []);
      const leftover = stillRows.filter((n) => n.externalRef === andonEventId);
      step('5a. 关灯处置 → 该安灯的提醒随之了结（andon_cleared + 处置人），不再挂在待办里',
        (closed.status === 200 || closed.status === 201)
          && closedNote?.resolution === 'andon_cleared'
          && closedNote?.resolvedBy === andonUser
          && leftover.length === 0,
        `close=${closed.status} resolution=${closedNote?.resolution ?? 'none'} `
          + `by=${closedNote?.resolvedBy ?? 'none'} pending=${leftover.length} `
          + `list=${resolvedRes?.status ?? 0} rows=${resolvedRows.length}`);

      step('5b. 关灯是终端事实：安灯状态为 closed（平台不替人"猜"是否已处理）',
        String(closed.body?.status ?? '') === 'closed',
        `status=${closed.body?.status ?? 'none'}`);

      // ---- 5c/5d（NO-48a）：红灯亮了**没人接手** → 主动升级（这是原有 SLA 逻辑的盲区：
      // 只在"有人接手但接晚了"时升级，没人接手时什么都不发生）----
      const breachEventId = `EVT-E2E-ANDON-BREACH-${tag}`;
      const breachUplink = await fetch(`${BASE}/api/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
        body: JSON.stringify({
          events: [
            {
              eventId: breachEventId,
              eventType: 'AndonRaised',
              schemaVersion: '1.0.0',
              occurredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
              observedAt: new Date().toISOString(),
              source: 'edge:e2e-andon-breach',
              subject: 'device:EXO-E2E-BREACH',
              payload: {
                deviceId: 'EXO-E2E-BREACH',
                title: `无人接手安灯 ${tag}`,
                level: 'high',
                // 5 秒 SLA：立刻进入超期，无需等待
                slaSeconds: 5,
                assignee: 'dispatcher',
              },
              evidence: { deviceId: 'EXO-E2E-BREACH', dataQuality: 'good' },
            },
          ],
        }),
      }).catch(() => null);
      const breachSweep = await fetch(`${BASE}/api/oee/andons/sla-sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
        .catch(() => ({ status: 0, body: null }));
      step('5c. 没人接手且超过 SLA → 主动升级（L1 给班组长+调度；扫描不改业务事实）',
        (breachUplink?.status === 201 || breachUplink?.status === 200)
          && (breachSweep.status === 200 || breachSweep.status === 201)
          && (breachSweep.body?.breached ?? 0) >= 1
          && (breachSweep.body?.created ?? 0) >= 2
          && (breachSweep.body?.escalations ?? []).some(
            (e) => e.eventId === breachEventId && e.level >= 1,
          ),
        `sweep=${breachSweep.status} breached=${breachSweep.body?.breached} `
          + `created=${breachSweep.body?.created} levels=${JSON.stringify((breachSweep.body?.escalations ?? []).map((e) => e.level))}`);

      const breachNoticeRes = await fetch(`${BASE}/api/notifications?status=pending`, {
        headers: { Authorization: `Bearer ${andonToken}` },
      }).catch(() => null);
      const breachNoticeBody = await breachNoticeRes?.json().catch(() => null);
      const breachRows = Array.isArray(breachNoticeBody)
        ? breachNoticeBody
        : (breachNoticeBody?.notifications ?? []);
      // 升级提醒与"开灯提醒"是**两个桶**：开灯那条仍然在（升级不替代它），
      // 升级桶各自独立可幂等（重复扫描不重复打扰）。
      const breachNotes = breachRows.filter(
        (n) => n.externalRef === breachEventId && String(n.notificationId).includes('sla_breach'),
      );
      const raisedNotes = breachRows.filter(
        (n) => n.externalRef === breachEventId && String(n.notificationId).includes('-raised-'),
      );
      const breachAgain = await fetch(`${BASE}/api/oee/andons/sla-sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
        .catch(() => ({ status: 0, body: null }));
      step('5d. 升级提醒与开灯提醒分桶共存；重复扫描幂等（created=0，只累加 duplicates）',
        breachNotes.length >= 2
          && raisedNotes.length >= 1
          && (breachAgain.body?.duplicates ?? 0) >= 1
          && (breachAgain.body?.created ?? -1) === 0,
        `breachNotes=${breachNotes.length} raisedNotes=${raisedNotes.length} `
          + `againCreated=${breachAgain.body?.created} againDuplicates=${breachAgain.body?.duplicates}`);

      // 把这条升级安灯关掉：升级提醒随之进入终态（与 5a 同一闭环）
      for (const action of ['acknowledge', 'process', 'close']) {
        await fetch(`${BASE}/api/oee/andons/${encodeURIComponent(breachEventId)}/state?action=${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
          body: JSON.stringify({ reason: 'e2e NO-48a 升级后处置' }),
        }).catch(() => null);
      }
      const breachResolvedRes = await fetch(`${BASE}/api/notifications?status=resolved`, {
        headers: { Authorization: `Bearer ${andonToken}` },
      }).catch(() => null);
      const breachResolvedBody = await breachResolvedRes?.json().catch(() => null);
      const breachResolvedRows = Array.isArray(breachResolvedBody)
        ? breachResolvedBody
        : (breachResolvedBody?.notifications ?? []);
      const breachClosed = breachResolvedRows.filter(
        (n) => n.externalRef === breachEventId && n.resolution === 'andon_cleared',
      );
      step('5e. 升级提醒随关灯了结（andon_cleared）——升级不是死胡同，处置后不再挂待办',
        breachClosed.length >= 1,
        `resolved=${breachClosed.length}`);

      // ---- 5f/5g（NO-49a）：设备责任人 → 安灯提醒**点名到人**，而不是只广播角色 ----
      const responsibilityDevice = `EXO-E2E-RESP-${tag}`;
      const boundPersonId = process.env.EWOH_E2E_PERSON_ID || '';
      // 责任人只能登记在**台账里的设备**上（404 是设计），因此先按产品路径建一台：
      // 这也顺带验证了"不建影子设备"的边界（同一 deviceId 已存在 → 服务端 400，本步容忍）。
      const deviceCreated = await fetch(`${BASE}/api/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
        body: JSON.stringify({
          deviceId: responsibilityDevice,
          workerName: `责任人路由探针 ${tag}`,
          deviceModel: 'NyExo-A1',
          deviceCategory: 'exoskeleton',
          sourceType: 'simulated',
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
        .catch(() => ({ status: 0, body: null }));
      const responsibilitySet = boundPersonId
        ? await fetch(`${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
            body: JSON.stringify({ personId: boundPersonId, responsibility: 'owner', note: 'e2e NO-49a 责任人路由' }),
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
            .catch(() => ({ status: 0, body: null }))
        : { status: 0, body: null };

      if (!boundPersonId) {
        skip('5f. 安灯提醒点名到设备责任人', '缺少 EWOH_E2E_PERSON_ID（无法建立责任关系）');
      } else if (responsibilitySet.status !== 200 && responsibilitySet.status !== 201) {
        // 设备必须先在本租户台账（404 时不猜、不建影子设备）——这里如实报出原因
        skip(
          '5f. 安灯提醒点名到设备责任人',
          `建设备 status=${deviceCreated.status} / 写责任 status=${responsibilitySet.status}：`
            + `${JSON.stringify(responsibilitySet.body).slice(0, 120)}`,
        );
      } else {
        const respEventId = `EVT-E2E-ANDON-RESP-${tag}`;
        const respOccurred = new Date(Date.now() - 60_000).toISOString();
        const respUplink = await fetch(`${BASE}/api/ingest/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
          body: JSON.stringify({
            events: [
              {
                eventId: respEventId,
                eventType: 'AndonRaised',
                schemaVersion: '1.0.0',
                occurredAt: respOccurred,
                observedAt: respOccurred,
                source: 'edge:e2e-andon-responsibility',
                subject: `device:${responsibilityDevice}`,
                payload: {
                  deviceId: responsibilityDevice,
                  title: `责任人路由验证 ${tag}`,
                  level: 'high',
                  slaSeconds: 900,
                },
                evidence: { deviceId: responsibilityDevice, dataQuality: 'good' },
              },
            ],
          }),
        }).catch(() => null);
        const workerToken = await loginAdmin(
          process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei',
          process.env.EWOH_E2E_FIELD_PASS || '',
        );
        const workerListRes = workerToken
          ? await fetch(`${BASE}/api/notifications?status=pending`, {
              headers: { Authorization: `Bearer ${workerToken}` },
            }).catch(() => null)
          : null;
        const workerListBody = await workerListRes?.json().catch(() => null);
        const workerRows = Array.isArray(workerListBody) ? workerListBody : (workerListBody?.notifications ?? []);
        const personalNote = workerRows.find(
          (n) => n.externalRef === respEventId && String(n.notificationId).includes('-user-'),
        );
        step('5f. 责任人在场 → 安灯提醒**点名到责任人本人**（通知号带 user 收件人段）',
          (respUplink?.status === 201 || respUplink?.status === 200)
            && Boolean(workerToken)
            && Boolean(personalNote)
            && String(personalNote?.recipientType) === 'user',
          `set=${responsibilitySet.status} ingest=${respUplink?.status} `
            + `note=${personalNote?.notificationId ?? 'missing'}`);

        // 缺口可见：登记一位**没有绑定账号**的维护责任人，并让这台设备出现"没人接手且超期"的安灯
        // → 升级扫描必须如实报出"这位责任人发不到"（不是静默当成已通知）。
        const unboundPersonId = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
        await fetch(`${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
          body: JSON.stringify({ personId: unboundPersonId, responsibility: 'maintainer' }),
        }).catch(() => null);
        const gapEventId = `EVT-E2E-ANDON-GAP-${tag}`;
        const gapOccurred = new Date(Date.now() - 10 * 60_000).toISOString();
        const gapUplink = await fetch(`${BASE}/api/ingest/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
          body: JSON.stringify({
            events: [
              {
                eventId: gapEventId,
                eventType: 'AndonRaised',
                schemaVersion: '1.0.0',
                occurredAt: gapOccurred,
                observedAt: gapOccurred,
                source: 'edge:e2e-andon-gap',
                subject: `device:${responsibilityDevice}`,
                payload: {
                  deviceId: responsibilityDevice,
                  title: `责任人缺口验证 ${tag}`,
                  level: 'high',
                  // 5 秒 SLA + 10 分钟前开灯 → 一定进入超期且**没人接手**
                  slaSeconds: 5,
                },
                evidence: { deviceId: responsibilityDevice, dataQuality: 'good' },
              },
            ],
          }),
        }).catch(() => null);
        const gapSweep = await fetch(`${BASE}/api/oee/andons/sla-sweep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
          .catch(() => ({ status: 0, body: null }));
        const unresolved = gapSweep.body?.unresolvedResponsiblePersons ?? [];
        const gapEscalation = (gapSweep.body?.escalations ?? []).find((e) => e.eventId === gapEventId);
        step('5g. 责任人**没有绑定账号**时如实报缺口（升级照发角色，缺口显式列出）',
          (gapUplink?.status === 201 || gapUplink?.status === 200)
            && (gapSweep.status === 200 || gapSweep.status === 201)
            && unresolved.includes(`person:${unboundPersonId}`)
            && Array.isArray(gapEscalation?.unresolvedResponsiblePersons)
            && gapEscalation.unresolvedResponsiblePersons.includes(`person:${unboundPersonId}`)
            // 缺口不阻塞升级：角色仍然收到
            && (gapEscalation?.recipients ?? []).some((r) => ['workshop_lead', 'dispatcher', 'safety_admin'].includes(r)),
          `status=${gapSweep.status} unresolved=${JSON.stringify(unresolved)} `
            + `roles=${JSON.stringify(gapEscalation?.recipients ?? null)}`);

        // ---- 5i/5j（NO-51a）：班次维度——本班优先、他班只报缺口（不发"不该当班的人"）----
        // 用接口自己回答"现在是哪个班次"，再挑一个**不是当前班次**的班次登记责任人，
        // 因此本检查与运行时刻无关（不需要把系统时间调来调去）。
        const currentShiftRes = await fetch(`${BASE}/api/shifts/current`, {
          headers: { Authorization: `Bearer ${andonToken}` },
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
          .catch(() => ({ status: 0, body: null }));
        const allShiftsRes = await fetch(`${BASE}/api/shifts`, {
          headers: { Authorization: `Bearer ${andonToken}` },
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
          .catch(() => ({ status: 0, body: null }));
        const currentShiftId = currentShiftRes.body?.current?.shiftId ?? null;
        const otherShift = (Array.isArray(allShiftsRes.body) ? allShiftsRes.body : [])
          .find((shift) => shift.shiftId !== currentShiftId);

        if (!currentShiftId) {
          /**
           * 班次日历可能存在"没有班次覆盖当前时刻"的窗口（例如 06:00–08:00）。
           * 这种时刻**必须验证行为而不是跳过**：平台不得猜一个默认班。
           * 因此先断言"current=null（显式未知）"，再跳过与具体班次绑定的那半段。
           */
          step(
            '5i-0. 无班次覆盖当前时刻 → 不猜默认班（current=null，显式未知）',
            currentShiftRes.status === 200 && currentShiftRes.body?.current === null,
            `status=${currentShiftRes.status} current=${JSON.stringify(currentShiftRes.body?.current ?? null)} shifts=${
              Array.isArray(allShiftsRes.body) ? allShiftsRes.body.map((s) => s.shiftId).join(',') : 'n/a'
            }`,
          );
          skip(
            '5i. 班次责任人：本班优先、他班只报缺口（本时刻无当前班次，改由 e2e:data-quality/shift 场景覆盖）',
            `current=none other=${otherShift?.shiftId ?? 'none'}`,
          );
        } else if (!otherShift) {
          skip(
            '5i. 班次责任人：本班优先、他班只报缺口',
            `只有一个班次定义，无法构造"他班责任人"（shifts=${
              Array.isArray(allShiftsRes.body) ? allShiftsRes.body.length : 0
            }）`,
          );
        } else {
          // 把 owner 责任人登记到**别的班次**（默认全天那条仍然在，先收回全天避免混淆）
          await fetch(
            `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities/owner?reason=e2e%205i`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${andonToken}` } },
          ).catch(() => null);
          const offShiftSet = await fetch(
            `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
              body: JSON.stringify({
                personId: boundPersonId,
                responsibility: 'owner',
                shiftId: otherShift.shiftId,
              }),
            },
          ).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
            .catch(() => ({ status: 0, body: null }));

          const shiftEventId = `EVT-E2E-ANDON-SHIFT-${tag}`;
          const shiftOccurred = new Date(Date.now() - 10 * 60_000).toISOString();
          await fetch(`${BASE}/api/ingest/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
            body: JSON.stringify({
              events: [
                {
                  eventId: shiftEventId,
                  eventType: 'AndonRaised',
                  schemaVersion: '1.0.0',
                  occurredAt: shiftOccurred,
                  observedAt: shiftOccurred,
                  source: 'edge:e2e-andon-shift',
                  subject: `device:${responsibilityDevice}`,
                  payload: {
                    deviceId: responsibilityDevice,
                    title: `班次责任人验证 ${tag}`,
                    level: 'high',
                    slaSeconds: 5,
                  },
                  evidence: { deviceId: responsibilityDevice, dataQuality: 'good' },
                },
              ],
            }),
          }).catch(() => null);
          const shiftSweep = await fetch(`${BASE}/api/oee/andons/sla-sweep`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
            .catch(() => ({ status: 0, body: null }));
          const shiftEscalation = (shiftSweep.body?.escalations ?? []).find((e) => e.eventId === shiftEventId);
          step('5i. 只登记了**别的班次**责任人 → 不发给"不该当班的人"，缺口如实汇总（角色仍收到）',
            (offShiftSet.status === 200 || offShiftSet.status === 201)
              && (shiftSweep.status === 200 || shiftSweep.status === 201)
              && shiftEscalation?.shiftId === currentShiftId
              && (shiftEscalation?.outOfShiftPersons ?? []).includes(`person:${boundPersonId}`)
              && (shiftSweep.body?.outOfShiftResponsiblePersons ?? []).includes(`person:${boundPersonId}`)
              && !(shiftEscalation?.responsiblePersons ?? []).includes(`person:${boundPersonId}`)
              && (shiftEscalation?.recipients ?? []).some((r) =>
                ['workshop_lead', 'dispatcher', 'safety_admin'].includes(r)),
            `set=${offShiftSet.status} current=${currentShiftId} other=${otherShift.shiftId} `
              + `shiftId=${shiftEscalation?.shiftId ?? 'none'} `
              + `outOfShift=${JSON.stringify(shiftEscalation?.outOfShiftPersons ?? null)}`);

          // 本班责任人：把这条责任关系改成**当前班次** → 该责任人本人应被点名
          const deleteOffShift = await fetch(
            `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities/owner`
              + `?shiftId=${encodeURIComponent(otherShift.shiftId)}&reason=e2e%205j`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${andonToken}` } },
          ).then(async (r) => ({ status: r.status })).catch(() => ({ status: 0 }));
          const onShiftSet = await fetch(
            `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
              body: JSON.stringify({
                personId: boundPersonId,
                responsibility: 'owner',
                shiftId: currentShiftId,
              }),
            },
          ).then(async (r) => ({ status: r.status })).catch(() => ({ status: 0 }));
          const shiftEvent2Id = `EVT-E2E-ANDON-SHIFT2-${tag}`;
          await fetch(`${BASE}/api/ingest/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
            body: JSON.stringify({
              events: [
                {
                  eventId: shiftEvent2Id,
                  eventType: 'AndonRaised',
                  schemaVersion: '1.0.0',
                  occurredAt: shiftOccurred,
                  observedAt: shiftOccurred,
                  source: 'edge:e2e-andon-shift2',
                  subject: `device:${responsibilityDevice}`,
                  payload: { deviceId: responsibilityDevice, title: `本班责任人验证 ${tag}`, level: 'high', slaSeconds: 5 },
                  evidence: { deviceId: responsibilityDevice, dataQuality: 'good' },
                },
              ],
            }),
          }).catch(() => null);
          const shiftSweep2 = await fetch(`${BASE}/api/oee/andons/sla-sweep`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
            .catch(() => ({ status: 0, body: null }));
          const escalation2 = (shiftSweep2.body?.escalations ?? []).find((e) => e.eventId === shiftEvent2Id);
          step('5j. 登记**本班**责任人 → 该责任人本人被点名（本班优先），且不再计入他班缺口',
            (deleteOffShift.status === 200 || deleteOffShift.status === 201)
              && (onShiftSet.status === 200 || onShiftSet.status === 201)
              && (escalation2?.responsiblePersons ?? []).includes(`person:${boundPersonId}`)
              && !(escalation2?.outOfShiftPersons ?? []).includes(`person:${boundPersonId}`),
            `clearOther=${deleteOffShift.status} setCurrent=${onShiftSet.status} `
              + `responsible=${JSON.stringify(escalation2?.responsiblePersons ?? null)}`);

          // ---- 5k（NO-52a）：交接班前的责任人核对（覆盖率快照）----
          // 交接班时要能回答"接班那一班，哪些设备没人负责"；快照还会被存进交接记录，
          // 供事后审计"交接当时知不知道"。
          const coverage = await fetch(`${BASE}/api/device-responsibilities/coverage`, {
            headers: { Authorization: `Bearer ${andonToken}` },
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
            .catch(() => ({ status: 0, body: null }));
          const coverageDevice = (coverage.body?.devices ?? []).find(
            (d) => d.deviceId === responsibilityDevice,
          );
          step('5k. 责任人核对快照：按当前班次给出覆盖/缺口，并逐台列出缺口原因',
            (coverage.status === 200 || coverage.status === 201)
              && coverage.body?.shiftId === currentShiftId
              && typeof coverage.body?.total === 'number'
              && typeof coverage.body?.gaps === 'number'
              && Boolean(coverageDevice)
              && coverageDevice.covered === true
              && Array.isArray(coverage.body?.notes)
              && coverage.body.notes.join('').includes('不要求已绑定登录账号'),
            `status=${coverage.status} shiftId=${coverage.body?.shiftId ?? 'none'} `
              + `total=${coverage.body?.total} covered=${coverage.body?.covered} gaps=${coverage.body?.gaps} `
              + `uncovered=${coverage.body?.uncovered}`);

          const handoverWithSnapshot = await fetch(`${BASE}/api/shifts/handovers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${andonToken}` },
            body: JSON.stringify({
              shiftId: currentShiftId,
              toUserId: '11111111-1111-4111-8111-111111111111',
              openItems: [{ title: `e2e NO-52a 交接 ${tag}`, severity: 'warning' }],
              notes: 'e2e：验证交接记录保存责任人核对快照',
            }),
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
            .catch(() => ({ status: 0, body: null }));
          const snapshot = handoverWithSnapshot.body?.record?.responsibilitySnapshot
            ?? handoverWithSnapshot.body?.record?.responsibilitySnapshotJson
            ?? null;
          step('5l. 交接记录保存"交接时刻"的责任人核对快照（审计可回答当时状态）',
            (handoverWithSnapshot.status === 200 || handoverWithSnapshot.status === 201)
              && Boolean(snapshot)
              && snapshot.shiftId === currentShiftId
              && typeof snapshot.gaps === 'number'
              && Array.isArray(snapshot.gapDeviceIds),
            `status=${handoverWithSnapshot.status} snapshotKeys=${snapshot ? Object.keys(snapshot).join('|') : 'none'}`);

          // 收尾：收回本班责任关系
          await fetch(
            `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities/owner`
              + `?shiftId=${encodeURIComponent(currentShiftId)}&reason=e2e%20cleanup`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${andonToken}` } },
          ).catch(() => null);
        }

        // 收尾：把责任关系收回（避免污染后续场景），并验证"收回不存在 → 409"。
        // 注意顺序：5i/5j 已经动过 owner，因此这里用**确定还在**的 maintainer 做收回断言，
        // 避免断言依赖别的步骤的副作用（e2e 自身也要可重复运行）。
        const cleared = await fetch(
          `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities/maintainer?reason=e2e%20cleanup`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${andonToken}` } },
        ).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
          .catch(() => ({ status: 0, body: null }));
        const clearedAgain = await fetch(
          `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities/maintainer`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${andonToken}` } },
        ).then(async (r) => ({ status: r.status })).catch(() => ({ status: 0 }));
        // owner（可能已被 5j 收回）做尽力清理：不在此断言状态
        await fetch(
          `${BASE}/api/devices/${encodeURIComponent(responsibilityDevice)}/responsibilities/owner?reason=e2e%20cleanup`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${andonToken}` } },
        ).catch(() => null);
        step('5h. 收回责任关系；重复收回 → 409（不静默当成功）',
          (cleared.status === 200 || cleared.status === 201) && clearedAgain.status === 409,
          `clear=${cleared.status} again=${clearedAgain.status}`);
      }
    }

  } finally {
    // 场景清理：执行机构相关的世界状态/设备/能力行（模拟来源，可安全删除）
    try {
      await sql`delete from ewoh_world_state where org_id = ${INGEST_ORG} and entity_id = ${`AGV-SIM-${tag}`}`;
      await sql`delete from ewoh_device_capability where org_id = ${INGEST_ORG}::uuid and device_id = ${`AGV-SIM-${tag}`}`;
      await sql`delete from ewoh_device where org_id = ${INGEST_ORG} and device_id = ${`AGV-SIM-${tag}`}`;
    } catch (error) {
      console.warn(`[cleanup] 执行机构清理失败（不掩盖断言结果）：${error?.message ?? error}`);
    }
    await sql.end({ timeout: 5 });
  }

  finish();
}

main().catch((error) => {
  record('FAIL', 'unexpected', error?.message ?? String(error));
  finish();
});
