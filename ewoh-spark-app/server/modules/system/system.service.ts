import { Injectable, Inject, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, like } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';

/**
 * NEST-615（2026-08-17 审计整改）：敏感键正则补 [_-]? 可选分隔变体
 * （api_key / access-key / auth_config / private.key 等此前漏网）。
 */
const SENSITIVE_KEY = /(password|passwd|secret|token|credential|api[_-]?key|access[_-]?key|auth[_-]?config|private[_-]?key)/i;

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

export interface FlagEvaluationContext {
  orgId?: string;
  factoryId?: string;
  upgradeRing?: string;
  roles?: string[];
}

interface FlagTargeting {
  rings?: string[];
  roles?: string[];
  orgIds?: string[];
  factories?: string[];
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

  /**
   * NEST-614（2026-08-17 审计整改）：配置/特性开关查询带 org 谓词
   * （global_admin 放行，与 RLS 例外路径一致）。
   */
  private orgCondition(actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }) {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: system config operations require tenant context',
      );
    }
    return eq(ewohSchedulerConfig.orgId, orgId);
  }

  async listConfigs(actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }) {
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(this.orgCondition(actor))
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => ({
      id: row.id,
      configKey: row.configKey,
      configValue: maskSensitiveConfig(row.configValue),
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getConfig(key: string, actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }) {
    const orgCond = this.orgCondition(actor);
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(
        orgCond
          ? and(eq(ewohSchedulerConfig.configKey, key), orgCond)
          : eq(ewohSchedulerConfig.configKey, key),
      );
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

  async setConfig(
    key: string,
    configValue: unknown,
    updatedBy?: string,
    orgId?: string,
  ) {
    if (!key?.trim()) {
      throw new BadRequestException('configKey is required');
    }
    if (!updatedBy?.trim()) {
      throw new UnauthorizedException('Authenticated user context is required');
    }
    const actor = updatedBy.trim();
    // NEST-642：insert 显式携带 orgId（冲突目标含 orgId 但 values 原先不带，
    // 依赖 GUC 默认；显式写入后不依赖请求级 GUC 状态）。
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey: key.trim(),
        configValue: configValue as Record<string, unknown>,
        updatedBy: actor,
        ...(orgId?.trim() ? { orgId: orgId.trim() } : {}),
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

  async listFeatureFlags(actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }) {
    const orgCond = this.orgCondition(actor);
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(
        orgCond
          ? and(like(ewohSchedulerConfig.configKey, 'feature.%'), orgCond)
          : like(ewohSchedulerConfig.configKey, 'feature.%'),
      )
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => parseFeatureFlag(row));
  }

  async getFeatureFlag(key: string, actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean }) {
    if (!key?.startsWith('feature.')) {
      throw new BadRequestException('feature flag key must start with feature.');
    }
    const orgCond = this.orgCondition(actor);
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(
        orgCond
          ? and(eq(ewohSchedulerConfig.configKey, key), orgCond)
          : eq(ewohSchedulerConfig.configKey, key),
      );
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
    orgId?: string,
  ) {
    if (!key?.startsWith('feature.')) {
      throw new BadRequestException('feature flag key must start with feature.');
    }
    const saved = await this.setConfig(
      key,
      { enabled: Boolean(enabled), metadata: metadata ?? {} },
      updatedBy,
      orgId,
    );
    return parseFeatureFlag(saved);
  }

  async evaluateFeatureFlags(
    keys?: string[],
    context: FlagEvaluationContext = {},
    actor?: { primaryOrgId?: string; isGlobalAdmin?: boolean },
  ) {
    const flags = await this.listFeatureFlags(actor);
    const requested = keys && keys.length > 0 ? keys : flags.map((flag) => flag.key);
    return requested.map((key) => {
      const flag = flags.find((candidate) => candidate.key === key);
      if (!flag) {
        return {
          key,
          enabled: false,
          reason: 'flag_not_found',
          variant: 'off',
          targetingApplied: false,
        };
      }
      const metadata = flag.metadata as {
        targeting?: FlagTargeting;
        fallbackEnabled?: boolean;
      };
      const targeting = metadata.targeting;
      let reason = 'default';
      let targetingApplied = false;
      if (targeting && typeof targeting === 'object') {
        targetingApplied = true;
        if (
          Array.isArray(targeting.rings) &&
          targeting.rings.length > 0 &&
          !targeting.rings.includes(context.upgradeRing ?? '')
        ) {
          reason = 'ring_mismatch';
        }
        if (
          reason === 'default' &&
          Array.isArray(targeting.roles) &&
          targeting.roles.length > 0 &&
          !(context.roles ?? []).some((role) => targeting.roles!.includes(role))
        ) {
          reason = 'role_mismatch';
        }
        if (
          reason === 'default' &&
          Array.isArray(targeting.orgIds) &&
          targeting.orgIds.length > 0 &&
          !targeting.orgIds.includes(context.orgId ?? '')
        ) {
          reason = 'org_mismatch';
        }
        if (
          reason === 'default' &&
          Array.isArray(targeting.factories) &&
          targeting.factories.length > 0 &&
          !targeting.factories.includes(context.factoryId ?? '')
        ) {
          reason = 'factory_mismatch';
        }
      }
      const safeClosed =
        reason !== 'default' && metadata.fallbackEnabled !== true;
      const enabled = safeClosed ? false : flag.enabled;
      return {
        key,
        enabled,
        reason: reason === 'default' ? (flag.enabled ? 'default_on' : 'default_off') : reason,
        variant: enabled ? 'on' : 'off',
        targetingApplied,
      };
    });
  }
}
