import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../shared/access-token.guard';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, AccessTokenGuard],
  exports: [AuthService, AccessTokenGuard],
})
export class AuthModule {}
