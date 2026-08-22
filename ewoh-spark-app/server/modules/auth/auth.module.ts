import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../shared/access-token.guard';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, AccessTokenGuard, LoginRateLimitGuard],
  exports: [AuthService, AccessTokenGuard],
})
export class AuthModule {}
