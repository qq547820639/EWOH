import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  validateReasoningTrace,
  evaluateReasoningRules,
  REASONING_ENGINE_VERSION,
  REASONING_RULE_IDS,
  TRACE_FACT_KINDS,
  type ReasoningFact,
} from '@shared/reasoning-trace';
import { isCanonicalIdentity } from '@shared/identity';
import { InferenceResultService } from '../inference/inference.service';
import { LearningProposalService } from '../learning/learning-proposal.service';

export interface EvaluateReasoningInput {
  traceId?: string | null;
  snapshotVersion: number;
  facts: Array<{
    subjectId: string;
    kind: string;
    values: Record<string, number | boolean>;
    evidenceIds: string[];
  }>;
  eventIds?: string[];
  window?: { from?: string; to?: string } | null;
}

export interface ReasoningRuleDefinition {
  ruleId: string;
  name: string;
  factKind: string;
  severity: string;
  trigger: string;
}

const RULE_DEFINITIONS: ReasoningRuleDefinition[] = [
  { ruleId: 'rule:worker-overload', name: '人员过载', factKind: 'person', severity: 'high', trigger: 'workload ≥ 0.8 且 (fatigue ≥ 0.7 或 ergonomicRisk ≥ 0.7)' },
  { ruleId: 'rule:exo-low-battery', name: '外骨骼低电量', factKind: 'exo', severity: 'high', trigger: 'batteryPct < 20' },
  { ruleId: 'rule:machine-vibration-risk', name: '设备振动风险', factKind: 'machine', severity: 'critical', trigger: 'vibrationExceeded = true' },
  { ruleId: 'rule:material-shortage', name: '物料短缺', factKind: 'material', severity: 'high', trigger: 'inventory < minThreshold' },
  { ruleId: 'rule:station-quality-blocked', name: '工位质量封锁', factKind: 'station', severity: 'critical', trigger: 'qualityBlocked = true' },
  { ruleId: 'rule:andon-escalation', name: '安灯升级', factKind: 'alert', severity: 'high', trigger: 'andonRaised = true 且 unacknowledgedMinutes > 15' },
];

/**
 * 工业推理引擎（ADR-020 / NO-08b，Level 4 独立工业推理层）。
 *
 * - 确定性规则评估（shared/reasoning-trace.ts evaluateReasoningRules，
 *   §18：explanation 来自事实模板渲染——LLM 只允许翻译不允许编造）；
 * - 输入 fail-closed：未知 fact kind / 非规范身份 / 空证据链 → 拒绝整次评估；
 * - trace 契约自检（validateReasoningTrace）违规绝不返回（§33）；
 * - 每条结论以 L4 InferenceResult 落账（ADR-019 台账复用，modelId=
 *   reasoning:{ruleId}、inputVersion=snapshot-v{n}——结论行 + 规则版本 +
 *   快照版本 = 可重建审计链）；评估响应返回每结论 inferenceId（可追溯）；
 * - 落账失败 logger 留痕不阻断评估响应（结论主契约不被审计旁路阻断，
 *   与 ADR-019 决策 6 同语义）。
 */
@Injectable()
export class ReasoningService {
  private readonly logger = new Logger(ReasoningService.name);

  constructor(
    private readonly inferenceService: InferenceResultService,
    private readonly learningProposalService: LearningProposalService,
  ) {}

  async evaluate(input: EvaluateReasoningInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：推理评估必须带租户上下文');
    }
    if (!Number.isInteger(input.snapshotVersion) || input.snapshotVersion < 0) {
      throw new BadRequestException('snapshotVersion 必须为非负整数');
    }
    if (!Array.isArray(input.facts)) {
      throw new BadRequestException('facts 必须为数组');
    }
    const facts: ReasoningFact[] = input.facts.map((f) => this.validateFact(f));
    const eventIds = input.eventIds ?? [];
    if (eventIds.some((e) => typeof e !== 'string' || !isCanonicalIdentity(e))) {
      throw new BadRequestException('eventIds 必须是规范身份数组');
    }
    const traceId = input.traceId && input.traceId !== ''
      ? input.traceId
      : `rt-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 10)}`;
    // ADR-026 反馈腿激活面：本租户 approved 提案的阈值覆盖（人审激活，
    // 绝不隐式自动执行；无 approved 提案 = 引擎内置常量）。
    const thresholds = await this.learningProposalService.getActiveThresholds(orgId);
    const conclusions = evaluateReasoningRules(traceId, facts, thresholds);
    const trace: Record<string, unknown> = {
      traceId,
      engineVersion: REASONING_ENGINE_VERSION,
      factsRef: { snapshotVersion: input.snapshotVersion, eventIds },
      conclusions,
      auditTrail: true,
    };
    const errors = validateReasoningTrace(trace);
    if (errors.length > 0) {
      // 引擎输出违反自身契约——绝不返回（fail-closed，防内部缺陷外泄为事实）
      throw new BadRequestException(`推理轨迹违反契约: ${errors.join(', ')}`);
    }
    const inferenceIds: Array<{ conclusionId: string; inferenceId: string }> = [];
    const window = input.window ?? {};
    const tsStart = window.from ?? new Date().toISOString();
    const tsEnd = window.to ?? new Date().toISOString();
    for (const conclusion of conclusions) {
      try {
        const result = await this.inferenceService.recordInferenceResult(
          {
            subjectId: conclusion.subjectId,
            level: 'L4_industrial_reasoning',
            modelId: `reasoning:${conclusion.ruleId}`,
            modelVersion: REASONING_ENGINE_VERSION,
            inputVersion: `snapshot-v${input.snapshotVersion}`,
            label: conclusion.explanation,
            confidence: conclusion.confidence,
            oodIndicator: { flag: false, reasons: [] },
            dataQuality: 'good',
            evidence: { tsStart, tsEnd, isRule: true },
          },
          orgId,
        );
        inferenceIds.push({
          conclusionId: conclusion.conclusionId,
          inferenceId: String((result.record as Record<string, unknown>).inferenceId),
        });
      } catch (error) {
        this.logger.error(`推理结论落账失败 ${conclusion.ruleId}: ${String(error)}`);
      }
    }
    return { trace, inferenceIds };
  }

  listRules(): ReasoningRuleDefinition[] {
    return RULE_DEFINITIONS;
  }

  /** 输入事实校验（fail-closed：拒绝而非猜测）。 */
  private validateFact(f: EvaluateReasoningInput['facts'][number]): ReasoningFact {
    if (typeof f !== 'object' || f === null) {
      throw new BadRequestException('fact 必须为对象');
    }
    if (typeof f.subjectId !== 'string' || !isCanonicalIdentity(f.subjectId)) {
      throw new BadRequestException('fact.subjectId 必须是规范身份');
    }
    if (!(TRACE_FACT_KINDS as readonly string[]).includes(f.kind)) {
      throw new BadRequestException(`unknown_fact_kind:${f.kind}`);
    }
    if (typeof f.values !== 'object' || f.values === null || Array.isArray(f.values)) {
      throw new BadRequestException('fact.values 必须为对象');
    }
    if (!Array.isArray(f.evidenceIds) || f.evidenceIds.length === 0
      || f.evidenceIds.some((e) => typeof e !== 'string' || !isCanonicalIdentity(e))) {
      throw new BadRequestException('fact.evidenceIds 必须为非空规范身份数组（§3 证据链）');
    }
    return {
      subjectId: f.subjectId,
      kind: f.kind,
      values: f.values,
      evidenceIds: f.evidenceIds,
    };
  }
}
