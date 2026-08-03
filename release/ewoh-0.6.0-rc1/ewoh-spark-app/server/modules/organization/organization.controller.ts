import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import {
  OrganizationService,
  CreateOrganizationDto,
  CreatePersonnelDto,
} from './organization.service';
import { Roles } from '../shared/roles.decorator';

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
  ) {
    return this.organizationService.listPersonnel({ keyword, orgId, status });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.organizationService.getPersonnel(id, false);
  }

  @Get(':id/sensitive')
  @Roles('safety_admin', 'global_admin')
  getSensitive(@Param('id') id: string) {
    return this.organizationService.getPersonnel(id, true);
  }

  @Post()
  create(@Body() body: CreatePersonnelDto) {
    return this.organizationService.createPersonnel(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<CreatePersonnelDto>) {
    return this.organizationService.updatePersonnel(id, body);
  }

  @Get(':id/bindings')
  bindings(@Param('id') id: string) {
    return this.organizationService.getPersonnelBindings(id);
  }
}
