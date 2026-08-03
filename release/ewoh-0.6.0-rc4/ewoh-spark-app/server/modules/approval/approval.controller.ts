import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApprovalPersistenceService } from './approval-persistence.service';
import type { ApprovalStepAction, CreateApprovalRequest } from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/approvals')
export class ApprovalController {
  constructor(
    private readonly approvalService: ApprovalPersistenceService,
  ) {}

  @Post()
  create(
    @Body() body: CreateApprovalRequest,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.createApproval(body, request.userContext);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.approvalService.getApproval(id);
  }

  @Post(':id/steps/:stepId/state')
  @HttpCode(200)
  step(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Query('action') action: ApprovalStepAction,
    @Body() body: { reason?: string; delegateTo?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.stepAction(
      id,
      stepId,
      action,
      body.reason,
      body.delegateTo,
      request.userContext,
    );
  }

  @Post(':id/bypass')
  @HttpCode(200)
  bypass(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.bypass(id, body.reason ?? '', request.userContext);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.approvalService.cancel(id, request.userContext);
  }
}
