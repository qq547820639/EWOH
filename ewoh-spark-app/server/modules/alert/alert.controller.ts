import { Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import { AlertService } from './alert.service';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/alerts')
export class AlertController {
  constructor(private readonly alertService: AlertService) {}

  @Get()
  list(@Req() request: { userContext?: OrgContext }) {
    // NEST-433：org 过滤。
    return this.alertService.listAlerts(request.userContext);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-433：org 守卫。
    return this.alertService.getAlert(id, request.userContext);
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
