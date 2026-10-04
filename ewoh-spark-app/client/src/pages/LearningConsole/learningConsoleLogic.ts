/* 学习控制台派生逻辑（纯函数，可单测）。
 *
 * 三条硬约束：
 *  1. **人审阶梯不可绕过**：approve/reject/rollback 只有 workshop_lead /
 *     global_admin 能触发；UI 必须据此禁用按钮并说明原因，而不是让用户点了
 *     才被服务端 403。UI 判定只是体验优化，**服务端仍是权威**。
 *  2. **缺失不得伪装**：`modelAccuracy=null`（缺 outcome 标注）必须显示"未标注"，
 *     绝不显示 0 或 100%；可训练样本为 0 时必须说明"为什么不能训练"，
 *     而不是给出一个看似正常的空图表。
 *  3. **模拟/人工回执永不参与生产训练**：资格摘要中的 rejected 计数必须在
 *     UI 上可见且分原因说明。
 */

import type {
  LearningProposalRecord,
  LearningProposalStatus,
  OutcomeAnnotationRecord,
  OutcomeKind,
  OutcomeTargetType,
  ThresholdBaseline,
  ThresholdBaselineEntry,
  ThresholdChange,
  TrainingSampleSummary,
} from '../../api/learning';
// 归属 id 的展示归一与复发度量口径同源（`person:<uuid>` → `<uuid>`；执行事实表键见 shared）。
import { executionSubjectKey } from '@shared/improvement-action';
import { DISPLAY_TIME_OPTS } from '../../lib/intl';

/** 可触发人审激活阶梯的角色（与服务端 @Roles 一致）。 */
export const APPROVAL_ROLES = ['workshop_lead', 'global_admin'] as const;

/** 提案状态的中文标签（状态必须明确区分，不得混同）。 */
export const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  proposed: '待影子评估',
  shadow_evaluated: '已影子评估，待人审',
  approved: '已批准生效',
  rejected: '已拒绝',
  rolled_back: '已回滚',
};

export interface ProposalActionView {
  proposalId: string;
  status: string;
  statusLabel: string;
  /** 当前状态允许的下一步动作（按服务端状态机）。 */
  actions: Array<'shadow' | 'approve' | 'reject' | 'rollback'>;
  /** 需要人审权限的动作是否因角色不足被禁用。 */
  requiresApprovalRole: boolean;
  /** 提议人（可能缺失 = 存量行未回填）。 */
  proposedBy?: string;
  /**
   * 本提案是否由当前用户提出。B5 同族审批独立性：**仅批准**被回避
   * （拒绝自己的提案 = 撤回，服务端允许，UI 不得凭空收紧）。
   */
  isOwnProposal: boolean;
  /** 人类可读的变更描述。 */
  changeSummary: string;
  /** 影子评估摘要（无评估时明确说明"尚无影子证据"）。 */
  shadowSummary: string;
  /** 影子评估是否给出"接受"结论；null = 无证据。 */
  shadowAccepted: boolean | null;
  auditTrail: {
    approvedBy?: string;
    approvedAt?: string;
    rejectedBy?: string;
    rejectedReason?: string;
    rolledBackBy?: string;
    rolledBackReason?: string;
  };
}

/** 按服务端状态机推导可用动作。未知状态 → 无动作（fail-closed，不猜）。 */
export function allowedActions(status: string): Array<'shadow' | 'approve' | 'reject' | 'rollback'> {
  switch (status) {
    case 'proposed': return ['shadow'];
    case 'shadow_evaluated': return ['approve', 'reject'];
    case 'approved': return ['rollback'];
    default: return [];
  }
}

export function isApprovalRole(roles: string[] | null | undefined): boolean {
  if (!roles?.length) return false;
  return APPROVAL_ROLES.some((role) => roles.includes(role));
}

function formatChange(change: ThresholdChange | undefined): string {
  if (!change) return '变更内容缺失';
  return `${change.ruleId} · ${change.parameter}：${change.baselineValue} → ${change.candidateValue}`;
}

function formatShadow(shadow: LearningProposalRecord['shadowEval']): {
  text: string;
  accepted: boolean | null;
} {
  if (!shadow) return { text: '尚无影子评估证据（未评估）', accepted: null };
  if (typeof shadow.accepted !== 'boolean') {
    return { text: `影子评估已完成但未给出接受结论${shadow.reason ? `：${shadow.reason}` : ''}`, accepted: null };
  }
  const verdict = shadow.accepted ? '影子评估接受' : '影子评估不接受';
  return {
    text: `${verdict}${shadow.reason ? `：${shadow.reason}` : ''}`,
    accepted: shadow.accepted,
  };
}

/** 构造单条提案的视图模型。currentUserId 用于渲染 B5 生成人回避提示。 */
export function buildProposalView(
  proposal: LearningProposalRecord,
  roles: string[] | null | undefined,
  currentUserId?: string | null,
): ProposalActionView {
  const shadow = formatShadow(proposal.shadowEval);
  const proposedBy = typeof proposal.proposedBy === 'string' ? proposal.proposedBy : undefined;
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    statusLabel: PROPOSAL_STATUS_LABELS[proposal.status] ?? `未知状态（${proposal.status}）`,
    actions: allowedActions(proposal.status),
    requiresApprovalRole: ['approve', 'reject', 'rollback'].some((a) =>
      allowedActions(proposal.status).includes(a as 'approve' | 'reject' | 'rollback')),
    proposedBy,
    isOwnProposal: Boolean(proposedBy && currentUserId && proposedBy === currentUserId),
    changeSummary: formatChange(proposal.change),
    shadowSummary: shadow.text,
    shadowAccepted: shadow.accepted,
    auditTrail: {
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.approvedAt,
      rejectedBy: proposal.rejectedBy,
      rejectedReason: proposal.rejectedReason,
      rolledBackBy: proposal.rolledBackBy,
      rolledBackReason: proposal.rolledBackReason,
    },
  };
}

/**
 * 批准是否被 B5 生成人回避挡住（UI 预判，服务端仍权威）。
 * 只作用于 approve：拒绝自己的提案 = 撤回，服务端允许。
 */
export function isSelfApprovalBlocked(
  view: Pick<ProposalActionView, 'isOwnProposal'>,
  action: 'shadow' | 'approve' | 'reject' | 'rollback',
): boolean {
  return action === 'approve' && view.isOwnProposal;
}

export interface SampleEligibilityView {
  trainable: number;
  minRequired: number;
  /** 是否达到训练门槛。 */
  meetsThreshold: boolean;
  /** 行级标记通过但**不可**训练的数量（差额需解释）。 */
  downgradedByEvidence: number;
  /** 是否发生了"标记通过但证据不足"的降级——必须显式告知，否则用户会困惑。 */
  hasEvidenceDowngrade: boolean;
  /** 分原因的排除明细（含中文说明）。 */
  excluded: Array<{ reason: string; label: string; count: number }>;
  /** 供 UI 直接展示的结论句。 */
  verdict: string;
}

/**
 * 解释训练样本资格。
 *
 * 关键：区分"行级标记通过"（flaggedEligible）与"实际可训练"（trainable）。
 * 二者不等时说明存在**独立设备回执证据**缺口——这是最常见的困惑点：
 * 界面若只显示 flaggedEligible，用户会以为样本足够而重训却报不足。
 */
export function summarizeEligibility(summary: TrainingSampleSummary | null): SampleEligibilityView {
  if (!summary) {
    return {
      trainable: 0,
      minRequired: 0,
      meetsThreshold: false,
      downgradedByEvidence: 0,
      hasEvidenceDowngrade: false,
      excluded: [],
      verdict: '尚未取得训练样本资格数据（未加载）',
    };
  }
  const trainable = summary.trainable ?? 0;
  const flagged = summary.flaggedEligible ?? 0;
  const downgraded = Math.max(0, flagged - trainable);
  const excluded = Object.entries(summary.rejected ?? {})
    .map(([reason, count]) => ({
      reason,
      label: summary.rejectedLabels?.[reason] ?? reason,
      count: count ?? 0,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  const meetsThreshold = trainable >= (summary.minSamplesRequired ?? 0);
  let verdict: string;
  if (meetsThreshold) {
    verdict = `可训练样本 ${trainable} 条，已达到门槛（${summary.minSamplesRequired} 条）。`;
  } else if (trainable === 0 && flagged > 0) {
    verdict = `有 ${flagged} 条通过来源标记，但均缺独立设备回执证据，因此可训练样本为 0`
      + `（需 ≥${summary.minSamplesRequired} 条）。人工上报与模拟回执不计入。`;
  } else if (trainable === 0) {
    verdict = `暂无可训练样本（需 ≥${summary.minSamplesRequired} 条独立设备回执）。`;
  } else {
    verdict = `可训练样本 ${trainable} 条，未达门槛（需 ≥${summary.minSamplesRequired} 条）。`;
  }

  return {
    trainable,
    minRequired: summary.minSamplesRequired ?? 0,
    meetsThreshold,
    downgradedByEvidence: downgraded,
    hasEvidenceDowngrade: downgraded > 0,
    excluded,
    verdict,
  };
}

/**
 * 模型准确率展示。
 *
 * `null`/`undefined` 表示**缺 outcome 标注**，必须显示"未标注"——
 * 显示 0% 会被读成"模型完全不准"，显示 100% 则是伪造。
 */
export function formatModelAccuracy(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未标注（缺 outcome 标注，无法计算）';
  return `${(value * 100).toFixed(1)}%`;
}

/** 重训失败原因的中文说明（服务端返回 retrain_not_enough_data:<reason>）。 */
export function explainRetrainError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/retrain_not_enough_data/i.test(message)) {
    const detail = message.split(':').slice(1).join(':').trim();
    return `样本不足，未落版（不伪造模型）。${detail ? `服务端原因：${detail}` : ''}`
      + '——请核对上方"可训练样本"说明；只有独立设备回执可参与生产训练。';
  }
  return message;
}

/**
 * 提案动作失败原因的中文说明。
 *
 * 实测（2026-09-10 真实后端）确认了两类**正常业务状态**，它们不是用户错误，
 * 必须解释清楚而不是抛原始报文：
 *  - `shadow_facts_window_empty`：库内没有可重建的事实窗口。影子评估的证据
 *    只能由服务端从库内事实重建（R2-SBZ-004 fail-closed，不接受客户端供给），
 *    所以没有事实窗口时**无法**评估——提案会留在"待影子评估"。
 *  - `非法提案转移`：状态机强制先影子评估再人审；直接批准会被拒。
 */
export function explainProposalError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/SELF_APPROVAL_FORBIDDEN/i.test(message)) {
    return '本提案由你提出，按 B5 审批独立性不能由本人批准——请交由其他班组长/全局管理员审批。'
      + '（这与方案审批同一条治理规则；服务端在写入前即拒绝，策略未被改动。）';
  }
  if (/shadow_facts_window_empty/i.test(message)) {
    return '影子评估需要库内可重建的事实窗口，而当前没有足够的事实数据。'
      + '证据只能由服务端从库内事实重建，客户端不能提供——因此本次无法评估，'
      + '提案保持"待影子评估"。请在有真实遥测/执行事实后重试。';
  }
  if (/非法提案转移/.test(message)) {
    return `状态机不允许该操作：${message}。必须先完成影子评估，才能进入人审；`
      + '批准后只能回滚，不能重复批准。';
  }
  return message;
}

/* ------------------------------------------------------------------
 * 阈值基线读面（决策原则 5：来源 / 生效值 / 更新时间 / 影响面）。
 * ------------------------------------------------------------------ */

export interface ThresholdBaselineView {
  ruleId: string;
  parameter: string;
  /** 生效值展示（未知时显式"未知"，绝不显示占位数字）。 */
  effectiveLabel: string;
  /** 生效值来源说明：已批准提案（含编号/审批人/时间）或引擎内置常量。 */
  sourceLabel: string;
  /** 该值是否来自已批准提案（true）还是引擎内置常量（false）。 */
  fromApprovedProposal: boolean;
  /** 是否有可用的基线数值（false = 无生效值，不能据此提候选值）。 */
  hasNumericBaseline: boolean;
  /** 在途/历史提案计数说明（让用户看到"已有提案在途，尚未生效"）。 */
  countsLabel: string;
  /** 无生效值时禁止提案的原因（null = 可提案）。 */
  proposeBlockedReason: string | null;
}

function formatValue(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知';
}

/** 构造阈值基线视图（每参数一行）。 */
export function buildThresholdBaselineView(
  baseline: ThresholdBaseline | null | undefined,
): { readAtLabel: string; engineVersion: string; entries: ThresholdBaselineView[] } {
  const entries = (baseline?.entries ?? []).map((entry: ThresholdBaselineEntry): ThresholdBaselineView => {
    const effective = typeof entry.effective === 'number' ? entry.effective : null;
    const provenance = entry.provenance;
    const fromApprovedProposal = entry.source === 'approved_proposal' && Boolean(provenance);
    let sourceLabel: string;
    if (fromApprovedProposal && provenance) {
      sourceLabel = `已批准提案 ${provenance.proposalId}（审批人 ${provenance.approvedBy ?? '未记录'}`
        + `，批准时间 ${provenance.approvedAt ?? '未记录'}`;
      sourceLabel = provenance.proposedBy
        ? `${sourceLabel}，提议人 ${provenance.proposedBy}）`
        : `${sourceLabel}，提议人未记录）`;
    } else if (entry.source === 'engine_default') {
      sourceLabel = `引擎内置常量 ${formatValue(entry.engineDefault)}（未经人审激活，不是已生效策略）`;
    } else if (entry.source === 'engine_default_unknown') {
      sourceLabel = '未知来源（该参数未登记引擎内置常量，无法确定生效值）';
    } else {
      sourceLabel = `未识别的来源（${String(entry.source)}）`;
    }
    const counts = entry.counts ?? { pending: 0, approved: 0, rejected: 0, rolledBack: 0 };
    const countsLabel = `在途 ${counts.pending} 条（尚未生效） · 已批准 ${counts.approved} 条 ·`
      + ` 已拒绝 ${counts.rejected} 条 · 已回滚 ${counts.rolledBack} 条`;
    return {
      ruleId: entry.ruleId,
      parameter: entry.parameter,
      effectiveLabel: formatValue(effective),
      sourceLabel,
      fromApprovedProposal,
      hasNumericBaseline: effective !== null,
      countsLabel,
      proposeBlockedReason: effective === null
        ? '当前生效值未知（无已批准覆盖且未登记引擎内置常量），无法确定候选值的比较基线，因此不允许提案。'
        : null,
    };
  });
  const readAt = baseline?.readAt;
  return {
    readAtLabel: readAt && !Number.isNaN(Date.parse(readAt))
      ? `读取时间 ${new Date(readAt).toLocaleString('zh-CN', DISPLAY_TIME_OPTS)}`
      : '读取时间未知',
    engineVersion: baseline?.engineVersion ?? '未知',
    entries,
  };
}

/**
 * 候选值校验结果。
 *
 * 注：本仓库 tsconfig 未开启 strictNullChecks，布尔字面量判别式联合在该配置下
 * 不做收窄（`if (!r.ok) r.reason` 会报 TS2339），故这里用可选字段表达
 * 「通过时无 reason / 失败时无 value」，避免调用方被迫写断言。
 */
export interface CandidateValidation {
  ok: boolean;
  /** 校验通过时的数值；ok=false 时为 undefined。 */
  value?: number;
  /** 校验失败原因；ok=true 时为 undefined。 */
  reason?: string;
}

/**
 * 候选值校验（与共享契约同口径：0 ≤ v ≤ 1 且 ≠ 基线）。
 * 前端只做即时反馈，服务端与 DB CHECK 才是权威。
 */
export function validateCandidateValue(
  raw: string,
  baselineValue: number | null,
): CandidateValidation {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: '请填写候选阈值。' };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, reason: '候选阈值必须是数字。' };
  if (value < 0 || value > 1) return { ok: false, reason: '阈值必须在 0 与 1 之间（负荷为 0–1 的比例）。' };
  if (baselineValue !== null && value === baselineValue) {
    return { ok: false, reason: '候选阈值与当前生效值相同，契约要求变更必须产生差异（no-op 提案会被拒绝）。' };
  }
  return { ok: true, value };
}

/** 提案提交后的如实反馈（区分"已登记待评估"与"已评估待人审"）。 */
export function describeProposalCreation(
  created: boolean,
  status: string | undefined,
  proposalId: string | undefined,
): string {
  const id = proposalId ?? '（服务端未返回编号）';
  const prefix = created ? '提案已登记' : '该编号的提案已存在（幂等回读，未重复创建）';
  if (status === 'shadow_evaluated') {
    return `${prefix}：${id}，已用库内事实完成影子评估，状态"已影子评估，待人审"。`
      + '提案不会自动生效——需班组长/全局管理员审批，且提议人不得审批自己的提案。';
  }
  if (status === 'proposed') {
    return `${prefix}：${id}，状态"待影子评估"。库内当前没有可重建的事实窗口，`
      + '因此尚未生成影子证据（证据只能由服务端从库内事实重建）。'
      + '提案不会自动生效——需班组长/全局管理员审批。';
  }
  return `${prefix}：${id}，状态"${status ?? '未知'}"。提案不会自动生效。`;
}

/** 提案列表按"需要我处理的优先"排序：待人审 > 待评估 > 已生效 > 终态。 */
export function sortProposalsForReview(views: ProposalActionView[]): ProposalActionView[] {
  const priority: Record<string, number> = {
    shadow_evaluated: 0,
    proposed: 1,
    approved: 2,
    rejected: 3,
    rolled_back: 4,
  };
  return [...views].sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
}

export function isTerminalProposalStatus(status: LearningProposalStatus | string): boolean {
  return status === 'rejected' || status === 'rolled_back';
}

/* ===== 结果标注（Outcome Annotation，学习回路"经验"一环的真值面） ===== */

/** 与服务端契约注册表一致的合法枚举（contracts/learning/outcome-annotation.schema.json）。 */
export const OUTCOME_TARGET_TYPES: Array<{ value: OutcomeTargetType; label: string }> = [
  { value: 'plan', label: '调度方案' },
  { value: 'decision', label: '决策记录' },
  { value: 'proposal', label: '学习提案' },
  { value: 'agent_command', label: 'Agent 指令' },
];

export const OUTCOME_KINDS: Array<{ value: OutcomeKind; label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = [
  { value: 'success', label: '成功', tone: 'ok' },
  { value: 'partial_success', label: '部分成功', tone: 'warn' },
  { value: 'failure', label: '失败', tone: 'bad' },
  { value: 'invalid', label: '无效（目标不可评）', tone: 'muted' },
];

export function outcomeKindLabel(kind: string | undefined): string {
  return OUTCOME_KINDS.find((k) => k.value === kind)?.label ?? (kind || '未知');
}

export function outcomeTargetLabel(type: string | undefined): string {
  return OUTCOME_TARGET_TYPES.find((t) => t.value === type)?.label ?? (type || '未知');
}

export interface AnnotationInputValidation {
  ok: boolean;
  targetType?: OutcomeTargetType;
  /** 校验通过时的规范化目标编号；ok=false 时可能缺省。 */
  targetId?: string;
  outcomeKind?: OutcomeKind;
  measured?: Record<string, number>;
  /** 校验失败原因；ok=true 时为 undefined。 */
  reason?: string;
}

/**
 * 标注表单校验（与服务端契约同口径）：
 *  - targetType / outcomeKind 必须在注册表内（fail-closed，不猜）；
 *  - targetId 必填；measured 可选，格式 `key=value` 逗号分隔、值必须为数字；
 *  - comment 可选 ≤1000 字。
 * 前端只做即时反馈；服务端契约校验 + 会话身份才是权威。
 */
export function validateAnnotationInput(raw: {
  targetType: string;
  targetId: string;
  outcomeKind: string;
  measured: string;
  comment: string;
}): AnnotationInputValidation {
  const targetType = OUTCOME_TARGET_TYPES.find((t) => t.value === raw.targetType)?.value;
  if (!targetType) return { ok: false, reason: '请选择标注对象类型。' };
  const targetId = raw.targetId.trim();
  if (!targetId) return { ok: false, reason: '请填写目标编号（如方案 ID / 决策 ID）。' };
  if (targetId.length > 200) return { ok: false, reason: '目标编号过长（≤200 字符）。' };
  const outcomeKind = OUTCOME_KINDS.find((k) => k.value === raw.outcomeKind)?.value;
  if (!outcomeKind) return { ok: false, reason: '请选择结果判定。' };

  let measured: Record<string, number> | undefined;
  const measuredRaw = raw.measured.trim();
  if (measuredRaw !== '') {
    measured = {};
    for (const pair of measuredRaw.split(/[,，;；]/)) {
      const trimmed = pair.trim();
      if (trimmed === '') continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return { ok: false, reason: `度量格式应为 key=value（逗号分隔），问题片段："${trimmed}"。` };
      const key = trimmed.slice(0, eq).trim();
      const num = Number(trimmed.slice(eq + 1).trim());
      if (!key) return { ok: false, reason: `度量键不能为空："${trimmed}"。` };
      if (!Number.isFinite(num)) return { ok: false, reason: `度量值必须是数字："${trimmed}"。` };
      measured[key] = num;
    }
    if (Object.keys(measured).length === 0) measured = undefined;
  }

  if (raw.comment.length > 1000) return { ok: false, reason: '备注过长（≤1000 字符）。' };
  return { ok: true, targetType, targetId: raw.targetId.trim(), outcomeKind, measured };
}

/** 单条标注的展示摘要（判定 + 对象 + 时间 + 判定人，缺失如实显示）。 */
export function buildAnnotationSummary(record: OutcomeAnnotationRecord): string {
  const judgedAt = record.judgedAt ? formatAnnotationTime(record.judgedAt) : '时间未知';
  const measuredKeys = record.measured ? Object.keys(record.measured) : [];
  const measuredLabel = measuredKeys.length > 0
    ? `度量 ${measuredKeys.map((k) => `${k}=${record.measured?.[k]}`).join('，')}`
    : '无度量快照';
  return `${outcomeKindLabel(record.outcomeKind)} · ${judgedAt} · 判定人 ${record.judgedBy || '未记录'} · ${measuredLabel}`;
}

function formatAnnotationTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/* ── NO-54a：运行记忆信号的展示口径 ─────────────────────────────────────── */

export interface LearningSignalMetricLine {
  label: string;
  value: string;
}

export interface LearningSignalView {
  signalId: string;
  kindLabel: string;
  severity: string;
  severityTone: 'neutral' | 'warning' | 'critical';
  statusLabel: string;
  subjectLabel: string;
  /** "证据：N 条 · 时间范围 …"；无证据时间时显式写"时间未知"。 */
  evidenceLabel: string;
  /** 实测快照逐行（页面上必须能读到"依据是什么"）。 */
  metricLines: LearningSignalMetricLine[];
  /** 可信度文案；null → "样本不足，不给结论"（绝不显示成低可信度）。 */
  confidenceLabel: string;
  confidenceKnown: boolean;
  hypothesis: string;
  expectedEffect: string;
  risk: string;
  missing: string[];
  /** 可执行时的方向与基线；不可执行时为 null。 */
  actionable: {
    direction: 'raise' | 'lower';
    directionLabel: string;
    ruleId: string;
    parameter: string;
    baselineValue: number;
    baselineSource: string;
  } | null;
  notActionableReason: string | null;
  /** 已经人处理过（promoted/dismissed）时不显示操作按钮。 */
  canDecide: boolean;
  decisionLabel: string | null;
  promotedProposalId: string | null;
}

const SIGNAL_KIND_LABELS: Record<string, string> = {
  notification_fatigue: '提醒疲劳/积压',
  data_quality_backlog: '数据质量待核实积压',
  deviation_repeat: '执行偏差复发',
};

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  notification_kind: '提醒类型',
  notification_source: '提醒来源',
  quality_alert: '数据质量告警',
  execution_deviation: '执行偏差',
  threshold_baseline: '阈值基线',
};

export function learningSignalKindLabel(kind: string | null | undefined): string {
  const key = String(kind ?? '');
  return SIGNAL_KIND_LABELS[key] ?? key;
}

export function learningSignalDirectionLabel(direction: string | null | undefined): string {
  if (direction === 'raise') return '放宽（阈值可能过紧）';
  if (direction === 'lower') return '收紧（阈值可能过松）';
  return '方向待查';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hours(value: unknown): string {
  const n = num(value);
  return n === null ? '时间未知' : `${n} 小时`;
}

/** 实测快照 → 人话行（缺字段显式未知，不补 0）。 */
export function signalMetricLines(metrics: Record<string, unknown>): LearningSignalMetricLine[] {
  const lines: LearningSignalMetricLine[] = [];
  const push = (label: string, value: string | null) => {
    if (value !== null) lines.push({ label, value });
  };
  if (metrics.kindLabel || metrics.kind) {
    push('提醒类型', String(metrics.kindLabel ?? metrics.kind));
  }
  if (num(metrics.pending) !== null) push('待处置', `${num(metrics.pending)} 条`);
  if (num(metrics.resolved) !== null) push('已了结', `${num(metrics.resolved)} 条`);
  if (num(metrics.dispositionRate) !== null) {
    push('处置率', `${Math.round((num(metrics.dispositionRate) as number) * 100)}%`);
  }
  if (num(metrics.oldestPendingAgeHours) !== null) {
    push('最老待处置', hours(metrics.oldestPendingAgeHours));
  }
  if (num(metrics.comparable) !== null) push('可比样本', `${num(metrics.comparable)} 条`);
  if (num(metrics.openQualityAlerts) !== null) {
    push('未了结质量告警', `${num(metrics.openQualityAlerts)} 条`);
  }
  if (num(metrics.pendingQualityReminders) !== null) {
    push('待核实提醒', `${num(metrics.pendingQualityReminders)} 条`);
  }
  if (metrics.objectId) push('对象', `${String(metrics.objectType ?? '对象')} ${String(metrics.objectId)}`);
  if (metrics.deviationType) push('偏差类型', String(metrics.deviationType));
  if (num(metrics.count) !== null) push('复发次数', `${num(metrics.count)} 次`);
  if (typeof metrics.lastAt === 'string' && metrics.lastAt) {
    push('最后发生', new Date(metrics.lastAt).toLocaleString('zh-CN'));
  }
  if (num(metrics.windowDays) !== null) push('统计窗口', `${num(metrics.windowDays)} 天`);
  return lines;
}

export function buildLearningSignalView(signal: {
  signalId: string;
  kind: string;
  severity: string;
  status: string;
  sampleSize: number;
  confidence: string | null;
  metrics: Record<string, unknown>;
  narrative: { hypothesis: string; expectedEffect: string; risk: string; missing: string[] };
  evidenceRefs: Array<{ type: string; id: string; at: string | null }>;
  actionable: {
    ruleId: string;
    parameter: string;
    direction: string;
    baselineValue: number;
    baselineSource: string;
  } | null;
  notActionableReason: string | null;
  decidedBy?: string | null;
  decidedReason?: string | null;
  promotedProposalId?: string | null;
}): LearningSignalView {
  const kindLabel = learningSignalKindLabel(signal.kind);
  const status = String(signal.status ?? 'open');
  const statusLabel =
    status === 'promoted' ? '已生成提案' : status === 'dismissed' ? '已忽略' : '待处理';
  const times = signal.evidenceRefs
    .map((e) => e.at)
    .filter((at): at is string => typeof at === 'string' && at !== '')
    .sort();
  const evidenceLabel =
    `证据：${signal.evidenceRefs.length} 条`
    + `（${[...new Set(signal.evidenceRefs.map((e) => EVIDENCE_TYPE_LABELS[e.type] ?? e.type))].join('、')}）`
    + (times.length > 0
      ? ` · 证据时间 ${new Date(times[0]!).toLocaleString('zh-CN')} ~ ${new Date(times[times.length - 1]!).toLocaleString('zh-CN')}`
      : ' · 证据时间未知');
  const confidenceKnown = signal.confidence !== null && signal.confidence !== undefined;
  const decisionLabel =
    status === 'promoted'
      ? `由 ${signal.decidedBy ?? '未知'} 生成提案 ${signal.promotedProposalId ?? ''}`
      : status === 'dismissed'
        ? `由 ${signal.decidedBy ?? '未知'} 忽略：${signal.decidedReason ?? '未填理由'}`
        : null;
  return {
    signalId: signal.signalId,
    kindLabel,
    severity: String(signal.severity ?? 'low'),
    severityTone:
      signal.severity === 'high' ? 'critical' : signal.severity === 'medium' ? 'warning' : 'neutral',
    statusLabel,
    subjectLabel: String(signal.metrics.kindLabel ?? signal.metrics.objectId ?? signal.signalId),
    evidenceLabel,
    metricLines: signalMetricLines(signal.metrics ?? {}),
    confidenceLabel: confidenceKnown
      ? `可信度 ${signal.confidence}（样本 ${signal.sampleSize}）`
      : `样本不足（${signal.sampleSize} 条），不给结论`,
    confidenceKnown,
    hypothesis: signal.narrative?.hypothesis ?? '',
    expectedEffect: signal.narrative?.expectedEffect ?? '',
    risk: signal.narrative?.risk ?? '',
    missing: Array.isArray(signal.narrative?.missing) ? signal.narrative.missing : [],
    actionable:
      signal.actionable && (signal.actionable.direction === 'raise' || signal.actionable.direction === 'lower')
        ? {
            direction: signal.actionable.direction,
            directionLabel: learningSignalDirectionLabel(signal.actionable.direction),
            ruleId: signal.actionable.ruleId,
            parameter: signal.actionable.parameter,
            baselineValue: signal.actionable.baselineValue,
            baselineSource: signal.actionable.baselineSource,
          }
        : null,
    notActionableReason: signal.notActionableReason ?? null,
    canDecide: status === 'open',
    decisionLabel,
    promotedProposalId: signal.promotedProposalId ?? null,
  };
}

/** 候选值校验（与后端同一口径：0–1 且必须与当前生效值不同）。 */
export function validateSignalCandidate(
  raw: string,
  baselineValue: number | null,
): { ok: boolean; value?: number; reason?: string } {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: '请填写目标阈值（平台只给方向，数值由人给）' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: '目标阈值必须是数字' };
  if (value < 0 || value > 1) return { ok: false, reason: '目标阈值必须落在 0–1 之间' };
  if (baselineValue !== null && Math.abs(value - baselineValue) < 1e-9) {
    return { ok: false, reason: '目标阈值与当前生效值相同：没有变化就没有提案' };
  }
  return { ok: true, value };
}

/** 扫描结果摘要行（人话；"没有信号"也要说清扫了什么）。 */
export function scanResultLabel(result: {
  derived: number;
  created: number;
  refreshed: number;
  decisionsPreserved: number;
  rejected: Array<unknown>;
  windowDays: number;
  memory: { notificationScanned: number; openQualityAlerts: number; pendingQualityReminders: number; deviationObjects: number };
}): string {
  const parts = [
    `窗口 ${result.windowDays} 天`,
    `读提醒 ${result.memory.notificationScanned} 条`,
    `未了结质量告警 ${result.memory.openQualityAlerts} 条`,
    `待核实提醒 ${result.memory.pendingQualityReminders} 条`,
    `偏差对象 ${result.memory.deviationObjects} 个`,
  ];
  const outcome = result.derived === 0
    ? '本次没有达到门槛的信号（未达门槛 ≠ 现场没问题）'
    : `信号 ${result.derived} 条（新增 ${result.created} / 刷新 ${result.refreshed} / 保留人的决定 ${result.decisionsPreserved}）`;
  const rejected = result.rejected.length > 0 ? ` · 契约校验未通过 ${result.rejected.length} 条（未落库）` : '';
  return `${parts.join(' · ')} → ${outcome}${rejected}`;
}

/* ── NO-55a：改进行动项的展示口径 ───────────────────────────────────────── */

export interface ImprovementActionView {
  actionId: string;
  title: string;
  detail: string;
  kindLabel: string;
  kindSuggested: boolean;
  priorityLabel: string;
  priorityTone: 'neutral' | 'warning' | 'critical';
  statusLabel: string;
  sourceLabel: string;
  evidenceLabel: string;
  /** 对象归属（NO-58a）：`设备 DEV-04` / `人员 person:x` / `工位 station:WS-1` / 未绑定。 */
  subjectLabel: string;
  /** 有归属 = 复发可度量；false 时页面必须显式说"不可度量"，不许看起来像"没有复发"。 */
  measurable: boolean;
  ownerLabel: string;
  dueLabel: string;
  overdue: boolean;
  /** 未完成（proposed/accepted）才显示操作。 */
  canAccept: boolean;
  canComplete: boolean;
  canDecide: boolean;
  acceptanceLabel: string | null;
  outcomeLabel: string | null;
  decisionLabel: string | null;
}

const ACTION_KIND_LABELS: Record<string, string> = {
  process_change: '做法改进',
  training: '培训',
  tooling: '工具/数据',
  maintenance: '维护',
  threshold_review: '阈值复核（去提案面板改参数）',
};

const ACTION_STATUS_LABELS: Record<string, string> = {
  proposed: '待接受',
  accepted: '已接受',
  rejected: '已拒绝',
  completed: '已完成',
  dropped: '已放弃',
};

export function improvementKindLabel(kind: string | null | undefined): string {
  const key = String(kind ?? '');
  return ACTION_KIND_LABELS[key] ?? key;
}

export function improvementStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? '');
  return ACTION_STATUS_LABELS[key] ?? key;
}

export function improvementPriorityLabel(priority: string | null | undefined): string {
  if (priority === 'high') return '高';
  if (priority === 'medium') return '中';
  if (priority === 'low') return '低';
  return String(priority ?? '');
}

/** 是否逾期（未完成 + 有期限 + 期限已过）；没有期限不判逾期（不猜）。 */
export function isImprovementOverdue(
  action: { status: string; dueAt?: string | null },
  now: number,
): boolean {
  if (action.status !== 'proposed' && action.status !== 'accepted') return false;
  if (!action.dueAt) return false;
  const due = Date.parse(action.dueAt);
  return Number.isFinite(due) && due < now;
}

export function buildImprovementActionView(
  action: {
    actionId: string;
    sourceType: string;
    sourceRef: string;
    subjectType?: string | null;
    subjectId?: string | null;
    title: string;
    detail: string;
    kind: string;
    kindSource: string;
    priority: string;
    status: string;
    evidenceRefs: Array<{ type: string; id: string; at: string | null }>;
    owner?: string | null;
    dueAt?: string | null;
    acceptanceCriteria?: string | null;
    outcomeNote?: string | null;
    decidedReason?: string | null;
  },
  now: number = Date.now(),
): ImprovementActionView {
  const status = String(action.status ?? 'proposed');
  const overdue = isImprovementOverdue(action, now);
  const times = action.evidenceRefs
    .map((e) => e.at)
    .filter((at): at is string => typeof at === 'string' && at !== '')
    .sort();
  return {
    actionId: action.actionId,
    title: action.title,
    detail: action.detail,
    kindLabel: improvementKindLabel(action.kind),
    kindSuggested: action.kindSource !== 'human',
    priorityLabel: improvementPriorityLabel(action.priority),
    priorityTone:
      action.priority === 'high' ? 'critical' : action.priority === 'medium' ? 'warning' : 'neutral',
    statusLabel: overdue ? `${improvementStatusLabel(status)}（已逾期）` : improvementStatusLabel(status),
    sourceLabel:
      action.sourceType === 'retrospective_gap'
        ? `复盘缺口 · ${action.sourceRef}`
        : `复盘经验 · ${action.sourceRef}`,
    evidenceLabel:
      `证据 ${action.evidenceRefs.length} 条`
      + (times.length > 0 ? ` · 最近 ${new Date(times[times.length - 1]!).toLocaleString('zh-CN')}` : ' · 时间未知'),
    subjectLabel: improvementSubjectLabel(action.subjectType, action.subjectId),
    measurable: improvementSubjectMeasurable(action.subjectType, action.subjectId),
    ownerLabel: action.owner ? `负责人 ${action.owner}` : '未指派负责人',
    dueLabel: action.dueAt ? `期限 ${new Date(action.dueAt).toLocaleDateString('zh-CN')}` : '未设期限',
    overdue,
    canAccept: status === 'proposed',
    canComplete: status === 'accepted',
    canDecide: status === 'proposed' || status === 'accepted',
    acceptanceLabel: action.acceptanceCriteria ? `验收判据：${action.acceptanceCriteria}` : null,
    outcomeLabel: action.outcomeNote ? `完成结果：${action.outcomeNote}` : null,
    decisionLabel: action.decidedReason ? `决定理由：${action.decidedReason}` : null,
  };
}

const SUBJECT_TYPE_LABELS: Record<string, string> = {
  device: '设备',
  person: '人员',
  station: '工位',
};

/** 归属是否成对且类型已知（只有一半 = 半成品，按"未绑定"处理，不猜）。 */
export function improvementSubjectMeasurable(
  subjectType?: string | null,
  subjectId?: string | null,
): boolean {
  const type = typeof subjectType === 'string' ? subjectType.trim() : '';
  const id = typeof subjectId === 'string' ? subjectId.trim() : '';
  return type !== '' && id !== '' && SUBJECT_TYPE_LABELS[type] !== undefined;
}

/**
 * 对象归属文案。null = 复盘没有单一对象（plan/shift）或 target_id 缺失 —— 这时
 * 「复发是否下降」**不可度量**，页面必须说出来，不许显示成"没有复发"。
 */
export function improvementSubjectLabel(
  subjectType?: string | null,
  subjectId?: string | null,
): string {
  if (!improvementSubjectMeasurable(subjectType, subjectId)) {
    return '对象归属：未绑定（复发不可度量）';
  }
  const type = String(subjectType).trim();
  // 展示用裸 id（`person:<uuid>` / `station:<id>` → `<uuid>` / `<id>`）：
  // 前缀是规范身份引用的一部分，但页面上的类型标签已经说明了对象类型，重复前缀只碍读。
  const bare = executionSubjectKey(type, String(subjectId));
  return `对象归属：${SUBJECT_TYPE_LABELS[type]} ${bare || String(subjectId).trim()}`;
}

export interface RecurrenceView {
  conclusion: string;
  tone: 'neutral' | 'warning' | 'positive';
  windowLabel: string;
  beforeLabel: string;
  afterLabel: string;
  reason: string;
  /** 服务端补充说明（如"观察期未结束"）——必须原样展示，读者要知道结论有多新。 */
  noteLabel: string | null;
  /** 结论只是计数事实——必须与"这条改进有效"分开显示。 */
  disclaimer: string | null;
  measurable: boolean;
}

const RECURRENCE_CONCLUSION_LABELS: Record<string, string> = {
  no_subject: '不可度量（对象未绑定）',
  not_completed: '未完成：只有完成前的计数',
  insufficient_sample: '样本不足（不给趋势结论）',
  recurrence_dropped: '复发计数下降',
  recurrence_persisted: '复发计数未下降',
};

/**
 * 复发度量视图（NO-58a）。所有结论都**只描述计数**，不代表因果；`disclaimer`
 * 必须原样展示（`recurrence_dropped` 不等于"这条改进有效"）。
 */
export function buildRecurrenceView(effect: {
  windowDays: number;
  before: { from: string; to: string; deviations: number };
  after: { from: string; to: string; deviations: number };
  conclusion: string;
  reason: string;
  notes?: string[];
  subjectType?: string | null;
  subjectId?: string | null;
}): RecurrenceView {
  const measurable = improvementSubjectMeasurable(effect.subjectType, effect.subjectId);
  const conclusion = String(effect.conclusion ?? '');
  const notes = (effect.notes ?? []).filter((n) => typeof n === 'string' && n.trim() !== '');
  const fmt = (iso: string) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '—');
  return {
    conclusion: RECURRENCE_CONCLUSION_LABELS[conclusion] ?? `未知结论（${conclusion || '空'}）`,
    tone:
      conclusion === 'recurrence_dropped' ? 'positive'
        : conclusion === 'recurrence_persisted' ? 'warning'
          : 'neutral',
    windowLabel: `窗口 ${effect.windowDays} 天`,
    beforeLabel: `完成前 ${fmt(effect.before?.from ?? '')} ~ ${fmt(effect.before?.to ?? '')}：${effect.before?.deviations ?? 0} 次`,
    afterLabel: `完成后 ${fmt(effect.after?.from ?? '')} ~ ${fmt(effect.after?.to ?? '')}：${effect.after?.deviations ?? 0} 次`,
    reason: String(effect.reason ?? ''),
    noteLabel: notes.length > 0 ? notes.join('；') : null,
    disclaimer: conclusion === 'recurrence_dropped' || conclusion === 'recurrence_persisted'
      ? '计数变化只是事实：不等于"这条改进有效"（订单结构/季节变化同样会影响）。'
      : null,
    measurable,
  };
}

/** 扫描摘要（读了什么 + 派生/新增/刷新/保留决定）。 */
export function improvementScanLabel(result: {
  scannedRetrospectives: number;
  derived: number;
  created: number;
  refreshed: number;
  decisionsPreserved: number;
  rejected: Array<unknown>;
  memory: { publishedRetrospectives: number; lessons: number; gaps: number };
}): string {
  const read = `读已发布复盘 ${result.memory.publishedRetrospectives} 篇（经验 ${result.memory.lessons} 条 / 缺口 ${result.memory.gaps} 条）`;
  const outcome = result.derived === 0
    ? '本次没有需要行动的经验或缺口（warning 以下只作记忆保留）'
    : `候选 ${result.derived} 条（新增 ${result.created} / 刷新 ${result.refreshed} / 保留人的决定 ${result.decisionsPreserved}）`;
  const rejected = result.rejected.length > 0 ? ` · 契约未通过 ${result.rejected.length} 条（未落库）` : '';
  return `${read} → ${outcome}${rejected}`;
}

/** 接受输入校验（与后端同源：负责人/期限/验收判据必填）。 */
export function validateAcceptance(
  input: { owner?: string; dueAt?: string; acceptanceCriteria?: string },
): { ok: boolean; reason?: string } {
  if (!String(input.owner ?? '').trim()) return { ok: false, reason: '请填负责人（人或角色）' };
  const due = String(input.dueAt ?? '').trim();
  if (due === '') return { ok: false, reason: '请填期限' };
  if (Number.isNaN(Date.parse(due))) return { ok: false, reason: '期限必须是日期' };
  if (!String(input.acceptanceCriteria ?? '').trim()) {
    return { ok: false, reason: '请填验收判据（否则"做完了"没法被别人判断）' };
  }
  return { ok: true };
}
