import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestGuard } from './ingest.guard';
import { SensorIngestService } from './sensor-ingest.service';
import { RuleEngineModule } from '../rule-engine/rule-engine.module';
import { MesModule } from '../mes/mes.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

/**
 * Ingestion 模块（真机接入网关）
 * 依赖 RuleEngineModule（规则引擎评估）+ MesModule（ADR-004：MES 工单转发到
 * canonical MesService，不再直接写 scheduling 表）。
 * v0.7 B1：引入 SchedulerModule —— 设备故障/离线转换检测时触发 DEVICE_OFFLINE
 * 局部重排（事件驱动智能调度闭环；依赖图 IngestModule → SchedulerModule → TaskModule，无循环）。
 *
 * P1-INGEST-002：production 启动时强制校验 INGEST_API_KEY 已配置。
 * 缺失则启动失败（fail-closed），而不是等请求进来才发现鉴权被跳过。
 */
@Module({
  imports: [RuleEngineModule, MesModule, SchedulerModule],
  controllers: [IngestController],
  providers: [IngestService, IngestGuard, SensorIngestService],
})
export class IngestModule implements OnApplicationBootstrap {
  onApplicationBootstrap(): void {
    const isProd = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
    if (isProd && !process.env.INGEST_API_KEY) {
      throw new Error(
        'INGEST_API_KEY 未配置：production 环境必须配置接入密钥，拒绝启动 ingest 网关（fail-closed）',
      );
    }
  }
}
