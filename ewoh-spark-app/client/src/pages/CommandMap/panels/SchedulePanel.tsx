import { useEffect, useMemo, useRef, useState } from 'react';
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
import dayjs from 'dayjs';
import { toast } from 'sonner';
import {
  createRun,
  getActivePlans,
  getPlan,
  approvePlan,
  rejectPlanV2,
  dispatchPlanV2,
  replan,
  comparePlans,
} from '@client/src/api/scheduler';
import { getCurrentOperator } from '@client/src/lib/auth';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { useSchedulerStream } from '@client/src/hooks/useSchedulerStream';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  SchedulingConstraint,
  PersonnelInfo,
  PlanStatus,
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
  return dayjs(iso).format('MM-DD HH:mm');
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
  /** 将当前选中方案上抛给地图层做覆盖渲染 */
  onSelectPlan?: (plan: SchedulingPlanV2 | null) => void;
  /** 人员列表（用于调整指派/解释说明） */
  personnel?: PersonnelInfo[];
}

export default function SchedulePanel({
  focusPlanId,
  onFocusPlanConsumed,
  onViewOnMap,
  onSelectPlan,
  personnel = [],
}: SchedulePanelProps) {
  const queryClient = useQueryClient();
  // 订阅调度 SSE：将服务端事件增量写入 React Query 缓存（活跃方案/详情）。
  useSchedulerStream();

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [approveTarget, setApproveTarget] = useState<SchedulingPlanV2 | null>(null);
  const [approveReason, setApproveReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SchedulingPlanV2 | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [adjustTarget, setAdjustTarget] = useState<SchedulingAssignment | null>(null);
  const [adjustPersonId, setAdjustPersonId] = useState<string>('');
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparePlanId, setComparePlanId] = useState<string>('');
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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

  // 将选中方案上抛给地图层
  useEffect(() => {
    onSelectPlan?.(selectedPlan);
  }, [selectedPlan, onSelectPlan]);

  // 聚焦到大脑建议/任务编排关联的方案
  useEffect(() => {
    if (!focusPlanId) return;
    if (plans.some((p) => p.planId === focusPlanId)) {
      setSelectedPlanId(focusPlanId);
    } else if (plans.length > 0) {
      setSelectedPlanId(plans[0].planId);
    }
    onFocusPlanConsumed?.();
  }, [focusPlanId, plans, onFocusPlanConsumed]);

  const appendPlans = (newPlans: SchedulingPlanV2[]) => {
    if (!newPlans || newPlans.length === 0) return;
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) => {
      const merged = [...(prev ?? []), ...newPlans];
      const seen = new Set<string>();
      return merged.filter((p) => (seen.has(p.planId) ? false : (seen.add(p.planId), true)));
    });
    setSelectedPlanId((prev) => prev ?? newPlans[0].planId);
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
      // 后端不可用 → Demo 兜底
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
    setSelectedPlanId(plan.planId);
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
    onError: () => {
      toast.error('方案驳回失败');
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      dispatchPlanV2(plan.planId, getCurrentOperator()),
    onSuccess: (plan) => {
      toast.success('方案已下发执行');
      refreshPlan(plan);
    },
    onError: () => {
      toast.error('下发失败');
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
    onError: () => {
      toast.error('方案对比失败');
    },
  });

  const handleApprove = () => {
    if (!approveTarget) return;
    approveMutation.mutate({ plan: approveTarget, reason: approveReason.trim() });
  };

  const handleReject = () => {
    if (!rejectTarget) return;
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
    const other = plans.find((p) => p.planId !== selectedPlanId);
    setComparePlanId(other?.planId ?? plans[0]?.planId ?? '');
    setCompareResult(null);
    setCompareOpen(true);
  };

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
                  onClick={() => setSelectedPlanId(p.planId)}
                  className={cn(
                    'w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5 transition-colors',
                    active && 'bg-white/10',
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
                  {selectedPlan.status}
                </Badge>
                <span className="text-[10px] text-white/50">VERSION {selectedPlan.version}</span>
              </div>
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
                    className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5"
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

              {/* 分配变更列表 */}
              <div>
                <div className="text-[10px] text-white/60 font-medium mb-1">
                  分配明细（{selectedPlan.assignments.length}）
                </div>
                <div className="space-y-1">
                  {selectedPlan.assignments.map((a) => (
                    <div
                      key={a.assignmentId}
                      className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5"
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
                          ? a.reasons.map((r, i) => (
                              <div key={i} className="flex gap-1">
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
                  onClick={() => dispatchMutation.mutate(selectedPlan)}
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
                  onClick={() => replanMutation.mutate({ plan: selectedPlan, lockedConstraints: [] })}
                  disabled={plans.length === 0}
                >
                  <RotateCcw className="w-3 h-3" />
                  重新排程
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

      {/* 审批通过 Dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">审批调度方案</DialogTitle>
            <DialogDescription className="text-white/70">
              {approveTarget?.planName ?? approveTarget?.planId} · v{approveTarget?.version}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-white/60">审批理由</label>
            <Textarea
              value={approveReason}
              onChange={(e) => setApproveReason(e.target.value)}
              placeholder="请输入审批理由..."
              className="bg-white/5 border-white/10 text-white"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setApproveTarget(null)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={approveMutation.isPending}
            >
              {approveMutation.isPending ? '提交中...' : '确认审批'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 驳回 Dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">驳回调度方案</DialogTitle>
            <DialogDescription className="text-white/70">
              {rejectTarget?.planName ?? rejectTarget?.planId} · v{rejectTarget?.version}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-white/60">驳回理由（必填）</label>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="请输入驳回理由..."
              className="bg-white/5 border-white/10 text-white"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRejectTarget(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleReject}
              disabled={rejectMutation.isPending || !rejectReason.trim()}
            >
              {rejectMutation.isPending ? '驳回中...' : '确认驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 调整指派 Dialog */}
      <Dialog open={!!adjustTarget} onOpenChange={(open) => !open && setAdjustTarget(null)}>
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white">
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
                  value={adjustTarget?.taskId ?? ''}
                  onChange={(e) =>
                    setAdjustTarget(
                      selectedPlan.assignments.find((a) => a.taskId === e.target.value) ?? null,
                    )
                  }
                  className="mt-1 w-full rounded-md border border-white/10 bg-[hsl(220_14%_18%)] px-2 py-1.5 text-xs text-white outline-none"
                >
                  {selectedPlan.assignments.map((a) => (
                    <option key={a.taskId} value={a.taskId}>
                      {a.taskId}（当前:{' '}
                      {a.personId ? assignmentAssigneeName(a, personnel) : '未指派'}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-white/60">锁定人员</label>
                <select
                  value={adjustPersonId}
                  onChange={(e) => setAdjustPersonId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-white/10 bg-[hsl(220_14%_18%)] px-2 py-1.5 text-xs text-white outline-none"
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
            <Button variant="outline" size="sm" onClick={() => setAdjustTarget(null)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleAdjust}
              disabled={replanMutation.isPending || !adjustTarget || !adjustPersonId}
            >
              {replanMutation.isPending ? '重排中...' : '锁定并重排'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 对比方案 Dialog */}
      <Dialog open={compareOpen} onOpenChange={(open) => !open && setCompareOpen(false)}>
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-white">方案对比</DialogTitle>
            <DialogDescription className="text-white/70">
              对比两套方案的分配与指标差异
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge className="bg-white/10 text-white text-[9px]">A</Badge>
              <span className="text-xs text-white/80">{selectedPlan?.planName ?? selectedPlan?.planId}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge className="bg-white/10 text-white text-[9px]">B</Badge>
              <select
                value={comparePlanId}
                onChange={(e) => setComparePlanId(e.target.value)}
                className="flex-1 rounded-md border border-white/10 bg-[hsl(220_14%_18%)] px-2 py-1.5 text-xs text-white outline-none"
              >
                {plans.map((p) => (
                  <option key={p.planId} value={p.planId}>
                    {p.planName ?? p.planId} · {p.status}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={handleCompare}
                disabled={compareMutation.isPending || !comparePlanId}
              >
                {compareMutation.isPending ? '对比中...' : '对比'}
              </Button>
            </div>
            {compareResult && (
              <CompareResult result={compareResult} />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCompareOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            <div key={key} className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5">
              <div className="text-[9px] text-white/50">{label}</div>
              <div className={cn('text-sm font-semibold', v != null && v < 0 ? 'text-emerald-400' : v != null && v > 0 ? 'text-red-400' : 'text-white')}>
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
            <div key={i} className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/70">
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