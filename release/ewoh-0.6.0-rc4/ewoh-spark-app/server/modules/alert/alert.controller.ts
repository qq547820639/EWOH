import { Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { AlertService } from './alert.service';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/alerts')
export class AlertController {
  constructor(private readonly alertService: AlertService) {}

  @Get()
  list() {
    return this.alertService.listAlerts();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.alertService.getAlert(id);
  }

  @Post(':id/state')
  transition(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.alertService.transitionAlert(id, action, request.userContext);
  }
}
