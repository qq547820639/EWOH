/**
 * 设备物理仿真对抗 E2E —— AGV 电量物理 + PLC 故障门控孪生（真实 Modbus/TCP + 真实后端 + 真实 PG）。
 *
 * 为什么单列：行业对标把「真机 AGV / PLC」列为未验证，但设备侧**物理行为**可以用
 * 数字孪生对抗——仿真器按物理规律演化（SOC 放电、故障窗口），平台侧的资格门槛、
 * 回执终态语义被它对抗：
 *
 *   AGV 腿（tools/device_physics_sim.py --role agv）：
 *     1. SOC 状态流（位置+电量）经真实 /api/ingest/actuator 落台账（类别 agv、
 *        能力 transport.move 自动登记）；物理合理的放电曲线（时间窗匹配）全受理；
 *     2. **坏传感电量回跳**（单帧跳变）→ SOC_JUMP_IMPLAUSIBLE 显式拒绝且不写
 *        台账/世界状态；连续同水平帧 → SOC_REANCHOR 再锚定（真实充电是持续过程）；
 *     3. SOC 95% → 候选 eligible；SOC 跌破门槛 → 候选显式给出 `battery_low`
 *        （不是静默丢弃）；台账电量始终跟随最后可信值。
 *
 *   PLC 腿（tools/device_physics_sim.py --role plc，故障门控孪生 + 真实 Modbus/TCP）：
 *     4. 设备故障窗口内派搬运命令 → 边缘代理（真实子进程，真实 Modbus 协议帧）
 *        执行失败 → 平台回执 **不得伪装成成功终态**（executed）；
 *     5. 故障恢复后同一链路重跑 → executed（回执成功，且区分 gateway_ack 与
 *        command_receipt 两段事实）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=... EWOH_E2E_ADMIN_PASS=... EWOH_E2E_APPROVER_PASS=... \
 *   EWOH_E2E_INGEST_KEY=... EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/device-physics-adversarial.mjs
 *   （三态 PASS/FAIL/SKIP；exit 0/1/2）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || '';
const ORG_ID = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';
const REPO_ROOT = path.resolve(process.cwd(), '..');
const PYTHON = process.env.EWOH_E2E_PYTHON || 'python3';
const PLC_PORT = Number(process.env.EWOH_PLC_TWIN_PORT || 15031);

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
    `设备物理对抗: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
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
  // 短重试：场景里 spawnSync 子进程耗时（仿真/代理执行）会让 keep-alive 连接
  // 被服务端关闭，undici 复用死 socket → ECONNRESET（实测）。重试即新开连接。
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${BASE}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((e) => {
      if (process.env.EWOH_DP_DEBUG) console.error(`[debug] fetch ${method} ${url} 失败(第${attempt}次): ${e?.cause?.code ?? e?.code ?? e?.message ?? e}`);
      return null;
    });
    if (response) {
      return { status: response.status, body: await response.json().catch(() => null) };
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400));
  }
  return { status: 0, body: null };
}
const post = (url, body, token, extraHeaders) => call('POST', url, body ?? {}, token, extraHeaders);
const get = (url, token, extraHeaders) => call('GET', url, undefined, token, extraHeaders);

function errText(res) {
  return res.body?.error?.message ?? res.body?.error?.code ?? res.body?.message ?? '';
}

function runDeviceSim(args, timeoutMs = 120_000) {
  const result = spawnSync(PYTHON, [path.join(REPO_ROOT, 'tools/device_physics_sim.py'), ...args],
    { encoding: 'utf8', cwd: REPO_ROOT, timeout: timeoutMs });
  return result;
}

async function main() {
  const probe = await fetch(`${BASE}/api/scheduler/snapshot`).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}`);
    return finish();
  }
  step('0. 平台可达（读面要求鉴权）', probe.status === 401 || probe.status === 403 || probe.status === 200,
    `探测 status=${probe.status}`);
  if (!OWNER_DB || !INGEST_KEY) {
    skip('0b. 平台侧事实断言', '未提供 EWOH_E2E_OWNER_DATABASE_URL / EWOH_E2E_INGEST_KEY');
    return finish();
  }

  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS);
  const approverToken = await login(process.env.EWOH_E2E_APPROVER_USER || 'approver.li', process.env.EWOH_E2E_APPROVER_PASS);
  if (!adminToken || !approverToken) {
    skip('1. 登录（管理员 + 审批人）', lastLoginError ?? '缺少凭据');
    return finish();
  }
  step('1. 管理员 + 审批人登录成功', true);

  const sql = postgres(OWNER_DB, { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const workdir = mkdtempSync(path.join(tmpdir(), `ewoh-dp-${tag}-`));
  const agvDeviceId = `AGV-SIM-${tag.slice(-4)}`;
  const plcDeviceId = `PLC-SIM-${tag.slice(-4)}`;
  const taskTitleTag = tag;
  let taskId = null;
  let plcChildRef = null; // finally 兜底清理用

  try {
    // ── A. AGV 电量物理腿 ────────────────────────────────────────
    // 摄入 fail-closed：entity_id（=device_id）必须已登记。
    await sql`
      insert into ewoh_spatial_entity
        (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
      values (${ORG_ID}, ${agvDeviceId}, 'device', ${`仿真 AGV ${agvDeviceId}`}, 12, 8, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
      on conflict (org_id, entity_id) do update set status = 'active'`;
    await sql`update ewoh_personnel set _updated_at = now() where org_id = ${ORG_ID}::uuid`;

    // A1. SOC 放电曲线（物理时间匹配）：90 → 58 → 24 → 8，均匀铺在最近 78 分钟
    //     （帧距 26min，跌幅 ≤ 包络 1.5%/min×26min=39 点）→ 全序列受理。
    const socStatsPath = path.join(workdir, 'agv-soc.json');
    const agvSim = runDeviceSim([
      '--role', 'agv',
      '--device-id', agvDeviceId,
      '--platform-url', BASE,
      '--ingest-key', INGEST_KEY,
      '--org-id', ORG_ID,
      '--soc-sequence', '90,58,24,8',
      '--soc-window-min', '78',
      '--tick-sec', '1.2',
      '--tag', tag,
      '--stats-json', socStatsPath,
    ]);
    const socStats = existsSync(socStatsPath) ? JSON.parse(readFileSync(socStatsPath, 'utf8')) : null;
    const socErrors = (socStats?.soc_series ?? []).map((s) => s.resp?.error).filter(Boolean);
    step('A1. AGV SOC 放电曲线（时间窗匹配物理）全序列受理（真实 actuator 摄入）',
      agvSim.status === 0 && socStats?.frames_posted === 4 && socStats.frames_rejected === 0 && socErrors.length === 0,
      `exit=${agvSim.status} posted=${socStats?.frames_posted} rejected=${socStats?.frames_rejected} 错误=${JSON.stringify(socErrors)}`);

    const snapshot1 = await get('/api/scheduler/snapshot', adminToken);
    const allDevices = snapshot1.body?.devices ?? [];
    const device1 = allDevices.find((d) => d.deviceId === agvDeviceId);
    step('A2. 设备台账可见：类别 agv、电量=末帧 8（放电曲线末值）、位置已知（物理状态流 → 台账）',
      snapshot1.status === 200 && Boolean(device1)
        && Number(device1?.batteryPct) === 8
        && device1?.x != null,
      `snapshot=${snapshot1.status} total=${allDevices.length} battery=${device1?.batteryPct} xy=${device1?.x},${device1?.y} caps=${JSON.stringify(device1?.capabilities ?? null)}`);
    if (!device1) {
      record('FAIL', 'A2b. 快照缺设备（排障留痕）',
        `tag=${tag} 期望 deviceId=${agvDeviceId} 实际样例=${JSON.stringify(allDevices.slice(0, 3).map((d) => d.deviceId))}`);
    }

    // A3. 建搬运任务并进待派发；同时补齐候选前置（人员档案新鲜度 + 位置帧 + AGV 心跳）
    //     ——候选模型是 Person×Device 配对：人员位置 60s 新鲜度过期 → 全员
    //     person_unavailable，AGV 腿无从验证（与 agv-transport-loop 同一前置纪律）。
    // 工位选择与 agv-transport-loop 同款：只要 `station:` 空间实体（route 权威），
    // task.spatialEntityId 传工位实体号（不是 uuid，否则 route node 查不到 → route_infeasible）
    // 工位选择与 agv-transport-loop 同款：只要 `station:` 空间实体（route 权威），
    // task.spatialEntityId 传工位实体号（不是 uuid，否则 route node 查不到 → route_infeasible）。
    // 环境守卫：快照里没有带坐标的 station: 实体 → 如实 SKIP（环境漂移，不伪装产品缺陷）。
    const _stList = (snapshot1.body?.stations ?? []).filter(
      (s) => String(s.entityId ?? '').startsWith('station:') && s.x != null && s.y != null,
    );
    if (_stList.length === 0) {
      skip('A3-A7. AGV 资格腿', '快照里没有带坐标的 station: 空间实体（环境漂移；请先跑种子/主数据）');
      return finish();
    }
    const _stFirst = _stList[0];
    const stationPick = { stationId: String(_stFirst.entityId).split(':', 2)[1], x: Number(_stFirst.x), y: Number(_stFirst.y) };
    const created = await post('/api/tasks', {
      title: `DP 对抗搬运任务 ${taskTitleTag}`,
      taskType: 'transport',
      priority: 'high',
      ...(stationPick ? { spatialEntityId: stationPick.stationId } : {}),
      requiredDeviceCapabilities: ['transport.move'],
    }, adminToken);
    taskId = created.body?.id ?? null;
    const submitted = taskId ? await post(`/api/tasks/${taskId}/state?action=submit`, {}, adminToken) : { status: 0 };
    const ready = taskId ? await post(`/api/tasks/${taskId}/state?action=skip_approval`, {}, adminToken) : { status: 0 };
    step('A3. 搬运任务创建并按状态机进入待派发',
      Boolean(taskId) && (submitted.status === 200 || submitted.status === 201) && (ready.status === 200 || ready.status === 201),
      `task=${taskId} submit=${submitted.status} ready=${ready.status}`);

    await sql`update ewoh_personnel set _updated_at = now() where org_id = ${ORG_ID}::uuid`;
    const personsNow = (await get('/api/scheduler/snapshot', adminToken)).body?.persons ?? [];
    // 锁定人员（在飞 assignment）无论怎么刷新都不可用（LOCKED_PERSON，正确的
    // fail-closed）——选取时按快照的 lockedAssignments 显式排除，优先 AVAILABLE。
    const _lockedPersonIds = new Set(
      (snapshot1.body?.lockedAssignments ?? []).map((la) => la.personId).filter(Boolean),
    );
    // NO-97a：迭代最多 5 个有技能、未锁定的候选——逐个补位置帧 + 刷新档案时间戳，
    // 取第一个变为 AVAILABLE 的（共享 dev 库里部分人员可能正被其它场景占用 BUSY，
    // 单候选一次定生死会误报环境衰减为缺陷——与 agv-transport 同款修复）。
    // NO-97a：播种**专用人员**（与自建专用设备同款前置）——共享池的人员可能被
    // 其它场景的残留派工占成 BUSY（资源预约已全 released 仍 BUSY = 分配行残留）。
    // 专用人员无历史派工 → 档案刷新后必 AVAILABLE，场景不再受共享池污染。
    const dedicatedPersonId = randomUUID();
    await sql`
      insert into ewoh_personnel
        (org_id, employee_no, name, skills, status, _updated_at)
      values (${ORG_ID}::uuid, ${`DP-${tag}`}, ${`DP 对抗人员 ${tag}`},
              '["transport.move","assembly"]'::jsonb, 'available', now())
      on conflict do nothing`;
    personsNow.unshift({ id: dedicatedPersonId, skills: ['transport.move', 'assembly'], status: 'available' });
    const skillPool = personsNow.filter((p) => (p.skills ?? []).length > 0 && !_lockedPersonIds.has(p.id));
    const pickPool = skillPool.length > 0 ? skillPool : personsNow;
    let availablePerson = null;
    for (const personCandidate of pickPool.slice(0, 5)) {
      if (!personCandidate?.id) continue;
      await post('/api/ingest/location', {
        entity_id: personCandidate.id,
        tag_id: `TAG-${personCandidate.id}`,
        locator: 'uwb',
        confidence: 0.9,
        x: stationPick?.x ?? 12,
        y: stationPick?.y ?? 8,
        z: 0,
        ts: new Date().toISOString(),
        source_type: 'controlled_test',
        record_id: `dp-person-${tag}`,
      }, null, { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID });
      // 路由解析按**空间实体表**查人员坐标（routing.service calculateRoute →
      // ewoh_spatial_entity by personId）；人员播种工位坐标（与 perception-fusion
      // 同款前置：seed 空间实体，而不是假设 location 帧会反哺路由解析）。
      await sql`
        insert into ewoh_spatial_entity
          (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
        values (${ORG_ID}, ${personCandidate.id}, 'person', ${`DP 对抗人员 ${personCandidate.id}`}, ${stationPick?.x ?? 12}, ${stationPick?.y ?? 8}, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
        on conflict (org_id, entity_id) do update set x = ${stationPick?.x ?? 12}, y = ${stationPick?.y ?? 8}, status = 'active'`;
      // 挂接人员档案 → 空间实体：资源投影 person.x/y 来自档案的 spatial_entity_id
      // （为空则 personPoint 缺失 → 路由坐标未知 → route_infeasible）。
      await sql`
        update ewoh_personnel set spatial_entity_id = ${personCandidate.id}
        where org_id = ${ORG_ID}::uuid and id = ${personCandidate.id}::uuid`;
      const refreshed = await get('/api/scheduler/snapshot', adminToken);
      const refreshedPerson = (refreshed.body?.persons ?? []).find((p) => p.id === personCandidate.id);
      if (refreshedPerson && String(refreshedPerson.status ?? '').toUpperCase() === 'AVAILABLE') {
        availablePerson = refreshedPerson;
        break;
      }
      if (!availablePerson) availablePerson = refreshedPerson ?? personCandidate;
    }
    // A4a. 对抗腿：单帧坏传感回跳 8→95（AGV 刚放电到 8，1 秒后"满电"）——
    //      合理性闸门必须显式拒绝（SOC_JUMP_IMPLAUSIBLE），台账保持 8。
    const jumpResp = await post('/api/ingest/actuator', {
      device_id: agvDeviceId,
      event_time: new Date(Date.now() - 2_000).toISOString(),
      state: 'idle',
      x: stationPick?.x ?? 10,
      y: stationPick?.y ?? 8,
      battery_pct: 95,
      record_id: `dp-agv-hb-${tag}`,
    }, null, { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID });
    const snapshotAfterJump = await get('/api/scheduler/snapshot', adminToken);
    const deviceAfterJump = (snapshotAfterJump.body?.devices ?? []).find((d) => d.deviceId === agvDeviceId);
    step('A4a. 坏传感单帧回跳 8→95 → 显式拒绝（SOC_JUMP_IMPLAUSIBLE）且台账保持 8（不可信读数不得伪造事实）',
      jumpResp.body?.accepted === false && String(jumpResp.body?.error ?? '').includes('SOC_JUMP_IMPLAUSIBLE')
        && Number(deviceAfterJump?.batteryPct) === 8,
      `accepted=${jumpResp.body?.accepted} error=${jumpResp.body?.error} 台账=${deviceAfterJump?.batteryPct}%`);

    // A4b. 再锚定腿：设备持续报告 95%（真实充电/换电是持续过程，毛刺只有一帧）。
    //      连击计数含 A4a 那帧（streak 1→2→3），第 3 帧接受并标记 soc_reanchored。
    //      停到所选工位坐标——与 agv-transport-loop 同款：AGV 停在工位上，路由距离 0 才可行。
    const reanchorPosts = [];
    for (let i = 2; i <= 3; i++) {
      reanchorPosts.push(await post('/api/ingest/actuator', {
        device_id: agvDeviceId,
        event_time: new Date(Date.now() - 2_000).toISOString(),
        state: 'idle',
        x: stationPick?.x ?? 10,
        y: stationPick?.y ?? 8,
        battery_pct: 95,
        record_id: `dp-agv-reanchor-${i}-${tag}`,
      }, null, { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID }));
    }
    const snapshotReanchored = await get('/api/scheduler/snapshot', adminToken);
    const deviceReanchored = (snapshotReanchored.body?.devices ?? []).find((d) => d.deviceId === agvDeviceId);
    step('A4b. 连续同水平帧 → 再锚定接受（第 3 帧成功且 soc_reanchored=true，台账更新为 95）',
      reanchorPosts[0]?.body?.accepted === false
        && reanchorPosts[1]?.body?.accepted === true && reanchorPosts[1]?.body?.soc_reanchored === true
        && Number(deviceReanchored?.batteryPct) === 95,
      `帧2 accepted=${reanchorPosts[0]?.body?.accepted} 帧3 accepted=${reanchorPosts[1]?.body?.accepted}`
        + ` reanchored=${reanchorPosts[1]?.body?.soc_reanchored} 台账=${deviceReanchored?.batteryPct}%`);

    // 人员位置 60s 新鲜度在 A4a/A4b 之后可能已过期（候选 person_unavailable）——
    // 与 A6 同款前置纪律：候选读取前刷新位置帧 + 档案时间戳。
    if (availablePerson?.id) {
      await post('/api/ingest/location', {
        entity_id: availablePerson.id,
        tag_id: `TAG-${availablePerson.id}`,
        locator: 'uwb',
        confidence: 0.9,
        x: stationPick?.x ?? 12,
        y: stationPick?.y ?? 8,
        z: 0,
        ts: new Date().toISOString(),
        source_type: 'controlled_test',
        record_id: `dp-person-high-${tag}`,
      }, null, { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID });
      await sql`update ewoh_personnel set _updated_at = now() where org_id = ${ORG_ID}::uuid`;
    }
    const candidatesHigh = await get(`/api/scheduler/tasks/${taskId}/candidates`, adminToken);
    // 候选的 deviceId 是**台账 uuid**（ewoh_device.id），不是业务设备号
    const agvRowsHigh = (candidatesHigh.body?.candidates ?? []).filter((c) => c.deviceId === device1.id);
    // A5 诊断（2026-09-19 实测：fresh 库上全员 person_unavailable）：把候选读取同一时刻的
    // 人员投影事实（状态/新鲜度/可用窗）一并留痕，区分"场景数据就绪问题"与"产品闸门误伤"。
    const diagSnap = await get('/api/scheduler/snapshot', adminToken);
    const diagPersons = (diagSnap.body?.persons ?? [])
      .filter((p) => agvRowsHigh.some((c) => c.personId === p.id))
      .slice(0, 20)
      .map((p) => ({ p: p.id, s: p.status, q: p.dataQuality, w: p.availableWindows ?? null, af: p.availableFromMs ?? null }));
    step('A5. SOC 95% → 候选出现且至少一条 eligible（电量已知、能力匹配、人员可用）',
      candidatesHigh.status === 200 && agvRowsHigh.length > 0 && agvRowsHigh.some((c) => c.eligible === true),
      `rows=${agvRowsHigh.length} eligible=${agvRowsHigh.filter((c) => c.eligible).length}`
        + ` person=${availablePerson?.id ?? 'none'}/${availablePerson?.status ?? '-'}`
        + ` 投影=${JSON.stringify(diagPersons)}`
        + ` 逐行=${JSON.stringify(agvRowsHigh.map((c) => ({ p: c.personId, r: c.reasons })))}`);

    // A5. SOC 跌破门槛 → 候选显式 battery_low（不静默丢弃）
    // A6. SOC 再度跌破门槛 → 候选显式 battery_low（不静默丢弃）。
    //     途径是**物理合理的放电曲线**（时间窗匹配，帧距 26min）——单帧 95→8
    //     会被 A4a 同款闸门拒绝，真实场景里电量也是渐降的。
    const socLowPath = path.join(workdir, 'agv-soc-low.json');
    runDeviceSim([
      '--role', 'agv',
      '--device-id', agvDeviceId,
      '--platform-url', BASE,
      '--ingest-key', INGEST_KEY,
      '--org-id', ORG_ID,
      '--soc-sequence', '95,62,32,8',
      '--soc-window-min', '78',
      '--tick-sec', '1.2',
      '--tag', `${tag}-low`,
      '--stats-json', socLowPath,
    ]);
    if (availablePerson?.id) {
      await post('/api/ingest/location', {
        entity_id: availablePerson.id,
        tag_id: `TAG-${availablePerson.id}`,
        locator: 'uwb',
        confidence: 0.9,
        x: stationPick?.x ?? 12,
        y: stationPick?.y ?? 8,
        z: 0,
        ts: new Date().toISOString(),
        source_type: 'controlled_test',
        record_id: `dp-person-low-${tag}`,
      }, null, { 'X-Ingest-Key': INGEST_KEY, 'X-Org-Id': ORG_ID });
    }
    const candidatesLow = await get(`/api/scheduler/tasks/${taskId}/candidates`, adminToken);
    const agvRowsLow = (candidatesLow.body?.candidates ?? []).filter((c) => c.deviceId === device1.id);
    step('A6. SOC 跌破派工门槛 → 候选不合格且原因词表含 battery_low（可解释拒绝）',
      agvRowsLow.length > 0 && agvRowsLow.some((c) => (c.reasons ?? []).includes('battery_low')),
      `rows=${agvRowsLow.length}`
        + ` battery_low=${agvRowsLow.filter((c) => (c.reasons ?? []).includes('battery_low')).length}`
        + ` 样例=${JSON.stringify(agvRowsLow[0]?.reasons ?? null)}`);

    // A7. SOC 闸门全链取证（汇总）：合理曲线受理（A1）+ 单帧跳变显式拒绝（A4a）
    //     + 连续同水平再锚定（A4b）+ 台账电量跟随最后可信值（A6 后=8）。
    //     拒绝帧不留半条事实：执行机构 latest-wins 世界状态里查不到被拒读数的投影。
    const socLowStats = existsSync(socLowPath) ? JSON.parse(readFileSync(socLowPath, 'utf8')) : null;
    const snapshotFinal = await get('/api/scheduler/snapshot', adminToken);
    const deviceFinal = (snapshotFinal.body?.devices ?? []).find((d) => d.deviceId === agvDeviceId);
    step('A7. SOC 合理性闸门全链取证：合理曲线受理 / 跳变拒绝 / 再锚定生效 / 台账跟随可信值',
      socStats?.frames_posted === 4 && socStats?.frames_rejected === 0
        && socLowStats?.frames_rejected === 0
        && Number(deviceFinal?.batteryPct) === 8,
      `放电腿受理=${socStats?.frames_posted}/${socStats?.frames_rejected}`
        + ` 低压腿受理=${socLowStats?.frames_posted}/${socLowStats?.frames_rejected}`
        + ` 台账终值=${deviceFinal?.batteryPct}%`);

    // ── B. PLC 故障门控孪生腿（真实 Modbus/TCP）──────────────────
    await sql`
      insert into ewoh_spatial_entity
        (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
      values (${ORG_ID}, ${plcDeviceId}, 'device', ${`仿真 PLC ${plcDeviceId}`}, 40, 30, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
      on conflict (org_id, entity_id) do update set status = 'active'`;
    const plcStatsPath = path.join(workdir, 'plc-twin.json');
    // 故障窗口 [4s, 26s)：窗口内命令必须失败，窗口后命令必须成功
    const plcT0 = Date.now();
    const plcChild = spawn(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/device_physics_sim.py'),
        '--role', 'plc',
        '--device-id', plcDeviceId,
        '--port', String(PLC_PORT),
        '--duration-sec', '45',
        '--fault-window', '4:26',
        '--stats-json', plcStatsPath,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000, stdio: 'ignore' },
    );
    plcChild.unref();
    plcChildRef = plcChild;
    // 等孪生 Modbus 监听就绪（TCP 探测；最多 10s）
    const waitPort = async (port, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await new Promise((resolve) => {
          const sock = net.connect({ host: '127.0.0.1', port, timeout: 800 });
          sock.on('connect', () => { sock.destroy(); resolve(true); });
          sock.on('error', () => resolve(false));
          sock.on('timeout', () => { sock.destroy(); resolve(false); });
        });
        if (ok) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    };
    const portUp = await waitPort(PLC_PORT, 10_000);
    // 恢复等待锚定**实测端口就绪时刻**（孪生进程启动有冷启动延迟，锚 spawn 时刻
    // 会与孪生自身的故障窗口时钟漂移）——窗口尾 26s + 裕量 3s。
    const plcPortUpAt = Date.now();
    step('B0. PLC 孪生 Modbus/TCP 监听就绪（真实协议对端）', portUp, `port=${PLC_PORT}`);
    if (!portUp) {
      record('FAIL', 'B0b. 孪生未监听', '后续 B 腿断言无从验证');
      return finish();
    }
    await new Promise((r) => setTimeout(r, 4_500)); // 进入故障窗口（t≥4s）

    // B1. 故障窗口内的命令链：创建 → 审批 → 下发 → 代理执行（真实 Modbus 子进程）
    const mkRequest = async (idemKey) => {
      const createdReq = await post('/api/control/requests', {
        deviceId: plcDeviceId,
        commandKeys: ['dispatch_task'],
        idempotencyKey: idemKey,
      }, approverToken);
      const requestId = createdReq.body?.id ?? createdReq.body?.requestId ?? null;
      if (!requestId) return { requestId: null, createdReq };
      const authorizations = await get('/api/approvals/authorizations', adminToken);
      const approvalRow = (authorizations.body ?? []).find(
        (a) => a.entityType === 'control_request' && a.entityId === requestId,
      );
      const instance = approvalRow?.approvalId
        ? await get(`/api/approvals/${approvalRow.approvalId}`, adminToken)
        : { body: null };
      const stepId = instance.body?.steps?.[0]?.id ?? null;
      const approved = approvalRow?.approvalId && stepId
        ? await post(`/api/approvals/${approvalRow.approvalId}/steps/${stepId}/state?action=approve`,
          { reason: 'DP 对抗：执行机构搬运授权' }, adminToken)
        : { status: 0 };
      const sent = await post(`/api/control/requests/${requestId}/commands`, {
        commandKey: 'dispatch_task',
        payload: { targetStationId: 'ST-SIM-1', taskId: `T-DP-${idemKey}` },
      }, approverToken);
      return { requestId, createdReq, approved, sent };
    };

    const faulted = await mkRequest(`dp-fault-${tag}`);
    step('B1. 故障窗口内命令已创建+审批+下发',
      Boolean(faulted.requestId) && (faulted.sent.status === 200 || faulted.sent.status === 201),
      `request=${faulted.requestId} sent=${faulted.sent.status} msg=${errText(faulted.sent)}`);

    const agentFault = spawnSync(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/edge_control_agent.py'),
        '--once',
        '--device', plcDeviceId,
        '--platform-url', BASE,
        '--ingest-key', INGEST_KEY,
        '--org-id', ORG_ID,
        '--transport', 'modbus',
        '--modbus-host', '127.0.0.1',
        '--modbus-port', String(PLC_PORT),
        '--source-type', 'controlled_test',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000 },
    );
    const faultLine = (agentFault.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let faultStats = null;
    try { faultStats = JSON.parse(faultLine); } catch { faultStats = null; }
    const faultOutcome = faultStats?.outcomes?.[0]?.outcome ?? null;
    const faultAdapterReason = String(faultStats?.outcomes?.[0]?.adapterReason ?? '');
    step('B2. 故障窗口内执行：孪生以设备故障拒绝 dispatch_task（adapterReason=device_fault*，非传输层故障）→ 代理如实上报执行失败',
      agentFault.status === 2 && faultOutcome === 'execution_failed' && faultAdapterReason.startsWith('device_fault'),
      `exit=${agentFault.status} outcome=${faultOutcome ?? 'none'} adapterReason=${faultAdapterReason || 'none'}`);

    const detailFault = faulted.requestId ? await get(`/api/control/requests/${faulted.requestId}`, adminToken) : { body: null };
    const faultRequest = detailFault.body?.request ?? detailFault.body;
    const faultAttempt = (faultRequest?.attempts ?? []).find((a) => a.commandKey === 'dispatch_task');
    step('B3. 平台终态不得伪装成功：故障期执行回执 ≠ executed（终态语义如实）',
      detailFault.status === 200 && faultAttempt != null && faultAttempt.status !== 'executed',
      `attempt=${faultAttempt?.status ?? 'none'}`);

    // B4. 故障恢复后：新命令 → 同一链路 → executed（终态成功，回执两段事实齐全）
    const waitMs = Math.max(0, plcPortUpAt + 29_000 - Date.now());
    await new Promise((r) => setTimeout(r, waitMs)); // 等故障窗口结束（孪生时钟 t≈26s 后）
    const healthy = await mkRequest(`dp-ok-${tag}`);
    const agentOk = spawnSync(
      PYTHON,
      [
        path.join(REPO_ROOT, 'tools/edge_control_agent.py'),
        '--once',
        '--device', plcDeviceId,
        '--platform-url', BASE,
        '--ingest-key', INGEST_KEY,
        '--org-id', ORG_ID,
        '--transport', 'modbus',
        '--modbus-host', '127.0.0.1',
        '--modbus-port', String(PLC_PORT),
        '--source-type', 'controlled_test',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000 },
    );
    const okLine = (agentOk.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    let okStats = null;
    try { okStats = JSON.parse(okLine); } catch { okStats = null; }
    step('B4. 故障恢复后执行成功（代理 exit 0，executed）',
      agentOk.status === 0 && okStats?.executed === 1,
      `exit=${agentOk.status} executed=${okStats?.executed ?? 'n/a'} line=${okLine.slice(0, 160)}`);

    const detailOk = healthy.requestId ? await get(`/api/control/requests/${healthy.requestId}`, adminToken) : { body: null };
    const okRequest = detailOk.body?.request ?? detailOk.body;
    const okAttempt = (okRequest?.attempts ?? []).find((a) => a.commandKey === 'dispatch_task');
    step('B5. 平台终态 executed + payload 留痕（恢复后回执成功）',
      detailOk.status === 200 && okAttempt?.status === 'executed',
      `attempt=${okAttempt?.status ?? 'none'}`);

    const resultRows = healthy.requestId ? await sql`
      select result_type, result_code, success
      from ewoh_control_result where request_id = ${healthy.requestId} order by _created_at` : [];
    step('B6. 结果表区分 gateway_ack 与 command_receipt（两段事实不混为一谈）',
      resultRows.some((r) => r.result_type === 'gateway_ack' && r.result_code === 'delivered')
        && resultRows.some((r) => r.result_type === 'command_receipt' && r.result_code === 'executed' && r.success === true),
      `rows=${resultRows.map((r) => `${r.result_type}:${r.result_code}`).join(',')}`);

    // B7. 孪生侧事实：状态日志里有故障窗口，命令日志记录拒绝与接受
    // 孪生进程 34s 后退出并写 stats；等待其退出（最多 20s）
    const statsDeadline = Date.now() + 20_000;
    while (!existsSync(plcStatsPath) && Date.now() < statsDeadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 拒绝账目：故障拒绝经**真实 Modbus 异常路径**返回（adapterReason=device_fault:MODBUS_FAULT_*，
    // B2 已断言）；孪生侧账目这里核对故障窗口真实存在 + Modbus 帧被真实协议路径处理。
    let twinStats = null;
    try {
      twinStats = existsSync(plcStatsPath) ? JSON.parse(readFileSync(plcStatsPath, 'utf8')) : null;
    } catch { twinStats = null; } // 半写窗口（json.dump 中途）兜底，不算 FAIL 依据
    const faultStates = (twinStats?.state_log ?? []).filter((s) => s.state === 'fault');
    step('B7. 孪生侧账目：故障窗口真实存在 + Modbus 帧被真实协议路径处理',
      (twinStats?.fault_window ?? []).length === 2 && faultStates.length >= 2
        && Number(twinStats?.requests_served ?? 0) >= 1,
      `fault_states=${faultStates.length} modbus_requests=${twinStats?.requests_served} commands=${(twinStats?.command_log ?? []).length}`);
  } catch (error) {
    record('FAIL', '异常退出', String(error?.stack || error).slice(0, 300));
  } finally {
    // 兜底清理：孪生子进程异常路径下不得残留（固定端口会被下一轮撞上）
    if (typeof plcChildRef !== 'undefined' && plcChildRef && plcChildRef.exitCode == null) {
      try { plcChildRef.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  finish();
}

main();
