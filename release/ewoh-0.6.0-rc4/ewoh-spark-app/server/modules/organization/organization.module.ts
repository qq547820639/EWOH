import { Module } from '@nestjs/common';
import { OrganizationController, PersonnelController } from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  controllers: [OrganizationController, PersonnelController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
