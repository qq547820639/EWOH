import { Module } from '@nestjs/common';
import { ScaleController } from './scale.controller';
import { ScaleService } from './scale.service';
import { TracingModule } from '../tracing/tracing.module';

@Module({
  imports: [TracingModule],
  controllers: [ScaleController],
  providers: [ScaleService],
  exports: [ScaleService],
})
export class ScaleModule {}
