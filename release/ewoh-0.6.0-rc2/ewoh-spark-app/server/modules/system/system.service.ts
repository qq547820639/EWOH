import { Injectable, Inject, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq, like } from 'drizzle-orm';
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

function parseFeatureFlag(row: {
  configKey: string;
  configValue: unknown;
  updatedBy: string | null;
  updatedAt: Date | string;
}) {
  const value = (row.configValue as Record<string, unknown> | null) ?? {};
  return {
    key: row.configKey,
    enabled: value.enabled === true,
    metadata: value.metadata ?? {},
    updatedBy: row.updatedBy,
    updatedAt:
      typeof row.updatedAt === 'string'
        ? row.updatedAt
        : row.updatedAt.toISOString(),
  };
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

  async listFeatureFlags() {
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(like(ewohSchedulerConfig.configKey, 'feature.%'))
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => parseFeatureFlag(row));
  }

  async getFeatureFlag(key: string) {
    if (!key?.startsWith('feature.')) {
      throw new BadRequestException('feature flag key must start with feature.');
    }
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(eq(ewohSchedulerConfig.configKey, key));
    if (!row) {
      throw new NotFoundException(`Feature flag ${key} not found`);
    }
    return parseFeatureFlag(row);
  }

  async setFeatureFlag(
    key: string,
    enabled: boolean,
    metadata: Record<string, unknown>,
    updatedBy?: string,
  ) {
    if (!key?.startsWith('feature.')) {
      throw new BadRequestException('feature flag key must start with feature.');
    }
    const saved = await this.setConfig(
      key,
      { enabled: Boolean(enabled), metadata: metadata ?? {} },
      updatedBy,
    );
    return parseFeatureFlag(saved);
  }
}
