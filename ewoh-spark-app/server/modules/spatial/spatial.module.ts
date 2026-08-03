import { Module } from '@nestjs/common';
import { SpatialController } from './spatial.controller';
import { SpatialService } from './spatial.service';

@Module({
  controllers: [SpatialController],
  providers: [SpatialService],
})
export class SpatialModule {}
