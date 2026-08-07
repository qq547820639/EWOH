import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ArkService } from './ark.service';

@Module({
  controllers: [AiController],
  providers: [AiService, ArkService],
  exports: [AiService, ArkService],
})
export class AiModule {}