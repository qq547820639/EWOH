/* SchedulingNarratorService — AI 调度说明层（2026-08-21）。
 *
 * 职责边界（与「开发指令-AI调度说明生成」一致）：
 * - 只消费求解器/评估器原始输出（plan metrics/baselineDelta/violations/assignments），
 *   生成面向班组长/调度员的自然语言方案说明；不参与求解、不改写任何求解事实。
 * - LLM（ArkService，可选注入）生成 → 失败/未配置/输出不合格 → 规则模板兜底
 *   （narration_source: llm | rule_fallback）。
 * - 幂等：plan 已有 narration 则跳过（重复触发不覆盖）。
 * - 异步调用（调用方 fire-and-forget），绝不阻断方案生成/审批响应。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, inArray } from 'drizzle-orm';
import {
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
  ewohSpatialEntity,
} from '@server/database/schema';
import { RequestDatabaseContext } from '../../../database/request-database-context';
import { buildGucSettings } from '../../shared/org-context.interceptor';
import type { OrgContext } from '../../shared/org-context.interceptor';
import { ArkService } from '../../ai/ark.service';

export type NarrationSource = 'llm' | 'rule_fallback';

const NARRATION_MAX_CHARS = 800;

const NARRATION_SYSTEM_PROMPT = `你是工厂生产调度系统的方案解读助手。你只负责把求解器给出的
调度方案翻译成班组长/调度员能直接读懂的中文说明，不参与任何决策。
输入是一份结构化的调度方案数据（任务分配、指标、冲突、与基线的对比，JSON 格式）。
输出要求：
1. 四段式：一句话结论 / 主要调整 / 风险与关注点 / 建议动作；
2. 用业务语言（人员用姓名、设备用编号如 EXO-101、工位用名称），
   数字用"从 X 降至 Y""共 N 个任务"式表达；
3. 只描述输入中真实存在的事实，禁止编造任务、指标或原因；
4. 中文 200-400 字；不得输出 markdown、代码块、JSON、表格；
5. 没有风险时如实写"未发现明显风险"，不要硬凑。`;

@Injectable()
export class SchedulingNarratorService {
  private readonly logger = new Logger(SchedulingNarratorService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    @Optional() private readonly ark?: ArkService,
  ) {}

  /**
   * 幂等生成说明。返回 null 表示 plan 不存在；返回 { source, narration }。
   * 查询与落库在 org GUC 事务内执行（异步调用无 HTTP 事务上下文，RLS 需显式
   * 设置 GUC——否则 plan 读取被 RLS 拒（NEST-504 fail-closed），narration 落库失败）。
   * LLM 路径失败自动降级规则回退。
   */
  async generateForPlan(
    planId: string,
    ctx?: OrgContext,
  ): Promise<{ source: NarrationSource; narration: string } | null> {
    const gucSettings = buildGucSettings(
      ctx ?? {
        userId: 'system',
        primaryOrgId: null,
        roles: [],
        accessibleOrgIds: [],
        isGlobalAdmin: true,
      },
    );

    // ---- 阶段 1：读事务（快速，~100ms 内完成） ----
    // 读取 plan + assignments + 人员映射，构建 LLM 输入（含 DB 查询）。
    // 关键：LLM 调用（30-60s）必须在事务外，否则 3 个并发 narrator 会
    // 占用 3 个 PG 连接等待 Ark API，阻塞 tracing interceptor / health
    // 等其他连接请求 → HTTP 响应延迟 130s+（NEST-??? 修复）。
    type ReadResult = { plan: typeof ewohSchedulePlan.$inferSelect; assignments: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>; llmInput: string } | null;
    const readResult: ReadResult = await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      const [plan] = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(eq(ewohSchedulePlan.planId, planId))
        .limit(1);
      if (!plan) return null;
      // 幂等：已有说明直接返回（不覆盖）。
      if (plan.aiNarration) {
        return { plan, assignments: [], llmInput: '__IDEMPOTENT__' } as unknown as ReadResult;
      }
      const assignments = await this.db
        .select()
        .from(ewohSchedulingPlanAssignment)
        .where(eq(ewohSchedulingPlanAssignment.planId, planId));
      const llmInput = this.ark ? await this.buildLlmInput(plan, assignments) : '';
      return { plan, assignments, llmInput } as unknown as ReadResult;
    });

    if (!readResult) return null;
    const { plan, assignments, llmInput } = readResult;

    // 幂等：已有说明直接返回。
    if (llmInput === '__IDEMPOTENT__') {
      return {
        source: (plan.narrationSource as NarrationSource | null) ?? 'llm',
        narration: plan.aiNarration!,
      };
    }

    // ---- 阶段 2：LLM / 规则计算（事务外，不占 PG 连接） ----
    let narration: string;
    let source: NarrationSource;

    if (this.ark && llmInput) {
      try {
        const result = await this.ark.ask(NARRATION_SYSTEM_PROMPT, llmInput, {
          temperature: 0.3,
          kind: 'analysis',
          inputVersion: 'plan-narration-v1',
        });
        if (result.ok && result.text && result.text.trim().length >= 20) {
          const cleaned = this.sanitize(result.text);
          if (cleaned.length >= 20) {
            narration = cleaned;
            source = 'llm';
          } else {
            this.logger.warn(
              `plan narration LLM 输出不合格 planId=${planId}: too short after sanitize`,
            );
            narration = await this.buildRuleFallback(plan, assignments);
            source = 'rule_fallback';
          }
        } else {
          this.logger.warn(
            `plan narration LLM 输出不合格 planId=${planId}: ${result.error ?? 'empty'}`,
          );
          narration = await this.buildRuleFallback(plan, assignments);
          source = 'rule_fallback';
        }
      } catch (error) {
        this.logger.warn(
          `plan narration LLM 失败 planId=${planId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        narration = await this.buildRuleFallback(plan, assignments);
        source = 'rule_fallback';
      }
    } else {
      narration = await this.buildRuleFallback(plan, assignments);
      source = 'rule_fallback';
    }

    // ---- 阶段 3：写事务（快速，仅 UPDATE） ----
    await this.persist(planId, narration, source);
    return { source, narration };
  }

  private async persist(
    planId: string,
    narration: string,
    source: NarrationSource,
  ): Promise<void> {
    // 写事务需要 GUC 设置（RLS 上下文），独立于读事务。
    const gucSettings = buildGucSettings({
      userId: 'system',
      primaryOrgId: null,
      roles: [],
      accessibleOrgIds: [],
      isGlobalAdmin: true,
    });
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      await this.db
        .update(ewohSchedulePlan)
        .set({ aiNarration: narration, narrationSource: source })
        .where(eq(ewohSchedulePlan.planId, planId));
    });
  }

  /** 清洗 LLM 输出：去 markdown 围栏/首尾空白、截断上限。 */
  private sanitize(text: string): string {
    let t = text.trim();
    t = t.replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/\s*```$/, '');
    t = t.replace(/\s*\n\s*\n\s*/g, '\n');
    if (t.length > NARRATION_MAX_CHARS) {
      t = `${t.slice(0, NARRATION_MAX_CHARS)}…`;
    }
    return t;
  }

  /** 构造 LLM 输入：结构化 JSON 摘要（含人员姓名映射）。 */
  private async buildLlmInput(
    plan: typeof ewohSchedulePlan.$inferSelect,
    assignments: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>,
  ): Promise<string> {
    const personIds = Array.from(
      new Set(assignments.map((a) => a.personId).filter(Boolean) as string[]),
    );
    const personRows =
      personIds.length > 0
        ? await this.db
            .select({
              entityId: ewohSpatialEntity.entityId,
              name: ewohSpatialEntity.name,
            })
            .from(ewohSpatialEntity)
            .where(
              inArray(ewohSpatialEntity.entityId, personIds),
            )
        : [];
    const personName = new Map(
      personRows.map((r) => [r.entityId, r.name]),
    );
    const summary = {
      planId: plan.planId,
      status: plan.status,
      strategy: plan.strategy,
      metrics: plan.metricsJson ?? {},
      baselineDelta: plan.baselineDeltaJson ?? {},
      violations: Array.isArray(plan.violationsJson) ? plan.violationsJson : [],
      taskCount: assignments.length,
      assignments: assignments.map((a) => ({
        taskId: a.taskId,
        person: personName.get(a.personId ?? '') ?? a.personId ?? '未分配',
        deviceId: a.deviceId ?? null,
        stationId: a.stationId ?? null,
        plannedStart: a.plannedStart ? a.plannedStart.toISOString() : null,
        plannedEnd: a.plannedEnd ? a.plannedEnd.toISOString() : null,
      })),
    };
    return JSON.stringify(summary);
  }

  /** 规则回退模板（确定性，事实全部来自输入数据）。 */
  private async buildRuleFallback(
    plan: typeof ewohSchedulePlan.$inferSelect,
    assignments: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>,
  ): Promise<string> {
    const metrics = (plan.metricsJson ?? {}) as Record<string, number>;
    const delta = (plan.baselineDeltaJson ?? {}) as Record<string, number>;
    const violations = Array.isArray(plan.violationsJson)
      ? (plan.violationsJson as Array<Record<string, unknown>>)
      : [];
    const parts: string[] = [];
    parts.push(
      `本方案（${plan.strategy}）共分配 ${assignments.length} 个任务` +
        (metrics.maxWorkload
          ? `，最高负荷 ${(metrics.maxWorkload * 100).toFixed(0)}%`
          : '') +
        (metrics.walkingMeters
          ? `，预计步行 ${Math.round(metrics.walkingMeters)} 米`
          : '') +
        (metrics.lateMinutes ? `，预计延误 ${metrics.lateMinutes} 分钟` : '') +
        '。',
    );
    const deltaParts: string[] = [];
    if (delta.maxWorkload != null)
      deltaParts.push(`最高负荷${delta.maxWorkload >= 0 ? '上升' : '下降'} ${Math.abs(delta.maxWorkload * 100).toFixed(0)}%`);
    if (delta.walkingMeters != null)
      deltaParts.push(`步行${delta.walkingMeters >= 0 ? '增加' : '减少'} ${Math.round(Math.abs(delta.walkingMeters))} 米`);
    if (delta.lateMinutes != null)
      deltaParts.push(`延误${delta.lateMinutes >= 0 ? '增加' : '减少'} ${Math.abs(delta.lateMinutes)} 分钟`);
    if (deltaParts.length > 0) parts.push(`较上一版：${deltaParts.join('、')}。`);
    if (violations.length > 0) {
      const reasons = violations
        .map((v) => (v as { reason?: string }).reason ?? '未知原因')
        .slice(0, 3);
      parts.push(`需关注：${reasons.join('、')}。`);
    } else {
      parts.push('未发现明显风险。');
    }
    return parts.join('\n');
  }
}
