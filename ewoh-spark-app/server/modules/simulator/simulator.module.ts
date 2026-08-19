import { Module } from '@nestjs/common';
import { SimulatorController } from './simulator.controller';
import { SimulatorService } from './simulator.service';
import { RetentionService } from './retention.service';
import { RuleEngineModule } from '../rule-engine/rule-engine.module';

@Module({
  imports: [RuleEngineModule],
  controllers: [SimulatorController],
  providers: [SimulatorService, RetentionService],
  exports: [SimulatorService, RetentionService],
})
export class SimulatorModule {}
