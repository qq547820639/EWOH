import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestGuard } from './ingest.guard';
import { RuleEngineModule } from '../rule-engine/rule-engine.module';

/**
 * Ingestion 模块（真机接入网关）
 * 依赖 RuleEngineModule（规则引擎评估）
 */
@Module({
  imports: [RuleEngineModule],
  controllers: [IngestController],
  providers: [IngestService, IngestGuard],
})
export class IngestModule {}
