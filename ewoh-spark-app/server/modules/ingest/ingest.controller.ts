import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { IngestService } from './ingest.service';
import {
  DeviceExecutionReceiptService,
  type DeviceExecutionFactDto,
  type DeviceExecutionFactResult,
} from './device-execution-receipt.service';
import { IngestGuard } from './ingest.guard';
import type {
  ActuatorFrameDto,
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
  constructor(
    private readonly ingestService: IngestService,
    private readonly deviceExecutionReceiptService: DeviceExecutionReceiptService,
  ) {}

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
    this.assertParsableTime((frame as { event_time?: unknown }).event_time, 'event_time');
    if (!frame.sensor_id || !frame.event_time) {
      throw new BadRequestException('sensor_id 和 event_time 必填');
    }
    return this.ingestService.ingestEnvironment(frame, request?.userContext?.primaryOrgId ?? null);
  }

  @Post('camera')
  async ingestCamera(
    @Body() frame: CameraFrameDto,
    @Req() request?: { userContext?: OrgContext },
  ): Promise<IngestResponse> {
    this.assertParsableTime((frame as { event_time?: unknown }).event_time, 'event_time');
    if (!frame.camera_id || !frame.event_time) {
      throw new BadRequestException('camera_id 和 event_time 必填');
    }
    // NEST-210：透传 IngestGuard 挂载的租户上下文（service 写入带 orgId）。
    return this.ingestService.ingestCamera(frame, request?.userContext?.primaryOrgId);
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
  async ingestSpatialScan(
    @Body() scan: SpatialScanDto,
    @Req() request?: { userContext?: OrgContext },
  ): Promise<IngestResponse> {
    if (!scan.entity_id || !scan.source_type) {
      throw new BadRequestException('entity_id 和 source_type 必填');
    }
    // NEST-210：透传租户上下文。
    return this.ingestService.ingestSpatialScan(scan, request?.userContext?.primaryOrgId);
  }

  @Post('actuator')
  async ingestActuator(
    @Body() frame: ActuatorFrameDto,
    @Req() request?: { userContext?: OrgContext },
  ): Promise<IngestResponse> {
    // NO-59b：执行机构状态上行（边缘 actuator 适配器）。词表/租户/时钟漂移/幂等
    // 全部在服务层 fail-closed；控制器只做形状最小校验（缺失即 400，不写半条事实）。
    if (!frame?.device_id || !frame?.event_time || !frame?.state) {
      throw new BadRequestException('device_id、event_time、state 必填');
    }
    return this.ingestService.ingestActuator(frame, request?.userContext?.primaryOrgId);
  }

  @Post('location')
  async ingestLocation(
    @Body() loc: LocationFrameDto,
    @Req() request?: { userContext?: OrgContext },
  ): Promise<IngestResponse> {
    this.assertParsableTime((loc as { ts?: unknown }).ts, 'ts');
    if (!loc.entity_id || !loc.locator || !loc.ts) {
      throw new BadRequestException('entity_id、locator、ts 必填');
    }
    // NEST-210：透传租户上下文。
    return this.ingestService.ingestLocation(loc, request?.userContext?.primaryOrgId);
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

  /**
   * 设备执行事实接入（2026-09-13）—— **`device_receipt` 来源的唯一写入方**。
   *
   * 为什么单独成端点而不是复用 `/api/ingest/actuator`：执行事实的**来源标签**
   * 直接决定一条现场回执能否成为**生产训练样本**（见 `execution-receipt-provenance.ts`）。
   * 把它和普通执行机构遥测混在一个端点里，会让"什么情况下能产出 device_receipt"
   * 变得不可审计；独立端点 + 独立的严格校验，是这条安全边界的载体。
   *
   * 边界（详见 `DeviceExecutionReceiptService`）：只接受**带 org 绑定的** ingest key；
   * 设备只能报自己已绑定的执行行；时间必须是设备测得值（服务端不补）；不创建计划、
   * 不推进任务状态。
   */
  @Post('execution-facts')
  async ingestExecutionFact(
    @Body() body: DeviceExecutionFactDto,
    @Req() request: {
      userContext?: {
        userId: string;
        primaryOrgId: string;
        accessibleOrgIds: string[];
        isGlobalAdmin: boolean;
        ingestKeyBoundOrgId?: string | null;
      };
    },
  ): Promise<DeviceExecutionFactResult> {
    return this.deviceExecutionReceiptService.recordFact(body, request.userContext as never);
  }

  /**
   * 时间字段可解析性 fail-closed 校验：缺字段/不可解析一律 400 且**不触达服务层**。
   * 为什么在控制器而不是服务层：这些端点的帧契约里时间不是可缺省字段——
   * "时间读不出"的帧一旦进入投影就会以 null/now 兜底，伪造事实（原则 7）。
   * 环境帧用 event_time、摄像头帧用 event_time、定位帧用 ts（历史契约字段名）。
   */
  private assertParsableTime(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
      throw new BadRequestException(`${field} 必填且必须可解析为时间（收到：${JSON.stringify(value ?? null)}）`);
    }
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
