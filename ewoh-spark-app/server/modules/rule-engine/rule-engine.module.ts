import { Module } from '@nestjs/common';
import { RuleEngineService } from './rule-engine.service';

/**
 * 规则引擎模块（大脑-感知层）
 * 提供 RuleEngineService 供 SimulatorModule / IngestModule 复用
 */
@Module({
  providers: [RuleEngineService],
  exports: [RuleEngineService],
})
export class RuleEngineModule {}
