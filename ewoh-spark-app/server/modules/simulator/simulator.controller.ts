import { Controller, Get, Post } from '@nestjs/common';
import { SimulatorService } from './simulator.service';
import { Roles } from '../shared/roles.decorator';

/**
 * NEST-618（2026-08-17 审计整改）：补 @Roles（原先任何认证用户可 start/stop
 * 仿真器）。角色集与 route-role.policy FALLBACK 表一致。
 */
@Controller('api/simulator')
@Roles('global_admin', 'safety_admin')
export class SimulatorController {
  constructor(private readonly simulatorService: SimulatorService) {}

  @Post('start')
  async start() {
    return this.simulatorService.start();
  }

  @Post('stop')
  async stop() {
    return this.simulatorService.stop();
  }

  @Get('status')
  async status() {
    return this.simulatorService.getStatus();
  }
}
