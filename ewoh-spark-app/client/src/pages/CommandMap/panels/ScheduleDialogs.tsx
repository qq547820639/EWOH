/* CLI-027 拆分：SchedulePanel 的确认/对比 Dialog 子组件（机械提取，行为不变）。
 *
 * 状态所有权仍在 SchedulePanel（target/reason state 经 props 注入，回调上抛）；
 * 本文件只承接 JSX 与纯展示块（ReplanPreviewBlock / DispatchSummaryBlock /
 * CompareResult），降低 SchedulePanel 单文件体量。REPLAN 确认框补 reason
 * 收集输入（CLI-029，必填写入重排审计）。
 */
import { Check, X, Send } from 'lucide-react';
import {
  replanPreviewSummary,
  dispatchPlanSummary,
} from './schedule-panel-logic';
import SolverStatusChain from './SolverStatusChain';
import { PLAN_STATUS_LABELS } from '../vm/planStatusStepVM';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  PersonnelInfo,
  ReplanPreviewResult,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@client/src/components/ui/dialog';
import { Textarea } from '@client/src/components/ui/textarea';

/** Task 10 / 10.2：REPLAN 确认对话框的预览摘要块（数据全部来自后端 dry-run）。 */
export function ReplanPreviewBlock({
  preview,
  plan,
}: {
  preview: ReplanPreviewResult;
  plan: SchedulingPlanV2;
}): React.ReactElement {
  const summary = replanPreviewSummary(preview);
  if (!summary) return <div className="py-4 text-center text-xs text-white/50">无预览数据</div>;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-1.5 text-center">
        <div className="rounded-md border border-white/10 bg-card/5 px-1 py-1.5">
          <div className="text-sm font-bold text-white/90">{summary.affectedTaskCount}</div>
          <div className="text-[9px] text-white/50">影响任务</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-1 py-1.5">
          <div className="text-sm font-bold text-risk-degraded-foreground">{summary.changedAssignmentCount}</div>
          <div className="text-[9px] text-white/50">变更分配</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-1 py-1.5">
          <div className="text-sm font-bold text-risk-normal-foreground">{summary.unchangedAssignmentCount}</div>
          <div className="text-[9px] text-white/50">不变分配</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-1 py-1.5">
          <div className="text-sm font-bold text-white/90">+{summary.addedAssignmentCount}</div>
          <div className="text-[9px] text-white/50">新增</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-1 py-1.5">
          <div className="text-sm font-bold text-risk-blocked-foreground">-{summary.removedAssignmentCount}</div>
          <div className="text-[9px] text-white/50">移除</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {summary.deltas.map((d) => (
          <div key={d.key} className="rounded-md border border-white/10 bg-card/5 px-2 py-1">
            <div className="text-[9px] text-white/50">
              {d.label} Δ{d.unit ? `（${d.unit}）` : ''}
            </div>
            <div
              className={cn(
                'text-sm font-semibold',
                d.value < 0 ? 'text-risk-normal-foreground' : d.value > 0 ? 'text-risk-blocked-foreground' : 'text-white',
              )}
            >
              {d.value > 0 ? '+' : ''}
              {d.value.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SolverStatusChain
          status={plan.solverStatus}
          solverVersion={plan.solverVersion}
          fallbackReason={plan.fallbackReason}
          solveDurationMs={plan.solveDurationMs}
        />
        <span className="text-[9px] text-white/50">
          快照 v{plan.snapshotVersion ?? '—'} · 策略 v{plan.policyVersion ?? '—'}
        </span>
      </div>
      {summary.baselinePlanId && summary.candidatePlanId && (
        <div className="text-[9px] text-white/40">
          {summary.baselinePlanId.slice(-8)} → {summary.candidatePlanId.slice(-8)}（PREVIEW，不落库）
        </div>
      )}
    </div>
  );
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-risk-normal/20 text-risk-normal-foreground border-risk-normal/30';
    case 'dispatched':
      return 'bg-risk-offline/20 text-risk-offline-foreground border-risk-offline/30';
    case 'executing':
      return 'bg-risk-offline/20 text-risk-offline-foreground border-risk-offline/30';
    case 'completed':
      return 'bg-risk-normal/20 text-risk-normal-foreground border-risk-normal/30';
    case 'rejected':
      return 'bg-risk-blocked/20 text-risk-blocked-foreground border-risk-blocked/30';
    default:
      return 'bg-risk-unknown/20 text-risk-unknown-foreground border-risk-unknown/30';
  }
}

function formatPct(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

/** Task 10 / 10.2：DISPATCH 确认对话框的方案摘要块。 */
export function DispatchSummaryBlock({ plan }: { plan: SchedulingPlanV2 }): React.ReactElement {
  const summary = dispatchPlanSummary(plan);
  if (!summary) return <div className="py-4 text-center text-xs text-white/50">无方案数据</div>;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-white/90">{summary.planName ?? summary.planId}</span>
        <Badge className={cn('text-[9px] px-1.5', statusBadgeClass(plan.status))}>
          {PLAN_STATUS_LABELS[plan.status] ?? plan.status}
        </Badge>
        <span className="text-[10px] text-white/50">VERSION {summary.version}</span>
        <SolverStatusChain
          status={plan.solverStatus}
          solverVersion={plan.solverVersion}
          fallbackReason={plan.fallbackReason}
          solveDurationMs={plan.solveDurationMs}
        />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <div className="rounded-md border border-white/10 bg-card/5 px-2 py-1">
          <div className="text-sm font-bold text-white/90">{summary.assignmentsCount}</div>
          <div className="text-[9px] text-white/50">分配数</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-2 py-1">
          <div className="text-sm font-bold text-white/90">{summary.lateMinutes.toFixed(0)} min</div>
          <div className="text-[9px] text-white/50">预计延期</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-2 py-1">
          <div className="text-sm font-bold text-white/90">{summary.walkingMeters.toFixed(0)} m</div>
          <div className="text-[9px] text-white/50">人员总移动</div>
        </div>
        <div className="rounded-md border border-white/10 bg-card/5 px-2 py-1">
          <div className="text-sm font-bold text-white/90">{formatPct(summary.maxWorkload)}</div>
          <div className="text-[9px] text-white/50">最大负荷</div>
        </div>
      </div>
      <div className="text-[9px] text-white/50">
        工位等待 {summary.stationWaitMinutes.toFixed(0)} min · 快照 v{summary.snapshotVersion ?? '—'} · 策略 v
        {summary.policyVersion ?? '—'}
      </div>
    </div>
  );
}

/** 审批通过 Dialog。 */
export function ApprovePlanDialog({
  target,
  reason,
  onReasonChange,
  pending,
  onCancel,
  onConfirm,
  confirmRef,
}: {
  target: SchedulingPlanV2 | null;
  reason: string;
  onReasonChange: (value: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmRef?: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="bg-surface-inverse-raised border-white/10 text-white" data-inverse-surface="">
        <DialogHeader>
          <DialogTitle className="text-white">审批调度方案</DialogTitle>
          <DialogDescription className="text-white/70">
            {target?.planName ?? target?.planId} · v{target?.version}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-xs text-white/60">审批理由</label>
          <Textarea
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="请输入审批理由..."
            className="bg-card/5 border-white/10 text-white"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button ref={confirmRef} size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? '提交中...' : '确认审批'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 驳回 Dialog。 */
export function RejectPlanDialog({
  target,
  reason,
  onReasonChange,
  pending,
  onCancel,
  onConfirm,
}: {
  target: SchedulingPlanV2 | null;
  reason: string;
  onReasonChange: (value: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="bg-surface-inverse-raised border-white/10 text-white" data-inverse-surface="">
        <DialogHeader>
          <DialogTitle className="text-white">驳回调度方案</DialogTitle>
          <DialogDescription className="text-white/70">
            {target?.planName ?? target?.planId} · v{target?.version}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-xs text-white/60">驳回理由（必填）</label>
          <Textarea
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="请输入驳回理由..."
            className="bg-card/5 border-white/10 text-white"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" variant="destructive" onClick={onConfirm} disabled={pending || !reason.trim()}>
            {pending ? '驳回中...' : '确认驳回'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 调整指派 Dialog。 */
export function AdjustAssignmentDialog({
  target,
  personId,
  selectedPlan,
  personnel,
  onTargetChange,
  onPersonIdChange,
  pending,
  onCancel,
  onConfirm,
  assigneeNameOf,
}: {
  target: SchedulingAssignment | null;
  personId: string;
  selectedPlan: SchedulingPlanV2 | null;
  personnel: PersonnelInfo[];
  onTargetChange: (assignment: SchedulingAssignment | null) => void;
  onPersonIdChange: (value: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  assigneeNameOf: (assignment: SchedulingAssignment) => string;
}): React.ReactElement {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="bg-surface-inverse-raised border-white/10 text-white" data-inverse-surface="">
        <DialogHeader>
          <DialogTitle className="text-white">调整指派并重排</DialogTitle>
          <DialogDescription className="text-white/70">
            锁定任务到指定人员后重新排程（原方案将被标记 superseded）
          </DialogDescription>
        </DialogHeader>
        {selectedPlan && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-white/60">任务</label>
              <select
                value={target?.taskId ?? ''}
                onChange={(e) =>
                  onTargetChange(
                    selectedPlan.assignments.find((a) => a.taskId === e.target.value) ?? null,
                  )
                }
                className="mt-1 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none"
              >
                {selectedPlan.assignments.map((a) => (
                  <option key={a.taskId} value={a.taskId}>
                    {a.taskId}（当前: {a.personId ? assigneeNameOf(a) : '未指派'}）
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-white/60">锁定人员</label>
              <select
                value={personId}
                onChange={(e) => onPersonIdChange(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none"
              >
                <option value="">请选择人员</option>
                {personnel.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（{p.id}）
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={pending || !target || !personId}>
            {pending ? '重排中...' : '锁定并重排'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** REPLAN 预览 → 确认 Dialog（含 CLI-029 reason 收集，必填）。 */
export function ReplanConfirmDialog({
  target,
  reason,
  onReasonChange,
  preview,
  previewLoading,
  previewError,
  pending,
  onCancel,
  onConfirm,
  confirmRef,
}: {
  target: SchedulingPlanV2 | null;
  reason: string;
  onReasonChange: (value: string) => void;
  preview: ReplanPreviewResult | null;
  previewLoading: boolean;
  previewError: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmRef?: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="bg-surface-inverse-raised border-white/10 text-white max-w-xl" data-inverse-surface="">
        <DialogHeader>
          <DialogTitle className="text-white">重新排程确认</DialogTitle>
          <DialogDescription className="text-white/70">
            {target?.planName ?? target?.planId} · v{target?.version}
            — 以下为后端 dry-run 预览（不落库不派工），确认后才会执行真实重排。
          </DialogDescription>
        </DialogHeader>
        {previewLoading ? (
          <div className="py-6 text-center text-xs text-white/60">正在计算重排预览…</div>
        ) : previewError ? (
          <div className="rounded-md border border-risk-blocked/30 bg-risk-blocked/10 px-3 py-2 text-xs text-risk-blocked-foreground">
            预览失败：{previewError}
            <div className="mt-1 text-[10px] text-risk-blocked-foreground/70">可关闭后重试；不会执行任何变更。</div>
          </div>
        ) : preview && target ? (
          <ReplanPreviewBlock preview={preview} plan={target} />
        ) : (
          <div className="py-6 text-center text-xs text-white/50">无预览数据</div>
        )}
        <div className="space-y-2">
          <label className="text-xs text-white/60">重排理由（必填，CLI-029 写入审计）</label>
          <Textarea
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="请输入重新排程理由..."
            className="bg-card/5 border-white/10 text-white"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={previewLoading}>
            取消
          </Button>
          <Button
            ref={confirmRef}
            size="sm"
            autoFocus
            onClick={onConfirm}
            disabled={pending || previewLoading || !preview || !!previewError || !reason.trim()}
          >
            {pending ? '重排中...' : '确认执行重新排程'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** DISPATCH 确认 Dialog。 */
export function DispatchConfirmDialog({
  target,
  pending,
  onCancel,
  onConfirm,
  confirmRef,
}: {
  target: SchedulingPlanV2 | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmRef?: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="bg-surface-inverse-raised border-white/10 text-white max-w-xl" data-inverse-surface="">
        <DialogHeader>
          <DialogTitle className="text-white">确认下发执行</DialogTitle>
          <DialogDescription className="text-white/70">
            下发后方案进入执行态，人员/设备将按此方案作业；旧方案将失效。
          </DialogDescription>
        </DialogHeader>
        {target && <DispatchSummaryBlock plan={target} />}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button ref={confirmRef} size="sm" autoFocus onClick={onConfirm} disabled={pending}>
            <Send className="w-3 h-3" />
            {pending ? '下发中...' : '确认下发'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 对比方案 Dialog。 */
export function ComparePlansDialog({
  open,
  plans,
  selectedPlan,
  comparePlanId,
  onComparePlanIdChange,
  compareResult,
  pending,
  onClose,
  onCompare,
}: {
  open: boolean;
  plans: SchedulingPlanV2[];
  selectedPlan: SchedulingPlanV2 | null;
  comparePlanId: string | null;
  onComparePlanIdChange: (value: string | null) => void;
  compareResult: Record<string, unknown> | null;
  pending: boolean;
  onClose: () => void;
  onCompare: () => void;
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-surface-inverse-raised border-white/10 text-white max-w-2xl" data-inverse-surface="">
        <DialogHeader>
          <DialogTitle className="text-white">方案对比</DialogTitle>
          <DialogDescription className="text-white/70">
            对比两套方案的分配与指标差异
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-card/10 text-white text-[9px]">A</Badge>
            <span className="text-xs text-white/80">{selectedPlan?.planName ?? selectedPlan?.planId}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-card/10 text-white text-[9px]">B</Badge>
            <select
              value={comparePlanId ?? ''}
              onChange={(e) => onComparePlanIdChange(e.target.value || null)}
              className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none"
            >
              <option value="">
                {comparePlanId ? '请选择对比方案' : '暂无其他方案可选（无兜底）'}
              </option>
              {plans.map((p) => (
                <option key={p.planId} value={p.planId}>
                  {p.planName ?? p.planId} · {p.status}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={onCompare} disabled={pending || !comparePlanId}>
              <Check className="w-3 h-3" />
              {pending ? '对比中...' : '对比'}
            </Button>
          </div>
          {compareResult && <CompareResult result={compareResult} />}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            <X className="w-3 h-3" />
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompareResult({ result }: { result: Record<string, unknown> }) {
  const metricsDelta = (result.metricsDelta ?? {}) as Record<string, number>;
  const assignmentDelta = (result.assignmentDelta ?? []) as Array<Record<string, unknown>>;
  const labels: Array<[string, string]> = [
    ['lateMinutes', '延期变化'],
    ['walkingMeters', '移动变化'],
    ['stationWaitMinutes', '等待变化'],
    ['maxWorkload', '负荷变化'],
    ['changeCost', '变更成本'],
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-2">
        {labels.map(([key, label]) => {
          const v = metricsDelta[key];
          return (
            <div key={key} className="rounded-md border border-white/10 bg-card/5 px-2 py-1.5">
              <div className="text-[9px] text-white/50">{label}</div>
              <div className={cn('text-sm font-semibold', v != null && v < 0 ? 'text-risk-normal-foreground' : v != null && v > 0 ? 'text-risk-blocked-foreground' : 'text-white')}>
                {v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
              </div>
            </div>
          );
        })}
      </div>
      <div>
        <div className="text-[10px] text-white/60 font-medium mb-1">
          分配差异（{assignmentDelta.length}）
        </div>
        <div className="max-h-40 overflow-y-auto space-y-1">
          {assignmentDelta.map((d, i) => (
            <div
              key={String(d.taskId ?? `delta-${i}`)}
              className="rounded border border-white/10 bg-card/5 px-2 py-1 text-[10px] text-white/70"
            >
              {String(d.taskId ?? '—')}：
              {d.personChanged ? '人员变更' : ''}
              {d.deviceChanged ? ' / 设备变更' : ''}
              {d.timeChanged ? ' / 时间变更' : ''}
              {d.same === true ? ' 无变化' : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
