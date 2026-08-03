import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { AiService } from './ai.service';
import { Roles } from '../shared/roles.decorator';

@Controller('api/ai')
@Roles('dispatcher', 'global_admin')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('snapshot-version')
  snapshotVersion() {
    return { version: this.aiService.getSnapshotVersion() };
  }

  @Post('suggestions')
  suggestion(
    @Body()
    body: {
      triggeredBy: string;
      problem: string;
      snapshot: { version: number; from: string; to: string; records: number };
    },
  ) {
    return this.aiService.createSuggestion(body);
  }

  @Post('plans')
  plan(@Body() body: { suggestionId: string; content: Record<string, unknown> }) {
    return this.aiService.createPlan(body.suggestionId, body.content ?? {});
  }

  @Get('suggestions/:id')
  getSuggestion(@Param('id') id: string) {
    return this.aiService.getSuggestion(id);
  }

  @Get('plans/:id')
  getPlan(@Param('id') id: string) {
    return this.aiService.getPlan(id);
  }
}
