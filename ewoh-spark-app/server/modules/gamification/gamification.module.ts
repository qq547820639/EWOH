import { Module } from '@nestjs/common';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';
import { AiModule } from '../ai/ai.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [AiModule, SchedulerModule],
  controllers: [GamificationController],
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
