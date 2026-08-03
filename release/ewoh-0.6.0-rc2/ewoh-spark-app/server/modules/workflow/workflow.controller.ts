import { Body, Controller, Get, Post } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';

@Controller('api/workflows')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post('advance')
  advance(
    @Body()
    body: {
      workflow: unknown;
      currentStep: string;
      roles: string[];
    },
  ) {
    return this.workflowService.advance(
      body.workflow,
      body.currentStep,
      body.roles,
    );
  }

  @Get('examples')
  examples() {
    return this.workflowService.getExample();
  }
}
