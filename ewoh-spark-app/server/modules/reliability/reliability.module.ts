import { Module } from '@nestjs/common';
import { DeadLetterService } from './dead-letter.service';
import { DeadLetterController } from './dead-letter.controller';

/**
 * Reliability 模块（ADR-024 / NO-11a，§20）：Dead Letter 终态台账
 * （record 契约 fail-closed / 幂等 / 人审 requeue / discard 必带理由 +
 * DeadLetterRecorded 事件）。v1 禁止自动重试。
 */
@Module({
  controllers: [DeadLetterController],
  providers: [DeadLetterService],
  exports: [DeadLetterService],
})
export class ReliabilityModule {}
