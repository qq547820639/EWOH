import { Injectable, Inject, Logger, BadRequestException, HttpException, HttpStatus, Optional } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohDevice,
  ewohTelemetry,
  ewohEvent,
  ewohSpatialEntity,
  ewohIngestEventDedup,
} from '@server/database/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type {
  ExoskeletonFrameDto,
  EnvironmentFrameDto,
  CameraFrameDto,
  MesOrderDto,
  IngestResponse,
  BatchIngestResponse,
  EnvelopeEventDto,
  IngestEventResult,
  IngestEventBatchResponse,
  DataQuality,
  DataSourceType,
} from '@shared/api.interface';
import { RuleEngineService } from '../rule-engine/rule-engine.service';
import { MesService } from '../mes/mes.service';
import { SensorIngestService } from './sensor-ingest.service';
import { ReplanCoordinatorService } from '../scheduler/replan-coordinator.service';
import { IdentityService } from '../identity/identity.service';
import { normalizeSeverity, normalizeEventSeverity } from '@shared/risk';
import {
  buildEventEnvelope,
  envelopeForEvidence,
  envelopeSemantics,
  validateEventEnvelope,
} from '@shared/event-envelope';
import { DeadLetterService } from '../reliability/dead-letter.service';
import { ExoSessionService } from '../exo/exo-session.service';
import { insertAndonNotifications } from '../notification/andon-notifications';
import { isCatalogEventType, EVENT_CATALOG_TYPES } from '@shared/event-catalog';
import type { OrgContext } from '../shared/org-context.interceptor';

/** NO-04b：事件上行 Catalog 类型白名单（锁定投影的 Set，单次构建）。 */
const CATALOG_TYPE_SET: ReadonlySet<string> = new Set(EVENT_CATALOG_TYPES);

/**
 * Ingestion 服务（真机接入网关 - 皮肤+肢体数据汇聚）
 *
 * 接收来自边缘侧桥接脚本（edge_to_spark.py）的真机数据：
 *  - 外骨骼帧（UnifiedExoFrame 映射）
 *  - 环境传感器帧
 *  - 摄像头结构化检测帧
 *  - MES 工单事件
 *
 * 数据质量校验：
 *  - entity_id 存在性（ewoh_spatial_entity）
 *  - 时钟漂移（超前 +5min → invalid）
 *  - battery_pct 范围（0-100）
 *  - packet_loss_pct > 5 → degraded
 *  - raw_ref 幂等去重
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  /** 时钟漂移容忍上限（ms） */
  private static readonly CLOCK_DRIFT_MS = 5 * 60 * 1000;
  /** 丢包率降级阈值 */
  private static readonly PACKET_LOSS_DEGRADED = 5;
  /** 批量上限 */
  private static readonly BATCH_LIMIT = 100;
  /**
   * 身份解析的第三方系统命名空间（ADR-006/NO-02b）：
   * 边缘桥接上报的设备标识（vendor 序列号/配置 ID）经 ewoh_identity_mapping
   * 登记后解析为规范身份；未登记 → 遥测 entity_id 为 NULL（legacy 行为不变）。
   */
  private static readonly EDGE_DEVICE_SYSTEM = 'edge-device';

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ruleEngine: RuleEngineService,
    private readonly mesService: MesService,
    private readonly sensorIngest: SensorIngestService,
    // v0.7 B1：设备故障/离线转换 → DEVICE_OFFLINE 局部重排（事件驱动调度闭环）。
    private readonly replanCoordinator: ReplanCoordinatorService,
    // ADR-006 / NO-02b：设备 ID → 规范身份解析（ewoh_telemetry.entity_id 落点）。
    private readonly identityService: IdentityService,
    // NO-11a（ADR-024）：永久失败 → 死信终态台账（best-effort 旁路）。
    @Optional() private readonly deadLetterService?: DeadLetterService,
    // ADR-033 / §7：边缘绑定事件 → 云 ExoSession 台账投影（幂等）
    @Optional() private readonly exoSessionService?: ExoSessionService,
  ) {}

  // ===== 外骨骼数据接入 =====

  /** 单帧外骨骼数据接入（v0.7 B1：ctx 供设备离线重排定位租户） */
  async ingestExoskeleton(frame: ExoskeletonFrameDto, ctx?: OrgContext): Promise<IngestResponse> {
    return this.processOneFrame(frame, ctx);
  }

  /**
   * 批量外骨骼数据接入（≤100 条）。
   *
   * P1-INGEST-001：由逐帧串行（每帧 ≥3 次 DB 往返）改为批量预检 + 批量落库：
   *  1. 批量 entity 存在性查询（一次 IN）；
   *  2. 批量 raw_ref 幂等查询（一次 IN）；
   *  3. 逐帧映射为 telemetryRow（纯计算，无 DB）；
   *  4. 批量 insert telemetry（一次 INSERT ... VALUES）；
   *  5. 逐帧规则评估（RuleEngine 写事件，保留逐条语义）。
   * 每帧 DB 往返从 ~3 降到 ~1（规则评估）。
   */
  async ingestExoskeletonBatch(
    frames: ExoskeletonFrameDto[],
    ctx?: OrgContext,
  ): Promise<BatchIngestResponse> {
    const list = frames.slice(0, IngestService.BATCH_LIMIT);

    // 1. 批量解析 entity_id / raw_ref / device_id（纯计算）
    const parsed = list.map((frame) => ({
      frame,
      entityId: frame.entity_id ?? frame.device_id ?? '',
      deviceId: frame.device_id ?? frame.entity_id ?? '',
      rawRef: frame.raw_ref ?? this.computeRawRef(frame),
      sourceType: (frame.source_type ?? 'real') as DataSourceType,
      recordId: frame.record_id ?? randomUUID(),
    }));

    // 2. 批量 entity 存在性预检（R2-SOP-011/R2-SAM-012：有租户上下文时带 org 谓词）
    const batchOrgId = ctx?.primaryOrgId?.trim();
    const entityIds = Array.from(
      new Set(parsed.map((p) => p.entityId).filter((id) => !!id)),
    );
    const existingEntityIds = new Set<string>();
    if (entityIds.length > 0) {
      try {
        const rows = await this.db
          .select({ entityId: ewohSpatialEntity.entityId })
          .from(ewohSpatialEntity)
          .where(
            batchOrgId
              ? and(
                  eq(ewohSpatialEntity.orgId, batchOrgId),
                  inArray(ewohSpatialEntity.entityId, entityIds),
                )
              : inArray(ewohSpatialEntity.entityId, entityIds),
          );
        for (const r of rows) existingEntityIds.add(r.entityId);
      } catch (error) {
        this.logger.warn(
          `批量 entity 预检失败（fail-closed 拒绝写入）：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    // 3. 批量 raw_ref 幂等预检
    const rawRefs = parsed.map((p) => p.rawRef).filter(Boolean);
    const existingRawRefs = new Set<string>();
    if (rawRefs.length > 0) {
      try {
        const rows = await this.db
          .select({ rawRef: ewohTelemetry.rawRef })
          .from(ewohTelemetry)
          .where(
            batchOrgId
              ? and(
                  eq(ewohTelemetry.orgId, batchOrgId),
                  inArray(ewohTelemetry.rawRef, rawRefs),
                )
              : inArray(ewohTelemetry.rawRef, rawRefs),
          );
        for (const r of rows) existingRawRefs.add(r.rawRef);
      } catch (error) {
        this.logger.warn(
          `批量 raw_ref 预检失败（fail-closed 拒绝写入）：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    // 3.5 批量身份解析（ADR-006/NO-02b）：一次 IN 查询解析设备规范身份。
    //     未登记 / 无租户上下文 → legacy 行为（entity_id 为 NULL，不阻断遥测入库）。
    let resolvedEntities = new Map<string, string>();
    if (batchOrgId) {
      try {
        resolvedEntities = await this.identityService.resolveBatch(
          IngestService.EDGE_DEVICE_SYSTEM,
          Array.from(new Set(parsed.map((p) => p.deviceId).filter((id) => !!id))),
          batchOrgId,
        );
      } catch (error) {
        this.logger.warn(
          `批量身份解析失败（fail-closed 回退 legacy 行为）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 4. 逐帧：质量评估 + 字段映射（纯计算）；批量插入
    const results: IngestResponse[] = [];
    const now = new Date();
    const telemetryRows: Array<typeof ewohTelemetry.$inferInsert> = [];
    const deviceUpserts = new Map<string, typeof ewohDevice.$inferInsert>();
    const acceptedIdx: Array<{ parsedIdx: number; telemetryRow: (typeof ewohTelemetry.$inferInsert) }> = [];
    // NO-04a：Late/ClockDrift 时间语义（ADR-009）+ 同批次数据质量事件语义去重。
    const firedDataQualityEvents = new Set<string>();
    let lateCount = 0;
    let driftCount = 0;

    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      const frameSemantics = this.frameSemantics(p.frame);
      if (p.entityId && !existingEntityIds.has(p.entityId)) {
        // 写告警事件（同一批次内同 (eventCode,device) 只写一次，避免批量风暴与重试重复投递）
        const dedupKey = `ENTITY_NOT_FOUND|${p.deviceId}`;
        let eventsTriggered = 0;
        if (!firedDataQualityEvents.has(dedupKey)) {
          firedDataQualityEvents.add(dedupKey);
          eventsTriggered = (await this.fireDataQualityEvent(
            p.deviceId,
            p.sourceType,
            p.recordId,
            'ENTITY_NOT_FOUND',
            `entity_id ${p.entityId} 不存在`,
            { entity_id: p.entityId },
            batchOrgId,
          ))
            ? 1
            : 0;
        }
        results.push({
          accepted: false,
          skipped: false,
          record_id: p.recordId,
          data_quality: 'invalid',
          events_triggered: eventsTriggered,
          error: `entity_id ${p.entityId} 不存在`,
          is_late: frameSemantics.isLate,
          clock_drift: frameSemantics.clockDrift,
        });
        continue;
      }
      if (p.rawRef && existingRawRefs.has(p.rawRef)) {
        results.push({
          accepted: false,
          skipped: true,
          record_id: p.recordId,
          data_quality: 'good',
          events_triggered: 0,
        });
        continue;
      }

      const dataQuality = this.assessQuality(p.frame);
      const row = this.mapExoskeletonRow(p.frame, p.deviceId, p.sourceType, p.recordId, p.rawRef, dataQuality, now);
      // ADR-006/NO-02b：规范身份落点（未映射 → null，legacy 行为不变）。
      row.entityId = resolvedEntities.get(p.deviceId) ?? null;
      // ADR-075：telemetry 行归属注入（001 ewoh_org_visible RLS 对齐）。
      row.orgId = batchOrgId || null;
      telemetryRows.push(row);
      acceptedIdx.push({ parsedIdx: i, telemetryRow: row });

      // upsert device（批量收集后统一落库；v0.7 B1：首次出现故障码的设备触发离线重排）
      const deviceId = p.deviceId;
      if (deviceId && !deviceUpserts.has(deviceId)) {
        const newFaultCode = p.frame.device?.fault_code ?? p.frame.fault_code ?? null;
        if (newFaultCode) {
          // NEST-214：fire-and-forget 显式 catch（未处理 rejection 会污染进程级
          // unhandledRejection 信号；重排失败由 ReplanCoordinator 熔断兜底）。
          void this.detectFaultTransition(deviceId, newFaultCode, ctx).catch(
            (err) => {
              this.logger.warn(
                `detectFaultTransition failed device=${deviceId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          );
        }
        const deviceRow = this.mapDeviceRow(p.frame, deviceId, p.sourceType, now, p.rawRef);
        // ADR-075：device 行归属注入（001 ewoh_org_visible RLS 对齐）。
        deviceRow.orgId = batchOrgId || null;
        deviceUpserts.set(deviceId, deviceRow);
      }
      results.push({
        accepted: true,
        skipped: false,
        record_id: p.recordId,
        data_quality: dataQuality,
        events_triggered: 0, // 规则评估后补记
        is_late: frameSemantics.isLate,
        clock_drift: frameSemantics.clockDrift,
      });
      if (frameSemantics.isLate) lateCount += 1;
      if (frameSemantics.clockDrift) driftCount += 1;
    }

    // 5. 批量 upsert devices（一次）
    if (deviceUpserts.size > 0) {
      try {
        await this.db
          .insert(ewohDevice)
          .values(Array.from(deviceUpserts.values()))
          .onConflictDoUpdate({
            // NEST-205（standalone_057 配套）：唯一约束已改 (org_id, device_id)，
            // 冲突目标同步为复合键（防跨租户同 deviceId 互相覆盖）。
            target: [ewohDevice.orgId, ewohDevice.deviceId],
            // R2-SOP-020：批量路径 set 字段与单帧 upsertDevice 对齐（取该设备
            // 本批首帧的 excluded.* 值）——批量接入下设备台账的电量/故障码/
            // 固件等元数据不再停滞在首次插入值。
            set: {
              batteryPct: sql`excluded.battery_pct`,
              online: true,
              lastTelemetryAt: now,
              sourceType: sql`excluded.source_type`,
              firmwareVersion: sql`excluded.firmware_version`,
              hardwareVersion: sql`excluded.hardware_version`,
              protocolVersion: sql`excluded.protocol_version`,
              temperatureC: sql`excluded.temperature_c`,
              faultCode: sql`excluded.fault_code`,
              lastRawRef: sql`excluded.last_raw_ref`,
            },
          });
      } catch (error) {
        this.logger.warn(`批量 upsert 设备失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 6. 批量 insert telemetry（一次 INSERT）
    if (telemetryRows.length > 0) {
      try {
        await this.db.insert(ewohTelemetry).values(telemetryRows);
      } catch (error) {
        this.logger.error(
          `批量写入遥测失败 rows=${telemetryRows.length}：${error instanceof Error ? error.message : String(error)}`,
        );
        // 单帧失败语义：标记对应行为未接受
        for (const entry of acceptedIdx) {
          const idx = entry.parsedIdx;
          results[idx] = {
            accepted: false,
            skipped: false,
            record_id: parsed[idx].recordId,
            data_quality: 'invalid',
            events_triggered: 0,
            error: '写入失败',
          };
        }
        telemetryRows.length = 0;
        acceptedIdx.length = 0;
      }
    }

    // 7. 逐帧规则评估（RuleEngine 写事件，保留逐条语义）
    for (const entry of acceptedIdx) {
      const idx = entry.parsedIdx;
      const row = entry.telemetryRow;
      try {
        const triggered = await this.ruleEngine.evaluate({
          deviceId: parsed[idx].deviceId,
          pitchDeg: row.pitchDeg,
          loadScore: row.loadScore,
          batteryPct: row.batteryPct,
          sourceType: parsed[idx].sourceType,
          recordId: parsed[idx].recordId,
          dataQuality: row.dataQuality,
          packetLossPct: row.packetLossPct,
        });
        results[idx] = { ...results[idx], events_triggered: triggered };
      } catch (error) {
        this.logger.warn(`规则评估失败 device=${parsed[idx].deviceId}：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const accepted = results.filter((r) => r.accepted).length;
    const skipped = results.filter((r) => r.skipped).length;
    return { total: list.length, accepted, skipped, late_count: lateCount, clock_drift_count: driftCount, results };
  }

  /**
   * NO-04a：帧时间语义（ADR-009）——occurredAt=设备事件时间、receivedAt=云端接收
   * 时刻；isLate（>10min 迟到，标记不丢弃）与 clockDrift（越 5min 容忍界）由
   * envelope 契约语义函数判定。observedAt 缺省（边缘未上行接收时刻），契约
   * 语义对缺失 observed 的比对自动跳过。
   */
  private frameSemantics(frame: ExoskeletonFrameDto): { clockDrift: boolean; isLate: boolean } {
    const occurredAt = frame.event_time;
    const receivedAt = new Date().toISOString();
    return envelopeSemantics({
      eventId: '',
      eventType: 'TelemetryObserved',
      schemaVersion: '1.0.0',
      occurredAt,
      receivedAt,
      source: 'cloud:ingest',
    } as Record<string, unknown>);
  }

  /**
   * NO-04b：Edge→Cloud 事件批量上行（ADR-009 信封 + 传输级幂等去重）。
   *
   * 语义：
   *  - 每个信封 validateEventEnvelope 契约校验 + Catalog 类型白名单
   *    （未知类型 fail-closed 拒绝）；
   *  - 去重键 (org_id, source, event_id) 落 ewoh_ingest_event_dedup
   *    （ON CONFLICT DO NOTHING）：已落账 → duplicate（不重复写 ewoh_event，
   *    不重复投递）；首次 → 写 ewoh_event 事实行 + dedup 台账；
   *  - isLate/clockDrift 由 envelopeSemantics 判定并随台账落库（全链路可审计）；
   *  - org 上下文缺失显式失败（RLS 下不静默写全局，B4 同款语义）。
   */
  async ingestEventBatch(
    events: EnvelopeEventDto[],
    ctx?: OrgContext,
  ): Promise<IngestEventBatchResponse> {
    const orgId = ctx?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失（X-Org-Id / IngestGuard），事件上行显式失败');
    }
    const list = events.slice(0, IngestService.BATCH_LIMIT);
    const results: IngestEventResult[] = [];
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    const now = new Date();
    for (const envelope of list) {
      const base = {
        eventId: String(envelope.eventId ?? ''),
        source: String(envelope.source ?? ''),
        is_late: false,
        clock_drift: false,
      };
      const contractErrors = validateEventEnvelope(
        envelope,
        CATALOG_TYPE_SET,
      );
      if (contractErrors.length > 0) {
        rejected += 1;
        // NO-11a（ADR-024）：永久失败（重试无意义）→ 死信终态台账（best-effort）。
        // 信封校验器对未知目录类型返回 unknown_event_type（目录不会因重试变化）——
        // 其余契约违规映射 contract_violation（修复上游契约后才可人审重放）。
        const dlReason =
          contractErrors[0] === 'unknown_event_type' ? 'unknown_event_type' : 'contract_violation';
        void this.deadLetterService
          ?.record(
            {
              sourceId: 'cloud:ingest',
              reason: dlReason,
              envelope: envelope as unknown as Record<string, unknown>,
              correlationId: String(envelope.correlationId ?? '') || null,
            },
            orgId,
          )
          .catch((err) => {
            this.logger.warn(`死信落账失败（ingest 响应已含 rejected）: ${String(err)}`);
          });
        results.push({
          ...base,
          accepted: false,
          duplicate: false,
          error: `envelope_invalid:${contractErrors[0]}`,
        });
        continue;
      }
      const eventType = envelope.eventType as string;
      if (!isCatalogEventType(eventType)) {
        rejected += 1;
        // NO-11a（ADR-024）：永久失败（目录不会因重试变化）→ 死信终态台账
        void this.deadLetterService
          ?.record(
            {
              sourceId: 'cloud:ingest',
              reason: 'unknown_event_type',
              envelope: envelope as unknown as Record<string, unknown>,
              correlationId: String(envelope.correlationId ?? '') || null,
            },
            orgId,
          )
          .catch((err) => {
            this.logger.warn(`死信落账失败（ingest 响应已含 rejected）: ${String(err)}`);
          });
        results.push({
          ...base,
          accepted: false,
          duplicate: false,
          error: `unknown_event_type:${eventType}`,
        });
        continue;
      }
      const semantics = envelopeSemantics(envelope as unknown as Record<string, unknown>);
      const occurredAt = new Date(envelope.occurredAt);
      // 传输级幂等：ON CONFLICT (org_id, source, event_id) DO NOTHING，
      // returning 为空 = 已落账 → duplicate（绝不重复投递）。
      let dedupInserted = false;
      try {
        const inserted = await this.db
          .insert(ewohIngestEventDedup)
          .values({
            orgId,
            source: envelope.source,
            eventId: envelope.eventId,
            eventType,
            occurredAt: Number.isNaN(occurredAt.getTime()) ? null : occurredAt,
            receivedAt: now,
            isLate: semantics.isLate,
            clockDrift: semantics.clockDrift,
          })
          .onConflictDoNothing({ target: [ewohIngestEventDedup.orgId, ewohIngestEventDedup.source, ewohIngestEventDedup.eventId] })
          .returning({ id: ewohIngestEventDedup.id });
        dedupInserted = inserted.length > 0;
      } catch (error) {
        this.logger.error(
          `事件上行去重落账失败 ${envelope.eventId}：${error instanceof Error ? error.message : String(error)}`,
        );
        rejected += 1;
        results.push({ ...base, accepted: false, duplicate: false, error: 'dedup_write_failed' });
        continue;
      }
      if (!dedupInserted) {
        duplicates += 1;
        results.push({ ...base, accepted: false, duplicate: true, is_late: semantics.isLate, clock_drift: semantics.clockDrift });
        continue;
      }
      // ADR-033 决策 3：绑定事实投影到 ExoSession 台账（应用层幂等——
      // start 同 sessionId 回读、end 同终态原样返回；投影失败显式留痕不阻断
      // 事件主事实——事件行仍落账，投影缺口可重放修复）。
      if (eventType === 'ExoSessionStarted' || eventType === 'ExoSessionEnded') {
        try {
          await this.projectExoSessionEvent(eventType, envelope, orgId);
        } catch (error) {
          this.logger.warn(
            `exo session 投影失败 ${eventType} ${envelope.eventId}: ${String(error)}`,
          );
        }
      }
      // ADR-040：边缘 AndonRaised 投影为 canonical andon evidence 形状
      // （与 oee.openAndon 同形状：andonId/deviceId/level/slaMinutes/
      // escalationLevel/timeline）——云侧 listAndons/transitionAndon 统一消费，
      // 边缘与云侧开灯事实同台账同语义（§3 单一事实层）。
      const isEdgeAndon =
        eventType === 'AndonRaised' && String(envelope.source ?? '').startsWith('edge:');
      const andonPayload = isEdgeAndon
        ? ((envelope.payload ?? {}) as Record<string, unknown>)
        : null;
      const eventTitle = isEdgeAndon && andonPayload
        ? String(andonPayload.title ?? 'edge:AndonRaised')
        : `edge:${eventType}`;
      const eventSeverity = isEdgeAndon && andonPayload
        ? normalizeEventSeverity(andonPayload.level != null ? String(andonPayload.level) : 'high')
        : 'unknown'; // ADR-027：非安灯边缘上行事件无风险判定 → 显式 unknown（§33）
      const eventCode = isEdgeAndon ? 'ANDON' : `EDGE_${eventType}`;
      const slaSeconds = isEdgeAndon && andonPayload
        ? Number(andonPayload.slaSeconds ?? 900)
        : null;
      const evidenceJson = isEdgeAndon && andonPayload
        ? {
            andonId: envelope.eventId,
            deviceId: andonPayload.deviceId ?? envelope.subject ?? null,
            reason: andonPayload.reason ?? null,
            slaSeconds,
            slaMinutes: Math.ceil(slaSeconds / 60),
            level: eventSeverity,
            assignee: andonPayload.assignee ?? null,
            openedAt: Number.isNaN(occurredAt.getTime()) ? now.toISOString() : occurredAt.toISOString(),
            escalationLevel: 0,
            timeline: [{ at: occurredAt.toISOString(), type: 'open', actor: null }],
            envelope,
            envelopeSemantics: semantics,
            payload: envelope.payload ?? null,
          }
        : {
            envelope,
            envelopeSemantics: semantics,
            payload: envelope.payload ?? null,
            subject: envelope.subject ?? null,
          };
      try {
        await this.db.insert(ewohEvent).values({
          eventId: envelope.eventId,
          deviceId: isEdgeAndon && andonPayload ? String(andonPayload.deviceId ?? null) : null,
          eventCode,
          eventType,
          severity: eventSeverity,
          title: eventTitle,
          status: 'open',
          createdAt: Number.isNaN(occurredAt.getTime()) ? now : occurredAt,
          sourceType: 'real',
          orgId,
          evidenceJson,
        });
      } catch (error) {
        this.logger.error(
          `事件行写入失败 ${envelope.eventId}：${error instanceof Error ? error.message : String(error)}`,
        );
        // NEST-206：event 主事实写失败时回滚 dedup 占位行（恢复重放能力）；
        // 回滚失败才落死信（人审重放），绝不留下"dedup 已落账但无事件"的
        // 永久阻断态。
        try {
          await this.db
            .delete(ewohIngestEventDedup)
            .where(
              and(
                eq(ewohIngestEventDedup.orgId, orgId),
                eq(ewohIngestEventDedup.source, envelope.source),
                eq(ewohIngestEventDedup.eventId, envelope.eventId),
              ),
            );
        } catch (rollbackError) {
          this.logger.error(
            `dedup 回滚失败（落死信人审重放）${envelope.eventId}：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
          void this.deadLetterService
            ?.record(
              {
                sourceId: 'cloud:ingest',
                reason: 'event_write_failed',
                envelope: envelope as unknown as Record<string, unknown>,
                correlationId: String(envelope.correlationId ?? '') || null,
              },
              orgId,
            )
            .catch((err) => {
              this.logger.warn(`死信落账失败: ${String(err)}`);
            });
        }
        rejected += 1;
        results.push({ ...base, accepted: false, duplicate: false, error: 'event_write_failed' });
        continue;
      }
      // ADR-040：边缘安灯开灯 → 通知闭环（app 恒建 + lark 配置时建，ADR-037）；
      // 失败显式留痕不阻断事件主事实（通知是派生事实，投影缺口可补）。
      if (isEdgeAndon && andonPayload) {
        try {
          await insertAndonNotifications(this.db, orgId, {
            recipientId: String(andonPayload.assignee ?? 'dispatcher'),
            externalRef: envelope.eventId,
            title: `安灯 ${eventTitle}`,
            body: `设备 ${String(andonPayload.deviceId ?? '')} 安灯已开（${eventSeverity}，边缘上行）`,
            severity: eventSeverity,
          });
        } catch (error) {
          this.logger.warn(
            `边缘安灯通知创建失败 ${envelope.eventId}: ${String(error)}`,
          );
        }
      }
      accepted += 1;
      results.push({
        eventId: envelope.eventId,
        source: envelope.source,
        accepted: true,
        duplicate: false,
        is_late: semantics.isLate,
        clock_drift: semantics.clockDrift,
      });
    }
    return { total: list.length, accepted, duplicates, rejected, results };
  }

  /** 字段映射 → ewoh_telemetry 行（纯计算，供单帧/批量共用）。 */
  private mapExoskeletonRow(
    frame: ExoskeletonFrameDto,
    deviceId: string,
    sourceType: DataSourceType,
    recordId: string,
    rawRef: string,
    dataQuality: DataQuality,
    now: Date,
  ): typeof ewohTelemetry.$inferInsert {
    const eventTime = new Date(frame.event_time);
    return {
      deviceId,
      entityId: null,
      ts: eventTime,
      pitchDeg: frame.pose?.trunk_pitch_deg ?? frame.pitch_deg ?? null,
      loadScore: this.normalizeLoadScore(
        frame.load?.cumulative_load_score ?? frame.load_score ?? frame.load?.assist_level,
      ),
      fatigueTrend: frame.fatigue_trend ?? null,
      batteryPct: frame.device?.battery_pct ?? frame.battery_pct ?? null,
      qualityStatus: frame.quality?.status ?? frame.quality_status ?? null,
      sourceType,
      recordId,
      ingestedAt: now,
      rawRef,
      jointAngles: (frame.pose?.joint_angles_deg ?? frame.joint_angles ?? null) as Record<string, number> | null,
      angularVelocityDps: this.numericValue(frame.pose?.angular_velocity_dps ?? frame.angular_velocity_dps),
      assistLevel: this.numericValue(frame.load?.assist_level ?? frame.assist_level),
      torqueNm: this.numericValue(frame.load?.torque_nm ?? frame.torque_nm),
      cumulativeLoadScore: this.numericValue(frame.load?.cumulative_load_score ?? frame.cumulative_load_score),
      temperatureC: frame.device?.temperature_c ?? frame.temperature_c ?? null,
      faultCode: frame.device?.fault_code ?? frame.fault_code ?? null,
      packetLossPct: frame.quality?.packet_loss_pct ?? frame.packet_loss_pct ?? 0,
      dataConfidence: frame.quality?.confidence ?? frame.data_confidence ?? 1.0,
      dataQuality,
    };
  }

  /** 字段映射 → ewoh_device 行（纯计算）。 */
  private mapDeviceRow(
    frame: ExoskeletonFrameDto,
    deviceId: string,
    sourceType: DataSourceType,
    now: Date,
    rawRef: string,
  ): typeof ewohDevice.$inferInsert {
    return {
      deviceId,
      workerName: frame.worker_name ?? null,
      deviceModel: frame.device_model ?? null,
      batteryPct: frame.device?.battery_pct ?? frame.battery_pct ?? 100,
      online: true,
      lastTelemetryAt: now,
      sourceType,
      firmwareVersion: frame.firmware_version ?? null,
      hardwareVersion: frame.hardware_version ?? null,
      protocolVersion: frame.protocol_version ?? null,
      temperatureC: frame.device?.temperature_c ?? frame.temperature_c ?? null,
      faultCode: frame.device?.fault_code ?? frame.fault_code ?? null,
      lastRawRef: rawRef,
    };
  }

  /** 处理单帧（字段映射 + 质量校验 + 落库 + 规则评估） */
  private async processOneFrame(
    frame: ExoskeletonFrameDto,
    ctx?: OrgContext,
  ): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const rawRef = frame.raw_ref ?? this.computeRawRef(frame);
    const deviceId = frame.device_id ?? frame.entity_id;
    if (!deviceId) {
      throw new BadRequestException('entity_id 或 device_id 必填');
    }

    // 1. entity_id 存在性校验
    const entityId = frame.entity_id ?? frame.device_id;
    if (entityId) {
      const exists = await this.entityExists(entityId, ctx);
      if (!exists) {
        // 写入告警事件并返回 400（R2-SOP-002：orgId 从 ctx 透传，
        // 写入失败/缺 org 时 events_triggered 如实反映）
        const fired = await this.fireDataQualityEvent(
          deviceId,
          sourceType,
          recordId,
          'ENTITY_NOT_FOUND',
          `entity_id ${entityId} 不存在`,
          { entity_id: entityId },
          ctx?.primaryOrgId,
        );
        return {
          accepted: false,
          skipped: false,
          record_id: recordId,
          data_quality: 'invalid',
          events_triggered: fired ? 1 : 0,
          error: `entity_id ${frame.entity_id} 不存在`,
        };
      }
    }

    // 2. raw_ref 幂等去重
    const dup = await this.isDuplicateRawRef(rawRef);
    if (dup) {
      return {
        accepted: false,
        skipped: true,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    }

    // 3. 数据质量评估
    const dataQuality = this.assessQuality(frame);

    // 3.5 身份解析（ADR-006/NO-02b）：登记过映射 → 规范身份；否则 null（legacy）。
    let canonicalEntityId: string | null = null;
    const singleOrgId = ctx?.primaryOrgId?.trim();
    if (singleOrgId) {
      try {
        canonicalEntityId = await this.identityService.resolveMapping(
          IngestService.EDGE_DEVICE_SYSTEM,
          deviceId,
          singleOrgId,
        );
      } catch (error) {
        this.logger.warn(
          `单帧身份解析失败（fail-closed 回退 legacy 行为）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 4. 字段映射 → ewoh_telemetry
    const now = new Date();
    const eventTime = new Date(frame.event_time);
    const pitchDeg = frame.pose?.trunk_pitch_deg ?? frame.pitch_deg ?? null;
    const loadScore = this.normalizeLoadScore(
      frame.load?.cumulative_load_score ??
        frame.load_score ??
        frame.load?.assist_level,
    );
    const batteryPct = frame.device?.battery_pct ?? frame.battery_pct ?? null;
    const qualityStatus = frame.quality?.status ?? frame.quality_status ?? null;
    const jointAngles = frame.pose?.joint_angles_deg ?? frame.joint_angles ?? null;
    const angularVelocityDps = this.numericValue(
      frame.pose?.angular_velocity_dps ?? frame.angular_velocity_dps,
    );
    const assistLevel = this.numericValue(
      frame.load?.assist_level ?? frame.assist_level,
    );
    const torqueNm = this.numericValue(frame.load?.torque_nm ?? frame.torque_nm);
    const cumulativeLoadScore = this.numericValue(
      frame.load?.cumulative_load_score ?? frame.cumulative_load_score,
    );
    const temperatureC =
      frame.device?.temperature_c ?? frame.temperature_c ?? null;
    const faultCode = frame.device?.fault_code ?? frame.fault_code ?? null;
    const packetLossPct =
      frame.quality?.packet_loss_pct ?? frame.packet_loss_pct ?? 0;
    const dataConfidence =
      frame.quality?.confidence ?? frame.data_confidence ?? 1.0;

    const telemetryRow = {
      deviceId,
      entityId: canonicalEntityId,
      ts: eventTime,
      pitchDeg: pitchDeg != null ? Number(pitchDeg.toFixed(2)) : null,
      loadScore: loadScore != null ? Number(loadScore.toFixed(3)) : null,
      fatigueTrend: frame.fatigue_trend ?? null,
      batteryPct,
      qualityStatus,
      sourceType,
      recordId,
      ingestedAt: now,
      rawRef,
      jointAngles: (jointAngles as Record<string, number> | null) ?? null,
      angularVelocityDps,
      assistLevel,
      torqueNm,
      cumulativeLoadScore,
      temperatureC,
      faultCode,
      packetLossPct,
      dataConfidence,
      dataQuality,
      // ADR-075：telemetry 行归属注入（001 ewoh_org_visible RLS 对齐）。
      orgId: singleOrgId || null,
    };

    // 5. upsert ewoh_device（v0.7 B1：传入 ctx 以支持设备离线重排）
    await this.upsertDevice(frame, deviceId, sourceType, now, rawRef, ctx);

    // 6. 写入 ewoh_telemetry
    let eventsTriggered = 0;
    try {
      await this.db.insert(ewohTelemetry).values(telemetryRow);
      // 7. 规则引擎评估（大脑-感知层）
      eventsTriggered = await this.ruleEngine.evaluate({
        deviceId,
        pitchDeg: telemetryRow.pitchDeg,
        loadScore: telemetryRow.loadScore,
        batteryPct: telemetryRow.batteryPct,
        sourceType,
        recordId,
        dataQuality,
        packetLossPct: telemetryRow.packetLossPct,
      });
    } catch (error) {
      this.logger.error(`写入遥测失败 deviceId=${deviceId}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: dataQuality,
        events_triggered: 0,
        error: '写入失败',
      };
    }

    return {
      accepted: true,
      skipped: false,
      record_id: recordId,
      data_quality: dataQuality,
      events_triggered: eventsTriggered,
    };
  }

  // ===== 环境传感器接入 =====

  /** ADR-033：边缘绑定事件 → ExoSession 台账投影（契约校验 + 幂等）。 */
  private async projectExoSessionEvent(
    eventType: string,
    envelope: EnvelopeEventDto,
    orgId: string,
  ): Promise<void> {
    if (!this.exoSessionService) return;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    const sessionId = String(payload.sessionId ?? '');
    const exoId = String(payload.exoId ?? '');
    const personId = String(payload.personId ?? '');
    if (!sessionId || !exoId || !personId) {
      this.logger.warn(`exo session 投影跳过（载荷缺 sessionId/exoId/personId）: ${envelope.eventId}`);
      return;
    }
    if (eventType === 'ExoSessionStarted') {
      await this.exoSessionService.start(
        {
          sessionId,
          exoId,
          personId,
          startedAt: String(payload.startedAt ?? envelope.occurredAt),
        },
        orgId,
      );
    } else {
      const status = String(payload.status ?? 'ended');
      const endedBy = String(payload.endedBy ?? 'system');
      if (status === 'aborted') {
        await this.exoSessionService.abortSession(orgId, sessionId, endedBy);
      } else {
        await this.exoSessionService.endSession(orgId, sessionId, endedBy);
      }
    }
  }

  async ingestEnvironment(
    frame: EnvironmentFrameDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    // NO-13aa：环境传感器行归属经 ctx 注入（无 ctx → NULL 显式 legacy）。
    return this.sensorIngest.ingestEnvironment(frame, orgId ?? null);
  }


  // ===== 摄像头结构化检测接入 =====

  async ingestCamera(frame: CameraFrameDto, orgId?: string | null): Promise<IngestResponse> {
    // NEST-204/210：透传 org 上下文（写入归属）。
    return this.sensorIngest.ingestCamera(frame, orgId);
  }


  // ===== MES 工单接入 =====

  /**
   * ADR-004：MES 工单不再直接写 scheduling 表。
   * 转发到 canonical MesService.createWorkOrder（ewoh_schedule_task + step），
   * MES 到 Scheduling V2 的衔接由调度侧显式触发（SchedulerService.createRun），
   * Ingest 层不生成任何 scheduling truth。
   *
   * @deprecated 兼容路径：保留 HTTP 入口，语义改为「创建 MES 工单」而非「写调度方案」。
   */
  async ingestMes(order: MesOrderDto, ctx?: OrgContext): Promise<IngestResponse> {
    const recordId = order.record_id ?? randomUUID();
    const orgId = ctx?.primaryOrgId?.trim();
    // B4 修复：不再硬编码 primaryOrgId=''（空 org 在 RLS 下行为不确定）。
    // 从 IngestGuard 挂载的 userContext 取 primaryOrgId；上下文缺失时显式失败，
    // 绝不静默写全局。
    if (!orgId) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    try {
      await this.mesService.createWorkOrder(
        {
          orderId: order.order_id,
          title: `MES工单 ${order.order_id}`,
          productCode: order.product_code,
          orderQty: order.quantity,
          priority: order.priority ?? 'medium',
          planStart: order.planned_start,
          planEnd: order.planned_end,
          steps: [
            {
              name: 'MES 工单默认工序',
              instruction: `产品编码: ${order.product_code ?? '-'}，数量: ${order.quantity ?? 0}`,
            },
          ],
        },
        { userId: 'ingest', primaryOrgId: orgId },
      );
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`创建 MES 工单失败 order=${order.order_id}`, error);
      // NEST-215：MES 工单写失败返回非 200（原 accepted=false + HTTP 200 需要
      // 客户端 inspect body 才能发现失败）。携带 record_id/order_id 供对账。
      throw new HttpException(
        {
          code: 'MES_WORK_ORDER_WRITE_FAILED',
          message: 'MES 工单写入失败',
          record_id: recordId,
          order_id: order.order_id,
          detail: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // ===== 场景直接建模接入（多源融合） =====

  /** 空间扫描产物接入（3DGS/LiDAR/视觉SLAM）→ upsert ewoh_spatial_entity
   *（NEST-204/210：透传 org 上下文）。 */
  async ingestSpatialScan(
    scan: import('@shared/api.interface').SpatialScanDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    return this.sensorIngest.ingestSpatialScan(scan, orgId);
  }


  /** 定位坐标流接入（UWB/Wi-Fi/视觉融合）→ ewoh_world_state
   *（NEST-204/210：透传 org 上下文）。 */
  async ingestLocation(
    loc: import('@shared/api.interface').LocationFrameDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    return this.sensorIngest.ingestLocation(loc, orgId);
  }


  // ===== 内部工具 =====

  /** 评估数据质量 */
  private assessQuality(frame: ExoskeletonFrameDto): DataQuality {
    // 时钟漂移：超前当前 +5min → invalid
    const eventTime = new Date(frame.event_time).getTime();
    const now = Date.now();
    if (eventTime - now > IngestService.CLOCK_DRIFT_MS) {
      return 'invalid';
    }
    // battery_pct 超界 → invalid
    const batteryPct = frame.device?.battery_pct ?? frame.battery_pct;
    if (batteryPct != null && (batteryPct < 0 || batteryPct > 100)) {
      return 'invalid';
    }
    // 丢包率 > 5 → degraded
    const packetLossPct = frame.quality?.packet_loss_pct ?? frame.packet_loss_pct;
    if (packetLossPct != null && packetLossPct > IngestService.PACKET_LOSS_DEGRADED) {
      return 'degraded';
    }
    return 'good';
  }

  /** 检查 entity_id 是否存在（R2-SOP-011：有租户上下文时限定本 org 的行） */
  private async entityExists(entityId: string, ctx?: OrgContext): Promise<boolean> {
    try {
      const orgId = ctx?.primaryOrgId?.trim();
      const [row] = await this.db
        .select({ id: ewohSpatialEntity.id })
        .from(ewohSpatialEntity)
        .where(
          orgId
            ? and(eq(ewohSpatialEntity.orgId, orgId), eq(ewohSpatialEntity.entityId, entityId))
            : eq(ewohSpatialEntity.entityId, entityId),
        )
        .limit(1);
      return !!row;
    } catch (error) {
      this.logger.warn(
        `entity 存在性查询失败（fail-closed 拒绝写入）entityId=${entityId}：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /** raw_ref 幂等去重（R2-SAM-012：有租户上下文时去重键空间按 org 收敛） */
  private async isDuplicateRawRef(rawRef: string, ctx?: OrgContext): Promise<boolean> {
    try {
      const orgId = ctx?.primaryOrgId?.trim();
      const [row] = await this.db
        .select({ id: ewohTelemetry.id })
        .from(ewohTelemetry)
        .where(
          orgId
            ? and(eq(ewohTelemetry.orgId, orgId), eq(ewohTelemetry.rawRef, rawRef))
            : eq(ewohTelemetry.rawRef, rawRef),
        )
        .limit(1);
      return !!row;
    } catch (error) {
      this.logger.warn(
        `raw_ref 幂等去重查询失败（fail-closed 拒绝写入）rawRef=${rawRef}：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /** upsert ewoh_device */
  private async upsertDevice(
    frame: ExoskeletonFrameDto,
    deviceId: string,
    sourceType: DataSourceType,
    now: Date,
    rawRef: string,
    ctx?: OrgContext,
  ): Promise<void> {
    try {
      // v0.7 B1：检测设备状态转换（正常 → 故障/离线）。
      // 若设备此前正常（无故障码且在线）而本帧携带故障码 → 触发 DEVICE_OFFLINE 局部重排。
      // fire-and-forget：重排失败经 ReplanCoordinator 熔断（run 置 failed + 日志），
      // 绝不阻断 ingest 主链路（真机数据接入优先）。
      const newFaultCode = frame.device?.fault_code ?? frame.fault_code ?? null;
      if (newFaultCode) {
        await this.detectFaultTransition(deviceId, newFaultCode, ctx);
      }

      await this.db
        .insert(ewohDevice)
        .values({
          deviceId,
          workerName: frame.worker_name ?? null,
          deviceModel: frame.device_model ?? null,
          batteryPct: frame.device?.battery_pct ?? frame.battery_pct ?? 100,
          online: true,
          lastTelemetryAt: now,
          // ADR-075：device 行归属注入（001 ewoh_org_visible RLS 对齐）。
          orgId: ctx?.primaryOrgId ?? null,
          sourceType,
          firmwareVersion: frame.firmware_version ?? null,
          hardwareVersion: frame.hardware_version ?? null,
          protocolVersion: frame.protocol_version ?? null,
          temperatureC: frame.device?.temperature_c ?? frame.temperature_c ?? null,
          faultCode: frame.device?.fault_code ?? frame.fault_code ?? null,
          lastRawRef: rawRef,
        })
        .onConflictDoUpdate({
          // NEST-205（standalone_057 配套）：冲突目标改为复合 (org_id, device_id)。
          target: [ewohDevice.orgId, ewohDevice.deviceId],
          set: {
            batteryPct: frame.device?.battery_pct ?? frame.battery_pct ?? undefined,
            online: true,
            lastTelemetryAt: now,
            sourceType,
            firmwareVersion: frame.firmware_version ?? undefined,
            hardwareVersion: frame.hardware_version ?? undefined,
            protocolVersion: frame.protocol_version ?? undefined,
            temperatureC: frame.device?.temperature_c ?? frame.temperature_c ?? undefined,
            faultCode: frame.device?.fault_code ?? frame.fault_code ?? undefined,
            lastRawRef: rawRef,
          },
        });
    } catch (error) {
      this.logger.error(`upsert 设备失败 ${deviceId}`, error);
    }
  }

  /**
   * v0.7 B1：判定设备是否发生"正常 → 故障/离线"状态转换（纯函数，公开供测试）。
   * 此前正常 = 无故障码（null/空）且在线；新帧携带故障码 → 转换发生。
   */
  static isFaultTransition(
    existingFaultCode: string | null | undefined,
    existingOnline: boolean | number | null | undefined,
    newFaultCode: string | null | undefined,
  ): boolean {
    if (!newFaultCode) return false;
    const wasNormal =
      existingFaultCode == null || existingFaultCode === ''
        ? existingOnline === true || existingOnline === 1
        : false;
    return wasNormal;
  }

  /**
   * v0.7 B1：检测设备正常 → 故障/离线状态转换，命中则触发 DEVICE_OFFLINE 局部重排。
   * 查询设备既有 faultCode/online：此前正常（无故障码且在线）而新帧携带故障码 → 转换发生。
   * fire-and-forget：不 await（真机数据接入优先），异常由 ReplanCoordinator 熔断兜底。
   */
  private async detectFaultTransition(
    deviceId: string,
    newFaultCode: string,
    ctx?: OrgContext,
  ): Promise<void> {
    let wasNormal = false;
    try {
      // R2-SOP-011：057 迁移后 device 唯一键为 (org_id, device_id)，同 deviceId
      // 可跨租户存在——状态机判定必须限定本 org 的行，防误/漏触发重排。
      const orgId = ctx?.primaryOrgId?.trim();
      const [existing] = await this.db
        .select({ faultCode: ewohDevice.faultCode, online: ewohDevice.online })
        .from(ewohDevice)
        .where(
          orgId
            ? and(eq(ewohDevice.orgId, orgId), eq(ewohDevice.deviceId, deviceId))
            : eq(ewohDevice.deviceId, deviceId),
        )
        .limit(1);
      wasNormal = IngestService.isFaultTransition(
        existing?.faultCode,
        existing?.online,
        newFaultCode,
      );
    } catch (error) {
      // 查询失败不阻断（设备可能首次接入，无既有行 → 不算转换）
      this.logger.warn(
        `device ${deviceId} fault-state 查询失败（不阻断，视为无转换）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (wasNormal) {
      this.logger.warn(
        `device ${deviceId} transitioned to fault/offline (faultCode=${newFaultCode}), triggering DEVICE_OFFLINE replan`,
      );
      this.fireDeviceOfflineReplan(deviceId, ctx);
    }
  }

  /**
   * v0.7 B1：设备离线/故障转换 → DEVICE_OFFLINE 局部重排（fire-and-forget）。
   * 依赖 SchedulerModule 导出的 ReplanCoordinatorService（依赖图无循环）；
   * 重排的幂等/冷却由 TriggerService 保证，失败自动熔断不阻断事件源。
   */
  private fireDeviceOfflineReplan(deviceId: string, ctx?: OrgContext): void {
    const orgCtx: OrgContext = ctx ?? {
      userId: 'ingest',
      primaryOrgId: process.env.EWOH_INGEST_ORG_ID?.trim() || '',
      accessibleOrgIds: process.env.EWOH_INGEST_ORG_ID?.trim()
        ? [process.env.EWOH_INGEST_ORG_ID.trim()]
        : [],
      isGlobalAdmin: false,
    };
    // fire-and-forget：不 await（真机数据接入优先），异常已被 ReplanCoordinator 熔断兜底。
    Promise.resolve(
      this.replanCoordinator.handleTrigger('DEVICE_OFFLINE', deviceId, orgCtx),
    ).catch((e) => {
      this.logger.error(
        `DEVICE_OFFLINE replan for ${deviceId} failed: ${(e as Error).message}`,
      );
    });
  }

  /** 数据质量告警事件（entity 不存在等）。
   * R2-SOP-002：告警事件必须携带租户归属（orgId 从 ingest ctx 透传）；
   * org 缺失时 fail-closed 拒绝写入（不落 NULL=legacy 全租户可见行），
   * 返回 false 让调用方不再声称 events_triggered:1。 */
  private async fireDataQualityEvent(
    deviceId: string,
    sourceType: DataSourceType,
    recordId: string,
    eventCode: string,
    title: string,
    evidence: Record<string, unknown>,
    orgId?: string | null,
  ): Promise<boolean> {
    const normalizedOrgId = orgId?.trim();
    if (!normalizedOrgId) {
      this.logger.warn(
        `数据质量事件 ${eventCode} 缺少租户上下文，拒绝写入（不落 NULL legacy 行）`,
      );
      return false;
    }
    try {
      const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
      const now = new Date();
      const nowIso = now.toISOString();
      // ADR-009 / NO-04b：事件类型收敛到 Canonical Event Catalog + 信封嵌入。
      const envelope = buildEventEnvelope({
        eventId,
        eventType: 'DataQualityAlert',
        occurredAt: nowIso,
        observedAt: nowIso,
        receivedAt: nowIso,
        source: 'cloud:ingest',
        subject: `device:${deviceId}`,
      });
      const envelopeRecord = envelopeForEvidence(envelope);
      await this.db.insert(ewohEvent).values({
        eventId,
        // R2-SOP-002：租户归属注入（对齐 ingestEventBatch L556 事件上行路径）。
        orgId: normalizedOrgId,
        deviceId,
        eventCode,
        eventType: 'DataQualityAlert',
        severity: normalizeSeverity('L2'),
        title,
        status: 'open',
        createdAt: now,
        sourceType,
        triggerRecordId: recordId,
        evidenceJson: {
          ...evidence,
          device_id: deviceId,
          fired_at: nowIso,
          envelope: envelopeRecord.envelope,
          envelopeSemantics: envelopeRecord.envelopeSemantics,
        },
      });
      return true;
    } catch (error) {
      this.logger.error(`写入数据质量事件失败 ${eventCode}`, error);
      return false;
    }
  }

  /**
   * 计算 raw_ref（SHA256）。
   * NEST-224：record_id 缺失时用随机 nonce 参与哈希——同 device+event_time+
   * battery+load 的多帧不再互相碰撞（第二帧被静默 skip 当重复 = 数据丢失）；
   * 代价是无 record_id 的帧不可传输级幂等（可接受：丢失比重复更不可接受）。
   */
  private computeRawRef(frame: ExoskeletonFrameDto): string {
    const batteryPct = frame.device?.battery_pct ?? frame.battery_pct ?? '';
    const loadScore = this.normalizeLoadScore(
      frame.load?.cumulative_load_score ?? frame.load_score,
    );
    const recordToken = frame.record_id ?? `nonce:${randomUUID()}`;
    const payload = `${frame.device_id ?? frame.entity_id}|${frame.event_time}|${recordToken}|${batteryPct}|${loadScore ?? ''}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  /** 兼容 number 与 Record<string, number>（用于 angular_velocity_dps / torque_nm） */
  private numericValue(
    value: number | Record<string, number> | null | undefined,
  ): number | null {
    if (value == null) return null;
    if (typeof value === 'number') return Number(value.toFixed(3));
    const vals = Object.values(value);
    if (vals.length === 0) return null;
    return Number(vals.reduce((a, b) => a + b, 0).toFixed(3));
  }

  /** 规范负荷为 0-1；兼容旧版 0-100 载荷 */
  private normalizeLoadScore(value: number | null | undefined): number | null {
    if (value == null) return null;
    return value > 1 && value <= 100 ? value / 100 : value;
  }
}
