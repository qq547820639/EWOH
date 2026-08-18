import { ewohAiSuggestion, ewohTelemetry, ewohEvent, ewohProductionTask } from '@server/database/schema';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { sql, eq, and } from 'drizzle-orm';
import { ArkService } from './ark.service';
import { InferenceResultService } from '../inference/inference.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';

export interface AiSuggestion {
  id: string;
  triggeredBy: string;
  frozenAt: string;
  snapshotVersion: number;
  problem: string;
  dataRange: { from: string; to: string };
  completeness: number;
  basis: string[];
  suggestion: string;
  risk: string[];
  uncertainty: string[];
  confirmItems: string[];
  expiryConditions: string[];
  /**
   * NO-08d（ADR-014）：LLM 生成路径附带的 Canonical ReasoningResult 元数据
   * （无标定置信度显式声明 + 契约自检留痕）；规则模板回退路径无此字段。
   */
  reasoning?: Record<string, unknown>;
  /**
   * NO-08a（ADR-019）：确定性规则基础的 Canonical InferenceResult 元数据
   * （L1，confidence=1 如实声明；快照完备度→dataQuality）。LLM 文本增强由
   * reasoning 字段承载（两契约分工不混用）。
   */
  inference?: Record<string, unknown>;
}

export interface AiPlan {
  id: string;
  suggestionId: string;
  parentPlanId?: string;
  version: number;
  isSimulation: boolean;
  status: 'shadow' | 'simulating' | 'pending_review';
  content: Record<string, unknown>;
}

let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function buildSuggestion(input: {
  triggeredBy: string;
  snapshot: { version: number; from: string; to: string; records: number };
  problem: string;
  id?: string;
}): AiSuggestion {
  return {
    id: input.id ?? nextId('sug'),
    triggeredBy: input.triggeredBy,
    frozenAt: new Date().toISOString(),
    // 22P02 修复（2026-08-18）：snapshotVersion 强制数值化——历史曾写入
    // 对象（{}）导致快照版本查询 ::bigint 崩溃、api 进程 crash。
    snapshotVersion: Number(input.snapshot.version) || 0,
    problem: input.problem,
    dataRange: { from: input.snapshot.from, to: input.snapshot.to },
    completeness: Math.min(1, input.snapshot.records / 100),
    basis: ['当前世界快照', `版本 ${input.snapshot.version}`],
    suggestion: `建议对 ${input.problem} 进行人工复核`,
    risk: ['需人工确认后才能进入正式计划'],
    uncertainty: ['模型未使用真实姓名字段'],
    confirmItems: ['确认数据范围与快照版本'],
    expiryConditions: ['快照版本变化后失效'],
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly suggestions = new Map<string, AiSuggestion>();
  private readonly plans = new Map<string, AiPlan>();
  private snapshotVersion = 0;

  constructor(
    @Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: any,
    private readonly ark?: ArkService,
    @Optional() private readonly inference?: InferenceResultService,
  ) {}

  async getSnapshotVersion(orgId?: string | null): Promise<number> {
    if (!this.db) {
      return this.snapshotVersion;
    }
    // ADR-078：drizzle 类型安全 + 可选 org 过滤（跨租户版本号混读关闭）。
    // 22P02 修复（2026-08-18）：jsonb_typeof 防御——历史坏数据 snapshotVersion 为
    // 对象（{}）时 `->>'…'::bigint` 抛 invalid input syntax 导致查询崩溃、进程 crash；
    // 现仅对数字类型取值，非数字行视为 NULL 参与聚合。
    const rows = await this.db
      .select({
        version: sql`coalesce(max((CASE WHEN jsonb_typeof(content::jsonb->'snapshotVersion') = 'number' THEN (content::jsonb->>'snapshotVersion')::bigint END)), 0)::int`,
      })
      .from(ewohAiSuggestion)
      .where(orgId ? eq(ewohAiSuggestion.orgId, orgId) : undefined);
    return Number((rows[0] as { version: number } | undefined)?.version ?? 0);
  }

  /** Manual A2 trigger only; never called during initialization. */
  async createSuggestion(input: {
    triggeredBy: string;
    snapshot: { version: number; from: string; to: string; records: number };
    problem: string;
    /** NO-08a（ADR-019）：推理结果台账的租户上下文（缺省不落账，显式告警）。 */
    orgId?: string;
  }): Promise<AiSuggestion> {
    if (!input.triggeredBy?.trim() || !input.problem?.trim()) {
      throw new BadRequestException('triggeredBy and problem are required');
    }
    // 真实调用 Ark 大模型生成建议；失败时回落到规则模板，保证流程可用。
    let suggestion = await this.generateSuggestionWithLlm(input);
    // NO-08a（ADR-019）：把确定性规则基础记录为 L1 InferenceResult 台账
    // （与 LLM 文本增强的 ReasoningResult 分工——统计确定 vs 文本生成）。
    suggestion = await this.attachRuleBasisInference(suggestion, input);
    return this.persistSuggestion(suggestion, input);
  }

  /** AI 接入优化（2026-08-18）：建议生成流式化——骨架先出 → LLM 打字机 → 完成落库。
   * 分阶段产出：basis（规则模板骨架）→ delta（LLM JSON 文本增量）→ done（最终建议）。
   * LLM 失败时直接 done + 规则模板兜底（与 createSuggestion 语义一致）。 */
  async *streamSuggestion(input: {
    triggeredBy: string;
    problem: string;
    snapshot: { version: number; from: string; to: string; records: number };
    orgId?: string;
  }): AsyncGenerator<
    { phase: 'basis' | 'delta' | 'done'; suggestion?: AiSuggestion; delta?: string; error?: string },
    void,
    undefined
  > {
    const base = buildSuggestion(input);
    yield { phase: 'basis', suggestion: base };
    let final: AiSuggestion = base;
    if (this.ark) {
      const systemPrompt =
        '你是工厂具身操作系统的智能调度助手。基于给定的问题与数据快照，给出结构化、可执行的调度建议。' +
        '仅输出 JSON，字段：suggestion(建议正文), basis(依据数组), risk(风险数组), uncertainty(不确定性数组), confirmItems(人工确认项数组)。' +
        '不要输出 markdown 代码块或其他文字。';
      const userPrompt = [
        `问题：${input.problem}`,
        `触发人：${input.triggeredBy}`,
        `数据快照：version=${input.snapshot.version}, from=${input.snapshot.from}, to=${input.snapshot.to}, records=${input.snapshot.records}`,
      ].join('\n');
      const parts: string[] = [];
      try {
        for await (const delta of this.ark.chatStream(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { temperature: 0.4 },
        )) {
          parts.push(delta);
          yield { phase: 'delta', delta };
        }
        const text = parts.join('');
        try {
          const parsed = JSON.parse(text) as Partial<AiSuggestion>;
          final = {
            ...base,
            suggestion: parsed.suggestion || base.suggestion,
            basis: Array.isArray(parsed.basis) && parsed.basis.length ? parsed.basis : base.basis,
            risk: Array.isArray(parsed.risk) && parsed.risk.length ? parsed.risk : base.risk,
            uncertainty:
              Array.isArray(parsed.uncertainty) && parsed.uncertainty.length ? parsed.uncertainty : base.uncertainty,
            confirmItems:
              Array.isArray(parsed.confirmItems) && parsed.confirmItems.length ? parsed.confirmItems : base.confirmItems,
          };
        } catch {
          final = { ...base, suggestion: `${base.suggestion}\n（LLM 原始输出：${text.slice(0, 500)}）` };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        final = { ...base, basis: [...base.basis, `LLM 不可用：${message}`] };
      }
    }
    final = await this.attachRuleBasisInference(final, input);
    const persisted = await this.persistSuggestion(final, input);
    yield { phase: 'done', suggestion: persisted };
  }

  /** A2 建议落库（createSuggestion / streamSuggestion 共用；await 保持落库确认语义）。 */
  private async persistSuggestion(
    suggestion: AiSuggestion,
    input: { snapshot: { version: number }; triggeredBy: string; problem: string; orgId?: string },
  ): Promise<AiSuggestion> {
    if (!this.db) {
      this.snapshotVersion = input.snapshot.version;
      this.suggestions.set(suggestion.id, suggestion);
      return suggestion;
    }
    this.snapshotVersion = input.snapshot.version;
    const [row] = await this.db
      .insert(ewohAiSuggestion)
      .values({
        suggestionId: suggestion.id,
        title: input.problem,
        suggestionType: 'A2',
        status: 'generated',
        inputSummary: input.problem,
        content: JSON.stringify(suggestion),
        riskAssessment: JSON.stringify(suggestion.risk),
        triggeredBy: input.triggeredBy,
        aiLevel: 'A2',
        ...(input.orgId ? { orgId: input.orgId } : {}),
      })
      .returning({ content: ewohAiSuggestion.content });
    const persisted = row ? (JSON.parse(String(row.content)) as AiSuggestion) : suggestion;
    this.suggestions.set(suggestion.id, persisted);
    return persisted;
  }

  /**
   * NO-08a（ADR-019 决策 3/6）：A2 建议的确定性规则基础 → L1 InferenceResult。
   * 台账写入失败 logger.error 留痕、主流程不中断（建议生成主契约不被审计旁路阻断）。
   */
  private async attachRuleBasisInference(
    suggestion: AiSuggestion,
    input: { snapshot: { version: number; from: string; to: string; records: number }; problem: string; orgId?: string },
  ): Promise<AiSuggestion> {
    if (!this.inference) return suggestion;
    if (!input.orgId?.trim()) {
      this.logger.warn('A2 建议无租户上下文，跳过推理结果落账（显式，非静默）');
      return suggestion;
    }
    try {
      const result = await this.inference.recordInferenceResult(
        {
          subjectId: `decision:${suggestion.id}`,
          level: 'L1_deterministic_rules',
          modelId: 'rule-a2-suggestion',
          modelVersion: 'v1',
          inputVersion: `snapshot-v${input.snapshot.version}`,
          label: input.problem,
          confidence: 1,
          oodIndicator: { flag: false, reasons: [] },
          dataQuality: suggestion.completeness >= 0.5 ? 'good' : 'degraded',
          evidence: {
            tsStart: input.snapshot.from,
            tsEnd: input.snapshot.to,
            isRule: true,
          },
        },
        input.orgId,
      );
      return { ...suggestion, inference: result.record };
    } catch (error) {
      this.logger.error(`A2 建议推理结果落账失败: ${String(error)}`);
      return suggestion;
    }
  }

  /** 调用 Ark 大模型生成 A2 建议；无配置或失败时回落到规则模板。 */
  private async generateSuggestionWithLlm(input: {
    triggeredBy: string;
    problem: string;
    snapshot: { version: number; from: string; to: string; records: number };
  }): Promise<AiSuggestion> {
    const base = buildSuggestion(input);
    if (!this.ark) return base;
    const systemPrompt =
      '你是工厂具身操作系统的智能调度助手。基于给定的问题与数据快照，给出结构化、可执行的调度建议。' +
      '仅输出 JSON，字段：suggestion(建议正文), basis(依据数组), risk(风险数组), uncertainty(不确定性数组), confirmItems(人工确认项数组)。' +
      '不要输出 markdown 代码块或其他文字。';
    const userPrompt = [
      `问题：${input.problem}`,
      `触发人：${input.triggeredBy}`,
      `数据快照：version=${input.snapshot.version}, from=${input.snapshot.from}, to=${input.snapshot.to}, records=${input.snapshot.records}`,
    ].join('\n');
    const result = await this.ark.ask(systemPrompt, userPrompt, {
      temperature: 0.4,
      kind: 'suggestion',
      inputVersion: 'scheduler-suggestion-v2',
    });
    if (!result.ok) {
      base.basis.push(`LLM 不可用：${result.error}`);
      // NO-08d：失败路径同样留痕 ReasoningResult（ok=false + error 可审计）。
      return { ...base, reasoning: result.reasoning };
    }
    try {
      const parsed = JSON.parse(result.text) as Partial<AiSuggestion>;
      return {
        ...base,
        suggestion: parsed.suggestion || base.suggestion,
        basis: Array.isArray(parsed.basis) && parsed.basis.length ? parsed.basis : base.basis,
        risk: Array.isArray(parsed.risk) && parsed.risk.length ? parsed.risk : base.risk,
        uncertainty:
          Array.isArray(parsed.uncertainty) && parsed.uncertainty.length ? parsed.uncertainty : base.uncertainty,
        confirmItems:
          Array.isArray(parsed.confirmItems) && parsed.confirmItems.length ? parsed.confirmItems : base.confirmItems,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      };
    } catch {
      base.suggestion = `${base.suggestion}\n（LLM 原始输出：${result.text.slice(0, 500)}）`;
      return { ...base, reasoning: result.reasoning };
    }
  }

  /** Manual A3 trigger only.（NEST-422：建议归属 org 校验。） */
  async createPlan(
    suggestionId: string,
    content: Record<string, unknown>,
    actor?: OrgContext,
  ): Promise<AiPlan> {
    if (!this.db) {
      if (!this.suggestions.has(suggestionId)) {
        throw new NotFoundException(`Suggestion ${suggestionId} not found`);
      }
      const plan: AiPlan = {
        id: nextId('plan'),
        suggestionId,
        version: 1,
        isSimulation: true,
        status: 'shadow',
        content,
      };
      this.plans.set(plan.id, plan);
      return plan;
    }

    const [suggestionRow] = await this.db
      .select({ content: ewohAiSuggestion.content, orgId: ewohAiSuggestion.orgId })
      .from(ewohAiSuggestion)
      .where(eq(ewohAiSuggestion.suggestionId, suggestionId));
    if (!suggestionRow) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }
    // NEST-422：建议归属 org 守卫（跨租户 404）。
    assertTenantVisible(
      (suggestionRow as { orgId?: string | null }).orgId,
      actor,
      `Suggestion ${suggestionId}`,
    );
    const suggestionText =
      String((suggestionRow as Record<string, unknown>).content ?? '') || suggestionId;
    // 真实调用 Ark 生成方案要点；失败时保留原 content。
    const enrichedContent = await this.enrichPlanWithLlm(suggestionText, content);
    const plan: AiPlan = {
      id: `plan-${suggestionId}`,
      suggestionId,
      version: 1,
      isSimulation: true,
      status: 'shadow',
      content: enrichedContent,
    };
    await this.db
      .update(ewohAiSuggestion)
      .set({ planContent: plan as unknown as Record<string, unknown> })
      .where(eq(ewohAiSuggestion.suggestionId, suggestionId));
    return plan;
  }

  /** 调用 Ark 大模型生成 A3 方案要点；无配置或失败时保留原 content。 */
  private async enrichPlanWithLlm(
    suggestionText: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.ark) return content;
    const systemPrompt =
      '你是工厂调度专家。基于 A2 建议生成 A3 模拟调度方案要点。仅输出 JSON 对象，可包含 shift, actions, kpis, note 等键。' +
      '不要输出 markdown 代码块或其他文字。';
    const userPrompt = `A2 建议：${suggestionText}\n已有的方案上下文：${JSON.stringify(content)}`;
    const result = await this.ark.ask(systemPrompt, userPrompt, {
      temperature: 0.4,
      kind: 'analysis',
      inputVersion: 'plan-analysis-v1',
    });
    if (!result.ok) {
      return {
        ...content,
        llmNote: `LLM 不可用：${result.error}`,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      };
    }
    try {
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      return {
        ...content,
        ...parsed,
        llmNote: `由 Ark 模型生成（${result.model}）`,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      };
    } catch {
      return {
        ...content,
        llmNote: `LLM 原始输出：${result.text.slice(0, 500)}`,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      };
    }
  }

  /** NEST-422：单条读 org 守卫（跨租户 404）。 */
  async getSuggestion(id: string, actor?: OrgContext): Promise<AiSuggestion> {
    if (!this.db) {
      const suggestion = this.suggestions.get(id);
      if (!suggestion) {
        throw new NotFoundException(`Suggestion ${id} not found`);
      }
      return suggestion;
    }
    const [row] = await this.db
      .select({ content: ewohAiSuggestion.content, orgId: ewohAiSuggestion.orgId })
      .from(ewohAiSuggestion)
      .where(eq(ewohAiSuggestion.suggestionId, id));
    if (!row) {
      throw new NotFoundException(`Suggestion ${id} not found`);
    }
    assertTenantVisible(
      (row as { orgId?: string | null }).orgId,
      actor,
      `Suggestion ${id}`,
    );
    return JSON.parse(String((row as Record<string, unknown>).content)) as AiSuggestion;
  }

  /** NEST-422：单条读 org 守卫（跨租户 404）。 */
  async getPlan(id: string, actor?: OrgContext): Promise<AiPlan> {
    if (!this.db) {
      const plan = this.plans.get(id);
      if (!plan) {
        throw new NotFoundException(`Plan ${id} not found`);
      }
      return plan;
    }
    const [row] = await this.db
      .select({ planContent: ewohAiSuggestion.planContent, orgId: ewohAiSuggestion.orgId })
      .from(ewohAiSuggestion)
      .where(sql`plan_content->>'id' = ${id}`);
    if (!row) {
      throw new NotFoundException(`Plan ${id} not found`);
    }
    assertTenantVisible(
      (row as { orgId?: string | null }).orgId,
      actor,
      `Plan ${id}`,
    );
    // NEST-449：读 camelCase planContent（旧 snake_case 读取恒 undefined）。
    return (row as Record<string, unknown>).planContent as unknown as AiPlan;
  }

  /** 自然语言问答：采集系统实时上下文并调用 Ark 回答。 */
  async chatWithContext(question: string, orgId?: string | null): Promise<{
    ok: boolean;
    answer: string;
    model: string;
    error?: string;
    context?: string;
  }> {
    const context = await this.collectSystemContext(orgId ?? null);
    if (!this.ark) {
      return { ok: false, answer: '', model: '', error: 'AI 服务未就绪。', context };
    }
    const systemPrompt =
      '你是工厂具身操作系统的 AI 助手，基于给定的实时上下文回答管理人员的问题。' +
      '用中文、简洁、结构化作答；若数据不足，如实说明，不要编造。可以给出改善建议。';
    const userPrompt = `实时上下文：\n${context}\n\n问题：${question}`;
    const result = await this.ark.ask(systemPrompt, userPrompt, { temperature: 0.3 });
    return {
      ok: result.ok,
      answer: result.text,
      model: result.model,
      error: result.error,
      context,
    };
  }

  /**
   * 自然语言问答（流式）：采集系统实时上下文后调用 Ark（stream:true），
   * 逐增量产出回答文本。错误以 throw 抛出（首个 yield 前）。
   */
  async *chatWithContextStream(
    question: string,
    orgId?: string | null,
  ): AsyncGenerator<{ delta: string }, void, undefined> {
    const context = await this.collectSystemContext(orgId ?? null);
    if (!this.ark) {
      throw new Error('AI 服务未就绪。');
    }
    const systemPrompt =
      '你是工厂具身操作系统的 AI 助手，基于给定的实时上下文回答管理人员的问题。' +
      '用中文、简洁、结构化作答；若数据不足，如实说明，不要编造。可以给出改善建议。';
    const userPrompt = `实时上下文：\n${context}\n\n问题：${question}`;
    for await (const delta of this.ark.chatStream(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3 },
    )) {
      yield { delta };
    }
  }

  /** 当前 Ark 模型名（流式结束时附带返回）。 */
  async getArkModel(): Promise<string> {
    try {
      return (await this.ark?.getConfig())?.model ?? '';
    } catch {
      return '';
    }
  }

  /** 采集系统实时上下文（遥测负荷电量、开放事件、生产任务统计）。 */
  private async collectSystemContext(orgId?: string | null): Promise<string> {
    if (!this.db) return '（无数据库连接，无法采集实时上下文）';
    const lines: string[] = [];
    try {
      // ADR-078：drizzle 类型安全 + org 过滤（AI 上下文不跨租户，§15/§16）。
      const tele: Array<{ deviceId: string | null; avgLoad: string | null; avgBattery: string | null; cnt: number }> =
        await this.db
          .select({
            deviceId: ewohTelemetry.deviceId,
            avgLoad: sql`round(avg(load_score)::numeric, 2)`,
            avgBattery: sql`round(avg(battery_pct)::numeric, 1)`,
            cnt: sql`count(*)::int`,
          })
          .from(ewohTelemetry)
          .where(
            and(
              sql`ts > now() - interval '1 hour'`,
              ...(orgId ? [eq(ewohTelemetry.orgId, orgId)] : []),
            ),
          )
          .groupBy(ewohTelemetry.deviceId)
          .orderBy(sql`round(avg(load_score)::numeric, 2) desc`)
          .limit(8);
      if (tele?.length) {
        lines.push('【近1小时设备负荷/电量】');
        for (const t of tele) {
          lines.push(
            `  ${t.deviceId}: 平均负荷=${t.avgLoad ?? 'N/A'}, 平均电量=${t.avgBattery ?? 'N/A'}%, 采样=${t.cnt}`,
          );
        }
      }
    } catch (error) {
      // NEST-442：采集失败留痕（不再静默吞）。
      this.logger.warn(
        `collectSystemContext: 遥测采集失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const events: Array<{ severity: string | null; status: string | null; cnt: number }> = await this.db
        .select({
          severity: ewohEvent.severity,
          status: ewohEvent.status,
          cnt: sql`count(*)::int`,
        })
        .from(ewohEvent)
        .where(orgId ? eq(ewohEvent.orgId, orgId) : undefined)
        .groupBy(ewohEvent.severity, ewohEvent.status)
        .orderBy(sql`count(*) desc`)
        .limit(8);
      if (events?.length) {
        lines.push('【事件统计】');
        for (const e of events) {
          lines.push(`  严重度=${e.severity ?? 'N/A'}, 状态=${e.status ?? 'N/A'}: ${e.cnt} 条`);
        }
      }
    } catch (error) {
      // NEST-442：采集失败留痕（不再静默吞）。
      this.logger.warn(
        `collectSystemContext: 事件采集失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const tasks: Array<{ status: string | null; cnt: number }> = await this.db
        .select({
          status: ewohProductionTask.status,
          cnt: sql`count(*)::int`,
        })
        .from(ewohProductionTask)
        .where(orgId ? eq(ewohProductionTask.orgId, orgId) : undefined)
        .groupBy(ewohProductionTask.status)
        .orderBy(sql`count(*) desc`);
      if (tasks?.length) {
        lines.push('【生产任务】');
        for (const t of tasks) {
          lines.push(`  ${t.status ?? 'N/A'}: ${t.cnt} 个`);
        }
      }
    } catch (error) {
      // NEST-442：采集失败留痕（不再静默吞）。
      this.logger.warn(
        `collectSystemContext: 任务采集失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return lines.length ? lines.join('\n') : '（暂无实时数据）';
  }
}
