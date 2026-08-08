import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
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

  /** 空间扫描产物接入（3DGS/LiDAR/视觉SLAM）→ upsert ewoh_spatial_entity */
  async ingestSpatialScan(
    scan: SpatialScanDto,
  ): Promise<IngestResponse> {
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
  async ingestLocation(loc: LocationFrameDto): Promise<IngestResponse> {
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
}
