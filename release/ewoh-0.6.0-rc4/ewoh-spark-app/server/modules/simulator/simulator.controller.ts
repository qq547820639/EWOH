import { Controller, Get, Post } from '@nestjs/common';
import { SimulatorService } from './simulator.service';

@Controller('api/simulator')
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
