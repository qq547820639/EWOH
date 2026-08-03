import { Body, Controller, Get, Post } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';

@Controller('api/policies')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Post('evaluate')
  evaluate(
    @Body() body: { policy: unknown; context: Record<string, unknown> },
  ) {
    return this.policyService.evaluate(body.policy, body.context);
  }

  @Get('examples')
  examples() {
    return this.policyService.getExample();
  }
}
