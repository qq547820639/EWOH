import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { ModelService, RegisterModelDto } from './model.service';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/models')
export class ModelController {
  constructor(private readonly modelService: ModelService) {}

  @Get()
  list() {
    return this.modelService.listModels();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.modelService.getModel(id);
  }

  @Post()
  register(@Body() body: RegisterModelDto) {
    return this.modelService.registerModel(body);
  }

  @Post(':id/state')
  transition(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!action) {
      throw new BadRequestException('action is required');
    }
    return this.modelService.transitionStatus(id, action, request.userContext);
  }
}
