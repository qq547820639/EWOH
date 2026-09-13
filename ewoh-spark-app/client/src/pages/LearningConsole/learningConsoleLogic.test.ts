import {
  allowedActions,
  buildAnnotationSummary,
  buildThresholdBaselineView,
  describeProposalCreation,
  isSelfApprovalBlocked,
  outcomeKindLabel,
  outcomeTargetLabel,
  validateAnnotationInput,
  validateCandidateValue,
  explainProposalError,
  buildProposalView,
  explainRetrainError,
  formatModelAccuracy,
  isApprovalRole,
  isTerminalProposalStatus,
  sortProposalsForReview,
  summarizeEligibility,
  PROPOSAL_STATUS_LABELS,
  buildLearningSignalView,
  learningSignalDirectionLabel,
  learningSignalKindLabel,
  scanResultLabel,
  signalMetricLines,
  validateSignalCandidate,
  buildImprovementActionView,
  buildRecurrenceView,
  improvementSubjectLabel,
  improvementSubjectMeasurable,
  improvementKindLabel,
  improvementPriorityLabel,
  improvementScanLabel,
  improvementStatusLabel,
  isImprovementOverdue,
  validateAcceptance,
} from './learningConsoleLogic';
import type {
  LearningProposalRecord,
  ThresholdBaseline,
  ThresholdBaselineEntry,
  TrainingSampleSummary,
} from '../../api/learning';

function proposal(over: Partial<LearningProposalRecord> = {}): LearningProposalRecord {
  return {
    proposalId: 'LP-1',
    kind: 'threshold_change',
    status: 'proposed',
    change: { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold', baselineValue: 0.7, candidateValue: 0.8 },
    ...over,
  };
}

function samples(over: Partial<TrainingSampleSummary> = {}): TrainingSampleSummary {
  return {
    orgId: 'org-1',
    sampleLimit: 2000,
    totalFeedbackRows: 10,
    flaggedEligible: 0,
    trainable: 0,
    minSamplesRequired: 5,
    fullyTrained: false,
    rejected: {},
    rejectedLabels: {},
    eligibilityPolicy: 'independent-device-receipt-required',
    ...over,
  };
}

describe('学习控制台 · 提案状态机与权限', () => {
  it('按服务端状态机给出可用动作', () => {
    expect(allowedActions('proposed')).toEqual(['shadow']);
    expect(allowedActions('shadow_evaluated')).toEqual(['approve', 'reject']);
    expect(allowedActions('approved')).toEqual(['rollback']);
    expect(allowedActions('rejected')).toEqual([]);
    expect(allowedActions('rolled_back')).toEqual([]);
  });

  it('未知状态不给出任何动作（fail-closed，不猜）', () => {
    expect(allowedActions('something_new')).toEqual([]);
    expect(buildProposalView(proposal({ status: 'something_new' }), ['global_admin']).statusLabel)
      .toContain('未知状态');
  });

  it('没有影子证据时明确说明，而不是显示"接受"', () => {
    const view = buildProposalView(proposal(), ['global_admin']);
    expect(view.shadowAccepted).toBeNull();
    expect(view.shadowSummary).toContain('尚无影子评估证据');
  });

  it('影子评估已跑但缺接受结论时，不推断为通过', () => {
    const view = buildProposalView(proposal({ status: 'shadow_evaluated', shadowEval: { reason: 'no data' } }), ['global_admin']);
    expect(view.shadowAccepted).toBeNull();
    expect(view.shadowSummary).toContain('未给出接受结论');
  });

  it('影子评估给出结论时如实反映（接受/不接受）', () => {
    expect(buildProposalView(proposal({ shadowEval: { accepted: true } }), []).shadowAccepted).toBe(true);
    expect(buildProposalView(proposal({ shadowEval: { accepted: false } }), []).shadowAccepted).toBe(false);
  });

  it('需要人审的动作标记 requiresApprovalRole；且与角色判定一致', () => {
    const view = buildProposalView(proposal({ status: 'shadow_evaluated' }), ['worker']);
    expect(view.requiresApprovalRole).toBe(true);
    expect(isApprovalRole(['worker'])).toBe(false);
    expect(isApprovalRole(['workshop_lead'])).toBe(true);
    expect(isApprovalRole(['global_admin'])).toBe(true);
    expect(isApprovalRole(null)).toBe(false);
    expect(isApprovalRole([])).toBe(false);
  });

  it('变更描述包含规则、参数与前后值（可复核）', () => {
    expect(buildProposalView(proposal(), []).changeSummary)
      .toBe('rule:worker-overload · workloadThreshold：0.7 → 0.8');
  });

  it('变更缺失时不崩溃且明确说明缺失', () => {
    const view = buildProposalView(proposal({ change: undefined as never }), []);
    expect(view.changeSummary).toBe('变更内容缺失');
  });

  it('审计字段透传（谁批准/谁拒绝/谁回滚 + 理由）', () => {
    const view = buildProposalView(proposal({
      status: 'rejected', rejectedBy: 'u-lead', rejectedReason: '样本不足',
    }), []);
    expect(view.auditTrail.rejectedBy).toBe('u-lead');
    expect(view.auditTrail.rejectedReason).toBe('样本不足');
  });

  it('列表排序把"待人审"排在"待评估"之前，终态最后', () => {
    const views = [
      buildProposalView(proposal({ proposalId: 'a', status: 'approved' }), []),
      buildProposalView(proposal({ proposalId: 'b', status: 'proposed' }), []),
      buildProposalView(proposal({ proposalId: 'c', status: 'shadow_evaluated' }), []),
      buildProposalView(proposal({ proposalId: 'd', status: 'rolled_back' }), []),
    ];
    expect(sortProposalsForReview(views).map((v) => v.proposalId)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('终态判定', () => {
    expect(isTerminalProposalStatus('rejected')).toBe(true);
    expect(isTerminalProposalStatus('rolled_back')).toBe(true);
    expect(isTerminalProposalStatus('approved')).toBe(false);
    expect(PROPOSAL_STATUS_LABELS.approved).toBe('已批准生效');
  });
});

describe('学习控制台 · 训练样本资格解释', () => {
  it('未加载数据时明确说明"未加载"，不显示 0 条可训练', () => {
    const view = summarizeEligibility(null);
    expect(view.verdict).toContain('未加载');
    expect(view.trainable).toBe(0);
  });

  it('标记通过但缺设备证据 → 显式区分并说明原因（避免"有样本却训不了"的困惑）', () => {
    const view = summarizeEligibility(samples({
      flaggedEligible: 7, trainable: 0,
      rejected: { missing_independent_device_receipt: 7 },
      rejectedLabels: { missing_independent_device_receipt: '缺少独立设备回执证据（人工上报不满足）' },
    }));
    expect(view.hasEvidenceDowngrade).toBe(true);
    expect(view.downgradedByEvidence).toBe(7);
    expect(view.verdict).toContain('有 7 条通过来源标记');
    expect(view.verdict).toContain('人工上报与模拟回执不计入');
    expect(view.excluded[0].label).toContain('独立设备回执');
  });

  it('达到门槛时给出明确的"可训练"结论', () => {
    const view = summarizeEligibility(samples({ trainable: 12, minSamplesRequired: 5, fullyTrained: true }));
    expect(view.meetsThreshold).toBe(true);
    expect(view.verdict).toContain('已达到门槛');
  });

  it('有样本但未达门槛 → 说明还差多少', () => {
    const view = summarizeEligibility(samples({ trainable: 2, minSamplesRequired: 5 }));
    expect(view.meetsThreshold).toBe(false);
    expect(view.verdict).toContain('未达门槛');
  });

  it('完全无样本 → 说明需要独立设备回执', () => {
    expect(summarizeEligibility(samples()).verdict).toContain('独立设备回执');
  });

  it('排除明细按数量降序，且过滤掉 0 计数的原因', () => {
    const view = summarizeEligibility(samples({
      trainable: 3,
      rejected: { not_real_source: 2, missing_provenance: 5, flags_not_eligible: 0 },
      rejectedLabels: { not_real_source: '非真实来源', missing_provenance: '缺少可追溯证明 JSON' },
    }));
    expect(view.excluded.map((e) => e.reason)).toEqual(['missing_provenance', 'not_real_source']);
  });
});

describe('学习控制台 · 提案动作错误翻译（实测真实后端行为）', () => {
  it('缺事实窗口 → 说明证据只能服务端重建、提案保持待评估', () => {
    const text = explainProposalError('shadow_facts_window_empty：库内无可重建的事实窗口（R2-SBZ-004 fail-closed）');
    expect(text).toContain('可重建的事实窗口');
    expect(text).toContain('客户端不能提供');
    expect(text).toContain('保持"待影子评估"');
  });

  it('非法状态转移 → 说明必须先影子评估再人审', () => {
    const text = explainProposalError('非法提案转移：proposed → approved 不允许（ADR-026 状态机）');
    expect(text).toContain('必须先完成影子评估');
    expect(text).toContain('ADR-026 状态机');
  });

  it('其它错误原样返回，不误译', () => {
    expect(explainProposalError('网络不可用')).toBe('网络不可用');
    expect(explainProposalError(null)).toBeNull();
  });
});

describe('学习控制台 · 缺失数据不得伪装', () => {
  it('modelAccuracy 为 null → 显示"未标注"而不是 0%', () => {
    expect(formatModelAccuracy(null)).toContain('未标注');
    expect(formatModelAccuracy(undefined)).toContain('未标注');
    expect(formatModelAccuracy(Number.NaN)).toContain('未标注');
  });

  it('有准确率时按百分比显示', () => {
    expect(formatModelAccuracy(0.87)).toBe('87.0%');
    expect(formatModelAccuracy(0)).toBe('0.0%');
  });

  it('样本不足错误翻译为可执行说明，并强调未落版', () => {
    const text = explainRetrainError('retrain_not_enough_data: insufficient_samples(3<5)');
    expect(text).toContain('样本不足，未落版');
    expect(text).toContain('insufficient_samples(3<5)');
    expect(text).toContain('独立设备回执');
  });

  it('非样本不足错误原样返回，不误译', () => {
    expect(explainRetrainError('网络不可用')).toBe('网络不可用');
    expect(explainRetrainError(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------
 * B5 同族审批独立性（standalone_073）：提议人归属 + 自批回避 UI 预判。
 * 服务端仍是权威（403 SELF_APPROVAL_FORBIDDEN + DB CHECK）；此处只验证
 * UI 不会把「点了才被拒」当交互，也不会凭空收紧（拒绝自己的提案仍允许）。
 * ------------------------------------------------------------------ */
describe('学习控制台 · 生成人回避（B5）', () => {
  it('提议人=当前用户 → 提示需他人审批，且只有"批准"被预判拦下', () => {
    const view = buildProposalView(
      proposal({ status: 'shadow_evaluated', proposedBy: 'user-1' }),
      ['workshop_lead'],
      'user-1',
    );
    expect(view.isOwnProposal).toBe(true);
    expect(view.proposedBy).toBe('user-1');
    expect(isSelfApprovalBlocked(view, 'approve')).toBe(true);
    // 拒绝自己的提案 = 撤回，服务端允许，UI 不得凭空收紧。
    expect(isSelfApprovalBlocked(view, 'reject')).toBe(false);
    expect(isSelfApprovalBlocked(view, 'shadow')).toBe(false);
    expect(isSelfApprovalBlocked(view, 'rollback')).toBe(false);
  });

  it('他人提案 → 可批准；存量无提议人行 → 不预判拦截（服务端对 NULL 放行）', () => {
    const other = buildProposalView(
      proposal({ status: 'shadow_evaluated', proposedBy: 'user-2' }),
      ['workshop_lead'],
      'user-1',
    );
    expect(other.isOwnProposal).toBe(false);
    expect(isSelfApprovalBlocked(other, 'approve')).toBe(false);

    const legacy = buildProposalView(proposal({ status: 'shadow_evaluated' }), ['workshop_lead'], 'user-1');
    expect(legacy.proposedBy).toBeUndefined();
    expect(legacy.isOwnProposal).toBe(false);
    expect(isSelfApprovalBlocked(legacy, 'approve')).toBe(false);
  });

  it('服务端 SELF_APPROVAL_FORBIDDEN 被翻译为可执行说明，并明确策略未被改动', () => {
    const text = explainProposalError(
      'SELF_APPROVAL_FORBIDDEN: proposal lp:1 was proposed by the requesting operator (B5 审批独立性)',
    );
    expect(text).toContain('由你提出');
    expect(text).toContain('其他班组长/全局管理员');
    expect(text).toContain('策略未被改动');
  });
});

/* ------------------------------------------------------------------
 * 阈值基线读面：来源必须如实区分「已批准提案」与「引擎内置常量」。
 * ------------------------------------------------------------------ */
describe('学习控制台 · 阈值基线与候选值', () => {
  function baseline(over: Partial<ThresholdBaselineEntry> = {}): ThresholdBaseline {
    return {
      readAt: '2026-09-10T12:00:00.000Z',
      engineVersion: '1.0.0',
      entries: [{
        ruleId: 'rule:worker-overload',
        parameter: 'workloadThreshold',
        engineDefault: 0.8,
        effective: 0.8,
        source: 'engine_default',
        provenance: null,
        counts: { pending: 0, approved: 0, rejected: 0, rolledBack: 0 },
        ...over,
      }],
    };
  }

  it('无覆盖 → 明确标注"引擎内置常量（未经人审激活）"，绝不冒充已生效策略', () => {
    const view = buildThresholdBaselineView(baseline());
    expect(view.entries[0].effectiveLabel).toBe('0.8');
    expect(view.entries[0].fromApprovedProposal).toBe(false);
    expect(view.entries[0].sourceLabel).toContain('引擎内置常量');
    expect(view.entries[0].sourceLabel).toContain('不是已生效策略');
    expect(view.entries[0].proposeBlockedReason).toBeNull();
    expect(view.readAtLabel).toContain('读取时间');
    expect(view.engineVersion).toBe('1.0.0');
  });

  it('有 approved 覆盖 → 标注提案编号/审批人/提议人/批准时间，并区分在途与历史计数', () => {
    const view = buildThresholdBaselineView(baseline({
      effective: 0.75,
      source: 'approved_proposal',
      provenance: {
        proposalId: 'lp:active',
        baselineValue: 0.8,
        candidateValue: 0.75,
        approvedBy: 'person:lead',
        approvedAt: '2026-09-01T02:00:00.000Z',
        proposedBy: 'person:worker',
      },
      counts: { pending: 1, approved: 1, rejected: 2, rolledBack: 1 },
    }));
    const [entry] = view.entries;
    expect(entry.effectiveLabel).toBe('0.75');
    expect(entry.fromApprovedProposal).toBe(true);
    expect(entry.sourceLabel).toContain('lp:active');
    expect(entry.sourceLabel).toContain('person:lead');
    expect(entry.sourceLabel).toContain('person:worker');
    expect(entry.countsLabel).toContain('在途 1 条（尚未生效）');
    expect(entry.countsLabel).toContain('已回滚 1 条');
  });

  it('未登记引擎常量 → 生效值显示"未知"并禁止提案（不猜基线）', () => {
    const view = buildThresholdBaselineView(baseline({
      engineDefault: null,
      effective: null,
      source: 'engine_default_unknown',
    }));
    expect(view.entries[0].effectiveLabel).toBe('未知');
    expect(view.entries[0].hasNumericBaseline).toBe(false);
    expect(view.entries[0].proposeBlockedReason).toContain('无法确定候选值的比较基线');
  });

  it('缺失基线数据（未加载）→ 不编造条目', () => {
    expect(buildThresholdBaselineView(null).entries).toEqual([]);
    expect(buildThresholdBaselineView(null).readAtLabel).toBe('读取时间未知');
  });

  it('候选值校验与契约同口径：数字 / 0–1 / 必须与生效值不同', () => {
    expect(validateCandidateValue('', 0.8).reason).toContain('请填写');
    expect(validateCandidateValue('abc', 0.8).reason).toContain('必须是数字');
    expect(validateCandidateValue('1.5', 0.8).reason).toContain('0 与 1 之间');
    expect(validateCandidateValue('-0.2', 0.8).reason).toContain('0 与 1 之间');
    expect(validateCandidateValue('0.8', 0.8).reason).toContain('no-op');
    expect(validateCandidateValue('0.75', 0.8)).toEqual({ ok: true, value: 0.75 });
    // 基线未知时不做差值判断（服务端仍是权威），只校验范围。
    expect(validateCandidateValue('0.75', null)).toEqual({ ok: true, value: 0.75 });
  });

  it('提案提交反馈区分"待影子评估"与"已影子评估待人审"，并声明不会自动生效', () => {
    const evaluated = describeProposalCreation(true, 'shadow_evaluated', 'lp:x');
    expect(evaluated).toContain('提案已登记');
    expect(evaluated).toContain('待人审');
    expect(evaluated).toContain('不会自动生效');
    expect(evaluated).toContain('不得审批自己的提案');

    const pending = describeProposalCreation(true, 'proposed', 'lp:y');
    expect(pending).toContain('待影子评估');
    expect(pending).toContain('没有可重建的事实窗口');
    expect(pending).toContain('服务端从库内事实重建');

    const idempotent = describeProposalCreation(false, 'shadow_evaluated', 'lp:x');
    expect(idempotent).toContain('幂等回读');
  });
});

describe('结果标注视图模型', () => {
  it('表单校验按契约注册表 fail-closed：未知类型/判定、缺目标编号都拒绝', () => {
    expect(validateAnnotationInput({ targetType: 'plan', targetId: ' ', outcomeKind: 'success', measured: '', comment: '' }).reason)
      .toContain('目标编号');
    expect(validateAnnotationInput({ targetType: 'unknown', targetId: 'P1', outcomeKind: 'success', measured: '', comment: '' }).ok)
      .toBe(false);
    expect(validateAnnotationInput({ targetType: 'plan', targetId: 'P1', outcomeKind: 'excellent', measured: '', comment: '' }).ok)
      .toBe(false);
    expect(validateAnnotationInput({ targetType: 'plan', targetId: 'P1', outcomeKind: 'success', measured: '', comment: 'x'.repeat(1001) }).reason)
      .toContain('备注过长');
  });

  it('measured 解析 key=value 列表：合法数值保留、非法格式与非法数值拒绝', () => {
    const ok = validateAnnotationInput({
      targetType: 'decision', targetId: 'DEC-1', outcomeKind: 'partial_success',
      measured: 'delayMs=1200, 置信度=0.8；', comment: '',
    });
    expect(ok.ok).toBe(true);
    expect(ok.measured).toEqual({ delayMs: 1200, 置信度: 0.8 });

    expect(validateAnnotationInput({ targetType: 'plan', targetId: 'P1', outcomeKind: 'success', measured: 'delay', comment: '' }).reason)
      .toContain('key=value');
    expect(validateAnnotationInput({ targetType: 'plan', targetId: 'P1', outcomeKind: 'success', measured: 'delayMs=abc', comment: '' }).reason)
      .toContain('必须是数字');
    // 空白 measured = 不携带度量（缺省不猜测）
    const none = validateAnnotationInput({ targetType: 'plan', targetId: 'P1', outcomeKind: 'success', measured: '  ', comment: '' });
    expect(none.ok).toBe(true);
    expect(none.measured).toBeUndefined();
  });

  it('合法输入返回规范化字段', () => {
    const ok = validateAnnotationInput({
      targetType: 'proposal', targetId: ' lp:1 ', outcomeKind: 'failure',
      measured: '', comment: '影子评估后回滚',
    });
    expect(ok).toMatchObject({ ok: true, targetType: 'proposal', targetId: 'lp:1', outcomeKind: 'failure' });
  });

  it('摘要如实展示判定/时间/判定人/度量，缺失项不伪装', () => {
    const summary = buildAnnotationSummary({
      annotationId: 'oa:1', targetType: 'plan', targetId: 'PLAN-1', outcomeKind: 'success',
      judgedBy: 'user-admin', judgedAt: '2026-09-11T02:00:00.000Z',
      measured: { delayMs: 0 },
    });
    expect(summary).toContain('成功');
    expect(summary).toContain('user-admin');
    expect(summary).toContain('delayMs=0');

    const bare = buildAnnotationSummary({
      annotationId: 'oa:2', targetType: 'plan', targetId: 'PLAN-2', outcomeKind: 'weird',
      judgedBy: '', judgedAt: '',
    });
    expect(bare).toContain('未知');
    expect(bare).toContain('未记录');
    expect(bare).toContain('无度量快照');
  });

  it('枚举标签对未知值回显原文（不猜中文）', () => {
    expect(outcomeKindLabel('failure')).toBe('失败');
    expect(outcomeKindLabel('mystery')).toBe('mystery');
    expect(outcomeTargetLabel('agent_command')).toBe('Agent 指令');
    expect(outcomeTargetLabel('mystery')).toBe('mystery');
  });
});


/* ── NO-54a：运行记忆信号的展示口径 ───────────────────────────────────── */

function signalFixture(overrides: Record<string, unknown> = {}) {
  return {
    signalId: 'SIG-NOTIFICATION_FATIGUE-andon-30d-high',
    kind: 'notification_fatigue',
    severity: 'high',
    status: 'open',
    subjectKey: 'andon',
    windowDays: 30,
    sampleSize: 26,
    confidence: 'medium',
    metrics: {
      windowDays: 30,
      kindLabel: '安灯异常',
      pending: 20,
      resolved: 6,
      dispositionRate: 0.23,
      oldestPendingAgeHours: 26,
      comparable: 6,
    },
    narrative: { hypothesis: 'H', expectedEffect: 'E', risk: 'R', missing: [] },
    evidenceRefs: [
      { type: 'notification_kind', id: 'andon', at: '2026-09-12T08:00:00.000Z', detail: {} },
      { type: 'notification_source', id: 'ANDON-1', at: null, detail: {} },
    ],
    actionable: {
      ruleId: 'rule:worker-overload',
      parameter: 'workloadThreshold',
      direction: 'raise',
      baselineValue: 0.7,
      baselineSource: 'engine_default',
    },
    notActionableReason: null,
    detectedAt: '2026-09-12T08:00:00.000Z',
    ...overrides,
  } as never;
}

describe('buildLearningSignalView（信号展示口径）', () => {
  it('可执行信号：给方向/基线/实测快照与证据时间范围', () => {
    const view = buildLearningSignalView(signalFixture());
    expect(view.kindLabel).toBe('提醒疲劳/积压');
    expect(view.actionable?.directionLabel).toContain('放宽');
    expect(view.actionable?.baselineValue).toBe(0.7);
    expect(view.evidenceLabel).toContain('证据：2 条');
    expect(view.evidenceLabel).toContain('证据时间');
    expect(view.metricLines.map((l) => l.label)).toContain('待处置');
    expect(view.canDecide).toBe(true);
    expect(view.confidenceKnown).toBe(true);
  });

  it('证据时间缺失 → 显式"证据时间未知"（不拿扫描时刻冒充）', () => {
    const view = buildLearningSignalView(
      signalFixture({ evidenceRefs: [{ type: 'notification_kind', id: 'andon', at: null }] }),
    );
    expect(view.evidenceLabel).toContain('证据时间未知');
  });

  it('样本不足 → "不给结论"，不显示成低可信度', () => {
    const view = buildLearningSignalView(signalFixture({ confidence: null, sampleSize: 3 }));
    expect(view.confidenceKnown).toBe(false);
    expect(view.confidenceLabel).toContain('不给结论');
    expect(view.confidenceLabel).toContain('3 条');
  });

  it('不可执行 → 原样带出理由（页面要能读出为什么只能提示）', () => {
    const view = buildLearningSignalView(
      signalFixture({ actionable: null, notActionableReason: '数据质量积压不是策略阈值问题' }),
    );
    expect(view.actionable).toBeNull();
    expect(view.notActionableReason).toContain('不是策略阈值问题');
  });

  it('已转提案/已忽略 → 不再显示操作，决定与理由可见', () => {
    const promoted = buildLearningSignalView(
      signalFixture({ status: 'promoted', promotedProposalId: 'LP-X', decidedBy: 'lead.chen' }),
    );
    expect(promoted.canDecide).toBe(false);
    expect(promoted.statusLabel).toBe('已生成提案');
    expect(promoted.decisionLabel).toContain('LP-X');

    const dismissed = buildLearningSignalView(
      signalFixture({ status: 'dismissed', decidedBy: 'lead.chen', decidedReason: '已知积压' }),
    );
    expect(dismissed.canDecide).toBe(false);
    expect(dismissed.decisionLabel).toContain('已知积压');
  });
});

describe('signalMetricLines（实测快照 → 人话）', () => {
  it('缺字段不补 0（宁可不显示，也不伪造读数）', () => {
    const lines = signalMetricLines({ windowDays: 30, count: 4, objectId: 'EXO-9', objectType: 'device' });
    const labels = lines.map((l) => l.label);
    expect(labels).toEqual(['对象', '复发次数', '统计窗口']);
    expect(labels).not.toContain('待处置');
  });

  it('处置率转百分比、账龄转小时文案', () => {
    const lines = signalMetricLines({ dispositionRate: 0.23, oldestPendingAgeHours: 26 });
    expect(lines.find((l) => l.label === '处置率')?.value).toBe('23%');
    expect(lines.find((l) => l.label === '最老待处置')?.value).toBe('26 小时');
  });
});

describe('validateSignalCandidate（目标阈值由人给）', () => {
  it('空/非数字/越界/与基线相同 → 拒绝并说明', () => {
    expect(validateSignalCandidate('', 0.7).ok).toBe(false);
    expect(validateSignalCandidate('abc', 0.7).reason).toContain('数字');
    expect(validateSignalCandidate('1.5', 0.7).reason).toContain('0–1');
    expect(validateSignalCandidate('0.7', 0.7).reason).toContain('没有变化就没有提案');
  });

  it('合法值 → 通过并给出数值', () => {
    expect(validateSignalCandidate('0.78', 0.7)).toEqual({ ok: true, value: 0.78 });
  });
});

describe('scanResultLabel（扫描摘要）', () => {
  it('没有信号时明说"未达门槛 ≠ 没问题"，并列出扫了什么', () => {
    const label = scanResultLabel({
      derived: 0,
      created: 0,
      refreshed: 0,
      decisionsPreserved: 0,
      rejected: [],
      windowDays: 30,
      memory: { notificationScanned: 12, openQualityAlerts: 1, pendingQualityReminders: 0, deviationObjects: 2 },
    });
    expect(label).toContain('读提醒 12 条');
    expect(label).toContain('未达门槛 ≠ 现场没问题');
  });

  it('有信号时给出新增/刷新/保留决定，并暴露契约未通过条数', () => {
    const label = scanResultLabel({
      derived: 3,
      created: 2,
      refreshed: 1,
      decisionsPreserved: 1,
      rejected: [{ signalId: 'SIG-X', errors: ['bad'] }],
      windowDays: 7,
      memory: { notificationScanned: 40, openQualityAlerts: 6, pendingQualityReminders: 3, deviationObjects: 1 },
    });
    expect(label).toContain('窗口 7 天');
    expect(label).toContain('保留人的决定 1');
    expect(label).toContain('契约校验未通过 1 条');
  });
});

describe('信号文案（封闭词表）', () => {
  it('类型与方向标签；未知值原样透出（不猜）', () => {
    expect(learningSignalKindLabel('deviation_repeat')).toBe('执行偏差复发');
    expect(learningSignalKindLabel('magic')).toBe('magic');
    expect(learningSignalDirectionLabel('lower')).toContain('收紧');
    expect(learningSignalDirectionLabel('investigate')).toBe('方向待查');
  });
});


/* ── NO-55a：改进行动项的展示口径 ─────────────────────────────────────── */

function actionFixture(overrides: Record<string, unknown> = {}) {
  return {
    actionId: 'ACT-lesson-RTR-1-check-backup-device',
    sourceType: 'retrospective_lesson',
    sourceRef: 'RTR-1',
    title: '交接时未核对备用设备',
    detail: '交接清单里没有备用设备状态',
    kind: 'process_change',
    kindSource: 'suggested',
    priority: 'high',
    status: 'proposed',
    evidenceRefs: [
      { type: 'retrospective', id: 'RTR-1', at: '2026-09-11T08:00:00.000Z' },
      { type: 'lesson', id: 'RTR-1#交接时未核对备用设备', at: '2026-09-11T08:00:00.000Z' },
    ],
    detectedAt: '2026-09-12T08:00:00.000Z',
    ...overrides,
  } as never;
}

describe('buildImprovementActionView（行动项展示口径）', () => {
  const NOW = Date.parse('2026-09-12T08:00:00.000Z');

  it('待接受：显示来源/证据/未指派/未设期限，并给接受入口', () => {
    const view = buildImprovementActionView(actionFixture(), NOW);
    expect(view.statusLabel).toBe('待接受');
    expect(view.canAccept).toBe(true);
    expect(view.canDecide).toBe(true);
    expect(view.ownerLabel).toBe('未指派负责人');
    expect(view.dueLabel).toBe('未设期限');
    expect(view.sourceLabel).toContain('复盘经验');
    expect(view.evidenceLabel).toContain('证据 2 条');
    expect(view.kindSuggested).toBe(true);
  });

  it('对象归属：有归属显示对象并标可度量；没有归属必须显式说"不可度量"（不显示成没有复发）', () => {
    const bound = buildImprovementActionView(
      actionFixture({ subjectType: 'device', subjectId: 'DEV-04' }),
      NOW,
    );
    expect(bound.measurable).toBe(true);
    expect(bound.subjectLabel).toBe('对象归属：设备 DEV-04');

    const person = buildImprovementActionView(
      actionFixture({ subjectType: 'person', subjectId: 'person:63000000-0000-4000-8000-000000000001' }),
      NOW,
    );
    // 展示用裸 id（前缀只说明类型，页面已用类型标签表达）
    expect(person.subjectLabel).toBe('对象归属：人员 63000000-0000-4000-8000-000000000001');
    const station = buildImprovementActionView(
      actionFixture({ subjectType: 'station', subjectId: 'station:WS-12' }),
      NOW,
    );
    expect(station.subjectLabel).toContain('工位');

    const unbound = buildImprovementActionView(actionFixture(), NOW);
    expect(unbound.measurable).toBe(false);
    expect(unbound.subjectLabel).toBe('对象归属：未绑定（复发不可度量）');
  });

  it('归属半成品（只有一半/未知类型）按未绑定处理，不猜对象', () => {
    for (const half of [
      { subjectType: 'device' },
      { subjectId: 'DEV-04' },
      { subjectType: 'robot', subjectId: 'R-1' },
      { subjectType: '', subjectId: 'DEV-04' },
    ]) {
      const view = buildImprovementActionView(actionFixture(half), NOW);
      expect(view.measurable).toBe(false);
      expect(view.subjectLabel).toContain('未绑定');
    }
  });

  it('逾期：未完成 + 期限已过才标逾期（没有期限不判逾期）', () => {
    const overdue = buildImprovementActionView(
      actionFixture({ status: 'accepted', owner: 'P-1', dueAt: '2026-09-10T00:00:00.000Z' }),
      NOW,
    );
    expect(overdue.overdue).toBe(true);
    expect(overdue.statusLabel).toContain('已逾期');
    const noDue = buildImprovementActionView(actionFixture({ status: 'accepted', owner: 'P-1' }), NOW);
    expect(noDue.overdue).toBe(false);
    const done = buildImprovementActionView(
      actionFixture({ status: 'completed', dueAt: '2026-09-01T00:00:00.000Z', outcomeNote: '已加入模板' }),
      NOW,
    );
    expect(done.overdue).toBe(false);
    expect(done.outcomeLabel).toContain('已加入模板');
    expect(done.canDecide).toBe(false);
  });

  it('缺口来源与已接受状态的口径', () => {
    const view = buildImprovementActionView(
      actionFixture({
        sourceType: 'retrospective_gap',
        kind: 'tooling',
        kindSource: 'human',
        status: 'accepted',
        owner: 'P-2',
        dueAt: '2026-09-30T00:00:00.000Z',
        acceptanceCriteria: '停机时长可从回执重建',
      }),
      NOW,
    );
    expect(view.sourceLabel).toContain('复盘缺口');
    expect(view.kindSuggested).toBe(false);
    expect(view.canAccept).toBe(false);
    expect(view.canComplete).toBe(true);
    expect(view.acceptanceLabel).toContain('停机时长');
  });
});

describe('行动项文案与校验', () => {
  it('类型/状态/优先级标签；未知值原样透出（不猜）', () => {
    expect(improvementKindLabel('threshold_review')).toContain('阈值复核');
    expect(improvementKindLabel('magic')).toBe('magic');
    expect(improvementStatusLabel('dropped')).toBe('已放弃');
    expect(improvementPriorityLabel('high')).toBe('高');
  });

  it('isImprovementOverdue：终态永不逾期', () => {
    expect(isImprovementOverdue({ status: 'rejected', dueAt: '2020-01-01T00:00:00.000Z' }, Date.now())).toBe(false);
    expect(isImprovementOverdue({ status: 'proposed', dueAt: null }, Date.now())).toBe(false);
  });

  it('validateAcceptance：负责人/期限/判据三项必填', () => {
    expect(validateAcceptance({}).reason).toContain('负责人');
    expect(validateAcceptance({ owner: 'P-1' }).reason).toContain('期限');
    expect(validateAcceptance({ owner: 'P-1', dueAt: '不是日期' }).reason).toContain('日期');
    expect(validateAcceptance({ owner: 'P-1', dueAt: '2026-09-30' }).reason).toContain('验收判据');
    expect(validateAcceptance({ owner: 'P-1', dueAt: '2026-09-30', acceptanceCriteria: 'c' }).ok).toBe(true);
  });

  it('improvementScanLabel：说清读了什么，并区分"没有需要行动的"与"没读"', () => {
    const empty = improvementScanLabel({
      scannedRetrospectives: 2,
      derived: 0,
      created: 0,
      refreshed: 0,
      decisionsPreserved: 0,
      rejected: [],
      memory: { publishedRetrospectives: 2, lessons: 5, gaps: 0 },
    });
    expect(empty).toContain('读已发布复盘 2 篇');
    expect(empty).toContain('没有需要行动的经验或缺口');
    const created = improvementScanLabel({
      scannedRetrospectives: 2,
      derived: 3,
      created: 2,
      refreshed: 1,
      decisionsPreserved: 1,
      rejected: [{ actionId: 'x' }],
      memory: { publishedRetrospectives: 2, lessons: 5, gaps: 1 },
    });
    expect(created).toContain('保留人的决定 1');
    expect(created).toContain('契约未通过 1 条');
  });
});

/* ── NO-58a：复发度量（完成前后计数，只是事实） ───────────────────────── */

describe('buildRecurrenceView（复发度量口径）', () => {
  const base = {
    windowDays: 30,
    before: { from: '2026-08-19T00:00:00.000Z', to: '2026-09-18T00:00:00.000Z', deviations: 3 },
    after: { from: '2026-09-18T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', deviations: 0 },
    conclusion: 'recurrence_dropped',
    reason: '完成前 3 次 / 完成后 0 次：复发计数下降',
    notes: ['观察期未结束（完成后 1 天）——结论会随后续数据变化'],
    subjectType: 'device',
    subjectId: 'DEV-04',
  };

  it('下降：给计数与窗口，并明确"不等于这条改进有效"', () => {
    const view = buildRecurrenceView(base);
    expect(view.conclusion).toBe('复发计数下降');
    expect(view.tone).toBe('positive');
    expect(view.measurable).toBe(true);
    expect(view.beforeLabel).toContain('3 次');
    expect(view.afterLabel).toContain('0 次');
    expect(view.windowLabel).toBe('窗口 30 天');
    expect(view.disclaimer).toContain('不等于');
    expect(view.noteLabel).toContain('观察期未结束');
  });

  it('未下降同样是"计数事实"（不许反向说成"改进无效"）', () => {
    const view = buildRecurrenceView({ ...base, conclusion: 'recurrence_persisted', reason: '未下降' });
    expect(view.tone).toBe('warning');
    expect(view.disclaimer).toContain('不等于');
  });

  it('未绑定对象 → 不可度量（不是"没有复发"）', () => {
    const view = buildRecurrenceView({
      ...base,
      subjectType: null,
      subjectId: null,
      conclusion: 'no_subject',
      reason: '这条行动项没有对象归属 → 复发不可度量（不硬算）',
      before: { from: '', to: '', deviations: 0 },
      after: { from: '', to: '', deviations: 0 },
    });
    expect(view.measurable).toBe(false);
    expect(view.conclusion).toContain('不可度量');
    expect(view.beforeLabel).toContain('—');
    expect(view.disclaimer).toBeNull();
  });

  it('未完成/样本不足：不给趋势结论，也不出现"有效"字样', () => {
    const notCompleted = buildRecurrenceView({ ...base, conclusion: 'not_completed', reason: '尚未完成' });
    expect(notCompleted.conclusion).toContain('未完成');
    expect(notCompleted.disclaimer).toBeNull();
    const thin = buildRecurrenceView({ ...base, conclusion: 'insufficient_sample', reason: '样本不足' });
    expect(thin.conclusion).toContain('样本不足');
    expect(thin.disclaimer).toBeNull();
  });

  it('未知结论如实透出（不猜成某个已知结论）', () => {
    const view = buildRecurrenceView({ ...base, conclusion: 'brand_new_thing', reason: 'r' });
    expect(view.conclusion).toContain('brand_new_thing');
    expect(view.tone).toBe('neutral');
  });
});

describe('对象归属的纯函数口径', () => {
  it('improvementSubjectLabel / measurable：成对 + 已知类型才可度量', () => {
    expect(improvementSubjectMeasurable('device', 'DEV-04')).toBe(true);
    expect(improvementSubjectMeasurable('device', '  ')).toBe(false);
    expect(improvementSubjectMeasurable(null, 'DEV-04')).toBe(false);
    expect(improvementSubjectMeasurable('robot', 'R-1')).toBe(false);
    expect(improvementSubjectLabel('station', 'station:WS-12')).toBe('对象归属：工位 WS-12');
    expect(improvementSubjectLabel(undefined, undefined)).toContain('不可度量');
  });
});
