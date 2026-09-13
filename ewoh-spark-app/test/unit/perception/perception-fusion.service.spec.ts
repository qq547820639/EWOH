/* PerceptionFusionService 契约行为测试（NO-56a §5 感知融合）。
 *
 * 钉住的语义：
 *   1. 窗口内的定位 + 外骨骼 + 视觉观测被融合为一条快照，主体来自有观测的人；
 *   2. UWB 工位与**相机绑定工位**不一致 → 冲突快照（`strongAdviceAllowed=false`）；
 *   3. 视觉 track 未绑定到任何主体 → 如实计数（不按"最像的人"分配）；
 *   4. 坐标超出工位半径 → 工位未知 + 计入 stationUnresolved（不猜最近工位）；
 *   5. 无可用源的主体 → unknown/insufficient 快照（不显示成 0%）；
 *   6. 快照号确定性 → 重复 sweep 是 refreshed 而不是重复行；
 *   7. 只读感知事实（不更新 world_state / telemetry / spatial_entity / production_task）。
 *
 * DB 用 fake：world_state 的两类行（定位 / 相机检测）由 **种子标记** 区分——
 * `state_json ? 'locator'` 这类 JSON 操作符由替身显式模拟（真实 SQL 语义由
 * `e2e:perception-fusion` 在真实 PG 上验证）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import {
  ewohEnvironment,
  ewohPerceptionFusion,
  ewohProductionTask,
  ewohSpatialEntity,
  ewohTelemetry,
  ewohWorldState,
} from '@server/database/schema';
import { PerceptionFusionService } from '../../../server/modules/perception/perception-fusion.service';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;
const NOW = new Date('2026-09-12T08:00:00.000Z');

interface Seed {
  environment?: Array<{ sensorId: string; entityId: string; temperature?: number | null; vibration?: number | null; noise?: number | null; airQuality?: number | null; at?: Date; confidence?: number }>;
  locations?: Array<{ entityId: string; x: number; y: number; confidence?: number; at?: Date; recordId?: string }>;
  vision?: Array<{ entityId: string; cameraId: string; action?: string; confidence?: number; at?: Date; className?: string; skeleton?: Record<string, number[]> }>;
  telemetry?: Array<{ deviceId: string; entityId: string; pitchDeg?: number; jointAngles?: Record<string, number> | null; quality?: string; confidence?: number; at?: Date; sourceType?: string }>;
  stations?: Array<{ entityId: string; entityType: string; x: number; y: number }>;
  tasks?: Array<{ taskId: string; assigneeId: string; spatialEntityId: string | null; taskType: string; status: string }>;
  fusions?: Array<Record<string, unknown>>;
}

const COLUMN_KEYS = {
  _created_at: 'createdAt',
  sensor_id: 'sensorId',
  _updated_at: 'updatedAt',
  org_id: 'orgId',
  entity_id: 'entityId',
  device_id: 'deviceId',
  ts: 'ts',
  fusion_id: 'fusionId',
  subject_id: 'subjectId',
  status: 'status',
  assignee_id: 'assigneeId',
  entity_type: 'entityType',
};

function createDb(seed: Seed = {}) {
  const worldRows: Array<Record<string, unknown>> = [
    ...(seed.locations ?? []).map((l) => ({
      orgId: ORG,
      entityId: l.entityId,
      ts: l.at ?? new Date(NOW.getTime() - 10_000),
      stateJson: { locator: 'uwb', x: l.x, y: l.y, z: 0, confidence: l.confidence ?? 0.9, record_id: l.recordId ?? `rec-${l.entityId}` },
      __kind: 'location',
    })),
    ...(seed.vision ?? []).map((v) => ({
      orgId: ORG,
      entityId: `${v.cameraId}:${v.entityId}`,
      ts: v.at ?? new Date(NOW.getTime() - 8_000),
      stateJson: {
        camera_id: v.cameraId,
        class_name: v.className ?? 'person',
        confidence: v.confidence ?? 0.85,
        bbox: { x: 10, y: 20, w: 4, h: 8 },
        action: v.action ?? null,
        ...(v.skeleton ? { skeleton: v.skeleton } : {}),
      },
      __kind: 'vision',
    })),
  ];
  const telemetryRows = (seed.telemetry ?? []).map((t) => ({
    orgId: ORG,
    deviceId: t.deviceId,
    entityId: t.entityId,
    ts: t.at ?? new Date(NOW.getTime() - 20_000),
    pitchDeg: t.pitchDeg ?? 10,
    jointAngles: t.jointAngles ?? null,
    dataQuality: t.quality ?? 'good',
    dataConfidence: t.confidence ?? 0.9,
    sourceType: t.sourceType ?? 'real',
  }));
  const stationRows = (seed.stations ?? []).map((s) => ({ orgId: ORG, ...s }));
  const environmentRows = (seed.environment ?? []).map((row) => ({
    orgId: ORG,
    sensorId: row.sensorId,
    entityId: row.entityId,
    ts: row.at ?? new Date(NOW.getTime() - 5_000),
    temperature: row.temperature ?? null,
    vibration: row.vibration ?? null,
    noise: row.noise ?? null,
    airQuality: row.airQuality ?? null,
    dataConfidence: row.confidence ?? 0.9,
  }));
  const taskRows = (seed.tasks ?? []).map((t) => ({ orgId: ORG, ...t }));
  const fusionRows: Array<Record<string, unknown>> = [...(seed.fusions ?? [])];
  const matches = makeConditionMatcher(COLUMN_KEYS);

  /**
   * 把 drizzle 条件里的**字面量片段**拼出来（不能直接 JSON.stringify：
   * 条件里带 PgTable 对象，会 circular structure 抛错——2026-09-12 实测）。
   */
  function sqlTextOf(query: unknown): string {
    const parts: string[] = [];
    const walk = (value: unknown, depth = 0): void => {
      if (depth > 6 || value == null) return;
      if (typeof value === 'string') {
        parts.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        // drizzle 的 StringChunk.value 是**字符串数组**（实测：typeof 'object'），
        // 只处理 primitive 会把 ` ? 'locator'` 这种内联片段整段丢掉。
        if (Array.isArray(record.value)) {
          parts.push(record.value.filter((v): v is string => typeof v === 'string').join(''));
        } else if ('value' in record && typeof record.value !== 'object') {
          parts.push(String(record.value));
        }
        if (Array.isArray(record.queryChunks)) walk(record.queryChunks, depth + 1);
      }
    };
    walk((query as { queryChunks?: unknown[] } | null)?.queryChunks);
    return parts.join(' ');
  }

  /**
   * 替身模拟 `state_json ? '<key>'` 的行选择（真实 SQL 语义由 e2e 在真实 PG 上验证）。
   *
   * 这里**不再**解析条件里的 org/窗口参数：`?` 是 PostgreSQL 的 JSON 键存在操作符，
   * 共享 matcher 按设计对不认识的形态抛错，而在替身里复刻参数绑定既脆弱又没价值
   * ——org 由种子保证唯一，时间窗的语义由融合引擎自己的 TTL 判定覆盖
   * （过期证据会被显式排除，测试正是这么断言的）。
   */
  function jsonKeyFilter(table: unknown, condition: unknown): Array<Record<string, unknown>> {
    if (table !== ewohWorldState) return [];
    const text = sqlTextOf(condition);
    const jsonKeys = [...text.matchAll(/\?\s*'([^']+)'/g)].map((m) => m[1]);
    if (jsonKeys.includes('locator') && !jsonKeys.includes('camera_id')) {
      return worldRows.filter((r) => r.__kind === 'location');
    }
    if (jsonKeys.includes('camera_id') && !jsonKeys.includes('locator')) {
      return worldRows.filter((r) => r.__kind === 'vision');
    }
    return worldRows;
  }

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (table === ewohWorldState) return worldRows;
    if (table === ewohTelemetry) return telemetryRows;
    if (table === ewohSpatialEntity) return stationRows;
    if (table === ewohProductionTask) return taskRows;
    if (table === ewohEnvironment) return environmentRows;
    if (table === ewohPerceptionFusion) return fusionRows;
    return [];
  }

  function selectChain(table: unknown) {
    let filtered = rowsFor(table);
    const api = {
      where(condition: unknown) {
        if (table === ewohWorldState) {
          filtered = jsonKeyFilter(table, condition);
          return api;
        }
        filtered = rowsFor(table).filter((row) => matches(condition, row));
        return api;
      },
      orderBy() {
        // 真实查询按 fusedAt DESC 取最新；替身必须也排（否则"每个主体取最新"根本测不到：
        // 插入顺序 ≠ 最新顺序，2026-09-12 实测踩到）。
        if (table === ewohPerceptionFusion) {
          filtered = [...filtered].sort(
            (a, b) => (b.fusedAt as Date).getTime() - (a.fusedAt as Date).getTime(),
          );
        }
        return api;
      },
      limit(count: number) {
        return Promise.resolve(filtered.slice(0, count));
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(filtered).then(resolve, reject);
      },
    };
    return api;
  }

  const db = {
    select: () => ({ from: (table: unknown) => selectChain(table) }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        rowsFor(table).push({ ...row });
        return [row];
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (condition: unknown) => {
          const hit = rowsFor(table).filter((row) => matches(condition, row));
          for (const row of hit) Object.assign(row, patch);
          return hit.length;
        },
      }),
    }),
  };
  return { db, fusions: fusionRows, worldRows, telemetryRows, stationRows, taskRows, environmentRows };
}

function auditMock() {
  return { appendAuditLog: jest.fn(async () => undefined) };
}

const STATIONS: Seed['stations'] = [
  { entityId: 'ST-1', entityType: 'station', x: 10, y: 20 },
  { entityId: 'ST-2', entityType: 'station', x: 60, y: 20 },
  { entityId: 'CAM-A', entityType: 'camera', x: 10, y: 20 },
  { entityId: 'CAM-B', entityType: 'camera', x: 60, y: 20 },
];

describe('PerceptionFusionService.sweep（多源融合）', () => {
  it('定位 + 外骨骼 + 同工位视觉 → 一致快照（高置信、允许建议）', async () => {
    const { db, fusions } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A' }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 12 }],
      stations: STATIONS,
    });
    const audit = auditMock();
    const service = new PerceptionFusionService(db as never, audit as never);

    const result = await service.sweep(ACTOR, { now: NOW, windowMinutes: 5, bucketMinutes: 5 });

    expect(result.subjects).toBe(1);
    expect(result.persisted).toBe(1);
    expect(result.created).toBe(1);
    expect(result.byAgreement.consistent).toBe(1);
    expect(result.byConfidenceLevel.high).toBe(1);
    expect(result.conflictSubjects).toEqual([]);
    const [fused] = result.fused;
    expect(fused.subjectId).toBe('person:P-1');
    expect(fused.station?.stationId).toBe('ST-1');
    expect(fused.strongAdviceAllowed).toBe(true);
    expect(fusions).toHaveLength(1);
    expect(fusions[0]).toMatchObject({ agreement: 'consistent', confidenceLevel: 'high', stationId: 'ST-1' });
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'perception.fusion_sweep', orgId: ORG }),
    );
  });

  it('UWB 工位与相机绑定工位不一致 → 冲突快照且禁止强建议（各源都保留）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }], // ST-1
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-B' }], // 相机在 ST-2
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1' }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.byAgreement.conflict).toBe(1);
    expect(result.conflictSubjects).toEqual(['person:P-1']);
    const fused = result.fused[0];
    expect(fused.strongAdviceAllowed).toBe(false);
    expect(fused.station?.stationId).toBeNull();
    // 三个工位信号（uwb 实测 / station_semantics 映射 / vision 相机绑定）都保留，值去重后是 ST-1 vs ST-2
    expect([...new Set(fused.conflicts[0].participants.map((p) => p.value))].sort()).toEqual(['ST-1', 'ST-2']);
    expect(fused.conflicts[0].participants).toHaveLength(3);
  });

  it('视觉 track 未绑定到主体 → 如实计数（不按"最像的人"分配）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [
        { entityId: 'track-991', cameraId: 'CAM-A' },
        { entityId: 'person:P-1', cameraId: 'CAM-A' },
      ],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.unmatchedVisionDetections).toBe(1);
    expect(result.subjects).toBe(1);
    expect(result.fused[0].confidence.usableSources).toContain('vision');
  });

  it('坐标超出工位半径 → 工位未知并计入 stationUnresolved（不猜最近工位）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-9', x: 500, y: 500 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.stationUnresolved).toBe(1);
    // 无工位信号 → station 整体为 null（不是"有一个 stationId=null 的对象"）
    expect(result.fused[0].station).toBeNull();
    expect(result.fused[0].position?.stationId ?? null).toBeNull();
  });

  it('无可用源：观测全部过期 → unknown/insufficient 快照（不显示成 0%）', async () => {
    const stale = new Date(NOW.getTime() - 60 * 60_000);
    const { db } = createDb({
      locations: [{ entityId: 'person:P-2', x: 10, y: 20, at: stale }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const fused = result.fused[0];
    expect(fused.agreement).toBe('insufficient');
    expect(fused.confidence.level).toBe('unknown');
    expect(fused.confidence.score).toBeNull();
    expect(fused.confidence.excludedSources[0].status).toBe('stale');
    expect(fused.strongAdviceAllowed).toBe(false);
    expect(result.byConfidenceLevel.unknown).toBe(1);
  });

  it('在飞任务提供任务上下文；多个不同工位 → 有歧义置空并写明', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-3', x: 10, y: 20 }],
      stations: STATIONS,
      tasks: [
        { taskId: 'T-1', assigneeId: 'person:P-3', spatialEntityId: 'ST-1', taskType: 'assembly', status: 'executing' },
      ],
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const single = await service.sweep(ACTOR, { now: NOW });
    expect(single.fused[0].station?.sources).toContain('task_context');
    expect(single.notes.join(' ')).not.toContain('有歧义');

    const ambiguous = createDb({
      locations: [{ entityId: 'person:P-3', x: 10, y: 20 }],
      stations: STATIONS,
      tasks: [
        { taskId: 'T-1', assigneeId: 'person:P-3', spatialEntityId: 'ST-1', taskType: 'assembly', status: 'executing' },
        { taskId: 'T-2', assigneeId: 'person:P-3', spatialEntityId: 'ST-2', taskType: 'inspection', status: 'dispatched' },
      ],
    });
    const service2 = new PerceptionFusionService(ambiguous.db as never, auditMock() as never);
    const result2 = await service2.sweep(ACTOR, { now: NOW });
    expect(result2.notes.join(' ')).toContain('有歧义');
  });

  it('幂等：同窗口重复 sweep 是 refreshed，不产生第二行', async () => {
    const { db, fusions } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    await service.sweep(ACTOR, { now: NOW });
    const second = await service.sweep(ACTOR, { now: new Date(NOW.getTime() + 1_000) });
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(fusions).toHaveLength(1);
  });

  it('只读感知事实：sweep 不修改 world_state/telemetry/工位/任务行', async () => {
    const seed: Seed = {
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A' }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1' }],
      stations: STATIONS,
      tasks: [{ taskId: 'T-1', assigneeId: 'person:P-1', spatialEntityId: 'ST-1', taskType: 'assembly', status: 'executing' }],
    };
    const { db, worldRows, telemetryRows, stationRows, taskRows } = createDb(seed);
    const snapshot = JSON.stringify({ worldRows, telemetryRows, stationRows, taskRows });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    await service.sweep(ACTOR, { now: NOW });
    expect(JSON.stringify({ worldRows, telemetryRows, stationRows, taskRows })).toBe(snapshot);
  });

  it('缺 org/用户上下文 → 400（fail-closed）', async () => {
    const { db } = createDb({});
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    await expect(service.sweep(undefined)).rejects.toThrow(BadRequestException);
  });
});

describe('PerceptionFusionService.sweep（视觉骨架 → 躯干角，NO-58c）', () => {
  // 直立骨架（肩在上、髋在下 → 接近 0°）
  const UPRIGHT = {
    left_shoulder: [100, 100, 0.9], right_shoulder: [140, 100, 0.9],
    left_hip: [105, 200, 0.85], right_hip: [135, 200, 0.85],
  };
  // 外骨骼报大角度前倾（60°）但视觉骨架说直立 → 两个独立角度源冲突
  const BENT_BY_VISION = {
    left_shoulder: [200, 100, 0.9], right_shoulder: [210, 100, 0.9],
    left_hip: [105, 200, 0.9], right_hip: [135, 200, 0.9],
  };

  it('骨架可换算 → 视觉产出姿态观测，与外骨骼角度一致即无姿态冲突', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', skeleton: UPRIGHT }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 8 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const fused = result.fused[0];
    expect(fused.confidence.usableSources).toContain('vision');
    expect(fused.conflicts.filter((c) => c.dimension === 'posture')).toHaveLength(0);
    // 姿态主轴仍是外骨骼（角度源优先级），但视觉已作为第二个角度源参与
    expect(fused.posture?.basis.join(' ')).toContain('exo_imu');
  });

  it('外骨骼 60° vs 视觉骨架直立 → 姿态角度冲突（两源都保留，禁止强建议）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', skeleton: UPRIGHT }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 60 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const fused = result.fused[0];
    const postureConflicts = fused.conflicts.filter((c) => c.dimension === 'posture');
    expect(postureConflicts).toHaveLength(1);
    expect(postureConflicts[0].detail).toContain('姿态角度冲突');
    expect(fused.strongAdviceAllowed).toBe(false);
    expect(result.conflictSubjects).toEqual(['person:P-1']);
  });

  it('骨架缺髋部要点 → 不产出姿态观测，并如实写 note（不猜角度）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{
        entityId: 'person:P-1',
        cameraId: 'CAM-A',
        skeleton: { left_shoulder: [100, 100, 0.9], right_shoulder: [140, 100, 0.9] },
      }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 60 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const fused = result.fused[0];
    // 扫描级 note 如实说明"骨架算不出角度"（快照级 notes 只写融合引擎自己的结论）
    expect(result.notes.join(' ')).toContain('视觉骨架无法换算躯干角');
    expect(result.notes.join(' ')).toContain('left_hip');
    expect(fused.posture?.basis.join(' ')).toContain('exo_imu');
    // 只有外骨骼一个角度源 → 没有"角度 vs 角度"冲突可记
    expect(fused.conflicts.filter((c) => c.dimension === 'posture')).toHaveLength(0);
  });

  it('无骨架的视觉检测照旧只贡献工位/动作（不因为缺骨架就判冲突）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', action: 'standing' }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 10 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const fused = result.fused[0];
    expect(fused.conflicts).toHaveLength(0);
    expect(result.notes.join(' ')).not.toContain('视觉骨架');
  });

  it('视觉骨架角度 > 外骨骼小角度：同样记冲突（方向无关，只比差值）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', skeleton: BENT_BY_VISION }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 5 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const postureConflicts = result.fused[0].conflicts.filter((c) => c.dimension === 'posture');
    expect(postureConflicts).toHaveLength(1);
    expect(postureConflicts[0].participants.map((p) => p.source).sort()).toEqual(['exo_imu', 'vision']);
  });
});

describe('PerceptionFusionService.list（最新快照）', () => {
  it('每个主体只返回最新一条，可按主体过滤', async () => {
    const { db } = createDb({
      fusions: [
        { orgId: ORG, fusionId: 'FUSE-person:P-1-1', subjectId: 'person:P-1', agreement: 'partial', confidenceLevel: 'medium', fusedAt: new Date(NOW.getTime() - 60_000), stationId: null, conflictCount: 0, usableSourceCount: 2, recordJson: { subjectId: 'person:P-1', windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(), fusedAt: NOW.toISOString(), agreement: 'partial', confidence: { level: 'medium', score: 0.6, basis: 'x', usableSources: ['uwb'], degraded: false, missingSources: [], excludedSources: [], unknownConfidenceSources: [] }, conflicts: [], ruleTrace: [], strongAdviceAllowed: true, notes: [], position: null, posture: null, station: null } },
        { orgId: ORG, fusionId: 'FUSE-person:P-1-2', subjectId: 'person:P-1', agreement: 'consistent', confidenceLevel: 'high', fusedAt: NOW, stationId: 'ST-1', conflictCount: 0, usableSourceCount: 3, recordJson: { subjectId: 'person:P-1', windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(), fusedAt: NOW.toISOString(), agreement: 'consistent', confidence: { level: 'high', score: 0.9, basis: 'x', usableSources: ['uwb'], degraded: false, missingSources: [], excludedSources: [], unknownConfidenceSources: [] }, conflicts: [], ruleTrace: [], strongAdviceAllowed: true, notes: [], position: null, posture: null, station: null } },
        { orgId: ORG, fusionId: 'FUSE-person:P-2-1', subjectId: 'person:P-2', agreement: 'conflict', confidenceLevel: 'medium', fusedAt: NOW, stationId: null, conflictCount: 1, usableSourceCount: 3, recordJson: { subjectId: 'person:P-2', windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(), fusedAt: NOW.toISOString(), agreement: 'conflict', confidence: { level: 'medium', score: 0.5, basis: 'x', usableSources: ['uwb'], degraded: true, missingSources: [], excludedSources: [], unknownConfidenceSources: [] }, conflicts: [], ruleTrace: [], strongAdviceAllowed: false, notes: [], position: null, posture: null, station: null } },
      ],
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const all = await service.list(ACTOR);
    expect(all).toHaveLength(2);
    expect(all.find((f) => f.subjectId === 'person:P-1')?.agreement).toBe('consistent');
    const filtered = await service.list(ACTOR, { agreement: 'conflict' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].subjectId).toBe('person:P-2');
  });
});


/* ── NO-56b：区域级环境多源融合 ───────────────────────────────────────── */

describe('PerceptionFusionService.sweep（关节角 → 动作，NO-59a）', () => {
  it('关节角可判定 → 外骨骼产出动作观测；与视觉动作相反 → 记动作冲突', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 5, jointAngles: { left_knee: 5, right_knee: 6 } }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', action: 'squatting' }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const fused = result.fused[0];
    expect(fused.confidence.usableSources).toContain('exo_imu');
    const actionConflicts = fused.conflicts.filter((c) => c.dimension === 'action');
    expect(actionConflicts).toHaveLength(1);
    expect(actionConflicts[0].participants.map((p) => p.source).sort()).toEqual(['exo_imu', 'vision']);
    // 姿态结论的动作字段来自外骨骼（姿态主源）派生动作
    expect(fused.posture?.action).toBe('standing');
  });

  it('关节角与视觉动作一致 → 不记动作冲突', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 5, jointAngles: { left_knee: 5, right_knee: 6 } }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', action: 'standing' }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.fused[0].conflicts.filter((c) => c.dimension === 'action')).toHaveLength(0);
  });

  it('关节角判定不了 → 不产出动作观测，并如实写 note（不默认 standing）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 30, jointAngles: { left_knee: 45, right_knee: 48 } }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', action: 'standing' }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.notes.join(' ')).toContain('外骨骼关节角未产出动作判定');
    expect(result.notes.join(' ')).toContain('中间态');
    // 视觉动作仍在（单源动作结论照旧可用），只是没有第二个源来交叉验证
    expect(result.fused[0].conflicts.filter((c) => c.dimension === 'action')).toHaveLength(0);
  });

  it('没有关节角（老设备）→ 不产出动作观测也不误报冲突（向后兼容）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 5 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A', action: 'squatting' }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.notes.join(' ')).toContain('缺少膝角');
    expect(result.fused[0].conflicts.filter((c) => c.dimension === 'action')).toHaveLength(0);
  });

  it('多维度源不再抬高置信度：外骨骼报 posture+action 与只报 posture 分数一致', async () => {
    const withAction = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 5, jointAngles: { left_knee: 5, right_knee: 6 } }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A' }],
      stations: STATIONS,
    });
    const withoutAction = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      telemetry: [{ deviceId: 'EXO-1', entityId: 'person:P-1', pitchDeg: 5 }],
      vision: [{ entityId: 'person:P-1', cameraId: 'CAM-A' }],
      stations: STATIONS,
    });
    const a = await new PerceptionFusionService(withAction.db as never, auditMock() as never)
      .sweep(ACTOR, { now: NOW });
    const b = await new PerceptionFusionService(withoutAction.db as never, auditMock() as never)
      .sweep(ACTOR, { now: NOW });
    expect(a.fused[0].confidence.score).toBe(b.fused[0].confidence.score);
  });
});

describe('PerceptionFusionService.list / latestGates（NO-58b 性能与语义）', () => {
  it('subjectIds 批量过滤在查询层生效（只返回关心的主体，不把 200 条快照全捞进内存）', async () => {
    const { db } = createDb({
      fusions: [
        {
          orgId: ORG, fusionId: 'F-1', subjectId: 'person:P-1', agreement: 'consistent',
          confidenceLevel: 'high', stationId: 'ST-1', fusedAt: new Date('2026-09-12T07:59:00.000Z'),
          recordJson: {
            subjectId: 'person:P-1', windowStart: '2026-09-12T07:55:00.000Z', windowEnd: '2026-09-12T08:00:00.000Z',
            fusedAt: '2026-09-12T07:59:00.000Z', agreement: 'consistent', confidence: { level: 'high', score: 0.9, basis: 'b', degraded: false, missingSources: [], excludedSources: [], unknownConfidenceSources: [] },
            position: null, posture: null, station: null, ambient: null, conflicts: [], strongAdviceAllowed: true,
            ruleTrace: [],
          },
        },
        {
          orgId: ORG, fusionId: 'F-2', subjectId: 'person:P-2', agreement: 'conflict',
          confidenceLevel: 'low', stationId: null, fusedAt: new Date('2026-09-12T07:58:00.000Z'),
          recordJson: {
            subjectId: 'person:P-2', windowStart: '2026-09-12T07:55:00.000Z', windowEnd: '2026-09-12T08:00:00.000Z',
            fusedAt: '2026-09-12T07:58:00.000Z', agreement: 'conflict', confidence: { level: 'low', score: 0.3, basis: 'b', degraded: true, missingSources: [], excludedSources: [], unknownConfidenceSources: [] },
            position: null, posture: null, station: null, ambient: null, conflicts: [], strongAdviceAllowed: false,
            ruleTrace: [],
          },
        },
      ],
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);

    const onlyFirst = await service.list(ACTOR, { subjectIds: ['person:P-1'] });
    expect(onlyFirst.map((f) => f.subjectId)).toEqual(['person:P-1']);

    // 门控只包含被点名的主体（其余主体"未评估"不会混进来）
    const gates = await service.latestGates(ACTOR, ['person:P-2']);
    expect([...gates.keys()]).toEqual(['person:P-2']);
    expect(gates.get('person:P-2')?.strongAdviceAllowed).toBe(false);
    expect(gates.has('person:P-1')).toBe(false);

    // 不传主体 → 保持"每个主体最新一条"的旧行为（向后兼容）
    const all = await service.latestGates(ACTOR);
    expect(all.size).toBe(2);
  });
});

describe('PerceptionFusionService.sweep（区域 / 环境多源）', () => {
  it('同一工位两台环境传感器一致 → 区域主体 consistent + 代表值', async () => {
    const { db } = createDb({
      stations: STATIONS,
      environment: [
        { sensorId: 'ENV-1', entityId: 'ST-1', temperature: 30 },
        { sensorId: 'ENV-2', entityId: 'ST-1', temperature: 31 },
      ],
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const area = result.fused.find((f) => f.subjectId === 'station:ST-1');
    expect(area).toBeDefined();
    expect(area?.ambient?.[0]).toMatchObject({ channel: 'temperature', agreement: 'consistent' });
    expect(area?.ambient?.[0].value).toBeCloseTo(30.5, 3);
    expect(area?.agreement).toBe('consistent');
  });

  it('两台传感器不一致 → conflict + 代表值置空（不取平均掩盖分歧）', async () => {
    const { db } = createDb({
      stations: STATIONS,
      environment: [
        { sensorId: 'ENV-1', entityId: 'ST-1', temperature: 20 },
        { sensorId: 'ENV-2', entityId: 'ST-1', temperature: 40 },
      ],
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const area = result.fused.find((f) => f.subjectId === 'station:ST-1');
    expect(area?.agreement).toBe('conflict');
    expect(area?.ambient?.[0].value).toBeNull();
    expect(area?.strongAdviceAllowed).toBe(false);
    expect(result.conflictSubjects).toContain('station:ST-1');
  });

  it('环境观测绑定的实体不是工位 → area 主体 + 不提供工位结论（如实说明）', async () => {
    const { db } = createDb({
      stations: STATIONS,
      environment: [{ sensorId: 'ENV-9', entityId: 'zone-Z9', temperature: 26 }],
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    const area = result.fused.find((f) => f.subjectId === 'area:zone-Z9');
    expect(area).toBeDefined();
    expect(area?.station?.stationId ?? null).toBeNull();
    expect(result.notes.join(' ')).toContain('不是工位实体');
  });

  it('人员主体不把环境源当"应有源"（否则永远降级）', async () => {
    const { db } = createDb({
      locations: [{ entityId: 'person:P-1', x: 10, y: 20 }],
      stations: STATIONS,
    });
    const service = new PerceptionFusionService(db as never, auditMock() as never);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result.fused[0].confidence.missingSources).not.toContain('env_sensor');
  });
});
