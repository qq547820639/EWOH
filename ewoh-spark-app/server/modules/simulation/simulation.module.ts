import { Module } from '@nestjs/common';
import { SimulationService } from './simulation.service';
import { SimulationController } from './simulation.controller';

/**
 * Digital Twin Simulation 模块（ADR-025 / NO-12a，§13）：
 * 四类确定性评估器（what_if/capacity/layout/material_flow）+
 * 仿真运行台账（契约 fail-closed / isSimulation=true 三层强制隔离 /
 * completed|failed 终态落账 + SimulationRunCreated/Completed 事件）。
 */
@Module({
  controllers: [SimulationController],
  providers: [SimulationService],
  exports: [SimulationService],
})
export class SimulationModule {}
