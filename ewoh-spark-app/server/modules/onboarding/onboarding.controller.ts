import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/scale/onboarding')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('checklist')
  checklist() {
    return this.onboardingService.checklist();
  }

  @Post('run')
  run(
    @Body() body: { factoryName: string; config?: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.onboardingService.run(body, request.userContext);
  }

  @Get('partner/checklist')
  partnerChecklist() {
    return this.onboardingService.partnerChecklist();
  }

  @Get('sample-factory/status')
  sampleFactoryStatus(
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.onboardingService.sampleFactoryStatus(request.userContext);
  }

  @Post('sample-factory/init')
  sampleFactoryInit(
    @Body() body: { token: string; factoryName?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.onboardingService.sampleFactoryInit(body, request.userContext);
  }

  @Post('sample-factory/clear')
  sampleFactoryClear(
    @Body() body: { token: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.onboardingService.sampleFactoryClear(body, request.userContext);
  }

  @Post('partner/shadow-run')
  partnerShadowRun(
    @Body() body: { factoryName: string; config?: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.onboardingService.partnerShadowRun(body, request.userContext);
  }
}
