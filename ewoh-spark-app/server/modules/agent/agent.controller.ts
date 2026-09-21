import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import { AgentService, type ExecuteAgentCommandInput, type RegisterAgentManifestInput } from './agent.service';
import { AgentOrchestratorService, type AgentTaskInput } from './agent-orchestrator.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Agent Runtime API（ADR-016 / NO-06b，Phase 9）。
 *
 *  - POST /api/agents/manifests         注册 Agent Manifest（global_admin；契约校验 fail-closed）
 *  - GET  /api/agents/manifests         清单列表（租户作用域）
 *  - GET  /api/agents/manifests/:agentId 单清单
 *  - POST /api/agents/execute           执行结构化 Command（治理角色 + 审批门控）
 *
 * 所有读写带租户上下文（userContext.primaryOrgId）+ DB 层 RLS
 * （standalone_037 agent_manifest_org_isolation）双保险。
 */
@Controller('api/agents')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly orchestrator: AgentOrchestratorService,
  ) {}

  @Post('manifests')
  @Roles('global_admin')
  register(
    @Body() body: RegisterAgentManifestInput,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const orgId = this.currentOrgId(request);
    return this.agentService.registerManifest(body, orgId, {
      userId: request?.userContext?.userId ?? 'system',
    });
  }

  @Get('manifests')
  list(@Req() request?: { userContext?: OrgContext }) {
    return this.agentService.listManifests(this.currentOrgId(request));
  }

  @Get('manifests/:agentId')
  async get(
    @Param('agentId') agentId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const manifest = await this.agentService.getManifest(this.currentOrgId(request), agentId);
    if (!manifest) {
      throw new BadRequestException('agent_not_registered');
    }
    return manifest;
  }

  @Post('execute')
  @Roles('dispatcher', 'workshop_lead', 'global_admin')
  execute(
    @Body() body: ExecuteAgentCommandInput & { agentId?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    const orgId = this.currentOrgId(request);
    const agentId = body.agentId ?? '';
    if (!agentId) {
      throw new BadRequestException('agentId 必填');
    }
    const { command, payload } = body;
    if (!command) {
      throw new BadRequestException('command 必填');
    }
    return this.agentService.executeCommand(
      orgId,
      agentId,
      { command, payload },
      { userId: request?.userContext?.userId ?? 'system' },
    );
  }

  /** NO-06c：工厂主管 Agent 建议流（读世界状态 → 结构化建议 → 审批桥接）。 */
  @Post('supervisor/run')
  runSupervisor(@Req() request?: { userContext?: OrgContext }) {
    // R2-SBZ-002：透传 userContext（OrgContext），世界状态读取按 primaryOrgId
    // 过滤——不再仅传 userId 导致 collectState 无租户谓词的全租户聚合。
    return this.agentService.runSupervisorSuggestion(
      this.currentOrgId(request),
      request?.userContext,
    );
  }

  /** NO-12f/ADR-030：待批清单（org 作用域；过期显式标记）。 */
  @Get('approvals')
  listPendingApprovals(@Req() request?: { userContext?: OrgContext }) {
    return this.agentService.listPendingApprovals(this.currentOrgId(request));
  }

  /** NO-06c：审批解析（批准→执行 / 驳回→拒绝留痕；NEST-305：org 作用域）。 */
  @Post('approvals/:approvalId/resolve')
  resolveApproval(
    @Param('approvalId') approvalId: string,
    @Body() body: { approved: boolean },
    @Req() request?: { userContext?: OrgContext },
  ) {
    if (typeof body?.approved !== 'boolean') {
      throw new BadRequestException('approved 必填（boolean）');
    }
    return this.agentService.resolveApproval(
      this.currentOrgId(request),
      approvalId,
      body.approved,
      {
        userId: request?.userContext?.userId ?? 'system',
        // FR5：透传角色供服务层做"资格角色 ∩ 台账 rolesJson"强制（fail-closed）。
        roles: request?.userContext?.roles ?? [],
      },
    );
  }

  // ── NO-06f：AgentTask 编排（ADR-017） ─────────────────────────────────────

  @Post('tasks')
  createTask(
    @Body() body: AgentTaskInput,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.orchestrator.createTask(
      this.currentOrgId(request),
      body,
      { userId: request?.userContext?.userId ?? 'system' },
    );
  }

  @Get('tasks')
  listTasks(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-326：分页参数（非法值回退默认；服务端钳制上限 500）。
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : undefined;
    return this.orchestrator.listTasks(this.currentOrgId(request), {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
    });
  }

  @Post('tasks/:taskId/dispatch')
  dispatchTask(
    @Param('taskId') taskId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.orchestrator.dispatchTask(this.currentOrgId(request), taskId, {
      userId: request?.userContext?.userId ?? 'system',
      roles: request?.userContext?.roles,
    });
  }

  @Post('tasks/:taskId/start')
  startTask(
    @Param('taskId') taskId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.orchestrator.startTask(this.currentOrgId(request), taskId, {
      userId: request?.userContext?.userId ?? 'system',
      roles: request?.userContext?.roles,
    });
  }

  @Post('tasks/:taskId/complete')
  completeTask(
    @Param('taskId') taskId: string,
    @Body() body: { status: 'completed' | 'failed'; outcomeJson?: Record<string, unknown> },
    @Req() request?: { userContext?: OrgContext },
  ) {
    if (body?.status !== 'completed' && body?.status !== 'failed') {
      throw new BadRequestException('status 必填（completed|failed）');
    }
    return this.orchestrator.completeTask(
      this.currentOrgId(request),
      taskId,
      { status: body.status, outcomeJson: body.outcomeJson },
      { userId: request?.userContext?.userId ?? 'system', roles: request?.userContext?.roles },
    );
  }

  @Post('tasks/:taskId/cancel')
  cancelTask(
    @Param('taskId') taskId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.orchestrator.cancelTask(this.currentOrgId(request), taskId, {
      userId: request?.userContext?.userId ?? 'system',
      roles: request?.userContext?.roles,
    });
  }

  private currentOrgId(request: { userContext?: OrgContext }): string {
    return request?.userContext?.primaryOrgId?.trim() ?? '';
  }
}
