import { Module } from '@nestjs/common';
import { WorldController } from './world.controller';
import { WorldService } from './world.service';

@Module({
  controllers: [WorldController],
  providers: [WorldService],
})
export class WorldModule {}
