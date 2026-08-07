import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { ArkService } from './ark.service';

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
    snapshotVersion: input.snapshot.version,
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
  private readonly suggestions = new Map<string, AiSuggestion>();
  private readonly plans = new Map<string, AiPlan>();
  private snapshotVersion = 0;

  constructor(
    @Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: any,
    private readonly ark?: ArkService,
  ) {}

  async getSnapshotVersion(): Promise<number> {
    if (!this.db) {
      return this.snapshotVersion;
    }
    const rows = await this.db.execute(
      sql`
        select coalesce(max((content::jsonb->>'snapshotVersion')::bigint), 0)::int as version
        from public.ewoh_ai_suggestion
      `,
    );
    return Number((rows[0] as Record<string, unknown>)?.version ?? 0);
  }

  /** Manual A2 trigger only; never called during initialization. */
  async createSuggestion(input: {
    triggeredBy: string;
    snapshot: { version: number; from: string; to: string; records: number };
    problem: string;
  }): Promise<AiSuggestion> {
    if (!input.triggeredBy?.trim() || !input.problem?.trim()) {
      throw new BadRequestException('triggeredBy and problem are required');
    }
    // 真实调用 Ark 大模型生成建议；失败时回落到规则模板，保证流程可用。
    const suggestion = await this.generateSuggestionWithLlm(input);
    if (!this.db) {
      this.snapshotVersion = input.snapshot.version;
      this.suggestions.set(suggestion.id, suggestion);
      return suggestion;
    }
    const [row] = await this.db.execute(
      sql`
        insert into public.ewoh_ai_suggestion (
          suggestion_id, title, suggestion_type, status, input_summary,
          content, risk_assessment, triggered_by, ai_level
        ) values (
          ${suggestion.id}, ${input.problem}, 'A2', 'generated', ${input.problem},
          ${JSON.stringify(suggestion)}, ${JSON.stringify(suggestion.risk)},
          ${input.triggeredBy}, 'A2'
        )
        returning content
      `,
    );
    return JSON.parse(String((row as Record<string, unknown>).content)) as AiSuggestion;
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
    const result = await this.ark.ask(systemPrompt, userPrompt, { temperature: 0.4 });
    if (!result.ok) {
      base.basis.push(`LLM 不可用：${result.error}`);
      return base;
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
      };
    } catch {
      base.suggestion = `${base.suggestion}\n（LLM 原始输出：${result.text.slice(0, 500)}）`;
      return base;
    }
  }

  /** Manual A3 trigger only. */
  async createPlan(suggestionId: string, content: Record<string, unknown>): Promise<AiPlan> {
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

    const [suggestionRow] = await this.db.execute(
      sql`select content from public.ewoh_ai_suggestion where suggestion_id = ${suggestionId}`,
    );
    if (!suggestionRow) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }
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
    await this.db.execute(
      sql`
        update public.ewoh_ai_suggestion
        set plan_content = ${JSON.stringify(plan)}::jsonb
        where suggestion_id = ${suggestionId}
      `,
    );
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
    const result = await this.ark.ask(systemPrompt, userPrompt, { temperature: 0.4 });
    if (!result.ok) {
      return { ...content, llmNote: `LLM 不可用：${result.error}` };
    }
    try {
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      return { ...content, ...parsed, llmNote: `由 Ark 模型生成（${result.model}）` };
    } catch {
      return { ...content, llmNote: `LLM 原始输出：${result.text.slice(0, 500)}` };
    }
  }

  async getSuggestion(id: string): Promise<AiSuggestion> {
    if (!this.db) {
      const suggestion = this.suggestions.get(id);
      if (!suggestion) {
        throw new NotFoundException(`Suggestion ${id} not found`);
      }
      return suggestion;
    }
    const [row] = await this.db.execute(
      sql`select content from public.ewoh_ai_suggestion where suggestion_id = ${id}`,
    );
    if (!row) {
      throw new NotFoundException(`Suggestion ${id} not found`);
    }
    return JSON.parse(String((row as Record<string, unknown>).content)) as AiSuggestion;
  }

  async getPlan(id: string): Promise<AiPlan> {
    if (!this.db) {
      const plan = this.plans.get(id);
      if (!plan) {
        throw new NotFoundException(`Plan ${id} not found`);
      }
      return plan;
    }
    const [row] = await this.db.execute(
      sql`
        select plan_content
        from public.ewoh_ai_suggestion
        where plan_content->>'id' = ${id}
      `,
    );
    if (!row) {
      throw new NotFoundException(`Plan ${id} not found`);
    }
    return (row as Record<string, unknown>).plan_content as unknown as AiPlan;
  }

  /** 自然语言问答：采集系统实时上下文并调用 Ark 回答。 */
  async chatWithContext(question: string): Promise<{
    ok: boolean;
    answer: string;
    model: string;
    error?: string;
    context?: string;
  }> {
    const context = await this.collectSystemContext();
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

  /** 采集系统实时上下文（遥测负荷电量、开放事件、生产任务统计）。 */
  private async collectSystemContext(): Promise<string> {
    if (!this.db) return '（无数据库连接，无法采集实时上下文）';
    const lines: string[] = [];
    try {
      const tele: Array<{ deviceId: string; avgLoad: number | null; avgBattery: number | null; cnt: number }> =
        await this.db.execute(
          sql`
            select device_id as "deviceId",
                   round(avg(load_score)::numeric, 2) as "avgLoad",
                   round(avg(battery_pct)::numeric, 1) as "avgBattery",
                   count(*)::int as cnt
            from public.ewoh_telemetry
            where ts > now() - interval '1 hour'
            group by device_id
            order by "avgLoad" desc
            limit 8
          `,
        );
      if (tele?.length) {
        lines.push('【近1小时设备负荷/电量】');
        for (const t of tele) {
          lines.push(
            `  ${t.deviceId}: 平均负荷=${t.avgLoad ?? 'N/A'}, 平均电量=${t.avgBattery ?? 'N/A'}%, 采样=${t.cnt}`,
          );
        }
      }
    } catch {
      // 忽略遥测采集失败
    }
    try {
      const events: Array<{ severity: string; status: string; cnt: number }> = await this.db.execute(
        sql`
          select severity, status, count(*)::int as cnt
          from public.ewoh_event
          group by severity, status
          order by cnt desc
          limit 8
        `,
      );
      if (events?.length) {
        lines.push('【事件统计】');
        for (const e of events) {
          lines.push(`  严重度=${e.severity ?? 'N/A'}, 状态=${e.status ?? 'N/A'}: ${e.cnt} 条`);
        }
      }
    } catch {
      // 忽略事件采集失败
    }
    try {
      const tasks: Array<{ status: string; cnt: number }> = await this.db.execute(
        sql`
          select status, count(*)::int as cnt
          from public.ewoh_production_task
          group by status
          order by cnt desc
        `,
      );
      if (tasks?.length) {
        lines.push('【生产任务】');
        for (const t of tasks) {
          lines.push(`  ${t.status ?? 'N/A'}: ${t.cnt} 个`);
        }
      }
    } catch {
      // 忽略任务采集失败
    }
    return lines.length ? lines.join('\n') : '（暂无实时数据）';
  }
}
