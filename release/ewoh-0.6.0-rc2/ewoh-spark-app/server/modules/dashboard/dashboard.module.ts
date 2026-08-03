import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DeviceContractController } from './device-contract.controller';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [DashboardController, DeviceContractController],
  providers: [DashboardService],
})
export class DashboardModule {}
