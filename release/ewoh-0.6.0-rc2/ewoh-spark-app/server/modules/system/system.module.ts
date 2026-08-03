import { Module } from '@nestjs/common';
import { SystemConfigController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  controllers: [SystemConfigController],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
