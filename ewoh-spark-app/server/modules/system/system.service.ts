import { Injectable, Inject, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';

const SENSITIVE_KEY = /(password|passwd|secret|token|credential|apikey|accesskey|authconfig|privatekey)/i;

export function maskSensitiveConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveConfig(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : maskSensitiveConfig(item);
    }
    return result;
  }
  return value;
}

@Injectable()
export class SystemService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async listConfigs() {
    const rows = await this.db.select().from(ewohSchedulerConfig).orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => ({
      id: row.id,
      configKey: row.configKey,
      configValue: maskSensitiveConfig(row.configValue),
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getConfig(key: string) {
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(eq(ewohSchedulerConfig.configKey, key));
    if (!row) {
      throw new NotFoundException(`Config ${key} not found`);
    }
    return {
      id: row.id,
      configKey: row.configKey,
      configValue: maskSensitiveConfig(row.configValue),
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async setConfig(key: string, configValue: unknown, updatedBy?: string) {
    if (!key?.trim()) {
      throw new BadRequestException('configKey is required');
    }
    if (!updatedBy?.trim()) {
      throw new UnauthorizedException('Authenticated user context is required');
    }
    const actor = updatedBy.trim();
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey: key.trim(),
        configValue: configValue as Record<string, unknown>,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: [ewohSchedulerConfig.orgId, ewohSchedulerConfig.configKey],
        set: {
          configValue: configValue as Record<string, unknown>,
          updatedBy: actor,
        },
      })
      .returning();
    return {
      id: row.id,
      configKey: row.configKey,
      configValue: maskSensitiveConfig(row.configValue),
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
