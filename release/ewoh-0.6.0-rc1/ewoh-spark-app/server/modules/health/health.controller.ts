import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { Public } from '../shared/public.decorator';

@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', service: 'ewoh-api' };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.db.execute(sql`select 1 as ready`);
      return { status: 'ok', service: 'ewoh-api', checks: { database: 'ok' } };
    } catch {
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
