import { Module } from '@nestjs/common';
import { OeeController } from './oee.controller';
import { OeeService } from './oee.service';

@Module({
  controllers: [OeeController],
  providers: [OeeService],
  exports: [OeeService],
})
export class OeeModule {}
