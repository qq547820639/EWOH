import { Module } from '@nestjs/common';
import { TracingController } from './tracing.controller';
import { TracingInterceptor } from './tracing.interceptor';
import { TracingService } from './tracing.service';

@Module({
  controllers: [TracingController],
  providers: [TracingService, TracingInterceptor],
  exports: [TracingService, TracingInterceptor],
})
export class TracingModule {}
