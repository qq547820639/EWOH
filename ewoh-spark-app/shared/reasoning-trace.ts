/* 前后端共享契约 - Canonical Industrial Reasoning Trace（ADR-020 / NO-08b，Level 4）。
 *
 * 权威契约：contracts/reasoning/reasoning-trace.schema.json +
 * reasoning-trace.test-vectors.json。
 * 语义与 src/edge_platform/contracts/reasoning_trace.py 逐项一致（共享向量约束）。
 * evaluateReasoningRules 为 TS 生产引擎的纯评估函数（确定性规则，§18：
 * explanation 来自事实模板渲染；LLM 只允许翻译不允许编造）。
 */

import { isCanonicalIdentity } from './identity';
import type { PerceptionAdviceGate } from './perception-fusion';

export const REASONING_RULE_IDS = [
  'rule:worker-overload', 'rule:exo-low-battery', 'rule:machine-vibration-risk',
  'rule:material-shortage', 'rule:station-quality-blocked', 'rule:andon-escalation',
] as const;

export const TRACE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const TRACE_CONFIDENCE_BASES = ['deterministic', 'statistical'] as const;
export const TRACE_FACT_KINDS = ['person', 'exo', 'machine', 'material', 'station', 'alert'] as const;

export const REASONING_ENGINE_VERSION = '1.0.0';

/**
 * rule:worker-overload 的引擎内置负荷阈值（无 ADR-026 人审激活覆盖时生效值）。
 * 单一事实来源：matchesRule 与 LearningProposalService 阈值基线读面共用，
 * 避免「基线展示值」与「引擎实际判定值」两处字面量漂移。
 * 跨运行地对齐：src/edge_platform/contracts/reasoning_trace.py 同值 0.8。
 */
export const DEFAULT_WORKLOAD_THRESHOLD = 0.8;

const RULE_SET: ReadonlySet<string> = new Set(REASONING_RULE_IDS);
const SEVERITY_SET: ReadonlySet<string> = new Set(TRACE_SEVERITIES);
const BASIS_SET: ReadonlySet<string> = new Set(TRACE_CONFIDENCE_BASES);

const REQUIRED_FIELDS = ['traceId', 'engineVersion', 'factsRef', 'conclusions', 'auditTrail'] as const;
const CONCLUSION_FIELDS = [
  'conclusionId', 'ruleId', 'subjectId', 'severity', 'confidence',
  'confidenceBasis', 'premises', 'evidenceIds', 'explanation',
] as const;

function isCanonicalIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string' && isCanonicalIdentity(x));
}

/** EDGE-227 同款清洗（R2-SHR-001）：把原始字符串清洗为 conclusionId value 合法字符集。
 *
 * conclusionId 须满足规范身份 value 语法（无空白、无 ':'/'/'/'%'），原始
 * traceId/subjectId 不保证满足——剔除非 [A-Za-z0-9_.-]、截断 100、空兜底
 * 'unknown'，与 Python reasoning_trace._safe_conclusion_value 逐字节一致。 */
function safeConclusionValue(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);
  return cleaned === '' ? 'unknown' : cleaned;
}

/** 校验推理轨迹；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateReasoningTrace(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.traceId !== 'string' || r.traceId === '') return ['bad_trace_id'];
  if (typeof r.engineVersion !== 'string' || r.engineVersion === '') return ['bad_engine_version'];
  const factsRef = r.factsRef;
  if (typeof factsRef !== 'object' || factsRef === null || Array.isArray(factsRef)) {
    return ['bad_facts_ref'];
  }
  const fr = factsRef as Record<string, unknown>;
  const snapshot = fr.snapshotVersion;
  if (typeof snapshot !== 'number' || !Number.isInteger(snapshot) || snapshot < 0) {
    return ['bad_facts_ref'];
  }
  if (!isCanonicalIdList(fr.eventIds)) return ['bad_facts_ref'];
  const conclusions = r.conclusions;
  if (!Array.isArray(conclusions)) return ['bad_conclusions'];
  const seenConclusionIds = new Set<string>();
  for (const conclusion of conclusions) {
    if (typeof conclusion !== 'object' || conclusion === null || Array.isArray(conclusion)) {
      return ['bad_conclusions'];
    }
    const c = conclusion as Record<string, unknown>;
    for (const field of CONCLUSION_FIELDS) {
      if (!(field in c)) return [`missing_field:${field}`];
    }
    if (typeof c.conclusionId !== 'string' || !isCanonicalIdentity(c.conclusionId)) {
      return ['bad_conclusion_id'];
    }
    if (!RULE_SET.has(String(c.ruleId))) return ['unknown_rule'];
    if (typeof c.subjectId !== 'string' || !isCanonicalIdentity(c.subjectId)) return ['bad_subject'];
    if (!SEVERITY_SET.has(String(c.severity))) return ['unknown_severity'];
    const confidence = c.confidence;
    if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      return ['bad_confidence'];
    }
    const basis = String(c.confidenceBasis);
    if (!BASIS_SET.has(basis)) return ['bad_confidence_basis'];
    if (basis === 'deterministic' && confidence !== 1) return ['bad_confidence'];
    const premises = c.premises;
    if (!Array.isArray(premises) || premises.length === 0) return ['empty_premises'];
    if (!isCanonicalIdList(premises)) return ['bad_premise'];
    const evidence = c.evidenceIds;
    if (!Array.isArray(evidence) || evidence.length === 0) return ['empty_evidence'];
    if (!isCanonicalIdList(evidence)) return ['bad_evidence_ref'];
    if (typeof c.explanation !== 'string' || c.explanation.trim() === '') return ['bad_explanation'];
    // NO-58b：门控一致性——门控说不许强建议，结论就必须标 advisoryOnly；
    // 反之标了 advisoryOnly 必须给原因（否则页面读不出"为什么只是提示"）。
    const gate = c.perceptionGate as PerceptionAdviceGate | null | undefined;
    if (gate && gate.strongAdviceAllowed === false && c.advisoryOnly !== true) {
      return ['advisory_flag_inconsistent_with_gate'];
    }
    if (c.advisoryOnly === true && (typeof c.advisoryReason !== 'string' || c.advisoryReason.trim() === '')) {
      return ['advisory_requires_reason'];
    }
    // R2-SHR-011：conclusionId 在 conclusions 内必须唯一（多主体命中同规则
    // 时由 subjectId 段区分；重复 ID 会导致台账互相覆盖）。
    if (seenConclusionIds.has(c.conclusionId)) return ['duplicate_conclusion_id'];
    seenConclusionIds.add(c.conclusionId);
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}

// ============================================================================
// 确定性规则评估器（TS 生产引擎；语义与 Python reasoning_trace.evaluate_rules
// 逐条一致——规则按注册表顺序评估，结论确定性排序）。
// ============================================================================

export interface ReasoningFact {
  subjectId: string;
  kind: string;
  values: Record<string, number | boolean>;
  evidenceIds: string[];
  /** 该主体的感知建议门控（由 ReasoningService 从最新融合快照注入）。 */
  perceptionGate?: PerceptionAdviceGate | null;
}

/** 规则阈值覆盖（ADR-026 人审激活的激活面；缺省 = 引擎内置常量）。 */
export interface ReasoningThresholdOverrides {
  workload?: number;
  fatigue?: number;
  ergonomicRisk?: number;
}

export interface ReasoningConclusion {
  conclusionId: string;
  ruleId: string;
  subjectId: string;
  severity: string;
  confidence: number;
  confidenceBasis: string;
  premises: string[];
  evidenceIds: string[];
  explanation: string;
  /**
   * 感知门控（NO-58b）：该主体的感知融合`strongAdviceAllowed=false` 时，
   * 结论仍然产出（事实是真的），但**只能作为提示，不得据此生成强建议**
   * （§5 规则 5 / 原则 5）。缺省 = 没有融合快照（未评估，不等于"可以强建议"）。
   */
  advisoryOnly?: boolean;
  advisoryReason?: string | null;
  perceptionGate?: PerceptionAdviceGate | null;
}

const RULE_TEMPLATES: Record<string, string> = {
  'rule:worker-overload':
    '人员 {subject} 负荷 {workload}，疲劳 {fatigue}，工效风险 {ergonomic}——建议轮换或减负（人工复核）',
  'rule:exo-low-battery':
    '外骨骼 {subject} 电量 {battery}%——建议换电或下线充电',
  'rule:machine-vibration-risk':
    '设备 {subject} 振动阈值超限——建议停机检查（人工复核，勿自动处置）',
  'rule:material-shortage':
    '物料 {subject} 库存 {inventory} 低于安全阈值 {threshold}——建议补料',
  'rule:station-quality-blocked':
    '工位 {subject} 存在活跃质量封锁——禁止派工（人审解除）',
  'rule:andon-escalation':
    '安灯 {subject} 未确认 {minutes} 分钟——升级值班长',
};

const RULE_SEVERITY: Record<string, string> = {
  'rule:worker-overload': 'high',
  'rule:exo-low-battery': 'high',
  'rule:machine-vibration-risk': 'critical',
  'rule:material-shortage': 'high',
  'rule:station-quality-blocked': 'critical',
  'rule:andon-escalation': 'high',
};

function num(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

function fmt(value: unknown): string {
  const n = num(value);
  return n === null ? '?' : String(n);
}

function ge(value: unknown, bound: number): boolean {
  const n = num(value);
  return n !== null && n >= bound;
}

function gt(value: unknown, bound: number): boolean {
  const n = num(value);
  return n !== null && n > bound;
}

function lt(value: unknown, bound: number): boolean {
  const n = num(value);
  return n !== null && n < bound;
}

function matchesRule(ruleId: string, fact: ReasoningFact, thresholds?: ReasoningThresholdOverrides): boolean {
  const v = fact.values;
  switch (ruleId) {
    case 'rule:worker-overload':
      return fact.kind === 'person'
        && ge(v.workload, thresholds?.workload ?? DEFAULT_WORKLOAD_THRESHOLD)
        && (ge(v.fatigue, thresholds?.fatigue ?? 0.7) || ge(v.ergonomicRisk, thresholds?.ergonomicRisk ?? 0.7));
    case 'rule:exo-low-battery':
      return fact.kind === 'exo' && lt(v.batteryPct, 20);
    case 'rule:machine-vibration-risk':
      return fact.kind === 'machine' && v.vibrationExceeded === true;
    case 'rule:material-shortage':
      return fact.kind === 'material'
        && num(v.inventory) !== null && num(v.minThreshold) !== null
        && (num(v.inventory) as number) < (num(v.minThreshold) as number);
    case 'rule:station-quality-blocked':
      return fact.kind === 'station' && v.qualityBlocked === true;
    case 'rule:andon-escalation':
      return fact.kind === 'alert' && v.andonRaised === true && gt(v.unacknowledgedMinutes, 15);
    default:
      return false;
  }
}

/** 确定性规则评估（返回 conclusions；输入事实形状与 Python 评估器一致）。
 * thresholds 为 ADR-026 人审激活的阈值覆盖（缺省 = 引擎内置常量）。 */
export function evaluateReasoningRules(
  traceId: string,
  facts: ReasoningFact[],
  thresholds?: ReasoningThresholdOverrides,
): ReasoningConclusion[] {
  const conclusions: ReasoningConclusion[] = [];
  // SH-006：按 subjectId 去重（后到覆盖先到），与 Python evaluate_rules 的
  // by_kind = {f["subjectId"]: f for f in facts} 语义一致，避免重复 conclusionId。
  const bySubject = new Map(facts.map((f) => [f.subjectId, f] as const));
  for (const ruleId of REASONING_RULE_IDS) {
    for (const fact of bySubject.values()) {
      if (!matchesRule(ruleId, fact, thresholds)) continue;
      const v = fact.values;
      const explanation = RULE_TEMPLATES[ruleId]
        .replace('{subject}', fact.subjectId)
        .replace('{workload}', fmt(v.workload))
        .replace('{fatigue}', fmt(v.fatigue))
        .replace('{ergonomic}', fmt(v.ergonomicRisk))
        .replace('{battery}', fmt(v.batteryPct))
        .replace('{inventory}', fmt(v.inventory))
        .replace('{threshold}', fmt(v.minThreshold))
        .replace('{minutes}', fmt(v.unacknowledgedMinutes));
      const gate = fact.perceptionGate ?? null;
      const advisoryOnly = gate !== null && gate.strongAdviceAllowed === false;
      conclusions.push({
        // R2-SHR-001/011：traceId/subjectId 先经 safeConclusionValue 清洗，
        // 且 subjectId 参与 ID 拼接——同规则多主体命中时 conclusionId 不再碰撞。
        conclusionId: `decision:${safeConclusionValue(traceId)}-${ruleId.split(':')[1]}-${safeConclusionValue(fact.subjectId)}`,
        ruleId,
        subjectId: fact.subjectId,
        severity: RULE_SEVERITY[ruleId],
        confidence: 1,
        confidenceBasis: 'deterministic',
        premises: [fact.subjectId],
        evidenceIds: fact.evidenceIds,
        explanation: advisoryOnly
          ? `${explanation}（**仅提示**：${gate?.reason ?? '感知门控不允许强建议'}）`
          : explanation,
        // 门控字段**只在有门控时出现**：
        //   · 无门控 = "平台没评估过"，不是"评估为可强建议"——用缺省而不是 `false` 表达，
        //     调用方才能区分"未评估"与"已评估且允许"（原则 7：缺失不得伪造成确定事实）；
        //   · 同时保持与边缘运行时（`edge_platform/contracts/reasoning_trace.py`）以及
        //     跨语言金标场景（`tests/golden-fixtures/contract-golden-scenarios.json`）
        //     的结论形状逐字段一致——同一份 fixture 两侧都要过。
        ...(gate
          ? {
              advisoryOnly,
              advisoryReason: advisoryOnly ? gate.reason ?? '感知门控不允许强建议' : null,
              perceptionGate: gate,
            }
          : {}),
      });
    }
  }
  return conclusions;
}
