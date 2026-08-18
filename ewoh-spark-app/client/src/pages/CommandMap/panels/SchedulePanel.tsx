import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles,
  Check,
  X,
  Send,
  GitCompareArrows,
  Lock,
  RotateCcw,
  MapPin,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createRun,
  getActivePlans,
  getPlan,
  approvePlan,
  rejectPlanV2,
  dispatchPlanV2,
  replan,
  previewReplan,
  comparePlans,
} from '@client/src/api/scheduler';
import { getCurrentOperator } from '@client/src/lib/auth';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { isNonAuthoritativePlan } from './schedule-panel-demo';
import { pickComparePlanId, pickPreviousApprovedPlanId } from './schedule-panel-logic';
import SolverStatusChain from './SolverStatusChain';
import {
  ApprovePlanDialog,
  RejectPlanDialog,
  AdjustAssignmentDialog,
  ReplanConfirmDialog,
  DispatchConfirmDialog,
  ComparePlansDialog,
} from './ScheduleDialogs';
import { PlanStatusStepper } from './PlanStatusStepper';
import { ExecutionDeviationList } from './ExecutionDeviationList';
import { PLAN_STATUS_LABELS } from '../vm/planStatusStepVM';
import { useVirtualList } from '@client/src/lib/virtualList';
import { KeyboardTableView, type KeyboardTableColumn } from '../components/KeyboardTableView';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  SchedulingConstraint,
  PersonnelInfo,
  PlanStatus,
  ReplanPreviewResult,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';

const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: '手动',
  TASK_CREATED: '任务创建',
  TASK_UPDATED: '任务更新',
  PERSON_UNAVAILABLE: '人员不可用',
  DEVICE_OFFLINE: '设备离线',
  DEVICE_LOW_BATTERY: '设备低电量',
  BOTTLENECK_DETECTED: '瓶颈检测',
  DEADLINE_AT_RISK: '交期风险',
  SAFETY_EVENT: '安全事件',
  ZONE_RESTRICTED: '区域受限',
};

function statusBadgeClass(status: PlanStatus): string {
  switch (status) {
    case 'draft':
      return 'bg-gray-500/20 text-gray-300 border-gray-500/30';
    case 'shadow':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'approved':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'dispatched':
      return 'bg-teal-500/20 text-teal-400 border-teal-500/30';
    case 'executing':
      return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
    case 'completed':
      return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    case 'rejected':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'superseded':
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatPct(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

function isPlanStaleError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  const status = e.response?.status;
  const dataMsg = (e.response?.data as { message?: string } | undefined)?.message;
  const msg = dataMsg ?? e.message ?? '';
  return status === 409 && msg.includes('PLAN_STALE');
}

/** 从 baselineDelta 提取某 delta 字段（兼容多种命名）。 */
function baselineDeltaValue(plan: SchedulingPlanV2, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = plan.baselineDelta?.[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function assignmentAssigneeName(assignment: SchedulingAssignment, personnel: PersonnelInfo[]): string {
  if (!assignment.personId) return '未指派';
  const p = personnel.find((pp) => pp.id === assignment.personId || pp.employeeNo === assignment.personId);
  return p?.name ?? assignment.personId;
}

/** 后端不可用时的 Demo 兜底方案（明确标注 demo，不影响真实数据）。 */
function buildDemoPlan(): SchedulingPlanV2 {
  const now = new Date();
  const end = new Date(now.getTime() + 60 * 60 * 1000);
  return {
    planId: `DEMO-${Date.now()}`,
    planName: '演示方案（Demo）',
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'demo-snapshot',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [
      {
        assignmentId: 'demo-a1',
        taskId: 'TASK-001',
        personId: 'P-001',
        deviceId: null,
        stationId: 'W-001',
        zoneId: null,
        plannedStart: now.toISOString(),
        plannedEnd: end.toISOString(),
        routeId: null,
        status: 'proposed',
        reasons: ['当前人员 BODY_LOAD 偏高，换为负荷更低的人员以均衡负载'],
        alternatives: [{ personId: 'P-002', reason: '技能匹配度次优，路径距离略长' }],
      },
      {
        assignmentId: 'demo-a2',
        taskId: 'TASK-002',
        personId: 'P-003',
        deviceId: null,
        stationId: 'W-002',
        zoneId: null,
        plannedStart: now.toISOString(),
        plannedEnd: end.toISOString(),
        routeId: null,
        status: 'proposed',
        reasons: ['缩短人员移动距离，减少总体行走路程'],
        alternatives: [{ personId: 'P-001', reason: '当前已占用，时间冲突' }],
      },
    ],
    metrics: {
      lateMinutes: 5,
      walkingMeters: 320,
      stationWaitMinutes: 8,
      maxWorkload: 0.72,
      changeCost: 2,
    },
    baselineDelta: { lateMinutesDelta: -12, walkingMetersDelta: -40 },
    violations: [],
    createdAt: now.toISOString(),
  };
}

interface SchedulePanelProps {
  focusPlanId?: string | null;
  onFocusPlanConsumed?: () => void;
  /** 在调度模式地图上高亮某方案受影响人员 */
  onViewOnMap?: (personIds: string[]) => void;
  /**
   * 当前选中方案 id（受控）：由父组件注入（CommandMap ui.selectedPlanId）。
   * 本组件不自持选中状态，选中变更经 onSelectPlan 上抛父级 updateUi 回流。
   */
  selectedPlanId?: string | null;
  /** 选中方案变更回调（受控组件唯一写入口，plan 为 null 表示取消选中） */
  onSelectPlan?: (plan: SchedulingPlanV2 | null) => void;
  /** 人员列表（用于调整指派/解释说明） */
  personnel?: PersonnelInfo[];
}

function SchedulePanel({
  focusPlanId,
  onFocusPlanConsumed,
  onViewOnMap,
  onSelectPlan,
  selectedPlanId = null,
  personnel = [],
}: SchedulePanelProps) {
  const queryClient = useQueryClient();

  const [isDemo, setIsDemo] = useState(false);
  const [approveTarget, setApproveTarget] = useState<SchedulingPlanV2 | null>(null);
  const [approveReason, setApproveReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SchedulingPlanV2 | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Task 10 / 10.2：危险操作「预览 → 确认」——REPLAN 先调后端 previewReplan（dry-run）。
  const [replanTarget, setReplanTarget] = useState<SchedulingPlanV2 | null>(null);
  // CLI-029：重排理由改为收集用户输入（必填），不再缺省省略。
  const [replanReason, setReplanReason] = useState('');
  const [replanPreview, setReplanPreview] = useState<ReplanPreviewResult | null>(null);
  const [replanPreviewLoading, setReplanPreviewLoading] = useState(false);
  const [replanPreviewError, setReplanPreviewError] = useState<string | null>(null);
  // Task 10 / 10.2：DISPATCH 确认对话框（不再点击即下发）。
  const [dispatchTarget, setDispatchTarget] = useState<SchedulingPlanV2 | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<SchedulingAssignment | null>(null);
  const [adjustPersonId, setAdjustPersonId] = useState<string>('');
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparePlanId, setComparePlanId] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 焦点管理（镜像 Shell 帮助对话框模式：打开存焦点 → 关闭恢复）。
  const replanPrevFocusRef = useRef<HTMLElement | null>(null);
  const replanConfirmRef = useRef<HTMLButtonElement | null>(null);
  const dispatchPrevFocusRef = useRef<HTMLElement | null>(null);
  const dispatchConfirmRef = useRef<HTMLButtonElement | null>(null);

  // 活跃方案列表：来自 React Query 缓存（createRun 结果 + SSE 事件流维护）。
  const { data: plansData } = useQuery<SchedulingPlanV2[]>({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
  });
  const plans = plansData ?? [];

  // 深链/聚焦恢复：从服务端拉取目标方案并写入活跃列表缓存。
  const { data: deepLinkPlan } = useQuery<SchedulingPlanV2 | null>({
    queryKey: queryKeys.schedulerPlan(focusPlanId ?? 'none'),
    queryFn: () => (focusPlanId ? getPlan(focusPlanId) : Promise.resolve(null)),
    enabled: !!focusPlanId,
  });

  useEffect(() => {
    if (!deepLinkPlan || !focusPlanId) return;
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) => {
      const list = prev ?? [];
      const idx = list.findIndex((p) => p.planId === deepLinkPlan.planId);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = deepLinkPlan;
        return next;
      }
      return [...list, deepLinkPlan];
    });
  }, [deepLinkPlan, focusPlanId, queryClient]);

  const selectedPlan = useMemo(
    () => plans.find((p) => p.planId === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  // 「上一已批准/已派工方案」回看对比目标（无候选 → null，不兜底列表首个）。
  const prevApprovedPlanId = useMemo(
    () => pickPreviousApprovedPlanId(plans, selectedPlanId),
    [plans, selectedPlanId],
  );

  const handleCompareWithPrevious = () => {
    if (!selectedPlan || !prevApprovedPlanId) return;
    setComparePlanId(prevApprovedPlanId);
    compareMutation.mutate({ a: prevApprovedPlanId, b: selectedPlan.planId });
    setCompareOpen(true);
  };

  // 分配明细虚拟列表：行高按固定值估算（reasons/备选 1-2 行），只渲染可视窗口。
  const assignmentList = useVirtualList<HTMLDivElement>({
    total: selectedPlan?.assignments.length ?? 0,
    itemHeight: 72,
    overscan: 4,
  });

  // Task 12/12.2：卡片视图（默认）/ 表格视图（键盘可达语义表格）切换。
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const assignmentColumns = useMemo<KeyboardTableColumn<SchedulingAssignment>[]>(
    () => [
      { key: 'task', header: '任务', render: (a) => <span className="text-white/90 font-medium">{a.taskId}</span> },
      {
        key: 'person',
        header: '人员',
        render: (a) => <span className="text-cyan-400">{assignmentAssigneeName(a, personnel)}</span>,
      },
      {
        key: 'status',
        header: '状态',
        render: (a) => (
          <Badge className={cn('text-[8px] px-1', statusBadgeClassFromAssignment(a.status))}>
            {a.status}
          </Badge>
        ),
      },
      { key: 'station', header: '工位', render: (a) => (a.stationId ? `工位 ${a.stationId}` : '—') },
      {
        key: 'time',
        header: '计划时间',
        render: (a) => `${formatTime(a.plannedStart)} → ${formatTime(a.plannedEnd)}`,
      },
    ],
    [personnel],
  );

  // 切换方案时重置分配列表滚动位置。
  useEffect(() => {
    if (assignmentList.ref.current) assignmentList.ref.current.scrollTop = 0;
  }, [selectedPlanId]);

  // 聚焦到大脑建议/任务编排关联的方案（深链恢复）。
  // 受控：只选中 focusPlanId 对应方案；不在列表（deepLink 拉取中）时置 null，绝不回退首个方案。
  useEffect(() => {
    if (!focusPlanId) return;
    const target = plans.find((p) => p.planId === focusPlanId) ?? null;
    onSelectPlan?.(target);
    onFocusPlanConsumed?.();
  }, [focusPlanId, plans, onSelectPlan, onFocusPlanConsumed]);

  const appendPlans = (newPlans: SchedulingPlanV2[]) => {
    if (!newPlans || newPlans.length === 0) return;
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) => {
      const merged = [...(prev ?? []), ...newPlans];
      const seen = new Set<string>();
      return merged.filter((p) => (seen.has(p.planId) ? false : (seen.add(p.planId), true)));
    });
    // 受控：不自动选中新方案（绝不回退首个方案），由用户显式选择。
  };

  const generateMutation = useMutation({
    mutationFn: () => createRun({ trigger: 'MANUAL', operator: getCurrentOperator() }),
    onSuccess: (data) => {
      if (data.debounced || !data.run) {
        toast.info('调度已排队，请稍后刷新');
        return;
      }
      if (data.plans.length > 0) {
        appendPlans(data.plans);
        toast.success(`已生成 ${data.plans.length} 个方案`);
      } else {
        toast.info('本次未生成新方案');
      }
    },
    onError: (err) => {
      // P1-5：生产构建禁止自动创建 Demo 调度方案（Demo 不可审批/派工，会污染状态）。
      // 仅开发/演示构建允许兜底；生产展示明确 degraded 状态，保留最后一次权威方案。
      const buildMeta = (import.meta as unknown as {
        env?: { DEV?: boolean; PROD?: boolean; MODE?: string };
      }).env;
      const isProdBuild = Boolean(buildMeta?.PROD) || buildMeta?.MODE === 'production';
      const isDemoBuild = Boolean(buildMeta?.DEV) || buildMeta?.MODE?.includes('demo');
      if (isProdBuild && !isDemoBuild) {
        toast.error('调度引擎不可用', {
          description: err instanceof Error ? err.message : undefined,
        });
        setIsDemo(true); // 进入 degraded 展示（无 Demo 方案）
        return;
      }
      // 开发/演示构建：Demo 兜底（明确标注 demo，不影响真实数据）
      toast.warning('后端调度引擎不可用，已加载演示方案', {
        description: err instanceof Error ? err.message : undefined,
      });
      setIsDemo(true);
      appendPlans([buildDemoPlan()]);
    },
  });

  const refreshPlan = (plan: SchedulingPlanV2) => {
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) =>
      (prev ?? []).map((p) => (p.planId === plan.planId ? plan : p)),
    );
    onSelectPlan?.(plan);
  };

  const approveMutation = useMutation({
    mutationFn: ({ plan, reason }: { plan: SchedulingPlanV2; reason: string }) =>
      approvePlan(plan.planId, {
        version: plan.version,
        snapshotVersion: plan.snapshotVersion,
        operator: getCurrentOperator(),
        reason,
      }),
    onSuccess: (plan) => {
      toast.success('方案已审批通过');
      setApproveTarget(null);
      setApproveReason('');
      refreshPlan(plan);
    },
    onError: (err) => {
      if (isPlanStaleError(err)) {
        toast.error('该方案生成后现场状态已发生变化，请重新计算');
      } else {
        toast.error('审批失败', {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ plan, reason }: { plan: SchedulingPlanV2; reason: string }) =>
      rejectPlanV2(plan.planId, { operator: getCurrentOperator(), reason }),
    onSuccess: (plan) => {
      toast.success('方案已驳回');
      setRejectTarget(null);
      setRejectReason('');
      refreshPlan(plan);
    },
    onError: (err) => {
      // CLI-028：透传后端错误细节（原仅通用文案）。
      toast.error('方案驳回失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      dispatchPlanV2(plan.planId, getCurrentOperator()),
    onSuccess: (plan) => {
      toast.success('方案已下发执行');
      refreshPlan(plan);
    },
    onError: (err) => {
      // CLI-028：透传后端错误细节（原仅通用文案）。
      toast.error('下发失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const replanMutation = useMutation({
    mutationFn: ({
      plan,
      lockedConstraints,
      reason,
    }: {
      plan: SchedulingPlanV2;
      lockedConstraints: SchedulingConstraint[];
      reason?: string;
    }) =>
      replan(plan.planId, {
        lockedConstraints,
        operator: getCurrentOperator(),
        reason,
      }),
    onSuccess: (plan) => {
      toast.success('已重新排程生成新方案');
      setAdjustTarget(null);
      setAdjustPersonId('');
      appendPlans([plan]);
    },
    onError: (err) => {
      toast.error('重新排程失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const compareMutation = useMutation({
    mutationFn: ({ a, b }: { a: string; b: string }) => comparePlans(a, b),
    onSuccess: (result) => setCompareResult(result),
    onError: (err) => {
      // CLI-028：透传后端错误细节（原仅通用文案）。
      toast.error('方案对比失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const handleApprove = () => {
    if (!approveTarget) return;
    if (isNonAuthoritativePlan(approveTarget)) {
      toast.error('演示方案不可审批（仅用于展示）');
      return;
    }
    approveMutation.mutate({ plan: approveTarget, reason: approveReason.trim() });
  };

  const handleReject = () => {
    if (!rejectTarget) return;
    if (isNonAuthoritativePlan(rejectTarget)) {
      toast.error('演示方案不可驳回（仅用于展示）');
      return;
    }
    if (!rejectReason.trim()) {
      toast.error('请填写驳回理由');
      return;
    }
    rejectMutation.mutate({ plan: rejectTarget, reason: rejectReason });
  };

  const handleAdjust = () => {
    if (!adjustTarget || !adjustPersonId || !selectedPlan) return;
    replanMutation.mutate({
      plan: selectedPlan,
      lockedConstraints: [
        { taskId: adjustTarget.taskId, personId: adjustPersonId, type: 'LOCKED_PERSON' },
      ],
      reason: '班组长锁定指派',
    });
  };

  const handleCompare = () => {
    if (!selectedPlan || !comparePlanId) return;
    compareMutation.mutate({ a: selectedPlan.planId, b: comparePlanId });
  };

  const openCompare = () => {
    // 唯一约束：绝不回退首个方案——无其他可对比方案时 comparePlanId 置 null
    // （面板展示空/禁用态），避免「对比」双方是同一方案。
    setComparePlanId(pickComparePlanId(plans, selectedPlanId));
    setCompareResult(null);
    setCompareOpen(true);
  };

  // ---- Task 10 / 10.2：REPLAN 预览 → 确认 ----
  // 打开确认框即调后端 previewReplan（dry-run readonly）；仅确认后才执行真实 replan。
  const openReplanConfirm = (plan: SchedulingPlanV2) => {
    setReplanTarget(plan);
    setReplanReason('');
    setReplanPreview(null);
    setReplanPreviewError(null);
    setReplanPreviewLoading(true);
    previewReplan({ triggerType: 'MANUAL', triggerIds: [plan.planId] })
      .then((preview) => setReplanPreview(preview))
      .catch((err: unknown) => {
        setReplanPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setReplanPreviewLoading(false));
  };

  const confirmReplan = () => {
    if (!replanTarget) return;
    // CLI-029：补 reason（用户输入，必填），写入重排审计。
    replanMutation.mutate({
      plan: replanTarget,
      lockedConstraints: [],
      reason: replanReason.trim(),
    });
    setReplanTarget(null);
    setReplanReason('');
    setReplanPreview(null);
  };

  // ---- Task 10 / 10.2：DISPATCH 确认 ----
  const confirmDispatch = () => {
    if (!dispatchTarget) return;
    dispatchMutation.mutate(dispatchTarget);
    setDispatchTarget(null);
  };

  // 焦点管理（镜像 Shell 帮助对话框模式：打开存焦点 → 关闭恢复）。
  useEffect(() => {
    if (replanTarget) {
      replanPrevFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => replanConfirmRef.current?.focus());
    } else if (replanPrevFocusRef.current) {
      replanPrevFocusRef.current.focus();
      replanPrevFocusRef.current = null;
    }
  }, [replanTarget]);

  useEffect(() => {
    if (dispatchTarget) {
      dispatchPrevFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => dispatchConfirmRef.current?.focus());
    } else if (dispatchPrevFocusRef.current) {
      dispatchPrevFocusRef.current.focus();
      dispatchPrevFocusRef.current = null;
    }
  }, [dispatchTarget]);

  const kpis = selectedPlan
    ? [
        { label: '预计延期', value: `${selectedPlan.metrics.lateMinutes.toFixed(0)} min`, delta: baselineDeltaValue(selectedPlan, 'lateMinutesDelta', 'deltaLateMinutes') },
        { label: '人员总移动', value: `${selectedPlan.metrics.walkingMeters.toFixed(0)} m`, delta: baselineDeltaValue(selectedPlan, 'walkingMetersDelta', 'deltaWalkingMeters') },
        { label: '工位等待', value: `${selectedPlan.metrics.stationWaitMinutes.toFixed(0)} min`, delta: baselineDeltaValue(selectedPlan, 'stationWaitMinutesDelta', 'deltaStationWait') },
        { label: '最大负荷', value: formatPct(selectedPlan.metrics.maxWorkload), delta: baselineDeltaValue(selectedPlan, 'maxWorkloadDelta', 'deltaMaxWorkload') },
        { label: '计划变更', value: `${selectedPlan.metrics.changeCost.toFixed(0)} 项`, delta: baselineDeltaValue(selectedPlan, 'changeCostDelta', 'deltaChangeCost') },
      ]
    : [];

  return (
    <div className="h-full flex flex-col bg-[hsl(220_14%_14%)] text-white">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <Button
          size="sm"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
        >
          <Sparkles className="w-3.5 h-3.5" />
          {generateMutation.isPending ? '生成中...' : '生成调度方案'}
        </Button>
        {isDemo && (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px]">
            Demo 演示数据
          </Badge>
        )}
        <div className="flex-1" />
        {selectedPlan && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2"
            onClick={openCompare}
            disabled={plans.length < 2}
          >
            <GitCompareArrows className="w-3 h-3" />
            对比方案
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 方案列表 */}
        <div className="w-56 shrink-0 border-r border-white/10 overflow-y-auto" ref={listRef}>
          <div className="px-2 py-1.5 text-[10px] text-white/60 font-medium">方案列表</div>
          {plans.length === 0 ? (
            <div className="px-3 py-4 text-[10px] text-white/50">
              暂无方案，点击「生成调度方案」开始。
            </div>
          ) : (
            plans.map((p) => {
              const active = p.planId === selectedPlanId;
              return (
                <button
                  key={p.planId}
                  type="button"
                  onClick={() => onSelectPlan?.(p)}
                  className={cn(
                    'w-full text-left px-3 py-2 border-b border-white/5 hover:bg-card/5 transition-colors',
                    active && 'bg-card/10',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <ChevronRight
                      className={cn('w-3 h-3 text-white/40', active && 'rotate-90 text-white/80')}
                    />
                    <span className="text-[11px] text-white/90 truncate flex-1">
                      {p.planName ?? p.planId}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 pl-4">
                    <Badge className={cn('text-[8px] px-1', statusBadgeClass(p.status))}>
                      {p.status}
                    </Badge>
                    <span className="text-[9px] text-white/50">v{p.version}</span>
                  </div>
                  <div className="pl-4 mt-0.5 text-[9px] text-white/40">
                    {formatTime(p.createdAt)}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* 方案详情 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!selectedPlan ? (
            <div className="p-6 text-center text-sm text-white/60">
              请先生成方案或从左侧选择一个方案
            </div>
          ) : (
            <div className="p-3 space-y-3">
              {/* 方案头部 */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-white">
                  {selectedPlan.planName ?? selectedPlan.planId}
                </span>
                <Badge className={cn('text-[9px] px-1.5', statusBadgeClass(selectedPlan.status))}>
                  {PLAN_STATUS_LABELS[selectedPlan.status] ?? selectedPlan.status}
                </Badge>
                <span className="text-[10px] text-white/50">VERSION {selectedPlan.version}</span>
                <SolverStatusChain
                  status={selectedPlan.solverStatus}
                  solverVersion={selectedPlan.solverVersion}
                  fallbackReason={selectedPlan.fallbackReason}
                  solveDurationMs={selectedPlan.solveDurationMs}
                />
              </div>
              {/* 方案状态流转指示：值班员一眼看到卡点（影子方案→已批准→已派工→执行中） */}
              <PlanStatusStepper status={selectedPlan.status} />
              {/* 执行偏差（计划 vs 实际）：真实消费 /api/scheduler/executions */}
              <ExecutionDeviationList planId={selectedPlan.planId} />
              {/* 回看对比：上一已批准/已派工方案（值班员评估回退目标） */}
              {prevApprovedPlanId && (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] px-2 border-white/10"
                    onClick={handleCompareWithPrevious}
                  >
                    <GitCompareArrows className="w-3 h-3" />
                    对比上一已批准方案
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-white/60">
                <span>
                  Plan ID: <span className="text-white/80">{selectedPlan.planId}</span>
                </span>
                <span>
                  触发:{' '}
                  <span className="text-white/80">
                    {TRIGGER_LABELS[selectedPlan.trigger.type] ?? selectedPlan.trigger.type}
                  </span>
                </span>
                <span>
                  创建时间:{' '}
                  <span className="text-white/80">{formatTime(selectedPlan.createdAt)}</span>
                </span>
                <span>
                  快照版本:{' '}
                  <span className="text-white/80">{selectedPlan.snapshotVersion}</span>
                </span>
              </div>

              {/* KPI 网格 */}
              <div className="grid grid-cols-5 gap-2">
                {kpis.map((k) => (
                  <div
                    key={k.label}
                    className="rounded-md border border-white/10 bg-card/5 px-2 py-1.5"
                  >
                    <div className="text-[9px] text-white/50">{k.label}</div>
                    <div className="text-sm font-semibold text-white">{k.value}</div>
                    {k.delta !== undefined && (
                      <div
                        className={cn(
                          'text-[9px]',
                          k.delta <= 0 ? 'text-emerald-400' : 'text-red-400',
                        )}
                      >
                        较基线 {k.delta > 0 ? '+' : ''}
                        {k.delta.toFixed(0)}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* 分配变更列表（虚拟化：只渲染可视窗口；Task 12/12.2 支持表格视图） */}
              <div>
                <div className="flex items-center gap-2 text-[10px] text-white/60 font-medium mb-1">
                  <span>分配明细（{selectedPlan.assignments.length}）</span>
                  <button
                    type="button"
                    onClick={() => setViewMode((v) => (v === 'card' ? 'table' : 'card'))}
                    aria-pressed={viewMode === 'table'}
                    aria-label={viewMode === 'card' ? UI_ARIA_LABELS.switchTableView : UI_ARIA_LABELS.switchCardView}
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-white/50 hover:bg-card/10"
                  >
                    {viewMode === 'card' ? '表格视图' : '列表视图'}
                  </button>
                </div>
                {viewMode === 'table' ? (
                  <KeyboardTableView<SchedulingAssignment>
                    ariaLabel="分配明细（表格视图）"
                    className="max-h-[280px] rounded-md border border-white/10"
                    columns={assignmentColumns}
                    rows={selectedPlan.assignments}
                    rowKey={(a) => a.assignmentId}
                    onActivate={(a) => {
                      // 主操作：在地图上高亮该分配涉及的人员（与卡片视图「定位」一致）。
                      if (a.personId && onViewOnMap) onViewOnMap([a.personId]);
                    }}
                    itemHeight={34}
                  />
                ) : (
                <div
                  ref={assignmentList.ref}
                  className="max-h-[280px] overflow-y-auto rounded-md border border-white/10"
                >
                  <div style={{ height: assignmentList.range.totalHeight, position: 'relative' }}>
                    <div
                      className="space-y-1"
                      style={{ transform: `translateY(${assignmentList.range.offsetY}px)` }}
                    >
                      {selectedPlan.assignments
                        .slice(assignmentList.slice.start, assignmentList.slice.end)
                        .map((a) => (
                    <div
                      key={a.assignmentId}
                      className="rounded-md border border-white/10 bg-card/5 px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-white/80 font-medium">{a.taskId}</span>
                        <span className="text-[10px] text-white/50">→</span>
                        <span className="text-[10px] text-cyan-400">
                          {assignmentAssigneeName(a, personnel)}
                        </span>
                        <Badge className={cn('text-[8px] px-1', statusBadgeClassFromAssignment(a.status))}>
                          {a.status}
                        </Badge>
                        {a.stationId && (
                          <span className="text-[9px] text-white/50">工位 {a.stationId}</span>
                        )}
                        <span className="text-[9px] text-white/50">
                          {formatTime(a.plannedStart)} → {formatTime(a.plannedEnd)}
                        </span>
                      </div>
                      <div className="mt-1 text-[9px] text-white/60">
                        {a.reasons.length > 0
                          ? Array.from(new Set(a.reasons)).map((r) => (
                              <div key={`reason-${r}`} className="flex gap-1">
                                <span className="text-white/30">·</span>
                                <span>{r}</span>
                              </div>
                            ))
                          : '—'}
                        {a.alternatives.length > 0 && (
                          <div className="mt-1 text-white/40">
                            备选：{a.alternatives.map((alt) => String(alt.personId ?? alt.person ?? '')).join('、')}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                    </div>
                  </div>
                </div>
                )}
              </div>

              {/* 操作 */}
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <Button
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => {
                    setApproveTarget(selectedPlan);
                    setApproveReason('');
                  }}
                  disabled={selectedPlan.status === 'approved' || selectedPlan.status === 'dispatched'}
                >
                  <Check className="w-3 h-3" />
                  审批通过
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 text-red-400 border-red-500/30"
                  onClick={() => {
                    setRejectTarget(selectedPlan);
                    setRejectReason('');
                  }}
                  disabled={selectedPlan.status === 'rejected' || selectedPlan.status === 'dispatched'}
                >
                  <X className="w-3 h-3" />
                  驳回
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 text-cyan-400 border-cyan-500/30"
                  onClick={() => {
                    if (isNonAuthoritativePlan(selectedPlan)) {
                      toast.error('演示方案不可下发（仅用于展示）');
                      return;
                    }
                    // Task 10 / 10.2：下发前先确认（汇总方案摘要）。
                    setDispatchTarget(selectedPlan);
                  }}
                  disabled={selectedPlan.status !== 'approved' || dispatchMutation.isPending}
                >
                  <Send className="w-3 h-3" />
                  下发
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2"
                  onClick={() => {
                    setAdjustTarget(selectedPlan.assignments[0] ?? null);
                    setAdjustPersonId('');
                  }}
                  disabled={selectedPlan.assignments.length === 0}
                >
                  <Lock className="w-3 h-3" />
                  调整指派
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2"
                  onClick={() => openReplanConfirm(selectedPlan)}
                  disabled={plans.length === 0 || replanPreviewLoading}
                >
                  <RotateCcw className="w-3 h-3" />
                  {replanPreviewLoading ? '预览中...' : '重新排程'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2"
                  onClick={() => {
                    const ids = selectedPlan.assignments
                      .map((a) => a.personId)
                      .filter((p): p is string => Boolean(p));
                    if (ids.length > 0) onViewOnMap?.(ids);
                    else toast.info('该方案未指派人员，无法在地图上定位');
                  }}
                >
                  <MapPin className="w-3 h-3" />
                  图中查看
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CLI-027 拆分：6 个确认/对比 Dialog 移至 ./ScheduleDialogs（机械提取，行为不变）。 */}
      <ApprovePlanDialog
        target={approveTarget}
        reason={approveReason}
        onReasonChange={setApproveReason}
        pending={approveMutation.isPending}
        onCancel={() => setApproveTarget(null)}
        onConfirm={handleApprove}
      />
      <RejectPlanDialog
        target={rejectTarget}
        reason={rejectReason}
        onReasonChange={setRejectReason}
        pending={rejectMutation.isPending}
        onCancel={() => setRejectTarget(null)}
        onConfirm={handleReject}
      />
      <AdjustAssignmentDialog
        target={adjustTarget}
        personId={adjustPersonId}
        selectedPlan={selectedPlan}
        personnel={personnel}
        onTargetChange={setAdjustTarget}
        onPersonIdChange={setAdjustPersonId}
        pending={replanMutation.isPending}
        onCancel={() => setAdjustTarget(null)}
        onConfirm={handleAdjust}
        assigneeNameOf={(a) => assignmentAssigneeName(a, personnel)}
      />
      <ReplanConfirmDialog
        target={replanTarget}
        reason={replanReason}
        onReasonChange={setReplanReason}
        preview={replanPreview}
        previewLoading={replanPreviewLoading}
        previewError={replanPreviewError}
        pending={replanMutation.isPending}
        onCancel={() => setReplanTarget(null)}
        onConfirm={confirmReplan}
        confirmRef={replanConfirmRef}
      />
      <DispatchConfirmDialog
        target={dispatchTarget}
        pending={dispatchMutation.isPending}
        onCancel={() => setDispatchTarget(null)}
        onConfirm={confirmDispatch}
        confirmRef={dispatchConfirmRef}
      />
      <ComparePlansDialog
        open={compareOpen}
        plans={plans}
        selectedPlan={selectedPlan}
        comparePlanId={comparePlanId}
        onComparePlanIdChange={setComparePlanId}
        compareResult={compareResult}
        pending={compareMutation.isPending}
        onClose={() => setCompareOpen(false)}
        onCompare={handleCompare}
      />
    </div>
  );
}

function statusBadgeClassFromAssignment(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'dispatched':
    case 'executing':
      return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
    case 'failed':
    case 'blocked':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'completed':
      return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    case 'cancelled':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

// React.memo：仅当 props 引用变化（selectedPlanId/回调/人员列表）时重渲染，
// CommandMap 侧的 selection/mode/viewport 等 store 写入不会连带重渲染本面板（Task 4 / P1）。
export default memo(SchedulePanel);