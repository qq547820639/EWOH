import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';

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

  constructor(@Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: any) {}

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
    if (!this.db) {
      this.snapshotVersion = input.snapshot.version;
      const suggestion = buildSuggestion(input);
      this.suggestions.set(suggestion.id, suggestion);
      return suggestion;
    }

    const suggestion = buildSuggestion(input);
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

    const [suggestion] = await this.db.execute(
      sql`select suggestion_id from public.ewoh_ai_suggestion where suggestion_id = ${suggestionId}`,
    );
    if (!suggestion) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found`);
    }
    const plan: AiPlan = {
      id: `plan-${suggestionId}`,
      suggestionId,
      version: 1,
      isSimulation: true,
      status: 'shadow',
      content,
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
}
