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
  list(@Req() request: { userContext?: OrgContext }) {
    // NEST-411：org 过滤。
    return this.modelService.listModels(request.userContext);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-411：org 守卫。
    return this.modelService.getModel(id, request.userContext);
  }

  @Post()
  register(
    @Body() body: RegisterModelDto,
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-411：写入带 orgId。
    return this.modelService.registerModel(body, request.userContext);
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
