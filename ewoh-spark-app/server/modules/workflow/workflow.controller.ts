import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { WorkflowInstanceService } from './workflow-instance.service';
import { WorkflowService } from './workflow.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * NEST-610（2026-08-17 审计整改）：advance/advanceInstance 的 roles 一律取
 * 服务端 userContext（userContext.roles，回退单角色 role）——请求体 body.roles
 * 被显式忽略，杜绝越权伪造角色绕过工作流 allowedRoles 门控。
 */
function serverRoles(context?: OrgContext): string[] {
  if (!context) return [];
  if (Array.isArray(context.roles) && context.roles.length > 0) {
    return context.roles;
  }
  return context.role ? [context.role] : [];
}

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
      /** 已忽略：角色只能来自认证上下文（NEST-610）。 */
      roles?: string[];
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workflowService.advance(
      body.workflow,
      body.currentStep,
      serverRoles(request.userContext),
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
  listInstances(@Req() request: { userContext?: OrgContext }) {
    return this.workflowInstanceService.list(request.userContext);
  }

  @Post('instances/:key/advance')
  advanceInstance(
    @Param('key') key: string,
    @Body() body: { roles?: string[]; toStep?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    // body.roles 显式忽略（NEST-610）。
    return this.workflowInstanceService.advance(
      key,
      { roles: serverRoles(request.userContext), toStep: body.toStep },
      request.userContext,
    );
  }
}
