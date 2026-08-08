import { BadRequestException } from '@nestjs/common';
import { IngestService } from '../../../server/modules/ingest/ingest.service';
import {
  ewohDevice,
  ewohEvent,
  ewohSpatialEntity,
  ewohTelemetry,
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

describe('IngestService canonical UnifiedExoFrame mapping', () => {
  it('maps nested pose/load/device/quality fields into telemetry and device rows', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const ruleEngine = createRuleEngine();
    const service = new IngestService(
      db as never,
      ruleEngine as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
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

  it('normalizes a legacy 0-100 load_score to 0-1', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      createMesService() as unknown as never,
      createSensorIngest() as unknown as never,
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
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-UNKNOWN',
      event_time: new Date().toISOString(),
    });

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
      createSensorIngest() as unknown as never);

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
      createSensorIngest() as unknown as never);

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
      createSensorIngest() as unknown as never);

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
      createSensorIngest() as unknown as never);

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
    );

    const result = await service.ingestMes({
      order_id: 'WO-MES-1',
      product_code: 'P-1',
      quantity: 10,
      priority: 'high',
    });

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

  it('ADR-004：ingestMes 转发失败 → accepted=false（不静默成功）', async () => {
    const { db } = createBatchDb({ existingEntities: [], existingRawRefs: [] });
    const mes = {
      createWorkOrder: jest.fn().mockRejectedValue(new Error('mes down')),
    };
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
      mes as unknown as never,
      createSensorIngest() as unknown as never,
    );

    const result = await service.ingestMes({ order_id: 'WO-MES-2' });
    expect(result.accepted).toBe(false);
    expect(result.data_quality).toBe('invalid');
  });
});
