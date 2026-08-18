import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { isValidSpatialKind } from '@shared/location';
import {
  ewohEnvironment,
  ewohWorldState,
  ewohSpatialEntity,
} from '@server/database/schema';
import type {
  EnvironmentFrameDto,
  CameraFrameDto,
  SpatialScanDto,
  LocationFrameDto,
  IngestResponse,
  DataSourceType,
} from '@shared/api.interface';

/**
 * SensorIngestService（P1-Ingest decomposition）
 *
 * 承担非外骨骼传感器类 ingest：environment / camera / spatial scan / location。
 * 与外骨骼核心链（IngestService.processOneFrame 私有链）完全解耦，
 * 仅依赖 DB 写入，无跨方法状态。IngestService 委托到本服务。
 */
@Injectable()
export class SensorIngestService {
  private readonly logger = new Logger(SensorIngestService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  // ===== 环境传感器接入 =====

  async ingestEnvironment(
    frame: EnvironmentFrameDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const now = new Date();
    // R2-SOP-022：org 缺失显式拒绝——对齐 camera/spatial/location 三路径的
    // fail-closed 语义（不再静默写 NULL=legacy 全租户可见行）。
    if (!orgId?.trim()) {
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
        // ADR-075 续（NO-13aa）：环境传感器行归属注入（001 ewoh_org_visible RLS 对齐）。
        orgId: orgId ?? null,
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

  /**
   * NEST-204：写入显式携带 orgId（org 缺失 → 显式失败，不静默写
   * NULL=legacy 全可见行）。
   */
  async ingestCamera(frame: CameraFrameDto, orgId?: string | null): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const now = new Date();
    if (!orgId?.trim()) {
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
      // 写入 ewoh_world_state（每个检测目标一条状态快照）
      const rows = frame.detections.map((det) => ({
        entityId: det.track_id
          ? `${frame.camera_id}:${det.track_id}`
          : `${frame.camera_id}:${det.class_name}`,
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
        // NEST-204：行归属注入。
        orgId,
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

  // ===== 场景直接建模接入（多源融合） =====

  /** 空间扫描产物接入（3DGS/LiDAR/视觉SLAM）→ upsert ewoh_spatial_entity
   *（NEST-204：写入显式携带 orgId，org 缺失显式失败）。 */
  async ingestSpatialScan(
    scan: SpatialScanDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    const recordId = randomUUID();
    const now = new Date();
    if (!orgId?.trim()) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    // ADR-007：空间类型必须在 Canonical Location 契约注册表内；未知类型拒绝
    // （fail-closed，不把脏类型写进 ewoh_spatial_entity）。
    const entityType = scan.entity_type ?? 'workstation';
    if (!isValidSpatialKind(entityType)) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `entity_type ${entityType} 不在空间类型注册表（ADR-007）`,
      };
    }
    try {
      // DATA-FLOW-B1（2026-08-18）：坐标显式提供但非法（NaN/Infinity）→ fail-closed 拒绝；
      // 缺省写 NULL（诚实表达"位置未知"，不再写 0 假坐标——ADR-007 UNKNOWN 语义，
      // 消费方 x ?? 0 已兜底）。
      for (const [label, value] of [
        ['x', scan.x],
        ['y', scan.y],
        ['yaw', scan.yaw],
        ['bbox_w', scan.bbox_w],
        ['bbox_h', scan.bbox_h],
      ] as const) {
        if (value !== undefined && value !== null && !Number.isFinite(value)) {
          return {
            accepted: false,
            skipped: false,
            record_id: recordId,
            data_quality: 'invalid',
            events_triggered: 0,
            error: `${label} 坐标非法（非有限数）`,
          };
        }
      }
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
          entityType,
          parentId: scan.parent_id ?? null,
          name: scan.name ?? scan.entity_id,
          x: scan.x ?? null,
          y: scan.y ?? null,
          yaw: scan.yaw ?? null,
          bboxW: scan.bbox_w ?? null,
          bboxH: scan.bbox_h ?? null,
          status: 'active',
          sourceType: scan.source_type,
          confidence: scan.confidence ?? 1.0,
          version: 1,
          extra,
          // NEST-204：行归属注入。
          orgId,
        })
        .onConflictDoUpdate({
          // R2-SOP-003/R2-SAM-003（standalone_059）：冲突目标改租户复合键
          // (org_id, entity_id)——跨租户同 entity_id 不再互相覆盖元数据，
          // 冲突更新只会命中本 org 自己的行。
          target: [ewohSpatialEntity.orgId, ewohSpatialEntity.entityId],
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

  /** 定位坐标流接入（UWB/Wi-Fi/视觉融合）→ ewoh_world_state
   *（NEST-204：写入显式携带 orgId，org 缺失显式失败）。 */
  async ingestLocation(loc: LocationFrameDto, orgId?: string | null): Promise<IngestResponse> {
    const sourceType: DataSourceType = loc.source_type ?? 'real';
    const recordId = loc.record_id ?? randomUUID();
    if (!orgId?.trim()) {
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
      // DATA-FLOW-B1（2026-08-18）：定位坐标 x/y 必须为有限数（DTO 声明必填，
      // 运行时防 NaN/Infinity 污染 world_state 位置）。
      if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y)) {
        return {
          accepted: false,
          skipped: false,
          record_id: recordId,
          data_quality: 'invalid',
          events_triggered: 0,
          error: 'x/y 坐标缺失或非法（非有限数）',
        };
      }
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
        // NEST-204：行归属注入。
        orgId,
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
}
