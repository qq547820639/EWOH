/**
 * ReasoningConsole 纯逻辑（NO-25a）。
 *
 * 处理的是"平台从观测与世界模型推导出的实时风险"这一类数据：
 *   · 结论（哪条规则、作用对象、严重度、解释、证据数）；
 *   · 依据（数值 / 阈值 / 单位 / 观测时间 / 数据质量 / 来源）；
 *   · 未被采用的数据（skipped：过期、低置信、未声明能力……）。
 *
 * 纯函数放在这里，是为了让"哪些结论该显示、哪些数据为什么没被采用"这类
 * 判断可以被 node 测试直接钉死（原则 5/7）。
 */

export interface LiveEvidenceInput {
  evidenceId: string;
  subjectId: string;
  capability: string;
  field: string;
  value: number;
  threshold: number;
  unit: string;
  observedAt: string;
  ageMs: number;
  dataQuality: 'FRESH' | 'STALE' | 'UNKNOWN';
  dataConfidence: number | null;
  sourceType: string | null;
}

export interface LiveSkippedInput {
  sensorId: string;
  subjectId: string | null;
  field: string;
  reason: string;
  detail: string;
}

export interface LiveConclusionInput {
  conclusionId?: string;
  ruleId: string;
  subjectId: string;
  severity: string;
  explanation?: string;
  evidenceIds?: string[];
  /**
   * 感知门控（NO-58b）：结论是否只能当"提示"。**字段缺省 = 平台未评估**（不是"可以强建议"），
   * 因此页面必须区分"未评估"与"已评估且允许"（原则 7），不许把缺省显示成"可信"。
   */
  advisoryOnly?: boolean;
  advisoryReason?: string | null;
}

const RULE_LABELS: Record<string, string> = {
  'rule:worker-overload': '人员过载',
  'rule:exo-low-battery': '外骨骼低电量',
  'rule:machine-vibration-risk': '设备振动风险',
  'rule:material-shortage': '物料短缺',
  'rule:station-quality-blocked': '工位质量封锁',
  'rule:andon-escalation': '安灯升级',
};

export function ruleLabel(ruleId: string): string {
  // 未注册规则原样透出（§33：不把未知说成已知）
  return RULE_LABELS[ruleId] ?? ruleId;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** 结论按严重度排序（critical 在前），同级按规则名稳定排序（可复现）。 */
export function sortConclusions(
  conclusions: readonly LiveConclusionInput[],
): LiveConclusionInput[] {
  return [...conclusions].sort((a, b) => {
    const sa = SEVERITY_ORDER[String(a.severity ?? '').toLowerCase()] ?? 9;
    const sb = SEVERITY_ORDER[String(b.severity ?? '').toLowerCase()] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(a.ruleId).localeCompare(String(b.ruleId));
  });
}

export interface RiskRow {
  key: string;
  ruleId: string;
  ruleLabel: string;
  subjectId: string;
  severity: string;
  explanation: string;
  /** 证据条数与可读摘要（数值/阈值/来源/时间）。 */
  evidenceCount: number;
  evidenceSummary: string;
  /** 该结论是否有可追溯台账 id。 */
  inferenceId: string | null;
  /** 感知门控文案：`null` = 未评估（不显示"可信"）；有门控且禁止强建议时必须显式说明原因。 */
  advisoryLabel: string | null;
  advisoryOnly: boolean;
}

export function buildRiskRows(
  conclusions: readonly LiveConclusionInput[],
  evidence: readonly LiveEvidenceInput[],
  inferenceIds: Array<{ conclusionId: string; inferenceId: string }> = [],
): RiskRow[] {
  const bySubject = new Map<string, LiveEvidenceInput[]>();
  for (const item of evidence) {
    const list = bySubject.get(item.subjectId);
    if (list) list.push(item);
    else bySubject.set(item.subjectId, [item]);
  }
  const inferenceByConclusion = new Map(
    inferenceIds.map((entry) => [entry.conclusionId, entry.inferenceId] as const),
  );
  return sortConclusions(conclusions).map((conclusion) => {
    const subjectEvidence = bySubject.get(conclusion.subjectId) ?? [];
    return {
      key: conclusion.conclusionId ?? `${conclusion.ruleId}:${conclusion.subjectId}`,
      ruleId: conclusion.ruleId,
      ruleLabel: ruleLabel(conclusion.ruleId),
      subjectId: conclusion.subjectId,
      severity: String(conclusion.severity ?? 'unknown'),
      explanation: conclusion.explanation ?? '（引擎未给出解释文本）',
      evidenceCount: subjectEvidence.length,
      evidenceSummary: subjectEvidence
        .map(
          (item) =>
            `${item.field}=${item.value}${item.unit}（阈值 ${item.threshold}${item.unit}，` +
            `${item.dataQuality}，${item.sourceType ?? '来源未记录'}）`,
        )
        .join('；'),
      inferenceId:
        (conclusion.conclusionId ? inferenceByConclusion.get(conclusion.conclusionId) : null) ?? null,
      advisoryOnly: conclusion.advisoryOnly === true,
      advisoryLabel: conclusion.advisoryOnly === true
        ? `仅提示（感知门控：${String(conclusion.advisoryReason ?? '').trim() || '门控不允许强建议'}）`
        : null,
    };
  });
}

export interface SkippedRow {
  key: string;
  subject: string;
  field: string;
  reasonLabel: string;
  detail: string;
}

const SKIP_REASON_LABELS: Record<string, string> = {
  stale_reading: '读数已过期',
  low_confidence: '数据置信度不足',
  unknown_subject: '世界模型中没有该对象',
  capability_not_declared: '未声明对应观测能力',
  no_value: '该帧没有此读数',
  // NO-27a：物料/降级原因（不给人话就等于把缺口藏起来）
  no_threshold: '未声明再订货点（不判定短缺）',
  mixed_units: '计量单位不一致（无法合并数量）',
  unparsable_material_movement: '历史物料载荷不可解析',
  material_projection_failed: '物料库存投影失败（本次不含物料判定）',
  material_source_unavailable: '物料服务未装配（本次不含物料判定）',
};

/** 未被采用的数据行（**必须**可见：现场要知道数据为什么没进入判定）。 */
export function buildSkippedRows(skipped: readonly LiveSkippedInput[]): SkippedRow[] {
  return skipped.map((item, index) => ({
    key: `${item.sensorId}:${item.field}:${item.reason}:${index}`,
    subject: item.subjectId ?? item.sensorId,
    field: item.field,
    reasonLabel: SKIP_REASON_LABELS[item.reason] ?? item.reason,
    detail: item.detail,
  }));
}

/** 顶部汇总：严重度计数 + 依据/未采用 条数（一眼看清"现在有什么风险"）。 */
export function riskSummary(
  rows: readonly RiskRow[],
  evidenceCount: number,
  skippedCount: number,
): {
  total: number;
  critical: number;
  high: number;
  evidenceCount: number;
  skippedCount: number;
  label: string;
} {
  const critical = rows.filter((r) => r.severity === 'critical').length;
  const high = rows.filter((r) => r.severity === 'high').length;
  const label =
    rows.length === 0
      ? `当前没有规则命中（依据 ${evidenceCount} 条、未采用数据 ${skippedCount} 条）`
      : `实时风险 ${rows.length} 条（critical ${critical} / high ${high}）｜依据 ${evidenceCount} 条、未采用数据 ${skippedCount} 条`;
  return { total: rows.length, critical, high, evidenceCount, skippedCount, label };
}
