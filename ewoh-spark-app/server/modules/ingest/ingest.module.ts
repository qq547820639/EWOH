import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestGuard } from './ingest.guard';
import { SensorIngestService } from './sensor-ingest.service';
import { DeviceExecutionReceiptService } from './device-execution-receipt.service';
import { RuleEngineModule } from '../rule-engine/rule-engine.module';
import { MesModule } from '../mes/mes.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { IdentityModule } from '../identity/identity.module';
import { ReliabilityModule } from '../reliability/reliability.module';
import { ExoSessionModule } from '../exo/exo-session.module';
import { DeviceResponsibilityModule } from '../responsibility/device-responsibility.module';
import { validateIngestKeyConfiguration } from './ingest-key-config';

/**
 * Ingestion 模块（真机接入网关）
 * 依赖 RuleEngineModule（规则引擎评估）+ MesModule（ADR-004：MES 工单转发到
 * canonical MesService，不再直接写 scheduling 表）+ IdentityModule
 * （ADR-006/NO-02b：设备 ID → 规范身份解析，落 ewoh_telemetry.entity_id）。
 * v0.7 B1：引入 SchedulerModule —— 设备故障/离线转换检测时触发 DEVICE_OFFLINE
 * 局部重排（事件驱动智能调度闭环；依赖图 IngestModule → SchedulerModule → TaskModule，无循环）。
 *
 * P1-INGEST-002：production 启动时强制校验"存在可用接入密钥"。
 * 判定标准与请求期 `IngestGuard` 共用 `ingest-key-config.ts`，覆盖
 * `INGEST_API_KEY_<ORG_ID>`、`INGEST_API_KEYS` JSON 映射和 legacy
 * `INGEST_API_KEY` 三种形态——早期实现只认 legacy 全局 key，导致按推荐方式
 * 配置 per-key 绑定的生产部署无法启动（安全配置反而 fail-closed 到不可用）。
 * 配置存在但无法解析（JSON 非法）时同样拒绝启动，而不是留到请求期才发现。
 */
@Module({
  // NO-49a：边缘安灯同样要“点名到设备责任人”（与云侧开灯同一套收件人解析）。
  imports: [RuleEngineModule, MesModule, SchedulerModule, IdentityModule, ReliabilityModule, ExoSessionModule, DeviceResponsibilityModule],
  controllers: [IngestController],
  providers: [
    IngestService,
    IngestGuard,
    SensorIngestService,
    // 设备执行事实接入（device_receipt 的唯一写入方）。
    // AuditService 不在本地 provide：@Global SharedModule 的 DatabaseAuditSink
    // 不在 exports 里，本地实例会静默退化为内存 sink（审计不落库）——
    // 用全局导出的实例（同 control.module 的 2026-09-13 回归注记）。
    DeviceExecutionReceiptService,
  ],
})
export class IngestModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestModule.name);

  onApplicationBootstrap(): void {
    const isProd = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
    const problems = validateIngestKeyConfiguration(isProd);
    if (problems.length) {
      throw new Error(
        `接入密钥配置无效，拒绝启动 ingest 网关（fail-closed）：${problems.join('；')}`,
      );
    }
    if (!isProd) {
      this.logger.log('非 production：接入密钥非强制，请求期仍按 IngestGuard 规则鉴权');
    }
  }
}
