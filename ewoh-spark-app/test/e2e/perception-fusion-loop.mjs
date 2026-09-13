/**
 * 多模态感知融合 E2E（NO-56a，`docs/architecture/embodied_factory.md` §5）。
 *
 * 在**真实 PG** 上验证五条可解释规则与三条诚实边界：
 *   1. 权限边界：未认证/现场工人不能触发融合（401/403）；
 *   2. 多源接入是真实的：走真实摄入通道（`/api/ingest/location` + `/api/ingest/exoskeleton`
 *      + `/api/ingest/camera`），不是直接写库；
 *   3. 规则 1：UWB 与视觉同工位 → `consistent` + 高置信 + 允许建议；
 *   4. 规则 2：相机绑定到另一个工位却拍到同一人 → `conflict`（各源取值都保留）+ 禁止强建议；
 *   5. 规则 3：视觉缺失（相机没上报）→ 继续推断但 `degraded` + 缺源可见；
 *   6. 规则 4/7：观测过期 → `insufficient` + `confidence.level=unknown` + `score=null`（不显示成 0%）；
 *   7. 不猜：视觉 track 未绑定主体 → 如实计数；坐标超出工位半径 → 工位未知；
 *   8. 幂等：同窗口重复融合是 `refreshed`，不产生第二行；
 *   9. 只读：融合不修改世界状态行（比对 state_json）。
 *
 * 运行：
 *   EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_ADMIN_PASS=... \
 *   EWOH_E2E_APPROVER_PASS=... EWOH_E2E_FIELD_PASS=... EWOH_E2E_INGEST_KEY=... \
 *   EWOH_E2E_OWNER_DATABASE_URL=... \
 *     node test/e2e/perception-fusion-loop.mjs
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const BASE = process.env.EWOH_E2E_BACKEND_URL || 'http://127.0.0.1:3100';
const OWNER_DB = process.env.EWOH_E2E_OWNER_DATABASE_URL || process.env.EWOH_E2E_PG_URL || '';
const INGEST_KEY = process.env.EWOH_E2E_INGEST_KEY || '';
const ORG = process.env.EWOH_E2E_INGEST_ORG_ID || '00000000-0000-4000-8000-000000000001';

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
    `多模态感知融合: ${results.filter((r) => r.status === 'PASS').length} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`,
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

async function postJson(path, body, token) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function getJson(path, token) {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  if (!response) return { status: 0, body: null };
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function ingest(path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(payload),
  }).catch(() => null);
  const body = response ? await response.json().catch(() => null) : null;
  return { status: response?.status ?? 0, body };
}

async function main() {
  const probe = await fetch(`${BASE}/api/perception/fusion/sweep`, { method: 'POST' }).catch(() => null);
  if (!probe) {
    skip('0. 平台可达', `无法连接 ${BASE}（未启动或端口不可达）`);
    return finish();
  }
  step('0. 未认证融合被拒（401/403）', probe.status === 401 || probe.status === 403, `status=${probe.status}`);

  const adminToken = await login(process.env.EWOH_E2E_ADMIN_USER || 'admin', process.env.EWOH_E2E_ADMIN_PASS || '');
  const leadToken = await login(
    process.env.EWOH_E2E_APPROVER_USER || 'approver.li',
    process.env.EWOH_E2E_APPROVER_PASS || '',
  );
  const fieldToken = await login(
    process.env.EWOH_E2E_FIELD_USER || 'worker.zhangwei',
    process.env.EWOH_E2E_FIELD_PASS || '',
  );
  if (!adminToken || !leadToken) {
    skip('1. 管理员/班组长登录', lastLoginError ?? '登录失败（原因未知）');
    return finish();
  }
  step('1. 管理员 + 班组长登录成功', true);
  if (!INGEST_KEY) {
    skip('2. 多源接入与融合', '未提供 EWOH_E2E_INGEST_KEY（无法走真实摄入通道）');
    return finish();
  }
  if (!OWNER_DB) {
    skip('2. 多源接入与融合', '未提供 EWOH_E2E_OWNER_DATABASE_URL（无法核对落库事实）');
    return finish();
  }
  if (fieldToken) {
    const denied = await postJson('/api/perception/fusion/sweep', {}, fieldToken);
    step('2. 现场工人触发融合被拒（403）', denied.status === 403, `status=${denied.status}`);
  } else {
    skip('2. 现场工人触发融合被拒（403）', lastLoginError ?? '现场工人登录失败');
  }

  const sql = postgres(OWNER_DB, { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const person = `person:e2e-fuse-${tag}`;
  const otherPerson = `person:e2e-fuse-other-${tag}`;
  const stA = `ST-A-${tag}`;
  const stB = `ST-B-${tag}`;
  const camA = `CAM-A-${tag}`;
  const camB = `CAM-B-${tag}`;
  const tagId = `TAG-${tag}`;
  const exoDevice = `EXO-FUSE-${tag}`;
  const seededEntities = [person, otherPerson, stA, stB, camA, camB];

  const seedEntities = async () => {
    for (const [entityId, entityType, x, y] of [
      [stA, 'station', 10, 20],
      [stB, 'station', 100, 20],
      [camA, 'camera', 10, 20],
      [camB, 'camera', 100, 20],
      [person, 'person', 10, 20],
      [otherPerson, 'person', 100, 20],
    ]) {
      await sql`
        insert into ewoh_spatial_entity
          (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
        values (${ORG}, ${entityId}, ${entityType}, ${`e2e ${entityType} ${tag}`}, ${x}, ${y}, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
        on conflict (org_id, entity_id) do update set x = ${x}, y = ${y}, status = 'active'`;
    }
  };

  const sweep = (body) => postJson('/api/perception/fusion/sweep', body ?? { windowMinutes: 5, bucketMinutes: 5 }, leadToken);
  const subjectRow = (result) => (result.body?.fused ?? []).find((f) => f.subjectId === person);

  try {
    // ── 3. 多源接入（真实摄入通道）──────────────────────────────────
    await seedEntities();
    const location = await ingest('/api/ingest/location', {
      entity_id: person,
      tag_id: tagId,
      locator: 'uwb',
      confidence: 0.9,
      x: 10,
      y: 20,
      z: 0,
      ts: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-loc-${tag}`,
    });
    const exo = await ingest('/api/ingest/exoskeleton', {
      device_id: exoDevice,
      entity_id: person,
      event_time: new Date().toISOString(),
      source_type: 'real',
      sequence: 1,
      pose: { pitch_deg: 12, joint_angles_deg: { l_elbow: 90 } },
      quality: { status: 'good', confidence: 0.9 },
      record_id: `e2e-exo-${tag}`,
    });
    const cameraSame = await ingest('/api/ingest/camera', {
      camera_id: camA,
      event_time: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-cam-a-${tag}`,
      detections: [{ track_id: person, class_name: 'person', confidence: 0.85, bbox: { x: 10, y: 20, w: 4, h: 8 }, action: 'standing' }],
    });
    step(
      '3. 三源真实接入（定位 + 外骨骼 + 相机检测）',
      location.status === 201 && location.body?.accepted === true
        && exo.status === 201 && exo.body?.accepted === true
        && cameraSame.status === 201 && cameraSame.body?.accepted === true,
      `location=${location.body?.accepted} exo=${exo.body?.accepted} camera=${cameraSame.body?.accepted}`,
    );

    // ── 4. 规则 1：同工位 → 一致 + 高置信 ───────────────────────────
    const consistent = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const first = subjectRow(consistent);
    step(
      '4. 规则 1：UWB 与视觉同工位 → consistent + 高置信 + 允许建议',
      Boolean(first)
        && first.agreement === 'consistent'
        && first.confidence.level === 'high'
        && first.station?.stationId === stA
        && first.strongAdviceAllowed === true
        && first.ruleTrace.find((r) => r.rule === 'rule1_uwb_vision_same_station')?.fired === true,
      `agreement=${first?.agreement} level=${first?.confidence?.level} station=${first?.station?.stationId}`,
    );
    expectSingleSnapshot(consistent, person);

    // ── 5. 规则 2：相机绑到别的工位 → 冲突（各源保留）──────────────
    const cameraOther = await ingest('/api/ingest/camera', {
      camera_id: camB,
      event_time: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-cam-b-${tag}`,
      detections: [{ track_id: person, class_name: 'person', confidence: 0.8, bbox: { x: 1, y: 2, w: 4, h: 8 }, action: 'standing' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const conflicted = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const second = subjectRow(conflicted);
    step(
      '5. 规则 2：UWB ST-A 与相机（绑 ST-B）不一致 → conflict + 禁止强建议（各源取值都保留）',
      cameraOther.body?.accepted === true
        && second?.agreement === 'conflict'
        && second?.strongAdviceAllowed === false
        && second?.station?.stationId === null
        && (second?.conflicts?.[0]?.participants ?? []).some((p) => p.value === stB)
        && (second?.conflicts?.[0]?.participants ?? []).some((p) => p.value === stA),
      `agreement=${second?.agreement} participants=${(second?.conflicts?.[0]?.participants ?? []).map((p) => `${p.source}=${p.value}`).join(',')}`,
    );

    // ── 5b. 感知门控接入推理（NO-58b）：冲突主体的事实 → 结论只提示 ──
    if (second?.agreement === 'conflict' && second?.strongAdviceAllowed === false) {
      const reasoning = await postJson('/api/reasoning/evaluate', {
        traceId: `rt-e2e-gate-${tag}`,
        snapshotVersion: 1,
        eventIds: [`event:${tag}-gate`],
        facts: [{
          subjectId: person,
          kind: 'person',
          values: { workload: 0.99, fatigue: 0.9, ergonomicRisk: 0.9 },
          evidenceIds: [`event:${tag}-gate`],
        }],
      }, leadToken);
      const conclusions = Array.isArray(reasoning.body?.trace?.conclusions)
        ? reasoning.body.trace.conclusions
        : (Array.isArray(reasoning.body?.conclusions) ? reasoning.body.conclusions : []);
      const overload = conclusions.find((c) => String(c.ruleId) === 'rule:worker-overload');
      step(
        '5b. 感知门控接入推理：冲突主体的结论标 advisoryOnly（只提示、不得强建议）',
        (reasoning.status === 200 || reasoning.status === 201)
          && Boolean(overload)
          && overload.advisoryOnly === true
          && String(overload.advisoryReason ?? '').includes('不许强建议')
          && String(overload.explanation ?? '').includes('仅提示'),
        `status=${reasoning.status} conclusions=${conclusions.length} advisoryOnly=${overload?.advisoryOnly}`,
      );
    } else {
      skip('5b. 感知门控接入推理', '本时刻未构造出冲突快照（前置步骤未满足）');
    }

    // ── 6. 规则 3：视觉缺失（另一主体）→ 降级但继续推断 ─────────────
    const otherLocation = await ingest('/api/ingest/location', {
      entity_id: otherPerson,
      tag_id: `TAG-OTHER-${tag}`,
      locator: 'uwb',
      confidence: 0.8,
      x: 100,
      y: 20,
      z: 0,
      ts: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-loc-other-${tag}`,
    });
    await ingest('/api/ingest/exoskeleton', {
      device_id: `EXO-FUSE-OTHER-${tag}`,
      entity_id: otherPerson,
      event_time: new Date().toISOString(),
      source_type: 'real',
      sequence: 1,
      pose: { pitch_deg: 30 },
      quality: { status: 'good', confidence: 0.8 },
      record_id: `e2e-exo-other-${tag}`,
    });
    const degradedSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const other = (degradedSweep.body?.fused ?? []).find((f) => f.subjectId === otherPerson);
    step(
      '6. 规则 3：视觉缺失 → partial + degraded + 缺源可见（继续推断，不中断）',
      otherLocation.body?.accepted === true
        && other?.confidence.degraded === true
        && other?.confidence.missingSources.includes('vision')
        && other?.agreement === 'partial'
        && other?.ruleTrace.find((r) => r.rule === 'rule3_camera_down_degrade')?.fired === true,
      `agreement=${other?.agreement} degraded=${other?.confidence?.degraded} missing=${other?.confidence?.missingSources?.join(',')}`,
    );

    // ── 7. 不猜：未匹配视觉 + 工位未解析 ────────────────────────────
    await ingest('/api/ingest/camera', {
      camera_id: camA,
      event_time: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-cam-unknown-${tag}`,
      detections: [{ track_id: `track-${tag}-999`, class_name: 'person', confidence: 0.7 }],
    });
    const farPerson = `person:e2e-fuse-far-${tag}`;
    await sql`
      insert into ewoh_spatial_entity (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
      values (${ORG}, ${farPerson}, 'person', ${`e2e far ${tag}`}, 9999, 9999, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
      on conflict (org_id, entity_id) do nothing`;
    await ingest('/api/ingest/location', {
      entity_id: farPerson,
      tag_id: `TAG-FAR-${tag}`,
      locator: 'uwb',
      confidence: 0.7,
      x: 9999,
      y: 9999,
      z: 0,
      ts: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-loc-far-${tag}`,
    });
    seededEntities.push(farPerson);
    const unmatchedSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const far = (unmatchedSweep.body?.fused ?? []).find((f) => f.subjectId === farPerson);
    step(
      '7. 不猜：视觉 track 未绑定主体如实计数；坐标超半径 → 工位未知',
      Number(unmatchedSweep.body?.unmatchedVisionDetections ?? 0) >= 1
        && Number(unmatchedSweep.body?.stationUnresolved ?? 0) >= 1
        && far?.station === null
        && far?.position?.stationId === null,
      `unmatched=${unmatchedSweep.body?.unmatchedVisionDetections} stationUnresolved=${unmatchedSweep.body?.stationUnresolved}`,
    );

    // ── 7b. 环境多源（区域级同类多源交叉验证，NO-56b）───────────────
    const envA = await ingest('/api/ingest/environment', {
      sensor_id: `ENV-A-${tag}`,
      entity_id: stA,
      event_time: new Date().toISOString(),
      temperature: 30,
      vibration: 2,
      noise: 70,
      air_quality: 40,
      source_type: 'real',
      record_id: `e2e-env-a-${tag}`,
      data_confidence: 0.9,
    });
    const envB = await ingest('/api/ingest/environment', {
      sensor_id: `ENV-B-${tag}`,
      entity_id: stA,
      event_time: new Date().toISOString(),
      temperature: 31,
      vibration: 2.2,
      noise: 72,
      air_quality: 42,
      source_type: 'real',
      record_id: `e2e-env-b-${tag}`,
      data_confidence: 0.9,
    });
    const envSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const area = (envSweep.body?.fused ?? []).find((f) => f.subjectId === `station:${stA}`);
    const tempChannel = (area?.ambient ?? []).find((c) => c.channel === 'temperature');
    step(
      '7b. 同工位两台环境传感器一致 → 区域主体 consistent + 代表值（同类多源交叉验证）',
      envA.body?.accepted === true
        && envB.body?.accepted === true
        && tempChannel?.agreement === 'consistent'
        && Math.abs(Number(tempChannel?.value) - 30.5) < 0.01
        && area?.agreement === 'consistent',
      `agreement=${tempChannel?.agreement} value=${tempChannel?.value} spread=${tempChannel?.spread} areaAgreement=${area?.agreement}`,
    );
    // 单台传感器（另一区域）→ single_source（不吹成"一致"）
    await ingest('/api/ingest/environment', {
      sensor_id: `ENV-C-${tag}`,
      entity_id: stB,
      event_time: new Date().toISOString(),
      noise: 95,
      source_type: 'real',
      record_id: `e2e-env-c-${tag}`,
    });
    const singleSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const areaB = (singleSweep.body?.fused ?? []).find((f) => f.subjectId === `station:${stB}`);
    const noiseChannel = (areaB?.ambient ?? []).find((c) => c.channel === 'noise');
    step(
      '7c. 单台传感器 → single_source（无第二个独立源确认）+ 超过关注阈值只报事实',
      noiseChannel?.agreement === 'single_source'
        && noiseChannel?.exceedsWatchThreshold === true
        && (areaB?.notes ?? []).some((n) => n.includes('由现场按规程决定')),
      `agreement=${noiseChannel?.agreement} exceeds=${noiseChannel?.exceedsWatchThreshold}`,
    );

    // ── 7d/7e. NO-58c：视觉骨架 → 躯干角（第二个独立角度源）─────────
    // otherPerson 的外骨骼报 30°；视觉骨架给"接近水平"的躯干 → 差值 ≥ 容差 → 角度冲突。
    // （action 用 standing 且外骨骼 30° < 45°，所以只有**数值规则**能命中，隔离验证。）
    // 躯干接近水平：肩中点 (305,150) → 髋中点 (115,160) ≈ 87°，与外骨骼 30° 相差 ~57°（> 容差 30°）。
    // 注：首版几何算出来只有 ~40°（差值 10°）→ 断言不成立，是**断言自伤**而非实现缺陷。
    const bentSkeleton = {
      left_shoulder: [300, 150, 0.9],
      right_shoulder: [310, 150, 0.9],
      left_hip: [100, 160, 0.9],
      right_hip: [130, 160, 0.9],
    };
    const cameraSkeleton = await ingest('/api/ingest/camera', {
      camera_id: camA,
      event_time: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-cam-skeleton-${tag}`,
      detections: [{
        track_id: otherPerson,
        class_name: 'person',
        confidence: 0.85,
        bbox: { x: 10, y: 20, w: 4, h: 8 },
        action: 'standing',
        skeleton: bentSkeleton,
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const skeletonSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const withSkeleton = (skeletonSweep.body?.fused ?? []).find((f) => f.subjectId === otherPerson);
    const pitchConflict = (withSkeleton?.conflicts ?? []).find((c) => c.dimension === 'posture');
    step(
      '7d. 视觉骨架换算躯干角 → 与外骨骼角度不一致即姿态角度冲突（两个独立角度源，各源都保留）',
      cameraSkeleton.body?.accepted === true
        && Boolean(pitchConflict)
        && String(pitchConflict?.detail ?? '').includes('姿态角度冲突')
        && (pitchConflict?.participants ?? []).some((p) => p.source === 'exo_imu')
        && (pitchConflict?.participants ?? []).some((p) => p.source === 'vision')
        && withSkeleton?.strongAdviceAllowed === false,
      `conflicts=${(withSkeleton?.conflicts ?? []).map((c) => c.dimension).join(',')} detail=${String(pitchConflict?.detail ?? '').slice(0, 60)}`,
    );

    // 骨架缺髋部要点 → 无法换算 → 如实记 note（不猜 0°、不产出姿态观测）
    await ingest('/api/ingest/camera', {
      camera_id: camA,
      event_time: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-cam-skeleton-bad-${tag}`,
      detections: [{
        track_id: otherPerson,
        class_name: 'person',
        confidence: 0.85,
        bbox: { x: 10, y: 20, w: 4, h: 8 },
        action: 'standing',
        skeleton: { left_shoulder: [100, 100, 0.9], right_shoulder: [140, 100, 0.9] },
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const badSkeletonSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const badSkeletonNotes = (badSkeletonSweep.body?.notes ?? []).join(' ');
    const badFused = (badSkeletonSweep.body?.fused ?? []).find((f) => f.subjectId === otherPerson);
    step(
      '7e. 骨架缺要点 → 不换算角度（如实写原因），且不再产生姿态角度冲突',
      badSkeletonNotes.includes('视觉骨架无法换算躯干角')
        && badSkeletonNotes.includes('left_hip')
        && (badFused?.conflicts ?? []).every((c) => c.dimension !== 'posture'),
      `notes=${badSkeletonNotes.slice(0, 80)} postureConflicts=${(badFused?.conflicts ?? []).filter((c) => c.dimension === 'posture').length}`,
    );

    // ── 7f. NO-58b 调度侧：不可信主体牵涉在飞任务 → 调度冲突面显式可见 ──
    // 只查"与在飞任务相关"的主体：这里给 person 建一条在飞任务（人 + 工位都在任务上），
    // 感知融合此刻对 person 是冲突态（步骤 5 的 UWB vs 相机绑定工位不一致仍在窗口内）。
    const conflictTaskId = randomUUID(); // ewoh_production_task.id 是 uuid（文本号会报 invalid input syntax for type uuid）
    await sql`
      insert into ewoh_production_task
        (id, org_id, title, task_type, priority, base_priority, status, source, spatial_entity_id,
         assignee_id, plan_start, plan_end)
      values (${conflictTaskId}::uuid, ${ORG}::uuid, ${`e2e fuse conflict ${tag}`}, 'production', 'high', 'P1',
              'executing', 'simulated', ${stA}, ${person}, now(), now() + interval '1 hour')
      on conflict (id) do nothing`;
    const conflictFace = await getJson('/api/scheduler/conflicts', leadToken);
    const perceptionConflicts = (conflictFace.body?.conflicts ?? []).filter((c) => c.type === 'perception_inconsistent');
    const forPerson = perceptionConflicts.find((c) => c.resourceId === person);
    step(
      '7f. 感知不可信进入调度冲突面（提示层）：资源/任务/依据齐全，且不阻断其它冲突',
      (conflictFace.status === 200 || conflictFace.status === 201)
        && Boolean(forPerson)
        && forPerson?.resourceType === 'person'
        && (forPerson?.taskIds ?? []).includes(conflictTaskId)
        && forPerson?.data?.factor === 'perception_fusion'
        && String(forPerson?.resolution ?? '').includes('不阻断调度')
        && String(forPerson?.message ?? '').includes('不可信'),
      `status=${conflictFace.status} perception=${perceptionConflicts.length} resource=${forPerson?.resourceId} tasks=${(forPerson?.taskIds ?? []).join(',')}`,
    );

    // ── 7g. NO-59a：外骨骼关节角 → 动作，与视觉动作交叉验证 ─────────────
    // 关节角一直被摄入却从未参与融合；这里用真实摄入通道喂膝角（直立），
    // 再让视觉报 squatting → 两个独立动作源结论相反 → 必须记动作冲突（各源保留）。
    const kneeExo = await ingest('/api/ingest/exoskeleton', {
      device_id: exoDevice,
      entity_id: otherPerson,
      event_time: new Date().toISOString(),
      source_type: 'real',
      sequence: 2,
      pose: { pitch_deg: 5, joint_angles_deg: { left_knee: 5, right_knee: 6 } },
      quality: { status: 'good', confidence: 0.9 },
      record_id: `e2e-exo-knee-${tag}`,
    });
    const squattingCamera = await ingest('/api/ingest/camera', {
      camera_id: camA,
      event_time: new Date().toISOString(),
      source_type: 'real',
      record_id: `e2e-cam-action-${tag}`,
      detections: [{
        track_id: otherPerson,
        class_name: 'person',
        confidence: 0.85,
        bbox: { x: 10, y: 20, w: 4, h: 8 },
        action: 'squatting',
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const actionSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const withAction = (actionSweep.body?.fused ?? []).find((f) => f.subjectId === otherPerson);
    const actionConflict = (withAction?.conflicts ?? []).find((c) => c.dimension === 'action');
    step(
      '7g. 关节角派生动作（外骨骼）与视觉动作相反 → 动作冲突（两个独立动作源，各源保留）',
      kneeExo.body?.accepted === true
        && squattingCamera.body?.accepted === true
        && Boolean(actionConflict)
        && String(actionConflict?.detail ?? '').includes('动作冲突')
        && (actionConflict?.participants ?? []).some((p) => p.source === 'exo_imu' && p.value === 'standing')
        && (actionConflict?.participants ?? []).some((p) => p.source === 'vision' && p.value === 'squatting')
        && withAction?.posture?.action === 'standing'
        && withAction?.strongAdviceAllowed === false,
      `conflicts=${(withAction?.conflicts ?? []).map((c) => c.dimension).join(',')} exoAction=${withAction?.posture?.action}`,
    );

    // 关节角判定不了（中间态）→ 不产出动作观测，如实写 note（不默认 standing）
    await ingest('/api/ingest/exoskeleton', {
      device_id: exoDevice,
      entity_id: otherPerson,
      event_time: new Date().toISOString(),
      source_type: 'real',
      sequence: 3,
      pose: { pitch_deg: 30, joint_angles_deg: { left_knee: 45, right_knee: 48 } },
      quality: { status: 'good', confidence: 0.9 },
      record_id: `e2e-exo-mid-${tag}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const midSweep = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const midNotes = (midSweep.body?.notes ?? []).join(' ');
    const midFused = (midSweep.body?.fused ?? []).find((f) => f.subjectId === otherPerson);
    step(
      '7h. 关节角落在中间态 → 不判定动作（如实写原因），也不再产生动作冲突',
      midNotes.includes('外骨骼关节角未产出动作判定')
        && midNotes.includes('中间态')
        && (midFused?.conflicts ?? []).every((c) => c.dimension !== 'action'),
      `notes=${midNotes.slice(0, 70)} actionConflicts=${(midFused?.conflicts ?? []).filter((c) => c.dimension === 'action').length}`,
    );

    // ── 8. 幂等 + 只读 ──────────────────────────────────────────────
    const before = await sql`
      select state_json from ewoh_world_state where org_id = ${ORG} and entity_id = ${person} order by ts desc limit 1`;
    const again = await sweep({ windowMinutes: 5, bucketMinutes: 5 });
    const after = await sql`
      select state_json from ewoh_world_state where org_id = ${ORG} and entity_id = ${person} order by ts desc limit 1`;
    step(
      '8. 幂等（created=0 且 refreshed≥1）且只读（世界状态行未被改写）',
      Number(again.body?.created ?? -1) === 0
        && Number(again.body?.refreshed ?? 0) >= 1
        && JSON.stringify(before[0]?.state_json) === JSON.stringify(after[0]?.state_json),
      `created=${again.body?.created} refreshed=${again.body?.refreshed}`,
    );

    // ── 9. 规则 4/7：过期证据 → 证据不足（不给分）────────────────────
    const stalePerson = `person:e2e-fuse-stale-${tag}`;
    await sql`
      insert into ewoh_spatial_entity (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type, confidence)
      values (${ORG}, ${stalePerson}, 'person', ${`e2e stale ${tag}`}, 10, 20, 'active', 'simulated', 'FACTORY_CARTESIAN', 1.0)
      on conflict (org_id, entity_id) do nothing`;
    seededEntities.push(stalePerson);
    const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
    await sql`
      insert into ewoh_world_state (org_id, entity_id, state_json, ts)
      values (${ORG}, ${stalePerson}, ${sql.json({ locator: 'uwb', x: 10, y: 20, z: 0, confidence: 0.9, record_id: `e2e-stale-${tag}`, source_type: 'real' })}, ${staleTs})`;
    const staleSweep = await sweep({ windowMinutes: 60, bucketMinutes: 5 });
    const stale = (staleSweep.body?.fused ?? []).find((f) => f.subjectId === stalePerson);
    step(
      '9. 规则 4/7：过期证据被排除 → insufficient + unknown + score=null（不显示成 0%）',
      stale?.agreement === 'insufficient'
        && stale?.confidence.level === 'unknown'
        && stale?.confidence.score === null
        && (stale?.confidence.excludedSources ?? []).some((e) => e.status === 'stale')
        && stale?.strongAdviceAllowed === false,
      `agreement=${stale?.agreement} level=${stale?.confidence?.level} score=${stale?.confidence?.score} excluded=${stale?.confidence?.excludedSources?.length}`,
    );

    // ── 10. 读取面：最新快照可按主体过滤 ────────────────────────────
    const list = await getJson(`/api/perception/fusion?subjectId=${encodeURIComponent(person)}`, leadToken);
    const row = Array.isArray(list.body) ? list.body[0] : null;
    step(
      '10. 读取面：按主体返回最新快照（含冲突明细与规则留痕）',
      list.status === 200
        && row?.subjectId === person
        && Array.isArray(row?.ruleTrace)
        && row.ruleTrace.length === 5,
      `status=${list.status} rules=${row?.ruleTrace?.length}`,
    );
  } finally {
    try {
      await sql`delete from ewoh_scheduling_conflict where org_id = ${ORG} and conflict_id like 'CFL-%' and type = 'perception_inconsistent' and resource_id = ${person}`;
      await sql`delete from ewoh_production_task where org_id = ${ORG}::uuid and title like ${`e2e fuse conflict ${tag}%`}`;
      await sql`delete from ewoh_perception_fusion where org_id = ${ORG} and subject_id like ${`person:e2e-fuse-%${tag}%`}`;
      await sql`delete from ewoh_world_state where org_id = ${ORG} and (entity_id like ${`%${tag}%`})`;
      await sql`delete from ewoh_environment where org_id = ${ORG} and sensor_id like ${`%-${tag}`}`;
      await sql`delete from ewoh_telemetry where org_id = ${ORG} and entity_id like ${`%${tag}%`}`;
      for (const entityId of seededEntities) {
        await sql`delete from ewoh_spatial_entity where org_id = ${ORG} and entity_id = ${entityId}`;
      }
    } catch (error) {
      console.warn(`[cleanup] 清理失败（不掩盖断言结果）：${error?.message ?? error}`);
    }
    await sql.end().catch(() => undefined);
  }
  return finish();
}

/** 同窗口重复融合不应产生第二行（每个主体一条快照）。 */
function expectSingleSnapshot(result, subjectId) {
  const rows = (result.body?.fused ?? []).filter((f) => f.subjectId === subjectId);
  step(
    '4b. 幂等快照号：同一窗口同一主体只产生一条快照',
    rows.length === 1 && Number(result.body?.created ?? 0) >= 1,
    `rows=${rows.length} created=${result.body?.created}`,
  );
}

main().catch((error) => {
  console.error('E2E 执行异常:', error);
  record('FAIL', 'E2E 脚本异常', String(error?.message ?? error));
  finish();
});
