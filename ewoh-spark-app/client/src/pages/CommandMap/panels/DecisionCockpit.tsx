// panels/DecisionCockpit.tsx — Decision Cockpit 统一决策上下文（Task 5 / P1）
//
// 消费服务端权威数据（经 useCommandMapController 的 scheduler 聚合 + 候选端点 +
// 方案 diff 端点），经 decisionContextVM 纯函数装配成 9 段决策上下文：
// WHAT_HAPPENED / WHY / IMPACT / SYSTEM_DECISION / WHY_THIS_ASSIGNMENT /
// WHY_NOT_OTHERS / COST / RECOMMENDED_ACTION / ACTIONS。
// 前端不重算资格/硬约束（VM 只映射服务端字段）；ACTIONS 复用 CommandMap 既有行为
// （Compare→方案对比 / Override→人工覆盖 / Locate→定位 / Undo→清除上下文）。

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  GitCompareArrows,
  SlidersHorizontal,
  MapPin,
  Check,
  Lock,
  Ban,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getTaskCandidates, acknowledgeConflict, listExecutions } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { getCurrentOperator } from '@client/src/lib/auth';
import { useCommandMapController } from '../hooks/useCommandMapController';
import {
  decisionContextVM,
  type DecisionActionId,
  type DecisionConflictView,
} from '../vm/decisionContextVM';
import { buildExecutionFeedbackView } from '../vm/executionFeedbackVM';
import { extractUnchangedTasks } from '../vm/planCompareVM';
import { taskMoveExplainVM } from '../vm/taskMoveExplainVM';
import TaskMoveExplain from './TaskMoveExplain';
import SolverStatusChain from './SolverStatusChain';
import type {
  PlanCompareResult,
  PlanOverrideKind,
  ReplanImpact,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Textarea } from '@client/src/components/ui/textarea';

export interface DecisionCockpitProps {
  /** 服务端权威方案 diff（PlanCompareResult；来自对比/冲突预览，可选）。 */
  planDiff?: PlanCompareResult | null;
  /** ReplanImpact（可选；也可经 store decisionContext payload 携带）。 */
  replanImpact?: ReplanImpact | null;
  /** 打开方案对比（CommandMap 现有行为：setShowCompare(true)）。 */
  onCompare?: () => void;
  /** 打开人工覆盖（CommandMap 现有行为：切到 override 标签；kind 为初始动作模式）。 */
  onOverride?: (kind?: PlanOverrideKind) => void;
  /** 定位实体（CommandMap 现有行为：ctl.selectEntity + 聚焦）。 */
  onLocate?: (entityId: string | null) => void;
  /** 人员 id → 姓名（可空；缺省显示原始 id）。 */
  personNameOf?: (id: string | null) => string | null;
}

const SECTION_TONE_CLASS: Record<string, string> = {
  positive: 'text-emerald-400',
  negative: 'text-red-400',
  warning: 'text-amber-400',
  neutral: 'text-white/80',
};

const ACTION_META: Array<{ id: DecisionActionId; label: string; icon: LucideIcon; cls?: string }> = [
  { id: 'accept', label: '确认处置', icon: Check, cls: 'text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10' },
  { id: 'compare', label: '方案对比', icon: GitCompareArrows, cls: 'text-white/80 border-white/15 hover:bg-white/10' },
  { id: 'override', label: '人工覆盖', icon: SlidersHorizontal, cls: 'text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/10' },
  { id: 'lock', label: '锁定分配', icon: Lock, cls: 'text-white/80 border-white/15 hover:bg-white/10' },
  { id: 'exclude', label: '排除资源', icon: Ban, cls: 'text-white/80 border-white/15 hover:bg-white/10' },
  { id: 'locate', label: '定位', icon: MapPin, cls: 'text-white/80 border-white/15 hover:bg-white/10' },
  { id: 'undo', label: '清除上下文', icon: Undo2, cls: 'text-white/60 border-white/10 hover:bg-white/10' },
];

function isOpenConflict(conflict: { status?: string | null } | null): boolean {
  if (!conflict) return false;
  return conflict.status !== 'RESOLVED' && conflict.status !== 'ACKNOWLEDGED';
}

function isActionAvailable(
  action: DecisionActionId,
  ctx: {
    activePlan: boolean;
    selectedTask: boolean;
    conflictOpen: boolean;
    locateTarget: boolean;
    hasDecisionContext: boolean;
  }): boolean {
  switch (action) {
    case 'accept':
      return ctx.conflictOpen;
    case 'compare':
    case 'override':
      return ctx.activePlan;
    case 'lock':
    case 'exclude':
      return ctx.activePlan && ctx.selectedTask;
    case 'locate':
      return ctx.locateTarget;
    case 'undo':
      return ctx.hasDecisionContext || ctx.activePlan || ctx.selectedTask;
    default:
      return false;
  }
}

export function DecisionCockpit({
  planDiff,
  replanImpact: replanImpactProp,
  onCompare,
  onOverride,
  onLocate,
  personNameOf,
}: DecisionCockpitProps): React.ReactElement {
  const ctl = useCommandMapController();
  const queryClient = useQueryClient();
  const taskId = ctl.selectedTaskId;
  const activePlan = ctl.activePlan;

  const currentAssignment = useMemo(
    () => activePlan?.assignments.find((a) => a.taskId === taskId) ?? null,
    [activePlan, taskId],
  );
  const trace = currentAssignment?.decisionTrace ?? null;

  const conflicts = ctl.scheduler.conflicts.items;
  const conflict = useMemo(
    () => conflicts.find((c) => c.taskIds.includes(taskId ?? '')) ?? null,
    [conflicts, taskId],
  );
  // ConflictVMItem → 决策上下文冲突展示子集（服务端字段直映）。
  const conflictView = useMemo<DecisionConflictView | null>(() => {
    if (!conflict) return null;
    return {
      type: conflict.type,
      severity: conflict.severity,
      message: conflict.message,
      resolution: conflict.resolution,
      status: conflict.status,
      detectedAt: conflict.detectedAt,
      createdAt: conflict.detectedAt ?? null,
      planId: conflict.planId,
    };
  }, [conflict]);

  // 候选资源（服务端 TaskCandidatesResponse；只读展示，不本地复算资格）。
  const { data: candidates } = useQuery({
    queryKey: queryKeys.schedulerTaskCandidates(taskId ?? 'none'),
    queryFn: () => (taskId ? getTaskCandidates(taskId) : Promise.resolve(null)),
    enabled: Boolean(taskId),
    staleTime: 30_000,
  });

  // Phase 4 执行反馈（P1 闭环）：方案执行记录（planned vs actual + deviation 事实），
  // 30s 轮询与 CommandMap 其他运营查询一致；无方案时不请求。
  const executionsQuery = useQuery({
    queryKey: queryKeys.schedulerExecutions(activePlan?.planId),
    queryFn: () => listExecutions({ planId: activePlan?.planId }),
    enabled: Boolean(activePlan?.planId),
    refetchInterval: 30_000,
  });
  const executionFeedback = useMemo(
    () =>
      buildExecutionFeedbackView({
        executions: executionsQuery.data?.executions ?? null,
        personNameOf,
      }),
    [executionsQuery.data, personNameOf],
  );

  // ReplanImpact：优先 prop，其次 store decisionContext payload（source='replan'）。
  const payloadReplanImpact = useMemo(() => {
    const ctx = ctl.decisionContext.context as { replanImpact?: ReplanImpact } | null;
    return ctx?.replanImpact ?? null;
  }, [ctl.decisionContext]);

  const replanImpact = replanImpactProp ?? payloadReplanImpact;

  // 方案级 diff 计数（服务端 PlanCompareResult；未变化任务经 extractUnchangedTasks 派生）。
  const diffCounts = useMemo(() => {
    if (!planDiff) return { changed: 0, unchanged: 0, unchangedTaskIds: [] as string[] };
    const changed = planDiff.diffByTask.length + planDiff.added.length + planDiff.removed.length;
    const candidatePlan = ctl.scheduler.plans.find((p) => p.planId === planDiff.candidatePlanId);
    const unchangedTaskIds = extractUnchangedTasks(planDiff, candidatePlan?.assignments ?? []);
    return { changed, unchanged: unchangedTaskIds.length, unchangedTaskIds };
  }, [planDiff, ctl.scheduler.plans]);

  const taskDiff = useMemo(
    () => planDiff?.diffByTask.find((d) => d.taskId === taskId) ?? null,
    [planDiff, taskId],
  );

  const taskMoveVm = useMemo(
    () =>
      taskMoveExplainVM({
        diff: taskDiff,
        impact: replanImpact,
        trace,
        unchangedTaskCount: diffCounts.unchanged,
        changedTaskCount: diffCounts.changed > 0 ? diffCounts.changed : null,
        unchangedTaskIds: diffCounts.unchangedTaskIds,
      }),
    [taskDiff, replanImpact, trace, diffCounts],
  );

  // 可用动作（UI 层按数据存在性给出；VM 只映射文案，不判资格）。
  const availableActions = useMemo<DecisionActionId[]>(() => {
    const ctx = {
      activePlan: activePlan != null,
      selectedTask: taskId != null,
      conflictOpen: isOpenConflict(conflict),
      locateTarget: Boolean(
        currentAssignment?.personId || currentAssignment?.deviceId || currentAssignment?.stationId,
      ),
      hasDecisionContext: ctl.decisionContext.context != null,
    };
    return ACTION_META.map((a) => a.id).filter((id) => isActionAvailable(id, ctx));
  }, [activePlan, taskId, conflict, currentAssignment, ctl.decisionContext.context]);

  const vm = useMemo(
    () =>
      decisionContextVM({
        taskId,
        plan: activePlan,
        trace,
        conflict: conflictView,
        candidates: candidates ?? null,
        replanImpact,
        planDiff: planDiff ?? null,
        taskDiff,
        // CommandMap 上下文未接入 SchedulingFeedback 数据流（无该端点数据流）；
        // 不再静默透传 null 渲染为空，改为下方显式空态「暂无调度反馈数据」。
        feedback: null,
        unchangedTaskCount: diffCounts.unchanged,
        availableActions,
      }),
    [taskId, activePlan, trace, conflictView, candidates, replanImpact, planDiff, taskDiff, diffCounts.unchanged, availableActions],
  );

  // CLI-024：确认处置收集用户 reason（与冲突中心一致：必填、写入审计），
  // 不再硬编码「决策驾驶舱确认处置」。
  const [acceptReasonOpen, setAcceptReasonOpen] = useState(false);
  const [acceptReason, setAcceptReason] = useState('');

  const acceptMutation = useMutation({
    mutationFn: (c: { conflictId: string; reason: string }) =>
      acknowledgeConflict(c.conflictId, {
        operator: getCurrentOperator(),
        reason: c.reason,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerConflicts() });
      toast.success('冲突已确认处置');
      setAcceptReason('');
    },
    onError: (e) => {
      toast.error(`确认处置失败：${e instanceof Error ? e.message : '未知错误'}`);
    },
  });

  const empty = !vm;
  const visibleSections = (vm?.sections ?? []).filter(
    (s) => s.id !== 'ACTIONS' && s.rows.length > 0,
  );

  const handleAction = (action: DecisionActionId): void => {
    switch (action) {
      case 'accept':
        // CLI-024：先弹出 reason 收集对话框（必填），确认后才提交。
        if (conflict) setAcceptReasonOpen(true);
        break;
      case 'compare':
        onCompare?.();
        break;
      case 'override':
        onOverride?.();
        break;
      case 'lock':
        onOverride?.('LOCK_PERSON');
        break;
      case 'exclude':
        onOverride?.('EXCLUDE_RESOURCE');
        break;
      case 'locate': {
        const entityId =
          currentAssignment?.personId ?? currentAssignment?.deviceId ?? currentAssignment?.stationId ?? null;
        if (entityId) onLocate?.(entityId);
        else toast.info('该任务未分配可定位资源');
        break;
      }
      case 'undo':
        ctl.clearDecisionContext();
        break;
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3 text-white">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-white">决策驾驶舱</span>
        {taskId && <Badge className="border-white/10 bg-white/5 text-[9px] text-white/70">{taskId}</Badge>}
        <Badge className="border-white/10 bg-white/5 text-[9px] text-white/50">
          {ctl.decisionContext.source ?? 'plan'}
        </Badge>
        <div className="flex-1" />
        {taskMoveVm && (
          <span className="text-[9px] text-white/40">含「Why did this task move?」</span>
        )}
      </div>

      {empty ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-white/50">
          未选中任务/方案，或尚无决策上下文。
          <br />
          在地图上选择任务，或打开冲突/对比/覆盖流程后查看。
        </div>
      ) : (
        <div className="space-y-2">
          {/* Why did this task move? */}
          <TaskMoveExplain vm={taskMoveVm} personNameOf={personNameOf} />

          {/* 9 段决策上下文 */}
          {visibleSections.map((section) => (
            <div
              key={section.id}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5"
              data-section={section.id}
            >
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/60">
                {section.title}
              </div>
              {section.id === 'SYSTEM_DECISION' && activePlan && (
                <div className="mb-1">
                  <SolverStatusChain
                    status={activePlan.solverStatus}
                    solverVersion={activePlan.solverVersion}
                    fallbackReason={activePlan.fallbackReason}
                    solveDurationMs={activePlan.solveDurationMs}
                  />
                </div>
              )}
              <div className="space-y-0.5">
                {section.rows.map((row) => (
                  <div key={`${section.id}-${row.label}`} className="flex items-baseline gap-2 text-[10px]">
                    <span className="w-24 shrink-0 text-white/45">{row.label}</span>
                    <span className={cn('min-w-0 flex-1', SECTION_TONE_CLASS[row.tone ?? 'neutral'])}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* 调度反馈（Phase 4 执行反馈闭环）：真实消费 /api/scheduler/executions，
              派工后展示执行进度与偏差；空态如实说明而非静默透传 null。 */}
          <div
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5"
            data-section="SCHEDULING_FEEDBACK"
          >
            <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-white/60">
              <span>调度反馈</span>
              {executionsQuery.isError && (
                <button
                  type="button"
                  onClick={() => executionsQuery.refetch()}
                  className="normal-case underline-offset-2 text-white/50 hover:text-white/80 hover:underline"
                >
                  加载失败 · 重试
                </button>
              )}
            </div>
            {executionsQuery.isLoading ? (
              <div className="text-[10px] text-white/50">执行反馈加载中…</div>
            ) : executionFeedback.empty ? (
              <div className="text-[10px] text-white/50">
                暂无执行数据（方案派工后此处显示执行进度与偏差）
              </div>
            ) : (
              <div className="space-y-1">
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                  {executionFeedback.summary.map((row) => (
                    <div key={row.label} className="flex items-baseline gap-1.5 text-[10px]">
                      <span className="shrink-0 text-white/45">{row.label}</span>
                      <span className={cn('min-w-0 flex-1', SECTION_TONE_CLASS[row.tone] ?? 'text-white/80')}>
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="space-y-0.5 border-t border-white/10 pt-1">
                  {executionFeedback.recent.map((item) => (
                    <div
                      key={`${item.taskId}-${item.status}`}
                      className="flex items-baseline gap-1.5 text-[10px]"
                    >
                      <span className="shrink-0 truncate text-white/45">
                        {item.personLabel} · {item.taskId}
                      </span>
                      <span className={cn('shrink-0', SECTION_TONE_CLASS[item.statusTone] ?? 'text-white/80')}>
                        {item.statusLabel}
                      </span>
                      {item.deviationLabel && (
                        <span className="min-w-0 truncate text-amber-300/90">{item.deviationLabel}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ACTIONS：复用 CommandMap 既有行为 */}
          {availableActions.length > 0 && (
            <div className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/60">
                操作
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {ACTION_META.filter((a) => availableActions.includes(a.id)).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => handleAction(a.id)}
                    className={cn(
                      'flex items-center gap-1 rounded-md border bg-transparent px-2 py-1 text-[10px] transition-colors',
                      a.cls ?? 'text-white/80 border-white/15 hover:bg-white/10',
                    )}
                  >
                    <a.icon className="h-3 w-3" />
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* CLI-024：确认处置 reason 收集对话框（与冲突中心一致，必填写入审计） */}
      <Dialog
        open={acceptReasonOpen}
        onOpenChange={(open) => {
          if (!open) setAcceptReasonOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认处置冲突</DialogTitle>
            <DialogDescription>
              {conflict ? `${conflict.conflictId} — 操作原因必填（写入审计）。` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground" htmlFor="cockpit-accept-reason">
              操作原因（必填）
            </label>
            <Textarea
              id="cockpit-accept-reason"
              value={acceptReason}
              onChange={(e) => setAcceptReason(e.target.value)}
              placeholder="请输入确认处置原因..."
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAcceptReasonOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={acceptMutation.isPending || !acceptReason.trim()}
              onClick={() => {
                if (conflict) {
                  acceptMutation.mutate({
                    conflictId: conflict.conflictId,
                    reason: acceptReason.trim(),
                  });
                  setAcceptReasonOpen(false);
                }
              }}
            >
              {acceptMutation.isPending ? '提交中...' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default DecisionCockpit;

