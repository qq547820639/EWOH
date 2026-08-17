import { Controller, Get, Post, Patch, Param, Query, Body, Req } from '@nestjs/common';
import {
  OrganizationService,
  CreateOrganizationDto,
  CreatePersonnelDto,
} from './organization.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/organization')
@Roles('global_admin')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  list() {
    return this.organizationService.listOrganizations();
  }

  @Get('tree')
  tree() {
    return this.organizationService.getOrganizationTree();
  }

  @Post()
  create(@Body() body: CreateOrganizationDto) {
    return this.organizationService.createOrganization(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Partial<CreateOrganizationDto>,
  ) {
    return this.organizationService.updateOrganization(id, body);
  }
}

@Controller('api/personnel')
@Roles('workshop_lead', 'safety_admin', 'global_admin')
export class PersonnelController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  list(
    @Query('keyword') keyword?: string,
    @Query('orgId') orgId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-637：分页参数（非法值回退默认）。
    // R2-SNZ-011：透传租户上下文（原先 personnel 面零租户谓词）。
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : undefined;
    return this.organizationService.listPersonnel(
      {
        keyword,
        orgId,
        status,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
      },
      request?.userContext,
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request?: { userContext?: OrgContext }) {
    return this.organizationService.getPersonnel(id, false, request?.userContext);
  }

  @Get(':id/sensitive')
  @Roles('safety_admin', 'global_admin')
  getSensitive(
    @Param('id') id: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.organizationService.getPersonnel(id, true, request?.userContext);
  }

  @Post()
  create(
    @Body() body: CreatePersonnelDto,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.organizationService.createPersonnel(body, request?.userContext);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Partial<CreatePersonnelDto>,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.organizationService.updatePersonnel(id, body, request?.userContext);
  }

  @Get(':id/bindings')
  bindings(@Param('id') id: string, @Req() request?: { userContext?: OrgContext }) {
    return this.organizationService.getPersonnelBindings(id, request?.userContext);
  }
}
