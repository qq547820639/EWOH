import { BadRequestException, Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingConstraint } from '@server/database/schema';
import { and, asc, eq, isNull, or, gte } from 'drizzle-orm';
import type { SchedulingConstraint } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { isSoftConstraintType } from './constraints';

/**
 * 约束加载服务（Phase 0 / P0-2，05 §3.2）：持久化人工约束的**唯一加载入口**。
 *
 * 覆盖 4 个求解调用点（createRun / handleTrigger / conflict-preview / replan）：
 * - `loadGlobalActive(ctx, nowMs)`：全局 active 约束（org 隔离 + expiresAt 过滤 + active=true），
 *   供 createRun / handleTrigger / preview 使用。空结果 = 原行为（向后兼容）。
 * - `loadForPlan(planId, requestConstraints, ctx)`：按方案继承 + 请求约束合并
 *   （迁移自 plan.service.loadEffectiveConstraints，行为等价）。
 * - `hashConstraints(constraints)`：确定性哈希（JSON 键排序稳定序列化 → SHA-256），
 *   用于计划 constraints_json / effective_constraints_hash 的 replay 校验。
 *
 * 约束行真实列（standalone_023）：valid_from_ms / expires_at_ms / org_id / source /
 * deactivated_at / deactivated_by；旧 valueJson 内嵌字段保留（向后兼容读取）。
 */
@Injectable()
export class ConstraintLoaderService {
  private readonly logger = new Logger(ConstraintLoaderService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  /** 全局 active 约束（org 隔离 + 有效期过滤 + active=true），供 createRun / handleTrigger / preview。 */
  async loadGlobalActive(
    ctx: OrgContext,
    nowMs = Date.now(),
  ): Promise<SchedulingConstraint[]> {
    // NEST-004 修复（2026-08-17）：空字符串 orgId（SYSTEM_CTX/toOrgContext 兜底）
    // 与 null/undefined 同样视为"无租户上下文"。
    // R2 补齐（2026-08-17）：无租户上下文（SYSTEM_CTX，root db 无 GUC）不再
    // 全表加载——限定 org_id IS NULL（全局约束）行，跨租户 org 行不可见
    //（fail-closed；此前仅靠 GUC/RLS 兜底，SYSTEM_CTX 路径仍跨租户加载）。
    const orgId = ctx?.primaryOrgId?.trim() ? ctx.primaryOrgId : null;
    const rows = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(
        and(
          eq(ewohSchedulingConstraint.active, true),
          // org 隔离：org_id 匹配当前 org 或 NULL（全局约束放行）；
          // 无租户上下文 → 仅全局（NULL）行。
          orgId
            ? or(
                eq(ewohSchedulingConstraint.orgId, orgId),
                isNull(ewohSchedulingConstraint.orgId),
              )
            : isNull(ewohSchedulingConstraint.orgId),
          // 有效期过滤：expires_at_ms 为空或 >= now 才参与求解。
          or(
            isNull(ewohSchedulingConstraint.expiresAtMs),
            gte(ewohSchedulingConstraint.expiresAtMs, nowMs),
          ),
        ),
      )
      .orderBy(asc(ewohSchedulingConstraint.createdAt));
    return rows.map((r) => this.rowToConstraint(r));
  }

  /** 按方案继承 + 请求约束合并（迁移自 plan.service.loadEffectiveConstraints，行为等价）。 */
  async loadForPlan(
    planId: string,
    requestConstraints: SchedulingConstraint[] | null | undefined,
    ctx: OrgContext,
  ): Promise<SchedulingConstraint[]> {
    // NO-62c（e2e 抓到的真缺陷）：`lockedConstraints` 是请求体的**可选**字段，
    // 省略时 `undefined` 直接进 `[...requestConstraints]` → TypeError → 重排接口 500。
    // 语义：缺省 = 这次重排没有新增人工约束（继承方案既有约束照旧），不是"数据缺失"；
    // 但**非空非数组**是调用方契约错误，显式 400，绝不静默当空数组吞掉。
    if (requestConstraints != null && !Array.isArray(requestConstraints)) {
      throw new BadRequestException('requestConstraints 必须是约束数组');
    }
    const extras: SchedulingConstraint[] = requestConstraints ?? [];
    // NEST-004：同 loadGlobalActive——空串 orgId 显式等同无租户上下文；
    // 无租户上下文仅加载全局（NULL org）行（fail-closed，防跨租户加载）。
    const orgId = ctx?.primaryOrgId?.trim() ? ctx.primaryOrgId : null;
    const rows = await this.db
      .select()
      .from(ewohSchedulingConstraint)
      .where(
        and(
          eq(ewohSchedulingConstraint.planId, planId),
          eq(ewohSchedulingConstraint.active, true),
          orgId
            ? or(
                eq(ewohSchedulingConstraint.orgId, orgId),
                isNull(ewohSchedulingConstraint.orgId),
              )
            : isNull(ewohSchedulingConstraint.orgId),
          or(
            isNull(ewohSchedulingConstraint.expiresAtMs),
            gte(ewohSchedulingConstraint.expiresAtMs, Date.now()),
          ),
        ),
      )
      .orderBy(asc(ewohSchedulingConstraint.createdAt));
    const inherited = rows.map((r) => this.rowToConstraint(r));
    // 请求约束优先（operator 来源显式标注）；同类型同目标时请求覆盖继承。
    const merged = [...extras];
    for (const c of inherited) {
      const alreadyRequested = merged.some(
        (rc) =>
          rc.type === c.type &&
          rc.taskId === c.taskId &&
          rc.personId === c.personId &&
          rc.deviceId === c.deviceId &&
          rc.stationId === c.stationId,
      );
      if (!alreadyRequested) merged.push(c);
    }
    return merged;
  }

  /** 确定性哈希：JSON 键排序稳定序列化 → SHA-256（replay 校验用）。 */
  hashConstraints(constraints: SchedulingConstraint[]): string {
    const stableJson = JSON.stringify(this.stableSerialize(constraints));
    // 使用 Node crypto 的 SHA-256（同步，避免异步开销）。
    return createHash('sha256').update(stableJson, 'utf8').digest('hex');
  }

  /** 将约束行反序列化为 SchedulingConstraint（真实列优先，valueJson 内嵌字段兼容）。 */
  private rowToConstraint(row: {
    constraintId: string;
    planId: string | null;
    taskId: string | null;
    type: string;
    valueJson: unknown;
    active: boolean;
    validFromMs: number | null;
    expiresAtMs: number | null;
    orgId: string | null;
    source: string | null;
    deactivatedAt: Date | null;
    deactivatedBy: string | null;
    createdAt: Date;
  }): SchedulingConstraint {
    const v = (row.valueJson ?? {}) as Record<string, unknown>;
    return {
      id: row.constraintId,
      type: row.type as SchedulingConstraint['type'],
      taskId: row.taskId ?? undefined,
      personId: v.personId as string | undefined,
      deviceId: v.deviceId as string | undefined,
      stationId: v.stationId as string | undefined,
      zoneId: v.zoneId as string | undefined,
      startMs: v.startMs as number | undefined,
      endMs: v.endMs as number | undefined,
      operator: v.operator as string | undefined,
      reason: v.reason as string | undefined,
      validFrom: (v.validFrom as number | undefined) ?? (row.validFromMs ?? undefined),
      expiresAt: (v.expiresAt as number | undefined) ?? (row.expiresAtMs ?? undefined),
      validFromMs: row.validFromMs ?? null,
      expiresAtMs: row.expiresAtMs ?? null,
      orgId: row.orgId ?? null,
      source: (row.source ?? 'manual') as SchedulingConstraint['source'],
      deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
      deactivatedBy: row.deactivatedBy ?? null,
      snapshotVersion: v.snapshotVersion as string | undefined,
      // R2-SCH-010（2026-08-17）：按类型判定软约束——持久化软类型
      //（PREFERRED_RESOURCE/MANUAL_BOOST 等）hard=false，不再一律 hard:true。
      hard: !isSoftConstraintType(row.type),
    };
  }

  /** 稳定序列化：递归键排序，用于确定性哈希。 */
  private stableSerialize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((x) => this.stableSerialize(x));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        out[key] = this.stableSerialize(v);
      }
      return out;
    }
    return value;
  }
}
