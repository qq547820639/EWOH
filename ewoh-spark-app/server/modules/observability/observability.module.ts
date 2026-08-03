import { Module } from '@nestjs/common';
import { SlowQueryController } from './slow-query.controller';

@Module({
  controllers: [SlowQueryController],
})
export class ObservabilityModule {}
