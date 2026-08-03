import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ParametersService } from './parameters.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/parameters')
@Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin')
export class ParametersController {
  constructor(private readonly parametersService: ParametersService) {}

  @Post()
  register(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.parametersService.register(body as never, request.userContext);
  }

  @Get()
  list() {
    return this.parametersService.list();
  }

  @Get('summary')
  summary() {
    return this.parametersService.summary();
  }

  @Get(':key')
  get(@Param('key') key: string) {
    return this.parametersService.get(key);
  }

  @Put(':key')
  update(
    @Param('key') key: string,
    @Body() body: { current: unknown; note?: string; effectiveUntil?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.parametersService.update(key, body, request.userContext);
  }

  @Post(':key/approve')
  approve(
    @Param('key') key: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.parametersService.approve(key, request.userContext);
  }

  @Post(':key/rollback')
  rollback(
    @Param('key') key: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.parametersService.rollback(key, request.userContext);
  }

  @Post(':key/retire')
  retire(
    @Param('key') key: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.parametersService.retire(key, request.userContext);
  }
}
