/* SensorIngestService 单元测试（P1-Ingest decomposition）。
 *
 * 覆盖 environment / camera / spatial scan / location 四类传感器 ingest 的
 * 独立落库路径（从 IngestService 抽出后行为不变）。
 */
import { SensorIngestService } from '@server/modules/ingest/sensor-ingest.service';
import {
  ewohEnvironment,
  ewohWorldState,
  ewohSpatialEntity,
  ewohIdempotencyKeys,
  ewohDevice,
  ewohDeviceCapability,
} from '@server/database/schema';
import { validateCapability } from '@shared/capability';

function createDb(opts: { claimAccepted?: boolean; writeFails?: boolean; deviceRegistrationFails?: boolean } = {}) {
  const insertCalls: Array<{ table: unknown; rows: unknown[] }> = [];
  const deleteCalls: Array<Record<string, unknown>> = [];
  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((rows: unknown[]) => {
        insertCalls.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        if (table === ewohIdempotencyKeys) {
          // 传输级幂等认领：返回行 = 首次投递；空数组 = 重复投递。
          return {
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue(
                opts.claimAccepted === false ? [] : [{ id: '11111111-1111-4111-8111-111111111111' }],
              ),
            })),
          };
        }
        if (opts.deviceRegistrationFails && table === ewohDevice) {
          return {
            onConflictDoUpdate: jest.fn().mockRejectedValue(new Error('device registry down')),
          };
        }
        if (opts.writeFails) {
          return {
            then: (_resolve: unknown, reject: (e: Error) => void) => reject(new Error('pg write failed')),
          };
        }
        return {
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        };
      }),
    })),
    delete: jest.fn(() => ({
      where: jest.fn((cond: unknown) => {
        deleteCalls.push({ cond });
        return Promise.resolve([]);
      }),
    })),
  };
  return { db, insertCalls, deleteCalls };
}

describe('SensorIngestService', () => {
  it('ingestEnvironment 写入 ewoh_environment', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestEnvironment(
      {
        sensor_id: 'SEN-1',
        event_time: new Date().toISOString(),
        temperature: 25.5,
        source_type: 'real',
      },
      'ORG-1',
    );

    expect(res.accepted).toBe(true);
    const envInsert = insertCalls.find((c) => c.table === ewohEnvironment);
    expect(envInsert).toBeDefined();
    expect((envInsert!.rows[0] as Record<string, unknown>).sensorId).toBe('SEN-1');
    // NO-13aa（ADR-075 续）：环境行归属注入。
    expect((envInsert!.rows[0] as Record<string, unknown>).orgId).toBe('ORG-1');
  });

  it('ingestEnvironment 有 org → 行归属注入；无 org → fail-closed 拒绝（R2-SOP-022）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestEnvironment(
      {
        sensor_id: 'SEN-2',
        event_time: new Date().toISOString(),
        temperature: 21,
        source_type: 'real',
      },
      'ORG-1',
    );
    // R2-SOP-022：org 缺失显式拒绝——不再静默写 NULL=legacy 全租户可见行。
    const noOrg = await svc.ingestEnvironment({
      sensor_id: 'SEN-3',
      event_time: new Date().toISOString(),
      temperature: 22,
      source_type: 'real',
    });
    const withOrg = insertCalls.find((c) => c.table === ewohEnvironment && (c.rows[0] as Record<string, unknown>).sensorId === 'SEN-2');
    const sen3Insert = insertCalls.find((c) => c.table === ewohEnvironment && (c.rows[0] as Record<string, unknown>).sensorId === 'SEN-3');
    expect((withOrg!.rows[0] as Record<string, unknown>).orgId).toBe('ORG-1');
    expect(noOrg.accepted).toBe(false);
    expect(noOrg.data_quality).toBe('invalid');
    expect(sen3Insert).toBeUndefined();
  });

  it('ingestCamera 写入 ewoh_world_state（每个 detection 一条）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestCamera(
      {
        camera_id: 'CAM-1',
        event_time: new Date().toISOString(),
        detections: [
          { class_name: 'person', confidence: 0.9 },
          { class_name: 'person', confidence: 0.8, track_id: 'T-2' },
        ],
        record_id: 'rec-cam-trace',
      },
      // W4：世界态写入显式租户上下文（缺省 fail-closed 拒绝）。
      'ORG-1',
    );

    expect(res.accepted).toBe(true);
    const wsInsert = insertCalls.find((c) => c.table === ewohWorldState);
    expect(wsInsert!.rows).toHaveLength(2);
    expect((wsInsert!.rows[0] as Record<string, unknown>).orgId).toBe('ORG-1');
  });

  it('ingestSpatialScan upsert ewoh_spatial_entity', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestSpatialScan(
      {
        entity_id: 'WS-1',
        entity_type: 'workstation',
        source_type: 'real' as never,
        x: 10,
        y: 20,
      },
      'ORG-1',
    );

    expect(res.accepted).toBe(true);
    const entInsert = insertCalls.find((c) => c.table === ewohSpatialEntity);
    expect(entInsert).toBeDefined();
    expect((entInsert!.rows[0] as Record<string, unknown>).entityId).toBe('WS-1');
  });

  it('world_state 行保留 record_id（幂等键可追溯，重放不双写可事后核对）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestCamera(
      {
        camera_id: 'CAM-TRACE',
        event_time: new Date().toISOString(),
        detections: [{ class_name: 'person', confidence: 0.9 }],
        record_id: 'rec-trace-cam',
      },
      'ORG-1',
    );
    await svc.ingestLocation(
      {
        entity_id: 'person:p1', locator: 'uwb', confidence: 0.9, x: 1, y: 2,
        ts: new Date().toISOString(), record_id: 'rec-trace-loc',
      },
      'ORG-1',
    );
    const rows = insertCalls.filter((c) => c.table === ewohWorldState).flatMap((c) => c.rows);
    const ids = rows.map((r) => (r as { stateJson: Record<string, unknown> }).stateJson.record_id);
    expect(ids).toEqual(['rec-trace-cam', 'rec-trace-loc']);
  });

  it('ingestLocation 写入 ewoh_world_state（定位状态快照）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestLocation(
      {
        entity_id: 'P-1',
        locator: 'uwb',
        confidence: 0.9,
        x: 5,
        y: 6,
        ts: new Date().toISOString(),
      },
      'ORG-1',
    );

    expect(res.accepted).toBe(true);
    const wsInsert = insertCalls.find((c) => c.table === ewohWorldState);
    expect(wsInsert).toBeDefined();
    const state = (wsInsert!.rows[0] as Record<string, unknown>).stateJson as Record<string, unknown>;
    expect(state.locator).toBe('uwb');
  });

  it('DB 失败 → accepted=false 且不抛异常', async () => {
    const db = {
      insert: jest.fn(() => {
        throw new Error('db down');
      }),
    };
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestEnvironment({
      sensor_id: 'SEN-X',
      event_time: new Date().toISOString(),
    });

    expect(res.accepted).toBe(false);
    expect(res.data_quality).toBe('invalid');
  });

  /* ------------------------------------------------------------------
   * 传输级幂等（2026-09-10 边缘韧性收口）：边缘上行是 at-least-once
   * （断网缓冲补传 / 失败重试），三条传感器路径此前无去重——
   * 重放会把同一次观测写成两行。以下用例把「重放不双写」钉死。
   * ------------------------------------------------------------------ */
  it('environment 重放同一 record_id → skipped 且不再写库（dedup by (org, scope, record_id)）', async () => {
    const { db, insertCalls } = createDb({ claimAccepted: false });
    const svc = new SensorIngestService(db as never);
    const res = await svc.ingestEnvironment(
      { sensor_id: 'SEN-DUP', event_time: new Date().toISOString(), temperature: 20, record_id: 'rec-1' },
      'ORG-1',
    );
    expect(res).toMatchObject({ accepted: false, skipped: true, record_id: 'rec-1', events_triggered: 0 });
    // 关键：重复投递绝不写业务表
    expect(insertCalls.find((c) => c.table === ewohEnvironment)).toBeUndefined();
    // 认领按 (org, scope=ingest:environment, key=record_id) 维度
    const claim = insertCalls.find((c) => c.table === ewohIdempotencyKeys);
    expect(claim!.rows[0]).toMatchObject({ orgId: 'ORG-1', scope: 'ingest:environment', idempotencyKey: 'rec-1' });
  });

  it('environment 首次投递 → 认领 + 写库；写入失败 → 释放认领（不把瞬时错误永久判为已处理）', async () => {
    const first = createDb();
    const okSvc = new SensorIngestService(first.db as never);
    const ok = await okSvc.ingestEnvironment(
      { sensor_id: 'SEN-OK', event_time: new Date().toISOString(), temperature: 20, record_id: 'rec-2' },
      'ORG-1',
    );
    expect(ok.accepted).toBe(true);
    expect(first.deleteCalls).toHaveLength(0);

    const failing = createDb({ writeFails: true });
    const failSvc = new SensorIngestService(failing.db as never);
    const failed = await failSvc.ingestEnvironment(
      { sensor_id: 'SEN-FAIL', event_time: new Date().toISOString(), temperature: 20, record_id: 'rec-3' },
      'ORG-1',
    );
    expect(failed).toMatchObject({ accepted: false, data_quality: 'invalid' });
    // 释放认领：否则边缘重试同一 record_id 会被永久跳过 → 数据静默丢失
    expect(failing.deleteCalls).toHaveLength(1);
  });

  it('camera / location 同样按 scope 去重（不同路径的 record_id 互不抑制）', async () => {
    const dup = createDb({ claimAccepted: false });
    const dupSvc = new SensorIngestService(dup.db as never);

    const cam = await dupSvc.ingestCamera(
      { camera_id: 'CAM-1', event_time: new Date().toISOString(), detections: [{ class_name: 'person', confidence: 0.9 }], record_id: 'rec-x' },
      'ORG-1',
    );
    expect(cam).toMatchObject({ accepted: false, skipped: true });
    expect(dup.insertCalls.find((c) => c.table === ewohWorldState)).toBeUndefined();

    const loc = await dupSvc.ingestLocation(
      { entity_id: 'person:p1', locator: 'uwb', confidence: 0.9, x: 1, y: 2, ts: new Date().toISOString(), record_id: 'rec-x' },
      'ORG-1',
    );
    expect(loc).toMatchObject({ accepted: false, skipped: true });

    const scopes = dup.insertCalls
      .filter((c) => c.table === ewohIdempotencyKeys)
      .map((c) => (c.rows[0] as Record<string, unknown>).scope);
    // 同名 record_id 在两条路径下各自独立认领（scope 区分键空间）
    expect(scopes).toEqual(['ingest:camera', 'ingest:location']);
  });

  it('location 非法坐标不占用 record_id（先校验后认领，重试仍可写）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    const res = await svc.ingestLocation(
      { entity_id: 'person:p1', locator: 'uwb', confidence: 0.9, x: Number.NaN, y: 2, ts: new Date().toISOString(), record_id: 'rec-nan' },
      'ORG-1',
    );
    expect(res).toMatchObject({ accepted: false, data_quality: 'invalid' });
    expect(insertCalls.find((c) => c.table === ewohIdempotencyKeys)).toBeUndefined();
  });

  /* ------------------------------------------------------------------
   * 时间语义（ADR-009 口径，阈值复用 @shared/event-envelope 常量）：
   * - 迟到（>10min）标记不丢弃，质量降级为 degraded 并回传 is_late；
   * - 未来时间戳（超前 >5min）是坏时钟而非"晚到的数据"：显式拒绝写入
   *   （定位尤其敏感——世界状态按 ts 取最新位置，未来戳会让陈旧位置长期占位）。
   * ------------------------------------------------------------------ */
  it('迟到帧：标记 is_late + 质量 degraded，仍然落库（ADR-009 不丢弃）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    const lateTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const res = await svc.ingestEnvironment(
      { sensor_id: 'SEN-LATE', event_time: lateTs, temperature: 20, record_id: 'rec-late' },
      'ORG-1',
    );
    expect(res).toMatchObject({ accepted: true, is_late: true, clock_drift: false, data_quality: 'degraded' });
    expect(insertCalls.find((c) => c.table === ewohEnvironment)).toBeDefined();
  });

  it('未来时间戳（时钟漂移超容差）：三条路径都拒绝写入且不占用 record_id', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    const futureTs = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const env = await svc.ingestEnvironment(
      { sensor_id: 'SEN-FUT', event_time: futureTs, temperature: 20, record_id: 'rec-fut-env' },
      'ORG-1',
    );
    const cam = await svc.ingestCamera(
      { camera_id: 'CAM-FUT', event_time: futureTs, detections: [{ class_name: 'person', confidence: 0.9 }], record_id: 'rec-fut-cam' },
      'ORG-1',
    );
    const loc = await svc.ingestLocation(
      { entity_id: 'person:p1', locator: 'uwb', confidence: 0.9, x: 1, y: 2, ts: futureTs, record_id: 'rec-fut-loc' },
      'ORG-1',
    );

    for (const res of [env, cam, loc]) {
      expect(res).toMatchObject({ accepted: false, data_quality: 'invalid', clock_drift: true });
      expect(String(res.error)).toContain('CLOCK_DRIFT_FUTURE_TS');
    }
    expect(insertCalls.find((c) => c.table === ewohEnvironment)).toBeUndefined();
    expect(insertCalls.find((c) => c.table === ewohWorldState)).toBeUndefined();
    // 拒绝帧不得占用 record_id（无幂等认领），修复时钟后重试仍可写入
    expect(insertCalls.find((c) => c.table === ewohIdempotencyKeys)).toBeUndefined();
  });

  /* ------------------------------------------------------------------
   * 感知层入设备台账（2026-09-10）：平台 ewoh_device 此前只有外骨骼，
   * 环境/摄像头/定位设备即使数据入库也不在台账里（设备页/在线率看不到）。
   * ------------------------------------------------------------------ */
  it('环境/摄像头/定位摄入都登记设备台账（类别由 kind 唯一映射）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestEnvironment(
      { sensor_id: 'ENV-TOP', event_time: new Date().toISOString(), temperature: 20, record_id: 'r-env' },
      'ORG-1',
    );
    await svc.ingestCamera(
      { camera_id: 'CAM-TOP', event_time: new Date().toISOString(), detections: [{ class_name: 'person', confidence: 0.9 }], record_id: 'r-cam' },
      'ORG-1',
    );
    await svc.ingestLocation(
      { entity_id: 'person:p1', tag_id: 'TAG-TOP', locator: 'uwb', confidence: 0.9, x: 1, y: 2, ts: new Date().toISOString(), record_id: 'r-loc' },
      'ORG-1',
    );

    const devices = insertCalls.filter((c) => c.table === ewohDevice).map((c) => c.rows[0] as Record<string, unknown>);
    expect(devices.map((d) => [d.deviceId, d.deviceCategory, d.orgId, d.online])).toEqual([
      ['ENV-TOP', 'environment_sensor', 'ORG-1', true],
      ['CAM-TOP', 'camera', 'ORG-1', true],
      // 物理标签 id 优先（tag_id）——否则"哪个硬件报的"无从追溯
      ['TAG-TOP', 'location_tag', 'ORG-1', true],
    ]);
    // 传感器没有电池：**显式**写 NULL（列默认 100，省略会被 DB 默认值填成"满电"）
    for (const d of devices) expect(d.batteryPct).toBeNull();
  });

  it('定位帧缺 tag_id 时以 entity_id 兜底登记（台账不留空档）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestLocation(
      { entity_id: 'person:p9', locator: 'uwb', confidence: 0.9, x: 1, y: 2, ts: new Date().toISOString(), record_id: 'r-loc2' },
      'ORG-1',
    );
    const device = insertCalls.find((c) => c.table === ewohDevice)!.rows[0] as Record<string, unknown>;
    expect(device.deviceId).toBe('person:p9');
    expect(device.deviceCategory).toBe('location_tag');
  });

  it('被拒帧（坏时钟）不登记设备；重复帧也不重复登记', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestEnvironment(
      {
        sensor_id: 'ENV-FUT2', event_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        temperature: 20, record_id: 'r-fut',
      },
      'ORG-1',
    );
    expect(insertCalls.find((c) => c.table === ewohDevice)).toBeUndefined();

    const dup = createDb({ claimAccepted: false });
    const dupSvc = new SensorIngestService(dup.db as never);
    await dupSvc.ingestEnvironment(
      { sensor_id: 'ENV-DUP2', event_time: new Date().toISOString(), temperature: 20, record_id: 'r-dup' },
      'ORG-1',
    );
    expect(dup.insertCalls.find((c) => c.table === ewohDevice)).toBeUndefined();
  });

  it('设备登记失败不阻断数据落库（显式留痕，不静默）', async () => {
    const { db, insertCalls } = createDb({ deviceRegistrationFails: true });
    const svc = new SensorIngestService(db as never);
    const res = await svc.ingestEnvironment(
      { sensor_id: 'ENV-REGFAIL', event_time: new Date().toISOString(), temperature: 20, record_id: 'r-regfail' },
      'ORG-1',
    );
    // 数据优先：帧仍然入库（台账缺口靠日志可查）
    expect(res.accepted).toBe(true);
    expect(insertCalls.find((c) => c.table === ewohEnvironment)).toBeDefined();
  });

  /* ------------------------------------------------------------------
   * 能力模型（2026-09-10）：DDL 早有 ewoh_device_capability 但从无写入方
   * （实测 0 行）——世界模型不知道设备能观测什么。以下把"按类别声明、
   * 幂等、未登记类别不声张"钉死。
   * ------------------------------------------------------------------ */
  it('按类别声明能力：环境传感器声明 4 项观测能力', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestEnvironment(
      { sensor_id: 'ENV-CAP', event_time: new Date().toISOString(), temperature: 20, record_id: 'r-cap' },
      'ORG-1',
    );
    const caps = insertCalls
      .filter((c) => c.table === ewohDeviceCapability)
      .map((c) => c.rows[0] as Record<string, unknown>);
    expect(caps.map((c) => c.capabilityKey).sort()).toEqual([
      'observe.air_quality',
      'observe.noise',
      'observe.temperature',
      'observe.vibration',
    ]);
    for (const cap of caps) {
      expect(cap.orgId).toBe('ORG-1');
      expect(cap.deviceId).toBe('ENV-CAP');
      // 权威契约 kind（ADR-043）：设备能力 = device_capability
      expect(cap.capabilityType).toBe('device_capability');
      expect(cap.status).toBe('active');
      // 能力声明必须带来源字段与权威投影（subject/providerType/mode）
      const value = cap.capabilityValue as { fields: string[]; subject: string; providerType: string; mode: string };
      expect(value.fields.length).toBeGreaterThan(0);
      expect(value.providerType).toBe('device');
      expect(value.mode).toBe('observation');
      // 权威 subject 形状：<prefix>:<value>（前缀小写，值保留业务号原样大小写——
      // 身份不得被归一化改写，见 NO-14f）
      expect(value.subject).toBe('device:ENV-CAP');
      expect(value.subject).toMatch(/^[a-z0-9_]+:.+$/);
      // capabilityId 是确定性 id（cap:<subject>:<name>），满足契约 pattern
      expect(String(cap.capabilityId)).toBe(`cap:device:ENV-CAP:${String(cap.capabilityKey)}`);
    }
  });

  it('摄像头/定位标签各自声明自己的能力（互不串味）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestCamera(
      { camera_id: 'CAM-CAP', event_time: new Date().toISOString(), detections: [{ class_name: 'person', confidence: 0.9 }], record_id: 'r-cap2' },
      'ORG-1',
    );
    await svc.ingestLocation(
      { entity_id: 'person:p1', tag_id: 'TAG-CAP', locator: 'uwb', confidence: 0.9, x: 1, y: 2, ts: new Date().toISOString(), record_id: 'r-cap3' },
      'ORG-1',
    );
    const byDevice = new Map<string, string[]>();
    for (const call of insertCalls.filter((c) => c.table === ewohDeviceCapability)) {
      const row = call.rows[0] as Record<string, unknown>;
      const list = byDevice.get(String(row.deviceId)) ?? [];
      list.push(String(row.capabilityKey));
      byDevice.set(String(row.deviceId), list);
    }
    expect(byDevice.get('CAM-CAP')?.sort()).toEqual([
      'observe.action',
      'observe.person_detection',
      'observe.pose',
    ]);
    expect(byDevice.get('TAG-CAP')).toEqual(['observe.position']);

    // 权威 kind 逐行核对（摄像头/定位都是 device_capability）
    const kinds = insertCalls
      .filter((c) => c.table === ewohDeviceCapability)
      .map((c) => String((c.rows[0] as Record<string, unknown>).capabilityType));
    expect([...new Set(kinds)]).toEqual(['device_capability']);
  });

  it('写入台账前用权威契约校验：记录必须通过 validateCapability（fail-closed）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestEnvironment(
      { sensor_id: 'ENV-CONTRACT', event_time: new Date().toISOString(), temperature: 20, record_id: 'r-contract' },
      'ORG-1',
    );
    const rows = insertCalls
      .filter((c) => c.table === ewohDeviceCapability)
      .map((c) => c.rows[0] as Record<string, unknown>);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const value = row.capabilityValue as { subject: string; providerType: string; evidence: string[] };
      const record = {
        capabilityId: String(row.capabilityId),
        kind: String(row.capabilityType),
        name: String(row.capabilityKey),
        providerType: value.providerType,
        subject: value.subject,
        grantedAt: (row.effectiveFrom as Date).toISOString(),
        evidence: value.evidence,
        auditTrail: true,
      };
      // 与写路径同一校验器：台账行必须能被权威契约重新读回（无漂移）
      expect(validateCapability(record)).toEqual([]);
    }
  });

  it('被拒帧不声明能力（坏时钟）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    await svc.ingestEnvironment(
      {
        sensor_id: 'ENV-CAP-FUT', event_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        temperature: 20, record_id: 'r-cap-fut',
      },
      'ORG-1',
    );
    expect(insertCalls.find((c) => c.table === ewohDeviceCapability)).toBeUndefined();
  });

  it('未登记类别不声明任何能力（宁可能力为空，也不猜它能看什么）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    const declared = await svc.declareDeviceCapabilities({
      orgId: 'ORG-1', deviceId: 'MYSTERY-1', category: 'unknown', at: new Date(),
    });
    expect(declared).toBe(0);
    expect(insertCalls.filter((c) => c.table === ewohDeviceCapability)).toHaveLength(0);
  });
});

/* ── NO-59b：执行机构（AGV/PLC）状态帧上行 ────────────────────────────── */

describe('SensorIngestService 执行机构接入（NO-59b）', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const baseFrame = {
    device_id: 'AGV-01',
    // 相对当前时刻（固定字面量会随"现在"漂成未来时间戳 → 被时钟漂移守卫拒绝）
    event_time: new Date(Date.now() - 5_000).toISOString(),
    state: 'moving' as const,
    x: 1.5,
    y: 2.5,
    battery_pct: 88,
    current_task_id: 'T-9',
    target_station_id: 'ST-1',
    last_authorization_ref: 'control:CR-9',
    record_id: 'ACT-1',
    source_type: 'simulated' as const,
  };

  it('写入 ewoh_world_state（state_json.actuator）+ 登记设备与能力', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestActuator(baseFrame, ORG);

    expect(res.accepted).toBe(true);
    const worldRow = insertCalls.find((c) => c.table === ewohWorldState);
    expect(worldRow).toBeTruthy();
    const row = worldRow!.rows[0] as Record<string, unknown>;
    expect(row.entityId).toBe('AGV-01');
    expect(row.orgId).toBe(ORG);
    const state = row.stateJson as Record<string, unknown>;
    expect(state.actuator).toBe(true);
    expect(state.state).toBe('moving');
    expect(state.target_station_id).toBe('ST-1');
    // 命令可追溯：最后一次被接受的授权号随状态下行留痕
    expect(state.last_authorization_ref).toBe('control:CR-9');

    // 设备登记 + 能力声明（类别 agv → transport.move / observe.actuator_state / observe.position）
    const deviceRow = insertCalls.find((c) => c.table === ewohDevice);
    expect((deviceRow!.rows[0] as Record<string, unknown>).deviceCategory).toBe('agv');
    const capabilityRows = insertCalls
      .filter((c) => c.table === ewohDeviceCapability)
      .flatMap((c) => c.rows) as Array<Record<string, unknown>>;
    expect(capabilityRows.map((r) => r.capabilityKey).sort()).toEqual(
      ['observe.actuator_state', 'observe.position', 'transport.move'],
    );
  });

  it('状态投影到设备台账：位置/电量/故障码/在线（NO-61a）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestActuator({ ...baseFrame, battery_pct: 87.6, x: 12, y: 7 }, ORG);

    expect(res.accepted).toBe(true);
    // 设备表被写两次：① 设备登记（registerSensorDevice）② 状态投影（NO-61a）
    const deviceInserts = insertCalls.filter((c) => c.table === ewohDevice);
    expect(deviceInserts).toHaveLength(2);
    const projected = deviceInserts[1].rows[0] as Record<string, unknown>;
    expect(projected).toMatchObject({
      deviceId: 'AGV-01',
      deviceCategory: 'agv',
      batteryPct: 88,                 // 四舍五入到整数（列是 integer）
      locationLat: 12,
      locationLng: 7,
      locationCoordinateType: 'FACTORY_CARTESIAN',
      faultCode: null,                // 非故障帧 → 清空（故障解除是事实）
      online: true,
    });
  });

  it('故障态帧 → 设备台账记故障码（调度据此不派工）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    await svc.ingestActuator({ ...baseFrame, state: 'fault' as never, fault_code: 'LOW_BATTERY' }, ORG);

    const projected = insertCalls.filter((c) => c.table === ewohDevice).slice(-1)[0].rows[0] as Record<string, unknown>;
    expect(projected.faultCode).toBe('LOW_BATTERY');
    const worldRow = insertCalls.find((c) => c.table === ewohWorldState)!.rows[0] as Record<string, unknown>;
    expect((worldRow.stateJson as Record<string, unknown>).fault_code).toBe('LOW_BATTERY');
  });

  it('未知状态 → 拒绝并回显词表（不许默认 idle 假装在线）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestActuator({ ...baseFrame, state: 'teleporting' as never }, ORG);

    expect(res.accepted).toBe(false);
    expect(res.error).toContain('UNKNOWN_ACTUATOR_STATE');
    expect(res.error).toContain('teleporting');
    expect(insertCalls).toHaveLength(0);
  });

  it('缺 device_id / event_time → 拒绝（不写半条事实）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const noDevice = await svc.ingestActuator({ ...baseFrame, device_id: '  ' }, ORG);
    const noTime = await svc.ingestActuator({ ...baseFrame, event_time: '' }, ORG);

    expect(noDevice.accepted).toBe(false);
    expect(noTime.accepted).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });

  it('无租户上下文 → fail-closed 拒绝（不静默写全局可见行）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestActuator(baseFrame, null);

    expect(res.accepted).toBe(false);
    expect(res.error).toContain('租户上下文缺失');
    expect(insertCalls).toHaveLength(0);
  });

  it('未来时间戳（时钟漂移）→ 拒绝（不污染新鲜度与"最新一条"语义）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await svc.ingestActuator({ ...baseFrame, event_time: future }, ORG);

    expect(res.accepted).toBe(false);
    expect(res.error).toContain('CLOCK_DRIFT_FUTURE_TS');
    expect(insertCalls).toHaveLength(0);
  });

  it('同 record_id 重放 → 幂等跳过（边缘 at-least-once）', async () => {
    const { db, insertCalls } = createDb({ claimAccepted: false });
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestActuator(baseFrame, ORG);

    // 平台既有重复语义：accepted=false + skipped=true（重放不再写行，也不算失败）
    expect(res.accepted).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.data_quality).toBe('good');
    expect(insertCalls.filter((c) => c.table === ewohWorldState)).toHaveLength(0);
  });
});
