import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { SimulationService, type RunSimulationInput } from './simulation.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Digital Twin Simulation API（ADR-025 / NO-12a，§13）。
 *
 *  - POST /api/simulation/runs               创建运行（契约 fail-closed + 确定性评估）
 *  - GET  /api/simulation/runs               运行列表（租户作用域）
 *  - GET  /api/simulation/runs/:runId        运行详情（租户作用域）
 *
 * §13 三层强制：契约面 isSimulation=true + 表级 CHECK is_simulation=true +
 * 服务层绝不写生产 World State 表（本控制器唯一写路径 = ewoh_simulation_run）。
 * 读写带租户上下文 + DB 层 RLS（standalone_044）双保险。
 */
@Controller('api/simulation/runs')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  @Post()
  run(
    @Body() body: RunSimulationInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.simulationService.run(body, this.currentOrgId(request));
  }

  @Get()
  list(
    @Query('kind') kind: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.simulationService.listRuns(this.currentOrgId(request), { kind, status });
  }

  @Get(':runId')
  get(
    @Param('runId') runId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.simulationService.getRun(this.currentOrgId(request), runId);
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: simulation operations require tenant context');
    }
    return orgId;
  }
}
