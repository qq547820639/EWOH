import { Module } from '@nestjs/common';
import { FeatureFlagsController, SystemConfigController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  controllers: [SystemConfigController, FeatureFlagsController],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
