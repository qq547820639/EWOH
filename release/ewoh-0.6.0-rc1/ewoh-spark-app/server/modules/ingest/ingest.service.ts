import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohDevice,
  ewohTelemetry,
  ewohEvent,
  ewohSpatialEntity,
  ewohWorldState,
  ewohSchedulePlan,
  ewohEnvironment,
} from '@server/database/schema';
import { eq, and, sql } from 'drizzle-orm';
import type {
  ExoskeletonFrameDto,
  EnvironmentFrameDto,
  CameraFrameDto,
  MesOrderDto,
  IngestResponse,
  BatchIngestResponse,
  DataQuality,
  DataSourceType,
} from '@shared/api.interface';
import { RuleEngineService } from '../rule-engine/rule-engine.service';

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

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ruleEngine: RuleEngineService,
  ) {}

  // ===== 外骨骼数据接入 =====

  /** 单帧外骨骼数据接入 */
  async ingestExoskeleton(frame: ExoskeletonFrameDto): Promise<IngestResponse> {
    return this.processOneFrame(frame);
  }

  /** 批量外骨骼数据接入（≤100 条） */
  async ingestExoskeletonBatch(frames: ExoskeletonFrameDto[]): Promise<BatchIngestResponse> {
    const list = frames.slice(0, IngestService.BATCH_LIMIT);
    const results: IngestResponse[] = [];
    for (const frame of list) {
      results.push(await this.processOneFrame(frame));
    }
    const accepted = results.filter((r) => r.accepted).length;
    const skipped = results.filter((r) => r.skipped).length;
    return { total: list.length, accepted, skipped, results };
  }

  /** 处理单帧（字段映射 + 质量校验 + 落库 + 规则评估） */
  private async processOneFrame(frame: ExoskeletonFrameDto): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const rawRef = frame.raw_ref ?? this.computeRawRef(frame);

    // 1. entity_id 存在性校验
    if (frame.entity_id) {
      const exists = await this.entityExists(frame.entity_id);
      if (!exists) {
        // 写入告警事件并返回 400
        await this.fireDataQualityEvent(
          frame.device_id,
          sourceType,
          recordId,
          'ENTITY_NOT_FOUND',
          `entity_id ${frame.entity_id} 不存在`,
          { entity_id: frame.entity_id },
        );
        return {
          accepted: false,
          skipped: false,
          record_id: recordId,
          data_quality: 'invalid',
          events_triggered: 1,
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

    // 4. 字段映射 → ewoh_telemetry
    const now = new Date();
    const eventTime = new Date(frame.event_time);
    const pitchDeg = frame.pose?.trunk_pitch_deg ?? null;
    const loadScore = frame.load_score != null ? frame.load_score / 100 : null;

    const telemetryRow = {
      deviceId: frame.device_id,
      ts: eventTime,
      pitchDeg: pitchDeg != null ? Number(pitchDeg.toFixed(2)) : null,
      loadScore: loadScore != null ? Number(loadScore.toFixed(3)) : null,
      fatigueTrend: frame.fatigue_trend ?? null,
      batteryPct: frame.battery_pct ?? null,
      qualityStatus: frame.quality_status ?? null,
      sourceType,
      recordId,
      ingestedAt: now,
      rawRef,
      jointAngles: (frame.joint_angles as Record<string, number> | undefined) ?? null,
      angularVelocityDps: frame.angular_velocity_dps
        ? this.sumNumericRecord(frame.angular_velocity_dps)
        : null,
      assistLevel: frame.assist_level ?? null,
      torqueNm: frame.torque_nm ? this.sumNumericRecord(frame.torque_nm) : null,
      cumulativeLoadScore: frame.cumulative_load_score ?? null,
      temperatureC: frame.temperature_c ?? null,
      faultCode: frame.fault_code ?? null,
      packetLossPct: frame.packet_loss_pct ?? 0,
      dataConfidence: frame.data_confidence ?? 1.0,
      dataQuality,
    };

    // 5. upsert ewoh_device
    await this.upsertDevice(frame, sourceType, now, rawRef);

    // 6. 写入 ewoh_telemetry
    let eventsTriggered = 0;
    try {
      await this.db.insert(ewohTelemetry).values(telemetryRow);
      // 7. 规则引擎评估（大脑-感知层）
      eventsTriggered = await this.ruleEngine.evaluate({
        deviceId: frame.device_id,
        pitchDeg: telemetryRow.pitchDeg,
        loadScore: telemetryRow.loadScore,
        batteryPct: telemetryRow.batteryPct,
        sourceType,
        recordId,
        dataQuality,
        packetLossPct: telemetryRow.packetLossPct,
      });
    } catch (error) {
      this.logger.error(`写入遥测失败 deviceId=${frame.device_id}`, error);
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

  async ingestEnvironment(frame: EnvironmentFrameDto): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const now = new Date();
    try {
      await this.db.insert(ewohEnvironment).values({
        sensorId: frame.sensor_id,
        entityId: frame.entity_id ?? null,
        temperature: frame.temperature ?? null,
        vibration: frame.vibration ?? null,
        noise: frame.noise ?? null,
        airQuality: frame.air_quality ?? null,
        ts: new Date(frame.event_time),
        sourceType,
        recordId,
        dataConfidence: frame.data_confidence ?? 1.0,
      });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`写入环境数据失败 sensor=${frame.sensor_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
      };
    }
  }

  // ===== 摄像头结构化检测接入 =====

  async ingestCamera(frame: CameraFrameDto): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const now = new Date();
    try {
      // 写入 ewoh_world_state（每个检测目标一条状态快照）
      const rows = frame.detections.map((det) => ({
        entityId: det.track_id ? `${frame.camera_id}:${det.track_id}` : `${frame.camera_id}:${det.class_name}`,
        stateJson: {
          camera_id: frame.camera_id,
          class_name: det.class_name,
          confidence: det.confidence,
          bbox: det.bbox ?? null,
          skeleton: det.skeleton ?? null,
          action: det.action ?? null,
          source_type: sourceType,
        } as Record<string, unknown>,
        ts: new Date(frame.event_time),
      }));
      if (rows.length > 0) {
        await this.db.insert(ewohWorldState).values(rows);
      }
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`写入摄像头数据失败 camera=${frame.camera_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
      };
    }
  }

  // ===== MES 工单接入 =====

  async ingestMes(order: MesOrderDto): Promise<IngestResponse> {
    const sourceType: DataSourceType = order.source_type ?? 'real';
    const recordId = order.record_id ?? randomUUID();
    const now = new Date();
    try {
      // MES 工单 → ewoh_schedule_plan（strategy='mes_order'，status='proposed'）
      const planId = `MES-${order.order_id}`;
      await this.db
        .insert(ewohSchedulePlan)
        .values({
          planId,
          planName: `MES工单 ${order.order_id}`,
          strategy: 'mes_order',
          status: 'proposed',
          reason: `产品编码: ${order.product_code ?? '-'}，数量: ${order.quantity ?? 0}`,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: ewohSchedulePlan.planId,
          set: {
            reason: `产品编码: ${order.product_code ?? '-'}，数量: ${order.quantity ?? 0}，状态: ${order.status ?? '-'}`,
            updatedAt: now,
          },
        });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`写入 MES 工单失败 order=${order.order_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
      };
    }
  }

  // ===== 场景直接建模接入（多源融合） =====

  /** 空间扫描产物接入（3DGS/LiDAR/视觉SLAM）→ upsert ewoh_spatial_entity */
  async ingestSpatialScan(scan: import('@shared/api.interface').SpatialScanDto): Promise<IngestResponse> {
    const recordId = randomUUID();
    const now = new Date();
    try {
      const extra = {
        splat_url: scan.splat_url ?? null,
        pointcloud_url: scan.pointcloud_url ?? null,
        capture_at: scan.capture_at ?? null,
        scan_device: scan.scan_device ?? null,
        alignment_error_mm: scan.alignment_error_mm ?? null,
      };
      await this.db
        .insert(ewohSpatialEntity)
        .values({
          entityId: scan.entity_id,
          entityType: scan.entity_type ?? 'workstation',
          parentId: scan.parent_id ?? null,
          name: scan.name ?? scan.entity_id,
          x: scan.x ?? 0,
          y: scan.y ?? 0,
          yaw: scan.yaw ?? 0,
          bboxW: scan.bbox_w ?? 0,
          bboxH: scan.bbox_h ?? 0,
          status: 'active',
          sourceType: scan.source_type,
          confidence: scan.confidence ?? 1.0,
          version: 1,
          extra,
        })
        .onConflictDoUpdate({
          target: ewohSpatialEntity.entityId,
          set: {
            sourceType: scan.source_type,
            confidence: scan.confidence ?? 1.0,
            extra,
            updatedAt: now,
          },
        });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`写入空间扫描失败 entity=${scan.entity_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
      };
    }
  }

  /** 定位坐标流接入（UWB/Wi-Fi/视觉融合）→ ewoh_world_state */
  async ingestLocation(loc: import('@shared/api.interface').LocationFrameDto): Promise<IngestResponse> {
    const sourceType: DataSourceType = loc.source_type ?? 'real';
    const recordId = loc.record_id ?? randomUUID();
    try {
      await this.db.insert(ewohWorldState).values({
        entityId: loc.entity_id,
        stateJson: {
          locator: loc.locator,
          confidence: loc.confidence,
          x: loc.x,
          y: loc.y,
          z: loc.z ?? 0,
          source_type: sourceType,
        } as Record<string, unknown>,
        ts: new Date(loc.ts),
      });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`写入定位数据失败 entity=${loc.entity_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
      };
    }
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
    if (frame.battery_pct != null && (frame.battery_pct < 0 || frame.battery_pct > 100)) {
      return 'invalid';
    }
    // 丢包率 > 5 → degraded
    if (frame.packet_loss_pct != null && frame.packet_loss_pct > IngestService.PACKET_LOSS_DEGRADED) {
      return 'degraded';
    }
    return 'good';
  }

  /** 检查 entity_id 是否存在 */
  private async entityExists(entityId: string): Promise<boolean> {
    try {
      const [row] = await this.db
        .select({ id: ewohSpatialEntity.id })
        .from(ewohSpatialEntity)
        .where(eq(ewohSpatialEntity.entityId, entityId))
        .limit(1);
      return !!row;
    } catch {
      return false;
    }
  }

  /** raw_ref 幂等去重 */
  private async isDuplicateRawRef(rawRef: string): Promise<boolean> {
    try {
      const [row] = await this.db
        .select({ id: ewohTelemetry.id })
        .from(ewohTelemetry)
        .where(eq(ewohTelemetry.rawRef, rawRef))
        .limit(1);
      return !!row;
    } catch {
      return false;
    }
  }

  /** upsert ewoh_device */
  private async upsertDevice(
    frame: ExoskeletonFrameDto,
    sourceType: DataSourceType,
    now: Date,
    rawRef: string,
  ): Promise<void> {
    try {
      await this.db
        .insert(ewohDevice)
        .values({
          deviceId: frame.device_id,
          workerName: frame.worker_name ?? null,
          deviceModel: frame.device_model ?? null,
          batteryPct: frame.battery_pct ?? 100,
          online: true,
          lastTelemetryAt: now,
          sourceType,
          firmwareVersion: frame.firmware_version ?? null,
          hardwareVersion: frame.hardware_version ?? null,
          protocolVersion: frame.protocol_version ?? null,
          temperatureC: frame.temperature_c ?? null,
          faultCode: frame.fault_code ?? null,
          lastRawRef: rawRef,
        })
        .onConflictDoUpdate({
          target: ewohDevice.deviceId,
          set: {
            batteryPct: frame.battery_pct ?? undefined,
            online: true,
            lastTelemetryAt: now,
            sourceType,
            firmwareVersion: frame.firmware_version ?? undefined,
            hardwareVersion: frame.hardware_version ?? undefined,
            protocolVersion: frame.protocol_version ?? undefined,
            temperatureC: frame.temperature_c ?? undefined,
            faultCode: frame.fault_code ?? undefined,
            lastRawRef: rawRef,
          },
        });
    } catch (error) {
      this.logger.error(`upsert 设备失败 ${frame.device_id}`, error);
    }
  }

  /** 数据质量告警事件（entity 不存在等） */
  private async fireDataQualityEvent(
    deviceId: string,
    sourceType: DataSourceType,
    recordId: string,
    eventCode: string,
    title: string,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    try {
      const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
      const now = new Date();
      await this.db.insert(ewohEvent).values({
        eventId,
        deviceId,
        eventCode,
        eventType: 'data',
        severity: 'L2',
        title,
        status: 'open',
        createdAt: now,
        sourceType,
        triggerRecordId: recordId,
        evidenceJson: { ...evidence, device_id: deviceId, fired_at: now.toISOString() },
      });
    } catch (error) {
      this.logger.error(`写入数据质量事件失败 ${eventCode}`, error);
    }
  }

  /** 计算 raw_ref（SHA256） */
  private computeRawRef(frame: ExoskeletonFrameDto): string {
    const payload = `${frame.device_id}|${frame.event_time}|${frame.record_id ?? ''}|${frame.battery_pct ?? ''}|${frame.load_score ?? ''}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  /** 对 Record<string, number> 求和（用于 angular_velocity_dps / torque_nm 聚合） */
  private sumNumericRecord(rec: Record<string, number> | undefined): number | null {
    if (!rec) return null;
    const vals = Object.values(rec);
    if (vals.length === 0) return null;
    return Number(vals.reduce((a, b) => a + b, 0).toFixed(3));
  }
}
