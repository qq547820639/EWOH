import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveProposal,
  createOutcomeAnnotation,
  createProposal,
  getThresholdBaseline,
  getTrainingSamples,
  listEvaluations,
  listProposals,
  listRecentAnnotations,
  rejectProposal,
  retrainTaskDurationModel,
  rollbackProposal,
  runEvaluation,
  shadowEvaluateProposal,
} from '../../api/learning';
import type { LearningProposalRecord } from '../../api/learning';
import { RetrospectivePanel } from './RetrospectivePanel';
import { LearningSignalsCard } from './LearningSignalsCard';
import { ImprovementActionsCard } from './ImprovementActionsCard';
import { getAuthUser } from '../../lib/auth';
import { parseError } from '../../lib/errorContract';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import {
  buildProposalView,
  buildThresholdBaselineView,
  buildAnnotationSummary,
  describeProposalCreation,
  explainProposalError,
  explainRetrainError,
  formatModelAccuracy,
  isApprovalRole,
  isSelfApprovalBlocked,
  OUTCOME_KINDS,
  OUTCOME_TARGET_TYPES,
  outcomeTargetLabel,
  sortProposalsForReview,
  summarizeEligibility,
  validateAnnotationInput,
  validateCandidateValue,
  type ProposalActionView,
} from './learningConsoleLogic';

/**
 * 学习控制台（学习段用户流程）。
 *
 * 把此前只有后端、没有用户面的"反馈 → 评估 → 提案 → 影子 → 人审 → 回滚 /
 * 时长模型重训"接成一条可操作、可追溯的流程。三条硬约束：
 *  1. 激活阶梯（批准/拒绝/回滚）是**人审写路径**，仅 workshop_lead /
 *     global_admin 可触发；本页按角色禁用并说明，服务端仍是权威。
 *  2. 缺失不得伪装：准确率缺标注显示"未标注"；样本不足显示原因而非空结论。
 *  3. 模拟/人工回执永不参与生产训练——资格摘要按原因展示被排除的数量。
 */

function ProposalCard({
  view,
  canApprove,
  onChanged,
}: {
  view: ProposalActionView;
  canApprove: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState('');
  const needsReason = view.actions.includes('reject') || view.actions.includes('rollback');

  const mutate = useMutation({
    mutationFn: async (action: 'shadow' | 'approve' | 'reject' | 'rollback') => {
      if (action === 'shadow') return shadowEvaluateProposal(view.proposalId);
      if (action === 'approve') return approveProposal(view.proposalId);
      if (action === 'reject') return rejectProposal(view.proposalId, reason.trim());
      return rollbackProposal(view.proposalId, reason.trim());
    },
    onSuccess: onChanged,
  });

  const approvalBlocked = view.requiresApprovalRole && !canApprove;
  // B5 同族审批独立性：提议人不得批准自己的提案（仅 approve；拒绝=撤回仍允许）。
  const selfApprovalBlocked = isSelfApprovalBlocked(view, 'approve');
  // 影子评估缺事实窗口 / 非法状态转移 / 自批都属于正常业务状态，翻译后再展示。
  const error = mutate.error ? explainProposalError(parseError(mutate.error).message) : null;

  return (
    <article className="rounded-lg border border-border p-4" data-testid={`proposal-${view.proposalId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{view.proposalId}</h3>
        <span className="rounded bg-muted px-2 py-0.5 text-xs" data-testid="proposal-status">{view.statusLabel}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">变更：{view.changeSummary}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        提议人：{view.proposedBy ?? '未记录（存量提案，服务端回避校验对该行放行）'}
      </p>
      <p className="mt-1 text-xs" data-testid="proposal-shadow">{view.shadowSummary}</p>
      {(view.auditTrail.approvedBy || view.auditTrail.rejectedBy || view.auditTrail.rolledBackBy) && (
        <dl className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {view.auditTrail.approvedBy && <div>批准：{view.auditTrail.approvedBy}</div>}
          {view.auditTrail.rejectedBy && <div>拒绝：{view.auditTrail.rejectedBy}（{view.auditTrail.rejectedReason || '未填理由'}）</div>}
          {view.auditTrail.rolledBackBy && <div>回滚：{view.auditTrail.rolledBackBy}（{view.auditTrail.rolledBackReason || '未填理由'}）</div>}
        </dl>
      )}

      {error && <p className="mt-2 text-xs text-risk-blocked-foreground" role="alert">{error}</p>}

      {view.actions.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">该状态为终态，无可用动作。</p>
      ) : (
        <div className="mt-3 space-y-2 border-t pt-3">
          {needsReason && (
            <label htmlFor={`proposal-reason-${view.proposalId}`} className="block text-xs">
              理由（拒绝/回滚必填，写入审计）
              <input
                id={`proposal-reason-${view.proposalId}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                placeholder="填写理由"
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {view.actions.includes('shadow') && (
              <Button size="sm" variant="outline" disabled={mutate.isPending}
                onClick={() => mutate.mutate('shadow')}>运行影子评估</Button>
            )}
            {view.actions.includes('approve') && (
              <Button size="sm" disabled={mutate.isPending || approvalBlocked || selfApprovalBlocked}
                data-testid={`approve-${view.proposalId}`}
                onClick={() => mutate.mutate('approve')}>批准生效</Button>
            )}
            {view.actions.includes('reject') && (
              <Button size="sm" variant="outline" disabled={mutate.isPending || approvalBlocked || !reason.trim()}
                onClick={() => mutate.mutate('reject')}>拒绝</Button>
            )}
            {view.actions.includes('rollback') && (
              <Button size="sm" variant="outline" disabled={mutate.isPending || approvalBlocked || !reason.trim()}
                onClick={() => mutate.mutate('rollback')}>回滚</Button>
            )}
          </div>
          {approvalBlocked && (
            <p className="text-xs text-risk-degraded-foreground" data-testid="approval-blocked">
              批准/拒绝/回滚属于人审写路径，需要班组长或全局管理员角色（服务端强制）。
            </p>
          )}
          {selfApprovalBlocked && !approvalBlocked && (
            <p className="text-xs text-risk-degraded-foreground" data-testid={`self-approval-${view.proposalId}`}>
              本提案由你提出，需他人审批：按 B5 审批独立性，服务端会拒绝本人批准
              （拒绝/撤回自己的提案仍可执行）。
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 阈值基线 + 受控变更提案面板。
 *
 * 为什么需要它：反馈腿此前只有"读提案 / 审批"的界面，没有**提出**变更的入口，
 * 也没有地方能看清"当前生效的到底是什么值、这个值是谁批的"。结果是提议者
 * 只能猜基线（决策原则 5 要求来源/更新时间/影响面可见），而"提案"这一环在
 * 产品上实际不可达。
 *
 * 边界（写死在 UI 文案里，避免被误读）：
 *  - 这里只**提出**提案，不激活任何策略；激活必经他人人审（B5 生成人回避）。
 *  - 候选值必须落在契约允许的 0–1 且与当前生效值不同（no-op 会被契约拒绝）。
 *  - 影子证据由服务端从库内事实重放，UI 不提供"上传事实"的口子。
 */
function ThresholdProposalPanel({ onCreated }: { onCreated: () => void }): React.ReactElement {
  const baselineQuery = useQuery({
    queryKey: ['learning', 'thresholds'],
    queryFn: getThresholdBaseline,
    staleTime: 15_000,
  });
  const baseline = useMemo(
    () => buildThresholdBaselineView(baselineQuery.data ?? null),
    [baselineQuery.data],
  );
  const [selected, setSelected] = useState('');
  const [candidate, setCandidate] = useState('');
  const entry = baseline.entries.find((e) => `${e.ruleId}\u0000${e.parameter}` === selected)
    ?? baseline.entries[0];
  const entryKey = entry ? `${entry.ruleId}\u0000${entry.parameter}` : '';
  const baselineValue = entry && entry.hasNumericBaseline ? Number(entry.effectiveLabel) : null;
  const validation = validateCandidateValue(candidate, baselineValue);
  const candidateError = validation.ok ? null : (validation.reason ?? '候选值无效。');
  const candidateValue = validation.ok ? validation.value : undefined;

  const propose = useMutation({
    mutationFn: () => {
      if (!entry || baselineValue === null || typeof candidateValue !== 'number') {
        throw new Error('候选值无效');
      }
      return createProposal({
        ruleId: entry.ruleId,
        parameter: entry.parameter,
        baselineValue,
        candidateValue,
      });
    },
    onSuccess: () => {
      setCandidate('');
      onCreated();
    },
  });
  const proposeError = propose.error ? explainProposalError(parseError(propose.error).message) : null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">阈值基线与受控变更</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {baselineQuery.isError && (
          <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground" role="alert">
            阈值基线获取失败：{parseError(baselineQuery.error).message}。看不到基线时不应凭猜测提案。
          </p>
        )}
        {baselineQuery.isLoading && <p className="text-sm text-muted-foreground">正在读取阈值基线…</p>}
        {!baselineQuery.isLoading && !baselineQuery.isError && baseline.entries.length === 0 && (
          <p className="text-sm text-muted-foreground">当前没有可提案的规则阈值（服务端未返回基线条目）。</p>
        )}
        {baseline.entries.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {baseline.readAtLabel} · 推理引擎版本 {baseline.engineVersion}
          </p>
        )}
        <ul className="space-y-2">
          {baseline.entries.map((item) => (
            <li key={`${item.ruleId}-${item.parameter}`} className="rounded border border-border p-3 text-xs">
              <p className="font-medium text-foreground">
                {item.ruleId} · {item.parameter}
              </p>
              <p className="mt-1" data-testid={`threshold-effective-${item.parameter}`}>
                当前生效值：<strong>{item.effectiveLabel}</strong>
                {item.fromApprovedProposal ? '（已批准提案覆盖）' : '（引擎内置常量）'}
              </p>
              <p className="mt-1 text-muted-foreground" data-testid={`threshold-source-${item.parameter}`}>
                来源：{item.sourceLabel}
              </p>
              <p className="mt-1 text-muted-foreground">{item.countsLabel}</p>
            </li>
          ))}
        </ul>

        {entry && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium">提出受控变更（仅登记提案，不激活）</p>
            {entry.proposeBlockedReason && (
              <p className="text-xs text-risk-degraded-foreground" role="alert" data-testid="propose-blocked">
                {entry.proposeBlockedReason}
              </p>
            )}
            {baseline.entries.length > 1 && (
              <label htmlFor="proposal-target" className="block text-xs">
                变更对象
                <select
                  id="proposal-target"
                  value={selected || entryKey}
                  onChange={(event) => setSelected(event.target.value)}
                  className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                >
                  {baseline.entries.map((item) => (
                    <option key={`${item.ruleId}-${item.parameter}`} value={`${item.ruleId}\u0000${item.parameter}`}>
                      {item.ruleId} · {item.parameter}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label htmlFor="proposal-candidate" className="block text-xs">
              候选阈值（0–1，须与当前生效值不同）
              <input
                id="proposal-candidate"
                data-testid="proposal-candidate"
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                inputMode="decimal"
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                placeholder={baselineValue === null ? '当前基线未知' : `当前 ${baselineValue}`}
                disabled={entry.proposeBlockedReason !== null}
              />
            </label>
            {candidate.trim() !== '' && candidateError && (
              <p className="text-xs text-risk-degraded-foreground" role="alert" data-testid="candidate-error">
                {candidateError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  propose.isPending
                  || Boolean(entry.proposeBlockedReason)
                  || baselineValue === null
                  || !validation.ok
                }
                data-testid="propose-submit"
                onClick={() => propose.mutate()}
              >
                {propose.isPending ? '提交中…' : '提交提案（待人审）'}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                提案不会自动生效：需班组长/全局管理员审批，且提议人不得审批自己的提案。
              </span>
            </div>
            {proposeError && (
              <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-xs text-risk-degraded-foreground" role="alert" data-testid="propose-error">
                {proposeError}
              </p>
            )}
            {propose.data && (
              <p className="rounded border border-border bg-muted p-3 text-xs" role="status" data-testid="propose-result">
                {describeProposalCreation(
                  propose.data.created,
                  propose.data.proposal?.status,
                  propose.data.proposal?.proposalId,
                )}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 结果标注面板（学习回路"经验"一环的真值入口）。
 *
 * 为什么需要它：执行结果回库只是事实，学习评估需要人对"这个方案/决策到底
 * 效果如何"给出结构化判定（成功/部分成功/失败/无效 + 可选度量）。此前
 * POST /api/learning/annotations 只有后端没有用户面，模型准确率因此永远是
 * "未标注"——评估只能算接受率/延误这类粗统计，无法校准到结果质量。
 *
 * 诚信边界（写死在 UI 文案里）：
 *  - 判定人由服务端会话推导（请求体传入会被忽略），UI 不展示伪造空间；
 *  - 标注不改任何生产规则、不直接参与调度——它只是学习评估的真值输入；
 *  - 度量快照可选，缺省 = 不携带不猜测（§33）。
 */
function OutcomeAnnotationPanel(): React.ReactElement {
  const client = useQueryClient();
  const recentQuery = useQuery({
    queryKey: ['learning', 'annotations-recent'],
    queryFn: () => listRecentAnnotations(undefined, 20),
    staleTime: 15_000,
  });

  const [targetType, setTargetType] = useState<string>('plan');
  const [targetId, setTargetId] = useState('');
  const [outcomeKind, setOutcomeKind] = useState<string>('success');
  const [measured, setMeasured] = useState('');
  const [comment, setComment] = useState('');
  const validation = validateAnnotationInput({ targetType, targetId, outcomeKind, measured, comment });

  const annotate = useMutation({
    mutationFn: () => {
      if (!validation.ok) throw new Error(validation.reason ?? '标注输入无效');
      return createOutcomeAnnotation({
        targetType: validation.targetType!,
        targetId: targetId.trim(),
        outcomeKind: validation.outcomeKind!,
        measured: validation.measured,
        comment: comment.trim() === '' ? undefined : comment.trim(),
      });
    },
    onSuccess: () => {
      setTargetId('');
      setMeasured('');
      setComment('');
      void client.invalidateQueries({ queryKey: ['learning', 'annotations-recent'] });
    },
  });
  const annotateError = annotate.error ? parseError(annotate.error).message : null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">结果标注（运行记忆的真值来源）</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          对已终结的方案 / 决策 / 提案给出结果判定，供学习评估引用。判定人取当前登录身份（服务端强制）；
          标注只进入学习评估，不会修改任何生产规则或调度行为。
        </p>

        {recentQuery.isError && (
          <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground" role="alert">
            最近标注获取失败：{parseError(recentQuery.error).message}
          </p>
        )}
        {recentQuery.isLoading && <p className="text-sm text-muted-foreground">正在读取最近标注…</p>}

        <div className="space-y-2" data-testid="annotation-form">
          <div className="grid gap-2 sm:grid-cols-2">
            <label htmlFor="annotation-target-type" className="block text-xs">
              对象类型
              <select
                id="annotation-target-type"
                value={targetType}
                onChange={(event) => setTargetType(event.target.value)}
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
              >
                {OUTCOME_TARGET_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <label htmlFor="annotation-target-id" className="block text-xs">
              目标编号（如方案 / 决策 ID）
              <input
                id="annotation-target-id"
                data-testid="annotation-target-id"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                maxLength={200}
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                placeholder="粘贴待评定的对象 ID"
              />
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label htmlFor="annotation-outcome-kind" className="block text-xs">
              结果判定
              <select
                id="annotation-outcome-kind"
                value={outcomeKind}
                onChange={(event) => setOutcomeKind(event.target.value)}
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
              >
                {OUTCOME_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>
            <label htmlFor="annotation-measured" className="block text-xs">
              度量快照（可选，key=value 逗号分隔）
              <input
                id="annotation-measured"
                data-testid="annotation-measured"
                value={measured}
                onChange={(event) => setMeasured(event.target.value)}
                className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                placeholder="如 delayMs=1200, onTime=1"
              />
            </label>
          </div>
          <label htmlFor="annotation-comment" className="block text-xs">
            备注（可选，写入审计）
            <textarea
              id="annotation-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={1000}
              rows={2}
              className="mt-1 block w-full rounded border px-3 py-2 text-sm"
              placeholder="补充现场事实：发生了什么、依据是什么"
            />
          </label>
          {!validation.ok && (targetId.trim() !== '' || measured.trim() !== '') && (
            <p className="text-xs text-risk-degraded-foreground" role="alert" data-testid="annotation-error">
              {validation.reason}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!validation.ok || annotate.isPending}
              data-testid="annotation-submit"
              onClick={() => annotate.mutate()}
            >
              {annotate.isPending ? '提交中…' : '提交标注'}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              判定人 = 当前登录账号（服务端会话推导，不可代他人标注）
            </span>
          </div>
          {annotateError && (
            <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-xs text-risk-degraded-foreground" role="alert" data-testid="annotation-request-error">
              {annotateError}
            </p>
          )}
          {annotate.data && (
            <p className="rounded border border-border bg-muted p-3 text-xs" role="status" data-testid="annotation-result">
              {annotate.data.created
                ? `标注已记录：${annotate.data.annotation.annotationId}`
                : '该标注已存在（幂等回读，未重复创建）'}
            </p>
          )}
        </div>

        <div className="border-t pt-3">
          <p className="text-xs font-medium">最近标注 <span className="text-muted-foreground">{recentQuery.data?.length ?? 0} 条</span></p>
          {!recentQuery.isLoading && (recentQuery.data ?? []).length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="annotation-empty">
              尚无标注。没有结果判定时，模型准确率只能显示"未标注"——这是如实的缺失，不会被填成 0 或 100%。
            </p>
          )}
          <ul className="mt-2 space-y-1.5">
            {(recentQuery.data ?? []).map((record) => (
              <li key={record.annotationId} className="rounded border border-border p-2 text-xs" data-testid="annotation-row">
                <p className="font-medium">{outcomeTargetLabel(record.targetType)} {record.targetId}</p>
                <p className="mt-0.5 text-muted-foreground">{buildAnnotationSummary(record)}</p>
                {record.comment && <p className="mt-0.5 text-muted-foreground">备注：{record.comment}</p>}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export default function LearningConsole(): React.ReactElement {
  const client = useQueryClient();
  const roles = getAuthUser()?.roles ?? [];
  const currentUserId = getAuthUser()?.userId ?? null;
  const canApprove = isApprovalRole(roles);

  const samplesQuery = useQuery({
    queryKey: ['learning', 'training-samples'],
    queryFn: getTrainingSamples,
    staleTime: 30_000,
  });
  const proposalsQuery = useQuery({
    queryKey: ['learning', 'proposals'],
    queryFn: () => listProposals(),
    staleTime: 15_000,
  });
  const evaluationsQuery = useQuery({
    queryKey: ['learning', 'evaluations'],
    queryFn: () => listEvaluations(10),
    staleTime: 30_000,
  });

  const retrain = useMutation({
    mutationFn: retrainTaskDurationModel,
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['learning'] }); },
  });
  const evaluate = useMutation({
    mutationFn: () => runEvaluation({ evaluationType: 'on_demand' }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['learning'] }); },
  });

  const eligibility = useMemo(() => summarizeEligibility(samplesQuery.data ?? null), [samplesQuery.data]);
  /** 提案视图与原始记录配对（排序一次，渲染与计数共用同一结果）。 */
  const proposals = useMemo(
    () => sortProposalsForReview((proposalsQuery.data ?? []).map((p) => buildProposalView(p, roles, currentUserId)))
      .map((view) => ({
        view,
        record: (proposalsQuery.data ?? []).find((p) => p.proposalId === view.proposalId) as LearningProposalRecord,
      }))
      .filter((entry) => Boolean(entry.record)),
    [proposalsQuery.data, roles, currentUserId],
  );
  const latest = evaluationsQuery.data?.[0];
  const retrainError = explainRetrainError(retrain.error ? parseError(retrain.error).message : null);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">学习控制台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          从已核实的执行结果出发，评估 → 提案 → 影子 → 人审 → 回滚，并重训时长模型。
          所有结论都标注证据来源与缺口，样本不足时不会落版。
        </p>
      </header>

      {/* 训练样本资格：先说清"能不能学、为什么不能学" */}
      <Card>
        <CardHeader><CardTitle className="text-sm">训练样本资格</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {samplesQuery.isError && (
            <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground" role="alert">
              样本资格获取失败：{parseError(samplesQuery.error).message}。无法判断能否重训。
            </p>
          )}
          <p className="text-sm" data-testid="eligibility-verdict">{eligibility.verdict}</p>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>可训练样本 <strong className="text-foreground" data-testid="trainable-count">{eligibility.trainable}</strong> 条</span>
            <span>门槛 ≥{eligibility.minRequired} 条</span>
            <span>参与统计的反馈行 {samplesQuery.data?.totalFeedbackRows ?? '未知'}</span>
            <span>资格策略 {samplesQuery.data?.eligibilityPolicy ?? '未知'}</span>
          </div>
          {eligibility.excluded.length > 0 && (
            <div>
              <p className="text-xs font-medium">被排除的样本（不计入训练）</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {eligibility.excluded.map((entry) => (
                  <li key={entry.reason}>{entry.label}：{entry.count} 条</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={retrain.isPending}
              onClick={() => retrain.mutate()}
            >
              {retrain.isPending ? '重训中…' : '重训时长模型'}
            </Button>
            <Button size="sm" variant="outline" disabled={samplesQuery.isFetching}
              onClick={() => void samplesQuery.refetch()}>刷新样本资格</Button>
          </div>
          {retrainError && (
            <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground" role="alert">
              {retrainError}
            </p>
          )}
          {retrain.data && (
            <div className="rounded border border-border bg-muted p-3 text-xs" role="status">
              <p>
                已落版 {retrain.data.modelId} {retrain.data.version}
                （样本 {retrain.data.n ?? '未知'} 条，中位数 {retrain.data.medianMs ?? '未知'} ms，p90 {retrain.data.p90Ms ?? '未知'} ms）
              </p>
              {retrain.data.lineage && (
                <p className="mt-1 text-muted-foreground">
                  谱系：来自 {retrain.data.lineage.trainedFrom}，资格策略 {retrain.data.lineage.eligibilityPolicy}，
                  本次可训练样本 {retrain.data.lineage.trainableSamples ?? '未知'} 条。
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 最新评估 */}
      <Card>
        <CardHeader><CardTitle className="text-sm">最新学习评估</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Button size="sm" variant="outline" disabled={evaluate.isPending} onClick={() => evaluate.mutate()}>
              {evaluate.isPending ? '评估中…' : '运行一次评估'}
            </Button>
            <span>历史评估 {evaluationsQuery.data?.length ?? 0} 条</span>
          </div>
          {evaluationsQuery.isError && (
            <p className="text-sm text-risk-degraded-foreground" role="alert">
              评估记录获取失败：{parseError(evaluationsQuery.error).message}
            </p>
          )}
          {!evaluationsQuery.isLoading && !latest && (
            <p className="text-sm text-muted-foreground">尚无评估记录。评估使用决策与结果事实，不猜测缺失标注。</p>
          )}
          {latest && (
            <dl className="grid gap-2 text-xs sm:grid-cols-3">
              <div><dt className="text-muted-foreground">评估编号</dt><dd>{latest.evalId}</dd></div>
              <div><dt className="text-muted-foreground">类型</dt><dd>{latest.evaluationType ?? '未标注'}</dd></div>
              <div>
                <dt className="text-muted-foreground">模型准确率</dt>
                <dd data-testid="model-accuracy">{formatModelAccuracy(latest.modelAccuracy)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      {/* 结果标注：评估与准确率的真值输入（执行结果 → 人判结果 → 学习） */}
      <OutcomeAnnotationPanel />

      {/* DR-3 复盘/运行记忆：闭环六段组装 + AI 总结（学习闭环第⑩步的可追溯产物） */}
      <RetrospectivePanel />

      {/* NO-54a：运行记忆信号（提醒治理/数据质量积压/偏差复发 → 带证据的信号） */}
      <LearningSignalsCard />

      {/* NO-55a：改进行动项（复盘经验/缺口 → 有人负责、有期限、有完成证据的行动） */}
      <ImprovementActionsCard />

      {/* 阈值基线 + 受控变更提案（读基线 → 提出候选；绝不激活） */}
      <ThresholdProposalPanel
        onCreated={() => {
          void client.invalidateQueries({ queryKey: ['learning', 'proposals'] });
          void client.invalidateQueries({ queryKey: ['learning', 'thresholds'] });
        }}
      />

      {/* 学习提案与人审阶梯 */}
      <section aria-labelledby="proposals-title">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 id="proposals-title" className="text-sm font-semibold">学习提案与人审</h2>
          <span className="text-xs text-muted-foreground">{proposals.length} 条</span>
          {!canApprove && (
            <span className="text-xs text-risk-degraded-foreground">
              当前角色不可批准/拒绝/回滚（需班组长或全局管理员）
            </span>
          )}
        </div>
        {proposalsQuery.isError && (
          <p className="mt-3 text-sm text-risk-degraded-foreground" role="alert">
            提案获取失败：{parseError(proposalsQuery.error).message}
          </p>
        )}
        {!proposalsQuery.isLoading && proposals.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">当前没有学习提案。</p>
        )}
        <div className="mt-3 space-y-3">
          {proposals.map(({ view, record }) => (
            <ProposalCard
              key={view.proposalId}
              view={view}
              canApprove={canApprove}
              onChanged={() => { void client.invalidateQueries({ queryKey: ['learning', 'proposals'] }); }}
            />
          ))}
        </div>
      </section>

      <footer className="rounded-lg border border-border bg-muted p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">学习边界</p>
        <p className="mt-1">
          提案由平台事实与规则生成，<strong>不会自动生效</strong>——激活必经班组长/全局管理员人审并留痕；
          影子评估的证据由服务端从库内事实重建，不采信客户端提交的数据。
          时长模型只由<strong>独立设备回执</strong>训练，人工上报与模拟回执永久排除在训练集之外。
        </p>
      </footer>
    </div>
  );
}
