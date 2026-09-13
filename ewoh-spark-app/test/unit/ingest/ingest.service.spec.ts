import { BadRequestException } from '@nestjs/common';
import { IngestService } from '../../../server/modules/ingest/ingest.service';
import {
  ewohDevice,
  ewohEvent,
  ewohSpatialEntity,
  ewohTelemetry,
  ewohIngestEventDedup,
  ewohNotification,
} from '@server/database/schema';

function createIngestDb(selectResults: unknown[][]) {
  const insertRows: Array<{
    table: unknown;
    row: Record<string, unknown>;
  }> = [];
  let selectCall = 0;
  const selectLimit = jest.fn().mockImplementation(() =>
    Promise.resolve(
      selectResults[Math.min(selectCall++, selectResults.length - 1)] ?? [],
    ),
  );
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: selectLimit })),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        return { onConflictDoUpdate: jest.fn().mockResolvedValue([]) };
      }),
    })),
  };
  return { db, insertRows, selectLimit };
}

function createRuleEngine() {
  return {
    evaluate: jest.fn().mockResolvedValue(2),
  };
}

/** ADR-004：MesService mock（ingestMes 转发到 createWorkOrder）。 */
function createMesService() {
  return {
    createWorkOrder: jest.fn().mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-TEST' }, steps: [], materials: [] }),
  };
}

/** P1-Ingest decomposition：SensorIngestService mock（environment/camera/spatial/location）。 */
function createSensorIngest() {
  return {
    ingestEnvironment: jest.fn().mockResolvedValue({ accepted: true, record_id: 'env-1' }),
    ingestCamera: jest.fn().mockResolvedValue({ accepted: true, record_id: 'cam-1' }),
    ingestSpatialScan: jest.fn().mockResolvedValue({ accepted: true, record_id: 'scan-1' }),
    ingestLocation: jest.fn().mockResolvedValue({ accepted: true, record_id: 'loc-1' }),
  };
}

/** v0.7 B1：ReplanCoordinatorService mock（IngestService 构造参数 #5，设备离线局部重排）。 */
function createReplanCoordinator() {
  return {
    handleTrigger: jest.fn().mockResolvedValue({ ok: true, runId: 'RUN-REPLAN' }),
  };
}

/** ADR-006 / NO-02b：IdentityService mock（构造参数 #6；默认未映射 → legacy 行为）。 */
function createIdentityService() {
  return {
    resolveMapping: jest.fn().mockResolvedValue(null),
    resolveBatch: jest.fn().mockResolvedValue(new Map<string, string>()),
  };
}

describe('IngestService canonical UnifiedExoFrame mapping', () => {
  it('maps nested pose/load/device/quality fields into telemetry and device rows', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const ruleEngine = createRuleEngine();
    const service = new IngestService(
      db as never,
      ruleEngine as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-INGEST-1',
      event_time: new Date().toISOString(),
      source_type: 'real',
      pose: {
        trunk_pitch_deg: 50,
        angular_velocity_dps: 12.3,
        joint_angles_deg: { left_knee: 45 },
      },
      load: {
        assist_level: 0.6,
        torque_nm: 18.5,
        cumulative_load_score: 0.85,
      },
      device: {
        battery_pct: 88,
        temperature_c: 36.5,
        fault_code: null,
      },
      quality: {
        packet_loss_pct: 1.2,
        confidence: 0.95,
        status: 'good',
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.data_quality).toBe('good');
    const telemetry = insertRows.find(
      (entry) => entry.table === ewohTelemetry,
    )?.row;
    expect(telemetry?.deviceId).toBe('EXO-INGEST-1');
    expect(telemetry?.pitchDeg).toBe(50);
    expect(telemetry?.loadScore).toBe(0.85);
    expect(telemetry?.batteryPct).toBe(88);
    expect(telemetry?.assistLevel).toBe(0.6);
    expect(telemetry?.torqueNm).toBe(18.5);
    expect(telemetry?.angularVelocityDps).toBe(12.3);
    expect(telemetry?.temperatureC).toBe(36.5);
    expect(telemetry?.dataConfidence).toBe(0.95);
    expect(telemetry?.dataQuality).toBe('good');
    expect(telemetry?.sourceType).toBe('real');

    const device = insertRows.find((entry) => entry.table === ewohDevice)?.row;
    expect(device?.deviceId).toBe('EXO-INGEST-1');
    expect(device?.batteryPct).toBe(88);
    expect(device?.sourceType).toBe('real');
    expect(ruleEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'EXO-INGEST-1',
        pitchDeg: 50,
        loadScore: 0.85,
        batteryPct: 88,
      }),
    );
  });

  it('边缘方言：pose.pitch_deg 与帧内 entity_id 必须落库（2026-09-12 实测缺陷回归）', async () => {
    // 缺陷背景：mapper 只认 `pose.trunk_pitch_deg`，而边缘模拟器/桩与部分直连设备用
    // `pose.pitch_deg` → 俯仰角静默落 NULL；单帧路径又把 entity_id 无条件覆盖成
    // 身份映射结果（未登记映射时写 NULL）→"谁被佩戴"永久丢失，感知融合只能报"缺外骨骼源"。
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      device_id: 'EXO-DIALECT-1',
      entity_id: 'person:P-DIALECT',
      worker_id: 'worker.zhangwei',
      event_time: new Date().toISOString(),
      source_type: 'real',
      pose: { pitch_deg: 28.4, joint_angles_deg: { left_knee: 45 } },
    });

    expect(result.accepted).toBe(true);
    const telemetry = insertRows.find((entry) => entry.table === ewohTelemetry)?.row;
    expect(telemetry?.pitchDeg).toBe(28.4);
    expect(telemetry?.entityId).toBe('person:P-DIALECT');
    expect(telemetry?.workerId).toBe('worker.zhangwei');
    expect(telemetry?.deviceId).toBe('EXO-DIALECT-1');
  });

  it('规范字段仍然优先：trunk_pitch_deg 覆盖同名别名', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );
    await service.ingestExoskeleton({
      device_id: 'EXO-DIALECT-2',
      entity_id: 'person:P-DIALECT-2',
      event_time: new Date().toISOString(),
      pose: { pitch_deg: 10, trunk_pitch_deg: 50 },
      pitch_deg: 5,
    });
    const telemetry = insertRows.find((entry) => entry.table === ewohTelemetry)?.row;
    // 规范字段（trunk_pitch_deg）优先于别名（pose.pitch_deg / 顶层 pitch_deg）
    expect(telemetry?.pitchDeg).toBe(50);
  });

  it('normalizes a legacy 0-100 load_score to 0-1', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    await service.ingestExoskeleton({
      device_id: 'EXO-LEGACY',
      entity_id: 'EXO-LEGACY',
      event_time: new Date().toISOString(),
      load_score: 80,
      pitch_deg: 12,
      battery_pct: 90,
    });

    const telemetry = insertRows.find(
      (entry) => entry.table === ewohTelemetry,
    )?.row;
    expect(telemetry?.loadScore).toBe(0.8);
    expect(telemetry?.pitchDeg).toBe(12);
  });

  it('marks battery out of range as invalid and still persists the row', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-BAD-BATTERY',
      event_time: new Date().toISOString(),
      device: { battery_pct: 150 },
    });

    expect(result.accepted).toBe(true);
    expect(result.data_quality).toBe('invalid');
    const telemetry = insertRows.find(
      (entry) => entry.table === ewohTelemetry,
    )?.row;
    expect(telemetry?.dataQuality).toBe('invalid');
  });

  it('skips duplicate raw_ref frames', async () => {
    const { db, insertRows } = createIngestDb([[{}], [{}]]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-DUP',
      event_time: new Date().toISOString(),
      raw_ref: 'sha256-duplicate',
    });

    expect(result.accepted).toBe(false);
    expect(result.skipped).toBe(true);
    expect(
      insertRows.some((entry) => entry.table === ewohTelemetry),
    ).toBe(false);
  });

  it('rejects unknown entities with a data-quality event', async () => {
    const { db, insertRows } = createIngestDb([[], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    // R2-SOP-002：DataQualityAlert 需 ctx 透传 orgId（缺 org 拒写 NULL legacy 行）。
    const result = await service.ingestExoskeleton(
      {
        entity_id: 'EXO-UNKNOWN',
        event_time: new Date().toISOString(),
      },
      { userId: 'ingest-1', primaryOrgId: 'ORG-1' },
    );

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('不存在');
    expect(
      insertRows.some((entry) => entry.table === ewohEvent),
    ).toBe(true);
  });

  it('requires an entity or device identifier', async () => {
    const service = new IngestService(
      {} as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );;

    await expect(
      service.ingestExoskeleton({
        event_time: new Date().toISOString(),
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------- P1-INGEST-001：batch 回归测试 ----------

/**
 * 支持批量路径的 mock db。
 *
 * 批量预检代码形如：
 *   await this.db.select({...}).from(t).where(inArray(col, values))
 * drizzle 的查询对象可被 await 解析为数组；mock 按调用顺序返回：
 *   第 1 次 where → existingEntities 查询结果；
 *   第 2 次 where → existingRawRefs 查询结果。
 * insert(telemetry).values(rows) 记录多行批量插入。
 */
function createBatchDb(opts: {
  existingEntities: string[];
  existingRawRefs: string[];
}) {
  const insertCalls: Array<{ table: unknown; rows: unknown[] }> = [];
  let whereCall = 0;
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => {
          const callIdx = whereCall++;
          const result =
            callIdx === 0
              ? opts.existingEntities.map((entityId) => ({ entityId }))
              : opts.existingRawRefs.map((rawRef) => ({ rawRef }));
          return Promise.resolve(result) as unknown as {
            limit: unknown;
            then: unknown;
          };
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((rows: unknown[]) => {
        insertCalls.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        return {
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          returning: jest.fn().mockResolvedValue([]),
        };
      }),
    })),
  };
  return { db, insertCalls };
}

function makeFrame(overrides: Record<string, unknown> = {}) {
  return {
    entity_id: 'EXO-BATCH-1',
    event_time: new Date().toISOString(),
    source_type: 'real',
    device: { battery_pct: 88 },
    ...overrides,
  } as never;
}

describe('IngestService batch（P1-INGEST-001 回归）', () => {
  it('批量帧单次 insert telemetry（batch insert 而不是逐帧插入）', async () => {
    const { db, insertCalls } = createBatchDb({
      existingEntities: ['EXO-BATCH-1'],
      existingRawRefs: [],
    });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestExoskeletonBatch([
      makeFrame({ entity_id: 'EXO-BATCH-1' }),
      makeFrame({ entity_id: 'EXO-BATCH-1' }),
      makeFrame({ entity_id: 'EXO-BATCH-1' }),
    ]);

    expect(result.total).toBe(3);
    expect(result.accepted).toBe(3);
    // telemetry 应为一次批量 insert（rows.length === 3），而非逐帧 3 次单行 insert
    const telemetryInserts = insertCalls.filter((c) => c.table === ewohTelemetry);
    expect(telemetryInserts).toHaveLength(1);
    expect(telemetryInserts[0]?.rows).toHaveLength(3);
    // devices 也应单次 upsert
    const deviceInserts = insertCalls.filter((c) => c.table === ewohDevice);
    expect(deviceInserts).toHaveLength(1);
  });

  it('批量重复 raw_ref 被跳过（skipped=true）', async () => {
    const { db, insertCalls } = createBatchDb({
      existingEntities: ['EXO-BATCH-1'],
      existingRawRefs: ['dup-raw-ref'],
    });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestExoskeletonBatch([
      makeFrame({ entity_id: 'EXO-BATCH-1', raw_ref: 'dup-raw-ref' }),
      makeFrame({ entity_id: 'EXO-BATCH-1', raw_ref: 'new-raw-ref' }),
    ]);

    expect(result.total).toBe(2);
    expect(result.skipped).toBe(1);
    const telemetryInsert = insertCalls.find((c) => c.table === ewohTelemetry);
    expect(telemetryInsert?.rows).toHaveLength(1);
    expect((telemetryInsert?.rows[0] as Record<string, unknown>)?.rawRef).toBe('new-raw-ref');
  });

  it('批量时钟漂移帧标 invalid（quality 记录，行为与单帧一致）', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 超前 10min
    const { db, insertCalls } = createBatchDb({
      existingEntities: ['EXO-BATCH-1'],
      existingRawRefs: [],
    });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestExoskeletonBatch([
      makeFrame({ entity_id: 'EXO-BATCH-1', event_time: future }),
    ]);

    expect(result.total).toBe(1);
    // 与单帧一致：时钟漂移帧仍入库，但 data_quality=invalid
    expect(result.results[0].data_quality).toBe('invalid');
    const telemetryInsert = insertCalls.find((c) => c.table === ewohTelemetry);
    expect((telemetryInsert?.rows[0] as Record<string, unknown>)?.dataQuality).toBe('invalid');
  });

  it('部分无效 batch（entity 不存在）→ 该帧 rejected，其余 accepted', async () => {
    const { db, insertCalls } = createBatchDb({
      existingEntities: ['EXO-BATCH-1'],
      existingRawRefs: [],
    });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestExoskeletonBatch([
      makeFrame({ entity_id: 'EXO-BATCH-MISSING' }),
      makeFrame({ entity_id: 'EXO-BATCH-1' }),
    ]);

    expect(result.total).toBe(2);
    expect(result.accepted).toBe(1);
    expect(result.results[0].accepted).toBe(false);
    expect(result.results[0].error).toContain('不存在');
    expect(result.results[1].accepted).toBe(true);
    const telemetryInsert = insertCalls.find((c) => c.table === ewohTelemetry);
    expect(telemetryInsert?.rows).toHaveLength(1);
  });

  it('ADR-004：ingestMes 转发到 canonical MesService，不再写 scheduling 表', async () => {
    const { db, insertCalls } = createBatchDb({
      existingEntities: [],
      existingRawRefs: [],
    });
    const mes = createMesService();
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      mes as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    const result = await service.ingestMes(
      {
        order_id: 'WO-MES-1',
        product_code: 'P-1',
        quantity: 10,
        priority: 'high',
      },
      { userId: 'ingest', primaryOrgId: 'ORG-1' },
    );

    expect(result.accepted).toBe(true);
    // 不再写 ewoh_schedule_plan（无任何 insert 落到 scheduling 表）
    expect(insertCalls.length).toBe(0);
    // 转发到 MesService.createWorkOrder
    expect(mes.createWorkOrder).toHaveBeenCalledTimes(1);
    const body = mes.createWorkOrder.mock.calls[0][0];
    expect(body.orderId).toBe('WO-MES-1');
    expect(body.productCode).toBe('P-1');
    expect(body.orderQty).toBe(10);
    expect(body.priority).toBe('high');
    expect(body.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('ADR-004 / NEST-215：ingestMes 转发失败 → 502 MES_WORK_ORDER_WRITE_FAILED（不再 200+accepted=false 静默）', async () => {
    const { db } = createBatchDb({ existingEntities: [], existingRawRefs: [] });
    const mes = {
      createWorkOrder: jest.fn().mockRejectedValue(new Error('mes down')),
    };
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      mes as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
    );

    await expect(
      service.ingestMes(
        { order_id: 'WO-MES-2' },
        { userId: 'ingest', primaryOrgId: 'ORG-1' },
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'MES_WORK_ORDER_WRITE_FAILED' },
    });
  });

  it('NO-04a：迟到帧（>10min）标记 is_late，不丢弃（ADR-009 Late Event 语义）', async () => {
    const lateEventTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { db } = createBatchDb({ existingEntities: ['EXO-BATCH-1'], existingRawRefs: [] });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestExoskeletonBatch([
      makeFrame({ entity_id: 'EXO-BATCH-1', event_time: lateEventTime }),
    ]);

    expect(result.total).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.late_count).toBe(1);
    expect(result.clock_drift_count).toBe(0);
    expect(result.results[0].is_late).toBe(true);
    expect(result.results[0].clock_drift).toBe(false);
  });

  it('NO-04a：时钟漂移帧（未来 10min）标记 clock_drift（ADR-009）', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { db } = createBatchDb({ existingEntities: ['EXO-BATCH-1'], existingRawRefs: [] });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestExoskeletonBatch([
      makeFrame({ entity_id: 'EXO-BATCH-1', event_time: future }),
    ]);

    expect(result.clock_drift_count).toBe(1);
    expect(result.results[0].clock_drift).toBe(true);
  });

  it('NO-04a：同批次 entity 缺失只写一次 DataQualityAlert（语义去重防风暴）', async () => {
    const { db, insertCalls } = createBatchDb({ existingEntities: [], existingRawRefs: [] });
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    // R2-SOP-002：告警事件租户归属从 batch ctx 透传（缺 org 拒写）。
    const result = await service.ingestExoskeletonBatch(
      [
        makeFrame({ entity_id: 'EXO-MISSING-1' }),
        makeFrame({ entity_id: 'EXO-MISSING-1' }),
        makeFrame({ entity_id: 'EXO-MISSING-1' }),
      ],
      { userId: 'ingest-1', primaryOrgId: 'ORG-1' },
    );

    expect(result.total).toBe(3);
    expect(result.accepted).toBe(0);
    const eventInserts = insertCalls.filter((c) => c.table === ewohEvent);
    expect(eventInserts).toHaveLength(1);
  });
});

// ---------- NO-04b：Edge→Cloud 事件批量上行（ADR-009 信封 + 传输级幂等去重） ----------

/** 事件上行专用 mock db：dedup 台账按 (org,source,event) 语义去重。 */
function createEventBatchDb() {
  const dedupKeys = new Set<string>();
  const eventRows: Array<Record<string, unknown>> = [];
  const notificationRows: Array<Record<string, unknown>> = [];
  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohIngestEventDedup) {
          const key = `${String(row.orgId)}|${String(row.source)}|${String(row.eventId)}`;
          const isNew = !dedupKeys.has(key);
          if (isNew) dedupKeys.add(key);
          return {
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue(isNew ? [{ id: 'uuid-1' }] : []),
            })),
          };
        }
        if (table === ewohEvent) {
          eventRows.push(row);
        }
        if (table === ewohNotification) {
          notificationRows.push(row);
        }
        return {
          onConflictDoNothing: jest.fn(() => ({
            returning: jest.fn().mockResolvedValue([]),
          })),
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          returning: jest.fn().mockResolvedValue([]),
        };
      }),
    })),
    select: jest.fn(),
  };
  return { db, dedupKeys, eventRows, notificationRows };
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    eventId: 'EVT-EDGE-1',
    eventType: 'EntityDeclared',
    schemaVersion: '1.0.0',
    occurredAt: now,
    observedAt: now,
    receivedAt: now,
    source: 'edge:world-projection',
    ...overrides,
  } as never;
}

const EVENT_CTX = { userId: 'ingest', primaryOrgId: 'ORG-1' } as never;

describe('IngestService 事件批量上行（NO-04b）', () => {
  it('合法信封：落 ewoh_event + dedup 台账（accepted）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ eventId: 'EVT-A' }), makeEnvelope({ eventId: 'EVT-B', eventType: 'EntityStateObserved' })],
      EVENT_CTX,
    );

    expect(result.total).toBe(2);
    expect(result.accepted).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.rejected).toBe(0);
    expect(eventRows).toHaveLength(2);
    expect(eventRows[0]?.eventType).toBe('EntityDeclared');
  });

  it('重复投递：同 (org,source,eventId) 只落一次（duplicate 不重复投递）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ eventId: 'EVT-DUP' }), makeEnvelope({ eventId: 'EVT-DUP' })],
      EVENT_CTX,
    );

    expect(result.accepted).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.results[1].duplicate).toBe(true);
    expect(eventRows).toHaveLength(1);
  });

  it('ADR-040：边缘 AndonRaised → canonical andon evidence 投影（eventCode/severity/andonId/timeline）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({
        eventId: 'EVT-ANDON-1',
        eventType: 'AndonRaised',
        source: 'edge:andon',
        subject: 'device:exo-1',
        payload: {
          deviceId: 'device:exo-1',
          title: '线边缺料',
          reason: '物料耗尽',
          level: 'high',
          assignee: 'dispatcher',
          slaSeconds: 120,
          raisedAt: new Date().toISOString(),
        },
      })],
      EVENT_CTX,
    );

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    const row = eventRows[0];
    expect(row?.eventCode).toBe('ANDON');
    expect(row?.eventType).toBe('AndonRaised');
    expect(row?.severity).toBe('high');
    expect(row?.title).toBe('线边缺料');
    expect(row?.deviceId).toBe('device:exo-1');
    const evidence = row?.evidenceJson as Record<string, unknown>;
    expect(evidence.andonId).toBe('EVT-ANDON-1');
    expect(evidence.level).toBe('high');
    expect(evidence.slaSeconds).toBe(120);
    expect(evidence.slaMinutes).toBe(2);
    expect(evidence.assignee).toBe('dispatcher');
    expect(evidence.escalationLevel).toBe(0);
    expect((evidence.timeline as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it('ADR-040：边缘安灯开灯 → app 通知闭环（externalRef=事件主事实；lark 未配置不建 doomed 行）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const { db, notificationRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    await service.ingestEventBatch(
      [makeEnvelope({
        eventId: 'EVT-ANDON-2',
        eventType: 'AndonRaised',
        source: 'edge:andon',
        payload: { deviceId: 'device:exo-1', title: '缺料', level: 'critical', assignee: 'workshop_lead', slaSeconds: 60 },
      })],
      EVENT_CTX,
    );

    expect(notificationRows).toHaveLength(1);
    expect(notificationRows[0]).toMatchObject({
      channel: 'app',
      orgId: 'ORG-1',
      recipientId: 'workshop_lead',
      externalRef: 'EVT-ANDON-2',
      severity: 'critical',
      status: 'pending',
    });
  });

  it('ADR-040：非 edge 源 AndonRaised 不投影（守卫边界——云侧开灯走 OEE 直写路径）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    await service.ingestEventBatch(
      [makeEnvelope({
        eventId: 'EVT-ANDON-3',
        eventType: 'AndonRaised',
        source: 'cloud:oee',
        payload: { deviceId: 'device:exo-1', title: 'x', level: 'high' },
      })],
      EVENT_CTX,
    );

    const row = eventRows[0];
    expect(row?.eventCode).toBe('EDGE_AndonRaised');
    expect(row?.severity).toBe('unknown');
    expect(row?.title).toBe('edge:AndonRaised');
  });

  it('非法信封 fail-closed 拒绝（envelope_invalid）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ eventType: undefined, occurredAt: 'not-a-time' })],
      EVENT_CTX,
    );

    expect(result.rejected).toBe(1);
    expect(result.results[0].error).toContain('envelope_invalid');
    expect(eventRows).toHaveLength(0);
  });

  it('未知 Catalog 类型 fail-closed 拒绝（unknown_event_type）', async () => {
    const { db } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ eventType: 'GizmoInvented' })],
      EVENT_CTX,
    );

    expect(result.rejected).toBe(1);
    expect(result.results[0].error).toContain('unknown_event_type');
  });

  it('迟到事件（>10min）标记 is_late 且不丢弃（ADR-009）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const late = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const result = await service.ingestEventBatch(
      [makeEnvelope({ occurredAt: late, observedAt: late })],
      EVENT_CTX,
    );

    expect(result.accepted).toBe(1);
    expect(result.results[0].is_late).toBe(true);
    expect(eventRows).toHaveLength(1);
  });

  it('org 上下文缺失显式失败（RLS 下不静默写全局）', async () => {
    const { db } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    await expect(
      service.ingestEventBatch([makeEnvelope()], undefined as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('IngestService 事件上行乱序/回放补全（NO-04c）', () => {
  it('乱序批次：按 occurred_at 落库（createdAt=occurredAt），消费端按发生时刻排序', async () => {
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const nowIso = new Date().toISOString();
    const olderIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await service.ingestEventBatch(
      [
        makeEnvelope({ eventId: 'EVT-NEW', occurredAt: nowIso, observedAt: nowIso }),
        // 更早发生的事件后到达（乱序）：接受 + 标记迟到，不丢弃
        makeEnvelope({ eventId: 'EVT-OLD', occurredAt: olderIso, observedAt: olderIso }),
      ],
      EVENT_CTX,
    );

    expect(result.accepted).toBe(2);
    expect(result.results[1].is_late).toBe(true);
    expect(eventRows).toHaveLength(2);
    // 事件行时间 = 发生时刻（occurredAt），读取端按此排序即恢复真实时序
    const oldRow = eventRows.find((r) => r.eventId === 'EVT-OLD');
    expect(new Date(oldRow?.createdAt as string | Date).getTime()).toBe(
      new Date(olderIso).getTime(),
    );
  });

  it('历史回放补全：旧事件重放上行被幂等接受（is_late 标记，不改写已落账事实）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const first = await service.ingestEventBatch(
      [makeEnvelope({ eventId: 'EVT-BACKFILL', occurredAt: twoHoursAgo, observedAt: twoHoursAgo })],
      EVENT_CTX,
    );
    expect(first.accepted).toBe(1);
    expect(first.results[0].is_late).toBe(true);

    // 补全重放（同 event）：去重台账幂等接受为 duplicate，不重复落事件行
    const second = await service.ingestEventBatch(
      [makeEnvelope({ eventId: 'EVT-BACKFILL', occurredAt: twoHoursAgo, observedAt: twoHoursAgo })],
      EVENT_CTX,
    );
    expect(second.duplicates).toBe(1);
    expect(eventRows).toHaveLength(1);
  });

  // ---------- NO-11a（ADR-024）：永久失败 → 死信终态台账（best-effort） ----------

  function createDeadLetterMock() {
    const record = jest.fn().mockResolvedValue({ created: true });
    return { record };
  }

  it('unknown_event_type 永久失败 → 死信落账（reason=unknown_event_type）', async () => {
    const { db } = createEventBatchDb();
    const deadLetter = createDeadLetterMock();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
      deadLetter as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ eventType: 'TeleportEvent' })],
      EVENT_CTX,
    );
    expect(result.rejected).toBe(1);
    expect(deadLetter.record).toHaveBeenCalledTimes(1);
    const [input, orgId] = deadLetter.record.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(orgId).toBe('ORG-1');
    expect(input.reason).toBe('unknown_event_type');
    expect(input.sourceId).toBe('cloud:ingest');
    expect((input.envelope as Record<string, unknown>).eventType).toBe('TeleportEvent');
  });

  it('envelope 契约违规永久失败 → 死信落账（reason=contract_violation）', async () => {
    const { db } = createEventBatchDb();
    const deadLetter = createDeadLetterMock();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
      deadLetter as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ occurredAt: 'not-a-date' })],
      EVENT_CTX,
    );
    expect(result.rejected).toBe(1);
    expect(deadLetter.record).toHaveBeenCalledTimes(1);
    const [input] = deadLetter.record.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(input.reason).toBe('contract_violation');
  });

  it('死信落账失败不阻断上行主契约（响应仍含 rejected 计数）', async () => {
    const { db } = createEventBatchDb();
    const deadLetter = {
      record: jest.fn().mockRejectedValue(new Error('dead letter db down')),
    };
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
      deadLetter as never);

    const result = await service.ingestEventBatch(
      [makeEnvelope({ eventType: 'TeleportEvent' })],
      EVENT_CTX,
    );
    expect(result.rejected).toBe(1);
  });

  it('合法上行不落死信（瞬时/成功路径与死信边界显式）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const deadLetter = createDeadLetterMock();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never,
      deadLetter as never);

    const result = await service.ingestEventBatch([makeEnvelope()], EVENT_CTX);
    expect(result.accepted).toBe(1);
    expect(eventRows).toHaveLength(1);
    expect(deadLetter.record).not.toHaveBeenCalled();
  });
});

describe('IngestService ExoSession 投影（ADR-033 / §7）', () => {
  function makeExoMock() {
    const start = jest.fn().mockResolvedValue({ sessionId: 'exo-session:s1', status: 'active' });
    const endSession = jest.fn().mockResolvedValue({ sessionId: 'exo-session:s1', status: 'ended' });
    const abortSession = jest.fn().mockResolvedValue({ sessionId: 'exo-session:s1', status: 'aborted' });
    return { start, endSession, abortSession };
  }

  function makeExoEnvelope(eventType: string, payload: Record<string, unknown>, eventId?: string) {
    const now = new Date().toISOString();
    return {
      eventId: eventId ?? `EVT-EXO-${eventType}-${Math.random().toString(16).slice(2, 8)}`,
      eventType,
      schemaVersion: '1.0.0',
      occurredAt: now,
      observedAt: now,
      receivedAt: now,
      source: 'edge:exo-binding',
      payload,
    } as never;
  }

  it('ExoSessionStarted → start 投影（sessionId/exoId/personId 透传）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const exo = makeExoMock();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never, undefined, exo as never);
    const result = await service.ingestEventBatch([
      makeExoEnvelope('ExoSessionStarted', {
        sessionId: 'exo-session:s1', exoId: 'device:exo-1', personId: 'person:p-1',
        startedAt: '2026-08-16T08:00:00Z',
      }),
    ], EVENT_CTX);
    expect(result.accepted).toBe(1);
    expect(exo.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'exo-session:s1', exoId: 'device:exo-1', personId: 'person:p-1' }),
      'ORG-1',
    );
  });

  it('ExoSessionEnded → end 投影（endedBy 透传）；aborted → abort 投影', async () => {
    const { db } = createEventBatchDb();
    const exo = makeExoMock();
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never, undefined, exo as never);
    await service.ingestEventBatch([
      makeExoEnvelope('ExoSessionEnded', {
        sessionId: 'exo-session:s1', exoId: 'device:exo-1', personId: 'person:p-1',
        status: 'ended', endedBy: 'person:op1',
      }, 'EVT-EXO-END-1'),
      makeExoEnvelope('ExoSessionEnded', {
        sessionId: 'exo-session:s2', exoId: 'device:exo-2', personId: 'person:p-2',
        status: 'aborted', endedBy: 'person:op1',
      }, 'EVT-EXO-END-2'),
    ], EVENT_CTX);
    expect(exo.endSession).toHaveBeenCalledWith('ORG-1', 'exo-session:s1', 'person:op1');
    expect(exo.abortSession).toHaveBeenCalledWith('ORG-1', 'exo-session:s2', 'person:op1');
  });

  it('投影失败显式留痕不阻断事件主事实（event 行仍落账）', async () => {
    const { db, eventRows } = createEventBatchDb();
    const exo = makeExoMock();
    exo.start.mockRejectedValue(new Error('ledger down'));
    const service = new IngestService(db as never, createRuleEngine() as unknown as never, createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
      createReplanCoordinator() as unknown as never,
      createIdentityService() as unknown as never, undefined, exo as never);
    const result = await service.ingestEventBatch([
      makeExoEnvelope('ExoSessionStarted', {
        sessionId: 'exo-session:s1', exoId: 'device:exo-1', personId: 'person:p-1',
      }),
    ], EVENT_CTX);
    expect(result.accepted).toBe(1);
    expect(eventRows).toHaveLength(1);
  });
});

