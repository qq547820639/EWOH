import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../shared/public.decorator';
import { Roles, ANY_AUTHENTICATED_ROLES } from '../shared/roles.decorator';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  async login(@Body() body: { username?: string; password?: string }) {
    if (!body.username || !body.password) {
      throw new UnauthorizedException('username and password are required');
    }
    return this.authService.login(body.username, body.password);
  }

  @Post('refresh')
  @Public()
  async refresh(@Body() body: { refreshToken?: string }) {
    if (!body.refreshToken) {
      throw new UnauthorizedException('refreshToken is required');
    }
    return this.authService.refresh(body.refreshToken);
  }

  @Post('logout')
  @Public()
  async logout(@Body() body: { refreshToken?: string }) {
    if (!body.refreshToken) {
      throw new UnauthorizedException('refreshToken is required');
    }
    await this.authService.logout(body.refreshToken);
    return { success: true };
  }

  @Roles(...ANY_AUTHENTICATED_ROLES)
  @Get('me')
  me(@Req() request: { userContext?: { userId?: string; roles?: string[]; primaryOrgId?: string } }) {
    if (!request.userContext?.userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    return request.userContext;
  }
}
