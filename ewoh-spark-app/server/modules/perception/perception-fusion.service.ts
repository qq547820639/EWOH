import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  ewohEnvironment,
  ewohPerceptionFusion,
  ewohProductionTask,
  ewohSpatialEntity,
  ewohTelemetry,
  ewohWorldState,
} from '@server/database/schema';
import {
  deriveExoAction,
  deriveVisionTrunkPitch,
  fusePerception,
  perceptionAdviceGate,
  perceptionFusionId,
  validateFusedPerception,
  type FusedPerception,
  type PerceptionAdviceGate,
  type PerceptionObservation,
} from '@shared/perception-fusion';
import { TASK_NON_TERMINAL } from '../task/task.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';

/**
 * 多模态感知融合服务（NO-56a，`docs/architecture/embodied_factory.md` §5）。
 *
 * 读**真实落库的多源观测**并融合：
 *   · `ewoh_world_state` 的定位行（`state_json ? 'locator'`）→ UWB 位置；
 *   · `ewoh_telemetry` 的外骨骼行（`entity_id` = 佩戴人）→ IMU 姿态/动作；
 *   · `ewoh_world_state` 的相机检测行（`state_json ? 'camera_id'`，person 类）→ 视觉交叉验证
 *     （仅当 `track_id` 与该主体 id 一致时归属；否则如实计入未匹配，不按"最像的人"分配）；
 *   · `ewoh_spatial_entity` 的工位实体 → 坐标→工位（最近工位 + 半径，超出即未知）；
 *   · `ewoh_production_task` 的在飞任务 → 任务上下文（期望工位/动作；多个不同工位 = 有歧义 → 不猜）。
 *
 * 边界：**只读**感知事实，只写融合快照与审计；快照号确定性（主体 + 窗口桶）→ 重复扫描幂等；
 * 无可用源时如实给出 unknown/insufficient（不显示成 0%、不编造确定结论）。
 */
export interface PerceptionSweepResult {
  orgId: string;
  windowStart: string;
  windowEnd: string;
  windowMinutes: number;
  bucketMinutes: number;
  /** 候选主体数（窗口内有观测的人）。 */
  subjects: number;
  persisted: number;
  created: number;
  refreshed: number;
  byAgreement: Record<string, number>;
  byConfidenceLevel: Record<string, number>;
  /** 有冲突的主体（页面/上游优先看这些）。 */
  conflictSubjects: string[];
  /** 触发降级（缺源/排除证据）的主体。 */
  degradedSubjects: string[];
  /** 视觉检测存在但 track 未绑定到任何主体（如实暴露，不硬塞）。 */
  unmatchedVisionDetections: number;
  /** 工位无法解析（超出半径/无工位实体）的主体数。 */
  stationUnresolved: number;
  rejected: Array<{ subjectId: string; errors: string[] }>;
  notes: string[];
  fused: FusedPerception[];
}

const WORLD_STATE_LIMIT = 2000;
const TELEMETRY_LIMIT = 2000;
const DEFAULT_WINDOW_MINUTES = 5;
const DEFAULT_BUCKET_MINUTES = 5;
/** 坐标 → 工位的匹配半径（米）：超出即"工位未知"，不取最近的一个凑数。 */
export const STATION_MATCH_RADIUS_M = 5;

@Injectable()
export class PerceptionFusionService {
  private readonly logger = new Logger(PerceptionFusionService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private requireActor(actor?: OrgContext): OrgContext {
    if (!actor?.primaryOrgId?.trim() || !actor.userId?.trim()) {
      throw new BadRequestException('org/用户上下文缺失：感知融合必须带认证租户上下文');
    }
    return actor;
  }

  /** 融合一次（幂等；只读感知事实，只写快照与审计）。 */
  async sweep(
    actor?: OrgContext,
    options: { now?: Date; windowMinutes?: number; bucketMinutes?: number } = {},
  ): Promise<PerceptionSweepResult> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const now = options.now ?? new Date();
    const windowMinutes = Number.isFinite(options.windowMinutes)
      ? Math.min(Math.max(Math.trunc(Number(options.windowMinutes)), 1), 1440)
      : DEFAULT_WINDOW_MINUTES;
    const bucketMinutes = Number.isFinite(options.bucketMinutes)
      ? Math.min(Math.max(Math.trunc(Number(options.bucketMinutes)), 1), 1440)
      : DEFAULT_BUCKET_MINUTES;
    const windowEnd = now;
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000);
    const bucketMs = bucketMinutes * 60_000;

    const [locationRows, telemetryRows, visionRows, stations, tasks, environmentRows] = await Promise.all([
      this.db
        .select({ entityId: ewohWorldState.entityId, stateJson: ewohWorldState.stateJson, ts: ewohWorldState.ts })
        .from(ewohWorldState)
        .where(and(
          eq(ewohWorldState.orgId, orgId),
          gte(ewohWorldState.ts, windowStart),
          sql`${ewohWorldState.stateJson} ? 'locator'`,
        ))
        .orderBy(desc(ewohWorldState.ts))
        .limit(WORLD_STATE_LIMIT),
      this.db
        .select({
          deviceId: ewohTelemetry.deviceId,
          entityId: ewohTelemetry.entityId,
          ts: ewohTelemetry.ts,
          pitchDeg: ewohTelemetry.pitchDeg,
          jointAngles: ewohTelemetry.jointAngles,
          dataQuality: ewohTelemetry.dataQuality,
          dataConfidence: ewohTelemetry.dataConfidence,
          sourceType: ewohTelemetry.sourceType,
        })
        .from(ewohTelemetry)
        .where(and(
          eq(ewohTelemetry.orgId, orgId),
          gte(ewohTelemetry.ts, windowStart),
          isNotNull(ewohTelemetry.entityId),
        ))
        .orderBy(desc(ewohTelemetry.ts))
        .limit(TELEMETRY_LIMIT),
      this.db
        .select({ entityId: ewohWorldState.entityId, stateJson: ewohWorldState.stateJson, ts: ewohWorldState.ts })
        .from(ewohWorldState)
        .where(and(
          eq(ewohWorldState.orgId, orgId),
          gte(ewohWorldState.ts, windowStart),
          sql`${ewohWorldState.stateJson} ? 'camera_id'`,
        ))
        .orderBy(desc(ewohWorldState.ts))
        .limit(WORLD_STATE_LIMIT),
      this.db
        .select({
          entityId: ewohSpatialEntity.entityId,
          entityType: ewohSpatialEntity.entityType,
          x: ewohSpatialEntity.x,
          y: ewohSpatialEntity.y,
        })
        .from(ewohSpatialEntity)
        .where(and(
          eq(ewohSpatialEntity.orgId, orgId),
          // 工位 + 相机：相机自身坐标用于"这台相机覆盖哪个工位"的显式绑定
          // （matchedBy=camera_station_binding；相机没坐标就只贡献"有人"、不给工位信号）。
          inArray(ewohSpatialEntity.entityType, ['station', 'workstation', 'camera']),
        ))
        .limit(500),
      this.db
        .select({
          taskId: ewohProductionTask.id,
          assigneeId: ewohProductionTask.assigneeId,
          spatialEntityId: ewohProductionTask.spatialEntityId,
          taskType: ewohProductionTask.taskType,
          status: ewohProductionTask.status,
        })
        .from(ewohProductionTask)
        .where(and(
          eq(ewohProductionTask.orgId, orgId),
          isNotNull(ewohProductionTask.assigneeId),
          inArray(ewohProductionTask.status, [...TASK_NON_TERMINAL]),
        ))
        .limit(500),
      this.db
        .select({
          sensorId: ewohEnvironment.sensorId,
          entityId: ewohEnvironment.entityId,
          ts: ewohEnvironment.ts,
          temperature: ewohEnvironment.temperature,
          vibration: ewohEnvironment.vibration,
          noise: ewohEnvironment.noise,
          airQuality: ewohEnvironment.airQuality,
          dataConfidence: ewohEnvironment.dataConfidence,
        })
        .from(ewohEnvironment)
        .where(and(
          eq(ewohEnvironment.orgId, orgId),
          gte(ewohEnvironment.ts, windowStart),
          isNotNull(ewohEnvironment.entityId),
        ))
        .orderBy(desc(ewohEnvironment.ts))
        .limit(WORLD_STATE_LIMIT),
    ]);

    const stationEntities = stations.filter((s) => s.entityType !== 'camera');
    const cameraEntities = stations.filter((s) => s.entityType === 'camera');
    const stationById = new Map(stationEntities.map((s) => [s.entityId, s]));
    // 注：`stationById` 在下方环境主体判定中使用，必须先于主体集合构建。
    const subjects = new Set<string>();
    /** 区域主体：`station:<实体>` 或 `area:<实体>`（环境观测绑定的区域）。 */
    const areaSubjects = new Map<string, string>();
    for (const row of locationRows) if (row.entityId) subjects.add(row.entityId);
    for (const row of telemetryRows) if (row.entityId) subjects.add(row.entityId);
    for (const row of environmentRows) {
      const entity = String(row.entityId ?? '').trim();
      if (entity === '') continue;
      const isStation = stationById.has(entity);
      const subjectId = isStation ? `station:${entity}` : `area:${entity}`;
      areaSubjects.set(subjectId, entity);
      subjects.add(subjectId);
    }

    const tasksByPerson = new Map<string, Array<{ taskId: string; spatialEntityId: string | null; taskType: string }>>();
    for (const task of tasks) {
      const assignee = String(task.assigneeId ?? '').trim();
      if (assignee === '') continue;
      const list = tasksByPerson.get(assignee) ?? [];
      list.push({ taskId: String(task.taskId), spatialEntityId: task.spatialEntityId, taskType: String(task.taskType) });
      tasksByPerson.set(assignee, list);
    }

    // 视觉检测：只按 track_id == 主体 id 归属；其余如实计入未匹配。
    const visionBySubject = new Map<string, Array<{ cameraId: string; stateJson: Record<string, unknown>; ts: Date }>>();
    let unmatchedVisionDetections = 0;
    for (const row of visionRows) {
      const state = (row.stateJson ?? {}) as Record<string, unknown>;
      if (String(state.class_name ?? '') !== 'person') continue;
      const raw = String(row.entityId ?? '');
      const trackId = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      if (subjects.has(trackId)) {
        const list = visionBySubject.get(trackId) ?? [];
        list.push({ cameraId: String(state.camera_id ?? ''), stateJson: state, ts: row.ts });
        visionBySubject.set(trackId, list);
      } else {
        unmatchedVisionDetections += 1;
      }
    }

    const result: PerceptionSweepResult = {
      orgId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      windowMinutes,
      bucketMinutes,
      subjects: subjects.size,
      persisted: 0,
      created: 0,
      refreshed: 0,
      byAgreement: {},
      byConfidenceLevel: {},
      conflictSubjects: [],
      degradedSubjects: [],
      unmatchedVisionDetections,
      stationUnresolved: 0,
      rejected: [],
      notes: [],
      fused: [],
    };

    for (const subjectId of [...subjects].sort()) {
      const observations: PerceptionObservation[] = [];

      // ── 区域主体（环境多源）：station:<实体> / area:<实体> ────────────────
      const areaEntity = areaSubjects.get(subjectId);
      if (areaEntity) {
        const rows = environmentRows.filter((row) => String(row.entityId ?? '') === areaEntity);
        // 通道 → 每台传感器一条观测（同类多源交叉验证就发生在这里）
        const channels: Array<[string, number | null]> = [
          ['temperature', rows[0]?.temperature ?? null],
          ['vibration', rows[0]?.vibration ?? null],
          ['noise', rows[0]?.noise ?? null],
          ['air_quality', rows[0]?.airQuality ?? null],
        ];
        for (const [channel] of channels) {
          // 同通道按传感器各取窗口内最新一条
          const seen = new Set<string>();
          for (const row of rows) {
            const sensorId = String(row.sensorId ?? '');
            if (sensorId === '' || seen.has(sensorId)) continue;
            const raw = channel === 'temperature'
              ? row.temperature
              : channel === 'vibration'
                ? row.vibration
                : channel === 'noise'
                  ? row.noise
                  : row.airQuality;
            if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
            seen.add(sensorId);
            observations.push({
              source: 'env_sensor',
              sourceId: sensorId,
              dimension: 'ambient',
              observedAt: row.ts.toISOString(),
              quality: 'good',
              confidence:
                typeof row.dataConfidence === 'number' && Number.isFinite(row.dataConfidence)
                  ? row.dataConfidence
                  : null,
              value: { channel, ambient: Number(raw) },
              matchedBy: 'entity_id',
            });
          }
        }
        // 工位语义：区域主体自身的登记事实（"这是哪个工位/区域"）
        observations.push({
          source: 'station_semantics',
          sourceId: areaEntity,
          dimension: 'station_presence',
          observedAt: now.toISOString(),
          quality: 'good',
          confidence: 1,
          value: { stationId: stationById.has(areaEntity) ? areaEntity : null },
          matchedBy: 'station_entity',
        });
        if (!stationById.has(areaEntity)) {
          result.notes.push(`${subjectId}：环境观测绑定的实体不是工位实体 → 不提供工位结论，只做环境通道融合`);
        }
      }

      // UWB：取窗口内最新一条
      const location = locationRows.find((row) => row.entityId === subjectId);
      let stationFromLocation: { stationId: string; distanceM: number; radiusM: number; basis: string } | null = null;
      if (location) {
        const state = (location.stateJson ?? {}) as Record<string, unknown>;
        const x = Number(state.x);
        const y = Number(state.y);
        const stationMatch = Number.isFinite(x) && Number.isFinite(y)
          ? this.nearestStation(stationEntities, x, y)
          : null;
        stationFromLocation = stationMatch
          ? {
              stationId: stationMatch.stationId,
              distanceM: Math.round(stationMatch.distanceM * 100) / 100,
              radiusM: STATION_MATCH_RADIUS_M,
              basis: `nearest station within ${STATION_MATCH_RADIUS_M}m`,
            }
          : null;
        observations.push({
          source: 'uwb',
          sourceId: String(state.record_id ?? state.locator ?? 'uwb'),
          dimension: 'position',
          observedAt: location.ts.toISOString(),
          quality: 'good',
          confidence: typeof state.confidence === 'number' ? state.confidence : null,
          value: {
            x: Number.isFinite(x) ? x : null,
            y: Number.isFinite(y) ? y : null,
            z: Number.isFinite(Number(state.z)) ? Number(state.z) : null,
            stationId: stationFromLocation?.stationId ?? null,
          },
          matchedBy: 'entity_id',
        });
      }
      // 外骨骼：窗口内最新一条（entity_id = 佩戴人）
      const telemetry = telemetryRows.find((row) => row.entityId === subjectId);
      if (telemetry) {
        const quality = String(telemetry.dataQuality ?? 'good');
        observations.push({
          source: 'exo_imu',
          sourceId: telemetry.deviceId,
          dimension: 'posture',
          observedAt: telemetry.ts.toISOString(),
          quality: quality === 'invalid' ? 'invalid' : quality === 'degraded' ? 'degraded' : 'good',
          confidence:
            typeof telemetry.dataConfidence === 'number' && Number.isFinite(telemetry.dataConfidence)
              ? telemetry.dataConfidence
              : null,
          value: { pitchDeg: telemetry.pitchDeg ?? null },
          matchedBy: 'wearer_binding',
        });
        // NO-59a：关节角 → 动作（动作维度的第二个独立源，供与视觉动作交叉验证）。
        // 关节角一直被摄入却从未参与融合；判定不了就如实记 note（不猜、不默认 standing）。
        const jointAngles = (telemetry.jointAngles ?? null) as Record<string, unknown> | null;
        const derived = deriveExoAction(jointAngles, telemetry.pitchDeg ?? null);
        if (derived.action === null) {
          result.notes.push(
            `${subjectId}：外骨骼关节角未产出动作判定（${derived.reason ?? '未知原因'}；依据 ${derived.basis}）`,
          );
        } else {
          observations.push({
            source: 'exo_imu',
            sourceId: telemetry.deviceId,
            dimension: 'action',
            observedAt: telemetry.ts.toISOString(),
            quality: quality === 'invalid' ? 'invalid' : quality === 'degraded' ? 'degraded' : 'good',
            confidence:
              typeof telemetry.dataConfidence === 'number' && Number.isFinite(telemetry.dataConfidence)
                ? telemetry.dataConfidence
                : null,
            value: { action: derived.action },
            matchedBy: 'wearer_binding_joint_angles',
          });
        }
      }
      // 视觉：窗口内最新一条 person 检测（track_id == 主体 id 才归属）
      const vision = visionBySubject.get(subjectId);
      if (vision && vision.length > 0) {
        const latest = vision[0];
        const bboxCenter = this.bboxCenter(latest.stateJson);
        // 视觉的工位结论来自**相机自身的工位绑定**（相机坐标 → 最近工位，半径内）。
        // 不能复用 UWB 解析出的工位：那样规则 1/2（UWB vs 视觉）永远不可能产生冲突，
        // 等于把"交叉验证"做成了一句空话。
        const camera = cameraEntities.find((c) => c.entityId === latest.cameraId);
        const cameraStation = camera && Number.isFinite(Number(camera.x)) && Number.isFinite(Number(camera.y))
          ? this.nearestStation(stationEntities, Number(camera.x), Number(camera.y))
          : null;
        if (camera && !cameraStation) result.notes.push(
          `${subjectId}：相机 ${latest.cameraId} 未绑定到任何工位（缺坐标或超出半径）→ 视觉只贡献"有人"，不提供工位信号`,
        );
        observations.push({
          source: 'vision',
          sourceId: latest.cameraId,
          dimension: 'station_presence',
          observedAt: latest.ts.toISOString(),
          quality: 'good',
          confidence:
            typeof latest.stateJson.confidence === 'number' ? (latest.stateJson.confidence as number) : null,
          value: {
            stationId: cameraStation?.stationId ?? null,
            present: true,
            x: bboxCenter?.x ?? null,
            y: bboxCenter?.y ?? null,
          },
          matchedBy: 'camera_station_binding',
        });
        const action = String(latest.stateJson.action ?? '').trim();
        if (action !== '') {
          observations.push({
            source: 'vision',
            sourceId: latest.cameraId,
            dimension: 'action',
            observedAt: latest.ts.toISOString(),
            quality: 'good',
            confidence:
              typeof latest.stateJson.confidence === 'number' ? (latest.stateJson.confidence as number) : null,
            value: { action },
            matchedBy: 'track_id',
          });
        }
        // NO-58c：骨架 → 躯干俯仰（第二个独立角度源，用于与外骨骼交叉验证）。
        // 只有骨架能确定换算时才产出姿态观测；算不出来就如实记 note（不猜、不产出 0）。
        const skeleton = latest.stateJson.skeleton;
        if (skeleton && typeof skeleton === 'object') {
          const trunk = deriveVisionTrunkPitch(skeleton as Record<string, unknown>);
          if (trunk.pitchDeg === null) {
            result.notes.push(`${subjectId}：视觉骨架无法换算躯干角（${trunk.reason ?? '未知原因'}）→ 姿态维度不采信视觉`);
          } else {
            observations.push({
              source: 'vision',
              sourceId: latest.cameraId,
              dimension: 'posture',
              observedAt: latest.ts.toISOString(),
              quality: 'good',
              confidence:
                typeof latest.stateJson.confidence === 'number' ? (latest.stateJson.confidence as number) : null,
              value: { pitchDeg: trunk.pitchDeg },
              matchedBy: 'track_id_skeleton',
            });
          }
        }
      }
      // 任务上下文：在飞任务（多个不同工位 = 有歧义 → 不猜）
      const personTasks = tasksByPerson.get(subjectId) ?? [];
      const taskStations = [...new Set(personTasks.map((t) => String(t.spatialEntityId ?? '')).filter((s) => s !== ''))];
      const taskContext = personTasks.length === 0
        ? null
        : taskStations.length === 1 && stationById.has(taskStations[0])
          ? {
              stationId: taskStations[0],
              expectedAction: personTasks[0].taskType,
              basis: `task:${personTasks[0].taskId}`,
            }
          : null;
      if (personTasks.length > 0 && taskContext === null) {
        result.notes.push(
          `${subjectId}：在飞任务 ${personTasks.length} 个、期望工位 ${taskStations.length} 种 → 任务上下文有歧义，置空（不猜）`,
        );
      }
      if (!stationFromLocation && location) result.stationUnresolved += 1;

      const fused = fusePerception({
        subjectId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        now: now.toISOString(),
        observations,
        stationFromLocation,
        taskContext,
      });
      const errors = validateFusedPerception(fused);
      if (errors.length > 0) {
        this.logger.warn(`融合快照 ${subjectId} 未通过契约校验，已跳过：${errors.join(', ')}`);
        result.rejected.push({ subjectId, errors });
        continue;
      }
      const outcome = await this.persist(orgId, subjectId, fused, bucketMs, ctx.userId, now);
      if (outcome === 'created') result.created += 1;
      else result.refreshed += 1;
      result.persisted += 1;
      result.byAgreement[fused.agreement] = (result.byAgreement[fused.agreement] ?? 0) + 1;
      result.byConfidenceLevel[fused.confidence.level] = (result.byConfidenceLevel[fused.confidence.level] ?? 0) + 1;
      if (fused.conflicts.length > 0) result.conflictSubjects.push(subjectId);
      if (fused.confidence.degraded) result.degradedSubjects.push(subjectId);
      result.fused.push(fused);
    }

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'perception.fusion_sweep',
      entityType: 'perception_fusion',
      entityId: orgId,
      reason: `window=${windowMinutes}min bucket=${bucketMinutes}min`,
      before: {
        locationRows: locationRows.length,
        telemetryRows: telemetryRows.length,
        visionRows: visionRows.length,
      },
      after: {
        subjects: result.subjects,
        persisted: result.persisted,
        conflicts: result.conflictSubjects.length,
        degraded: result.degradedSubjects.length,
        unmatchedVisionDetections: result.unmatchedVisionDetections,
      },
    });
    return result;
  }

  /** 最新融合快照（默认每个主体取最新一条；可按一致性/主体过滤）。 */
  async list(
    actor?: OrgContext,
    filters: { subjectId?: string; subjectIds?: readonly string[]; agreement?: string; limit?: number } = {},
  ): Promise<FusedPerception[]> {
    const ctx = this.requireActor(actor);
    const conditions = [eq(ewohPerceptionFusion.orgId, ctx.primaryOrgId)];
    if (filters.subjectId?.trim()) conditions.push(eq(ewohPerceptionFusion.subjectId, filters.subjectId.trim()));
    // 批量主体过滤（NO-58b 性能）：门控消费者关心的是"我正在评估的这批主体"，
    // 让过滤发生在 SQL 里，而不是取 200 条快照到内存再筛（快照带 JSON，代价不低）。
    const wantedSubjects = [...new Set((filters.subjectIds ?? []).map((id) => String(id).trim()).filter((id) => id !== ''))];
    if (wantedSubjects.length > 0) conditions.push(inArray(ewohPerceptionFusion.subjectId, wantedSubjects));
    if (filters.agreement?.trim()) conditions.push(eq(ewohPerceptionFusion.agreement, filters.agreement.trim()));
    const limit = Number.isFinite(filters.limit)
      ? Math.min(Math.max(Math.trunc(Number(filters.limit)), 1), 500)
      : 100;
    const rows = await this.db
      .select()
      .from(ewohPerceptionFusion)
      .where(and(...conditions))
      .orderBy(desc(ewohPerceptionFusion.fusedAt))
      .limit(limit);
    const seen = new Set<string>();
    const latest: FusedPerception[] = [];
    for (const row of rows) {
      if (seen.has(row.subjectId)) continue;
      seen.add(row.subjectId);
      latest.push((row.recordJson ?? {}) as FusedPerception);
    }
    return latest;
  }

  /**
   * 最新**建议门控**（NO-58b）：给推理/候选引擎消费，避免它们各自解析融合快照。
   *
   * 只返回有快照的主体；没有快照的主体**不在返回里**（缺席 = 未评估，
   * 不等于"可以强建议"——调用方必须自己决定缺省语义，这里不替它猜）。
   */
  async latestGates(actor?: OrgContext, subjectIds?: readonly string[]): Promise<Map<string, PerceptionAdviceGate>> {
    const ctx = this.requireActor(actor);
    // 只取需要的主体（SQL 层过滤）；没给主体列表时才退化为"最近 200 条里每个主体最新一条"。
    const requested = (subjectIds ?? []).map((id) => String(id).trim()).filter((id) => id !== '');
    const latest = await this.list(ctx, {
      limit: requested.length > 0 ? Math.min(requested.length * 2, 200) : 200,
      subjectIds: requested,
    });
    const wanted = requested.length > 0 ? new Set(requested) : null;
    const gates = new Map<string, PerceptionAdviceGate>();
    for (const fused of latest) {
      if (wanted && !wanted.has(fused.subjectId)) continue;
      gates.set(fused.subjectId, perceptionAdviceGate(fused));
    }
    return gates;
  }

  /* ── 内部工具 ─────────────────────────────────────────────────────────── */

  /** 最近工位（半径内）；超出半径返回 null（不猜）。 */
  private nearestStation(
    stations: Array<{ entityId: string; x: number | null; y: number | null }>,
    x: number,
    y: number,
  ): { stationId: string; distanceM: number } | null {
    let best: { stationId: string; distanceM: number } | null = null;
    for (const station of stations) {
      if (!Number.isFinite(Number(station.x)) || !Number.isFinite(Number(station.y))) continue;
      const dx = Number(station.x) - x;
      const dy = Number(station.y) - y;
      const distanceM = Math.sqrt(dx * dx + dy * dy);
      if (distanceM > STATION_MATCH_RADIUS_M) continue;
      if (!best || distanceM < best.distanceM) best = { stationId: station.entityId, distanceM };
    }
    return best;
  }

  private bboxCenter(state: Record<string, unknown>): { x: number; y: number } | null {
    const bbox = state.bbox as { x?: number; y?: number; w?: number; h?: number } | null | undefined;
    if (!bbox || !Number.isFinite(Number(bbox.x)) || !Number.isFinite(Number(bbox.y))) return null;
    const w = Number(bbox.w ?? 0);
    const h = Number(bbox.h ?? 0);
    return { x: Number(bbox.x) + w / 2, y: Number(bbox.y) + h / 2 };
  }

  private async persist(
    orgId: string,
    subjectId: string,
    fused: FusedPerception,
    bucketMs: number,
    actorId: string,
    now: Date,
  ): Promise<'created' | 'refreshed'> {
    const fusionId = perceptionFusionId(subjectId, fused.windowEnd, bucketMs);
    const [existing] = await this.db
      .select({ id: ewohPerceptionFusion.id })
      .from(ewohPerceptionFusion)
      .where(and(eq(ewohPerceptionFusion.orgId, orgId), eq(ewohPerceptionFusion.fusionId, fusionId)))
      .limit(1);
    const values = {
      subjectId,
      windowStart: new Date(fused.windowStart),
      windowEnd: new Date(fused.windowEnd),
      fusedAt: new Date(fused.fusedAt),
      agreement: fused.agreement,
      confidenceLevel: fused.confidence.level,
      confidenceScore: fused.confidence.score,
      degraded: fused.confidence.degraded,
      strongAdviceAllowed: fused.strongAdviceAllowed,
      stationId: fused.station?.stationId ?? null,
      conflictCount: fused.conflicts.length,
      usableSourceCount: fused.confidence.usableSources.length,
      sourcesJson: fused.confidence,
      conflictsJson: fused.conflicts,
      ruleTraceJson: fused.ruleTrace,
      recordJson: fused as unknown as Record<string, unknown>,
      updatedAt: now,
      updatedBy: actorId,
    };
    if (!existing) {
      await this.db.insert(ewohPerceptionFusion).values({
        orgId,
        fusionId,
        createdBy: actorId,
        ...values,
      });
      return 'created';
    }
    await this.db
      .update(ewohPerceptionFusion)
      .set(values)
      .where(and(eq(ewohPerceptionFusion.orgId, orgId), eq(ewohPerceptionFusion.fusionId, fusionId)));
    return 'refreshed';
  }
}
