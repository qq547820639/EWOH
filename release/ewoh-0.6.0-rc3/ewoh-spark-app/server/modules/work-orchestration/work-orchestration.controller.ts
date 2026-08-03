import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { WorkOrchestrationService } from './work-orchestration.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/work')
@Roles('global_admin')
export class WorkOrchestrationController {
  constructor(private readonly workService: WorkOrchestrationService) {}

  @Get('overview')
  getOverview() {
    return this.workService.getOverview();
  }

  @Get('graph')
  getGraph() {
    return this.workService.getGraph();
  }

  @Get('items')
  getItems(
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('owner') owner?: string,
    @Query('wave') wave?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.workService.getItems({
      status,
      type,
      owner,
      wave,
      q,
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    });
  }

  @Get('evidence')
  getEvidence(
    @Query('kind') kind?: string,
    @Query('result') result?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.workService.getEvidence({
      kind,
      result,
      q,
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    });
  }

  @Get('evidence/:id/content')
  getEvidenceContent(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.workService.getEvidenceContent(
      id,
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Get('agents')
  getAgents() {
    return this.workService.getAgents();
  }

  @Get('gates')
  getGates() {
    return this.workService.getGates();
  }

  @Get('risks')
  getRisks() {
    return this.workService.getRisks();
  }

  @Get('resources')
  getResources() {
    return this.workService.getResources();
  }

  @Get('handoffs')
  getHandoffs() {
    return this.workService.getHandoffs();
  }

  @Get('git-sync')
  getGitSyncStatus() {
    return this.workService.getGitSyncStatus();
  }

  @Get('site-readiness')
  getSiteReadiness() {
    return this.workService.getSiteReadiness();
  }

  @Get('catalog')
  getCatalog() {
    return this.workService.getCatalog();
  }

  @Post('resources/:id/lock')
  acquireResource(
    @Param('id') id: string,
    @Body() body: { purpose?: string; expiresAt?: string; confirm?: boolean },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workService.acquireResource(id, body, request.userContext);
  }

  @Post('resources/:id/release')
  releaseResource(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workService.releaseResource(id, request.userContext);
  }

  @Post('handoffs')
  createHandoff(
    @Body()
    body: {
      fromActor: string;
      toActor: string;
      scope: string;
      contextPack?: string;
      openQuestions?: string[];
      acceptance?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workService.createHandoff(body, request.userContext);
  }

  @Post('handoffs/:id/state')
  updateHandoffStatus(
    @Param('id') id: string,
    @Body() body: { status: 'accepted' | 'rejected' | 'closed'; reason?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workService.updateHandoffStatus(id, body, request.userContext);
  }

  @Post('gates/:id/decision')
  recordGateDecision(
    @Param('id') id: string,
    @Body() body: { decision: 'approved' | 'rejected' | 'conditional'; conditions?: string[] },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workService.recordGateDecision(id, body, request.userContext);
  }

  @Post('gates/batch-decision')
  recordGateDecisions(
    @Body()
    body: {
      gateIds: string[];
      decision: 'approved' | 'rejected' | 'conditional';
      conditions?: string[];
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.workService.recordGateDecisions(body, request.userContext);
  }
}
