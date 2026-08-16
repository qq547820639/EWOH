/* decision-history.service.ts — Decision History 跨 kind 检索（ADR-065 / NO-13p，§12/§15/§18/§33）。
 *
 * 只读聚合：Decision Catalog 8 类 kind 跨四表统一读面——
 *  - ewoh_schedule_plan.decision_records_json（kind 1/2/4/5/6，数组元素；
 *    SQL 层 org 条件（ADR-072：org_id 自 standalone_025 已存在，org 匹配
 *    或 NULL 存量）+ 记录级 tenantId 过滤第二层）；
 *  - ewoh_agent_approval.decision_json（kind 3，org_id 列过滤 + 记录过滤双保险）；
 *  - ewoh_learning_proposal.decision_json（kind 7，同上）；
 *  - ewoh_scheduling_policy.decision_json（kind 8，org_id = 当前 org；
 *    全局策略 null 行不进入租户查询，显式边界）。
 * 全部记录过 validateDecision（§31 单一校验器）：非法 → 显式 skippedInvalid
 * 计数跳过（§33 绝不静默丢弃/伪装）；kind/status 过滤器 fail-closed（非封闭
 * 词表 → 400 不猜测）；排序 decidedAt 降序 + decisionId 字典序稳定；分页
 * limit 缺省 50 cap 100。
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulePlan,
  ewohAgentApproval,
  ewohLearningProposal,
  ewohSchedulingPolicy,
} from '@server/database/schema';
import { eq, isNotNull, and, or, isNull } from 'drizzle-orm';
import {
  validateDecision,
  DECISION_KINDS,
  DECISION_STATUSES,
  type DecisionRecord,
} from '@shared/decision';

export interface DecisionHistoryQuery {
  kind?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface DecisionHistoryResult {
  items: DecisionRecord[];
  total: number;
  skippedInvalid: number;
  sources: {
    plans: number;
    agentApprovals: number;
    learningProposals: number;
    policies: number;
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const KIND_SET: ReadonlySet<string> = new Set(DECISION_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(DECISION_STATUSES);

@Injectable()
export class DecisionHistoryService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** 跨 kind 决策历史检索（只读；租户边界 §15）。 */
  async listDecisions(
    orgId: string | null | undefined,
    query: DecisionHistoryQuery = {},
  ): Promise<DecisionHistoryResult> {
    const tenantId = orgId?.trim();
    if (!tenantId) {
      throw new BadRequestException('org 上下文缺失：决策历史检索必须带租户上下文（§15）');
    }
    // 过滤器 fail-closed（ADR-065 决策 3）。
    if (query.kind != null && query.kind !== '' && !KIND_SET.has(query.kind)) {
      throw new BadRequestException(`unknown_decision_kind:${query.kind}`);
    }
    if (query.status != null && query.status !== '' && !STATUS_SET.has(query.status)) {
      throw new BadRequestException(`unknown_decision_status:${query.status}`);
    }
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(query.limit) ? Math.floor(query.limit ?? DEFAULT_LIMIT) : DEFAULT_LIMIT),
    );
    const offset = Math.max(
      0,
      Number.isFinite(query.offset) ? Math.floor(query.offset ?? 0) : 0,
    );

    const records: DecisionRecord[] = [];
    let skippedInvalid = 0;
    const sources = { plans: 0, agentApprovals: 0, learningProposals: 0, policies: 0 };

    const accept = (record: unknown): void => {
      const errors = validateDecision(record);
      if (errors.length > 0) {
        skippedInvalid += 1;
        return;
      }
      const decision = record as DecisionRecord;
      // 记录级租户过滤（所有来源统一面，§15 纵深）。
      if (decision.tenantId !== tenantId) return;
      if (query.kind && decision.kind !== query.kind) return;
      if (query.status && decision.status !== query.status) return;
      records.push(decision);
    };

    // 1) 方案决策（数组元素；SQL 层 org 条件（org 匹配或 NULL 存量——
    //    ADR-072 修正过时注释：org_id 自 standalone_025 已存在）+ 记录级
    //    tenantId 过滤第二层，§15 纵深）。
    const planConditions = [isNotNull(ewohSchedulePlan.decisionRecordsJson)];
    if (tenantId) {
      planConditions.push(
        or(isNull(ewohSchedulePlan.orgId), eq(ewohSchedulePlan.orgId, tenantId)),
      );
    }
    const plans = await this.db
      .select({ decisionRecordsJson: ewohSchedulePlan.decisionRecordsJson })
      .from(ewohSchedulePlan)
      .where(and(...planConditions));
    for (const plan of plans) {
      const list = plan.decisionRecordsJson as unknown;
      if (!Array.isArray(list)) continue;
      for (const record of list) {
        sources.plans += 1;
        accept(record);
      }
    }

    // 2) Agent 审批决策（kind 3）。
    const approvals = await this.db
      .select({ decisionJson: ewohAgentApproval.decisionJson })
      .from(ewohAgentApproval)
      .where(
        eq(ewohAgentApproval.orgId, tenantId),
      );
    for (const row of approvals) {
      if (row.decisionJson == null) continue;
      sources.agentApprovals += 1;
      accept(row.decisionJson);
    }

    // 3) 学习提案激活决策（kind 7）。
    const proposals = await this.db
      .select({ decisionJson: ewohLearningProposal.decisionJson })
      .from(ewohLearningProposal)
      .where(eq(ewohLearningProposal.orgId, tenantId));
    for (const row of proposals) {
      if (row.decisionJson == null) continue;
      sources.learningProposals += 1;
      accept(row.decisionJson);
    }

    // 4) 策略激活决策（kind 8；全局策略 null 行不进入租户查询，显式边界）。
    const policies = await this.db
      .select({ decisionJson: ewohSchedulingPolicy.decisionJson })
      .from(ewohSchedulingPolicy)
      .where(eq(ewohSchedulingPolicy.orgId, tenantId));
    for (const row of policies) {
      if (row.decisionJson == null) continue;
      sources.policies += 1;
      accept(row.decisionJson);
    }

    // decidedAt 降序 + decisionId 字典序稳定排序。
    records.sort((a, b) => {
      const atA = new Date(a.decidedAt).getTime();
      const atB = new Date(b.decidedAt).getTime();
      if (atA !== atB) return atB - atA;
      return a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0;
    });

    const total = records.length;
    const items = records.slice(offset, offset + limit);
    return { items, total, skippedInvalid, sources };
  }
}
