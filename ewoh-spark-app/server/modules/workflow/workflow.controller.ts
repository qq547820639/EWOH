import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { WorkflowInstanceService } from './workflow-instance.service';
import { WorkflowService } from './workflow.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/workflows')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly workflowInstanceService: WorkflowInstanceService,
  ) {}

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

  @Post('instances')
  startInstance(
    @Body() body: { workflow: unknown; entityId: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workflowInstanceService.start(body, request.userContext);
  }

  @Get('instances')
  listInstances() {
    return this.workflowInstanceService.list();
  }

  @Post('instances/:key/advance')
  advanceInstance(
    @Param('key') key: string,
    @Body() body: { roles: string[]; toStep?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workflowInstanceService.advance(key, body, request.userContext);
  }
}
