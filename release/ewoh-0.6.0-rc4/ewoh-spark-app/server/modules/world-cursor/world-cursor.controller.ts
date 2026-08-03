import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { WorldCursorService, CursorExpiredError } from './world-cursor.service';

@Controller('api/world')
export class WorldCursorController {
  constructor(private readonly worldCursorService: WorldCursorService) {}

  @Get('snapshot')
  snapshot() {
    return this.worldCursorService.getSnapshot();
  }

  @Get('delta')
  async delta(@Query('cursor') cursor: string, @Query('limit') limit?: string) {
    try {
      return await this.worldCursorService.getDelta(cursor, limit ? parseInt(limit) : 200);
    } catch (error) {
      if (error instanceof CursorExpiredError) {
        throw new HttpException(
          { code: 'CURSOR_EXPIRED', message: error.message },
          HttpStatus.GONE,
        );
      }
      throw error;
    }
  }
}
