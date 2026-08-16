import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { IngestService } from './ingest.service';
import { IngestGuard } from './ingest.guard';
import type {
  ExoskeletonFrameDto,
  EnvironmentFrameDto,
  CameraFrameDto,
  MesOrderDto,
  SpatialScanDto,
  LocationFrameDto,
  IngestResponse,
  BatchIngestResponse,
  EnvelopeEventDto,
  IngestEventBatchResponse,
} from '@shared/api.interface';
import { Public } from '../shared/public.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Ingestion 接入网关 Controller（皮肤+肢体数据汇聚）
 *
 * 端点：
 *  - POST /api/ingest/exoskeleton        单帧外骨骼数据
 *  - POST /api/ingest/exoskeleton/batch  批量外骨骼数据（≤100）
 *  - POST /api/ingest/environment        环境传感器数据
 *  - POST /api/ingest/camera             摄像头结构化检测
 *  - POST /api/ingest/mes                MES 工单事件
 *
 * 鉴权：X-Ingest-Key（环境变量 INGEST_API_KEY）
 * 限流：100 req/min/IP
 * 请求体：1MB 上限（由 body parser 配置）
 */
@Controller('api/ingest')
@UseGuards(IngestGuard)
// Machine-to-machine endpoint authenticated by IngestGuard, not user roles.
@Public()
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post('exoskeleton')
  async ingestExoskeleton(
    @Body() frame: ExoskeletonFrameDto,
    @Req() request: { userContext?: { userId: string; primaryOrgId: string; accessibleOrgIds: string[]; isGlobalAdmin: boolean } },
  ): Promise<IngestResponse> {
    this.validateExoskeletonFrame(frame);
    // v0.7 B1：透传 IngestGuard 挂载的租户上下文（供设备离线重排使用）
    return this.ingestService.ingestExoskeleton(frame, request.userContext as never);
  }

  @Post('exoskeleton/batch')
  async ingestExoskeletonBatch(
    @Body() body: ExoskeletonFrameDto[] | { frames: ExoskeletonFrameDto[] },
    @Req() request: { userContext?: { userId: string; primaryOrgId: string; accessibleOrgIds: string[]; isGlobalAdmin: boolean } },
  ): Promise<BatchIngestResponse> {
    const frames = Array.isArray(body) ? body : body?.frames ?? [];
    if (frames.length === 0) {
      throw new BadRequestException('frames 为空');
    }
    if (frames.length > 100) {
      throw new BadRequestException('批量上限 100 条');
    }
    for (const f of frames) this.validateExoskeletonFrame(f);
    // v0.7 B1：透传租户上下文（批量帧的设备离线重排）
    return this.ingestService.ingestExoskeletonBatch(frames, request.userContext as never);
  }

  @Post('environment')
  async ingestEnvironment(
    @Body() frame: EnvironmentFrameDto,
    @Req() request?: { userContext?: OrgContext },
  ): Promise<IngestResponse> {
    if (!frame.sensor_id || !frame.event_time) {
      throw new BadRequestException('sensor_id 和 event_time 必填');
    }
    return this.ingestService.ingestEnvironment(frame, request?.userContext?.primaryOrgId ?? null);
  }

  @Post('camera')
  async ingestCamera(@Body() frame: CameraFrameDto): Promise<IngestResponse> {
    if (!frame.camera_id || !frame.event_time) {
      throw new BadRequestException('camera_id 和 event_time 必填');
    }
    return this.ingestService.ingestCamera(frame);
  }

  @Post('mes')
  async ingestMes(
    @Body() order: MesOrderDto,
    @Req() request: { userContext?: { userId: string; primaryOrgId: string; accessibleOrgIds: string[]; isGlobalAdmin: boolean } },
  ): Promise<IngestResponse> {
    if (!order.order_id) {
      throw new BadRequestException('order_id 必填');
    }
    // B4 修复：透传 IngestGuard 挂载的租户上下文（primaryOrgId），
    // 缺失时由 service 显式失败，不静默写全局。
    return this.ingestService.ingestMes(order, request.userContext as never);
  }

  @Post('spatial-scan')
  async ingestSpatialScan(@Body() scan: SpatialScanDto): Promise<IngestResponse> {
    if (!scan.entity_id || !scan.source_type) {
      throw new BadRequestException('entity_id 和 source_type 必填');
    }
    return this.ingestService.ingestSpatialScan(scan);
  }

  @Post('location')
  async ingestLocation(@Body() loc: LocationFrameDto): Promise<IngestResponse> {
    if (!loc.entity_id || !loc.locator || !loc.ts) {
      throw new BadRequestException('entity_id、locator、ts 必填');
    }
    return this.ingestService.ingestLocation(loc);
  }

  /** NO-04b：Edge→Cloud 事件批量上行（ADR-009 信封 + 传输级幂等去重）。 */
  @Post('events')
  async ingestEvents(
    @Body() body: EnvelopeEventDto[] | { events: EnvelopeEventDto[] },
    @Req() request: { userContext?: { userId: string; primaryOrgId: string; accessibleOrgIds: string[]; isGlobalAdmin: boolean } },
  ): Promise<IngestEventBatchResponse> {
    const events = Array.isArray(body) ? body : body?.events ?? [];
    if (events.length === 0) {
      throw new BadRequestException('events 为空');
    }
    if (events.length > 100) {
      throw new BadRequestException('批量上限 100 条');
    }
    return this.ingestService.ingestEventBatch(events, request.userContext as never);
  }

  private validateExoskeletonFrame(frame: ExoskeletonFrameDto): void {
    if (!frame.entity_id && !frame.device_id) {
      throw new BadRequestException('entity_id 或 device_id 必填');
    }
    if (!frame.event_time) {
      throw new BadRequestException('event_time 必填');
    }
    const ts = new Date(frame.event_time);
    if (isNaN(ts.getTime())) {
      throw new BadRequestException('event_time 格式无效');
    }
  }
}
