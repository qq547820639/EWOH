// panels/OverridePanel.tsx — 人工覆盖中心（v0.7 A3 智能调度接线 + Phase 3 / P3-T4 完备化）
//
// 消费 `usePlanOverrides`（POST /plans/:planId/overrides）：
// 将人工干预（锁定资源 / 排除资源 / 偏好资源 / 更换资源 / 加急 / 调时）转换为调度约束，
// 触发 V2 重排并展示 before/after diff（经 planDiffVM 差分展示）。
// reason + operator 必填（写审计）；SAFETY_BLOCK 等安全硬约束由后端校验。
//
// 交互链：选择方案 → 选择任务 → 选择动作类型 → 选择目标资源/时间 → 填写 operator+reason → 提交 → 展示 diff。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Lock,
  XCircle,
  Star,
  Zap,
  Clock,
  GitCompareArrows,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Factory,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getActivePlans, getTaskCandidates, previewOverrides } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { usePlanOverrides } from '@client/src/hooks/usePlanOverrides';
import { getCurrentOperator } from '@client/src/lib/auth';
import { planDiffVM } from '../vm/planDiffVM';
import { overridePreviewSummary, overridePreviewDeltaRows } from './override-preview-logic';
import type {
  OverridePreviewResponse,
  PlanOverrideAction,
  PlanOverrideKind,
  SchedulingPlanV2,
  TaskCandidateResource,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { ScrollArea } from '@client/src/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@client/src/components/ui/dialog';

/** 覆盖动作定义（九类，对应后端 PlanOverrideKind 子集，Phase 3 / P3-T4 新增换资源/锁定设备/工位/调时）。 */
const OVERRIDE_KINDS: Array<{
  kind: PlanOverrideKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  needsTarget: 'person' | 'device' | 'station' | 'time' | 'none';
}> = [
  { kind: 'LOCK_PERSON', label: '锁定人员', icon: Lock, description: '固定该任务的人员分配（重排不可更换）', needsTarget: 'person' },
  { kind: 'LOCK_DEVICE', label: '锁定设备', icon: Cpu, description: '固定该任务的设备分配', needsTarget: 'device' },
  { kind: 'LOCK_STATION', label: '锁定工位', icon: Factory, description: '固定该任务的工位分配', needsTarget: 'station' },
  { kind: 'EXCLUDE_RESOURCE', label: '排除资源', icon: XCircle, description: '禁止为该任务分配指定资源', needsTarget: 'person' },
  { kind: 'PREFER_RESOURCE', label: '偏好资源', icon: Star, description: '优先分配指定资源（软约束）', needsTarget: 'person' },
  { kind: 'CHANGE_RESOURCE', label: '更换资源', icon: GitCompareArrows, description: '将任务改派给指定人员（LOCKED_ASSIGNMENT）', needsTarget: 'person' },
  { kind: 'BOOST', label: '加急', icon: Zap, description: '提升该任务优先级（缩小 score）', needsTarget: 'none' },
  { kind: 'LOCK_TIME', label: '锁定时间', icon: Clock, description: '固定计划时间窗（重排不可挪动）', needsTarget: 'time' },
  { kind: 'ADJUST_TIME', label: '调整时间', icon: Clock, description: '调整计划时间窗（epoch ms 起止）', needsTarget: 'time' },
];

interface OverridePanelProps {
  /** 外部传入的已选方案（若为空则从活跃方案列表选择）。 */
  planId?: string | null;
  /** 初始覆盖动作类型（决策驾驶舱 Lock/Exclude 跳转时指定；缺省 LOCK_PERSON）。 */
  initialKind?: PlanOverrideKind;
}

export function OverridePanel({ planId: externalPlanId, initialKind }: OverridePanelProps): React.ReactElement {
  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: () => getActivePlans(),
    enabled: !externalPlanId,
    refetchInterval: 30_000,
  });

  const activePlans: SchedulingPlanV2[] = useMemo(() => plans ?? [], [plans]);
  const [planId, setPlanId] = useState<string | null>(externalPlanId ?? null);
  const [taskId, setTaskId] = useState<string>('');
  const [kind, setKind] = useState<PlanOverrideKind>(initialKind ?? 'LOCK_PERSON');
  const [targetPersonId, setTargetPersonId] = useState<string>('');
  const [targetDeviceId, setTargetDeviceId] = useState<string>('');
  const [targetStationId, setTargetStationId] = useState<string>('');
  const [startMs, setStartMs] = useState<string>('');
  const [endMs, setEndMs] = useState<string>('');
  const [operator, setOperator] = useState<string>(getCurrentOperator());
  const [reason, setReason] = useState<string>('');
  // Task 10 / 10.2：执行前预览（previewOverrides dry-run）→ 确认后才真正提交。
  const [preview, setPreview] = useState<OverridePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PlanOverrideAction | null>(null);
  const [result, setResult] = useState<{
    planId: string;
    changed: string[];
    added: string[];
    removed: string[];
    metrics: Record<string, number> | null;
  } | null>(null);
  // 焦点管理（镜像 Shell 帮助对话框模式：打开存焦点 → 关闭恢复）。
  const previewPrevFocusRef = useRef<HTMLElement | null>(null);
  const previewConfirmRef = useRef<HTMLButtonElement | null>(null);
  // Task 12/12.3：覆盖结果（重排成功）后聚焦结果区，屏幕阅读器可读（不只靠颜色）。
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Task 12/12.3：覆盖结果出现后把焦点移动到结果区（键盘用户立即感知执行结果）。
  useEffect(() => {
    if (result) {
      window.requestAnimationFrame(() => resultRef.current?.focus());
    }
  }, [result]);

  const overrideMutation = usePlanOverrides(planId);

  // 当前方案的分配明细（供任务选择下拉）。
  const currentPlan = useMemo(
    () => activePlans.find((p) => p.planId === planId) ?? null,
    [activePlans, planId],
  );
  const assignmentOptions = useMemo(
    () =>
      (currentPlan?.assignments ?? []).map((a) => ({
        taskId: a.taskId,
        label: `${a.taskId} → ${a.personId ?? a.deviceId ?? '未分配'}`,
      })),
    [currentPlan],
  );

  const kindMeta = OVERRIDE_KINDS.find((k) => k.kind === kind);

  // v0.7 Batch7.3：目标任务选定后拉取候选资源（评分/技能/负荷排序），供目标人员选择。
  const { data: candidates } = useQuery({
    queryKey: queryKeys.schedulerTaskCandidates(taskId),
    queryFn: () => getTaskCandidates(taskId),
    enabled: Boolean(taskId) && kindMeta?.needsTarget === 'person',
    staleTime: 30_000,
  });
  const candidateOptions: TaskCandidateResource[] = candidates?.candidates ?? [];

  function buildAction(): PlanOverrideAction | null {
    if (!operator.trim()) {
      toast.error('请填写操作人（operator）');
      return null;
    }
    if (!reason.trim()) {
      toast.error('请填写操作原因（写入审计，必填）');
      return null;
    }
    if (!taskId) {
      toast.error('请先选择要覆盖的任务');
      return null;
    }
    if (kindMeta?.needsTarget === 'person' && !targetPersonId) {
      toast.error('请选择目标人员');
      return null;
    }
    if (kindMeta?.needsTarget === 'device' && !targetDeviceId) {
      toast.error('请输入目标设备 ID');
      return null;
    }
    if (kindMeta?.needsTarget === 'station' && !targetStationId) {
      toast.error('请输入目标工位 ID');
      return null;
    }
    if (kindMeta?.needsTarget === 'time' && (!startMs || !endMs)) {
      toast.error('请输入调整后时间窗（epoch ms 起止）');
      return null;
    }
    return {
      kind,
      taskId,
      personId: kindMeta?.needsTarget === 'person' ? targetPersonId : undefined,
      deviceId: kindMeta?.needsTarget === 'device' ? targetDeviceId : undefined,
      stationId: kindMeta?.needsTarget === 'station' ? targetStationId : undefined,
      // Phase 3 / P3-T4：换资源使用 changeResource 字段（后端优先读此字段）。
      changeResource:
        kind === 'CHANGE_RESOURCE'
          ? { personId: targetPersonId || undefined }
          : undefined,
      startMs: kindMeta?.needsTarget === 'time' && startMs ? Number(startMs) : undefined,
      endMs: kindMeta?.needsTarget === 'time' && endMs ? Number(endMs) : undefined,
      reason,
    };
  }

  function handleSubmit() {
    const action = buildAction();
    if (!action || !planId) return;
    // Task 10 / 10.2：先执行预览（纯计算不落库）→ 预览对话框确认后才真正提交。
    setPendingAction(action);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    previewOverrides(planId, { actions: [action], operator, reason })
      .then(setPreview)
      .catch((e) => {
        setPreviewError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPreviewLoading(false));
  }

  /** 预览确认后真正执行覆盖（保留原 API 调用与成功后的 diff 展示）。 */
  function confirmExecute() {
    if (!pendingAction || !planId) return;
    overrideMutation.mutate(
      { actions: [pendingAction], operator, reason },
      {
        onSuccess: (res) => {
          toast.success('覆盖已生效，已触发重排');
          // Phase 3 / P3-T3：经 planDiffVM 差分展示 before/after（保留）。
          const diff = planDiffVM(res.before, res.after);
          setResult({
            planId: res.planId,
            changed: diff.changedAssignments.map((d) => d.taskId),
            added: diff.addedTaskIds,
            removed: diff.removedTaskIds,
            metrics: diff.metricsDelta,
          });
        },
        onError: (e) => {
          toast.error(`覆盖失败：${e instanceof Error ? e.message : '未知错误'}`);
        },
      },
    );
    setPreview(null);
    setPendingAction(null);
  }

  // 焦点管理（镜像 Shell 帮助对话框模式：打开存焦点 → 关闭恢复）。
  const previewOpen = Boolean(preview || previewError || previewLoading);
  useEffect(() => {
    if (previewOpen) {
      previewPrevFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => previewConfirmRef.current?.focus());
    } else if (previewPrevFocusRef.current) {
      previewPrevFocusRef.current.focus();
      previewPrevFocusRef.current = null;
    }
  }, [previewOpen]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <GitCompareArrows className="w-3.5 h-3.5 text-white/80" />
        <span className="text-xs text-white/80">人工覆盖</span>
        <Badge className="ml-1 bg-white/10 text-white/70 border-white/20">约束 → 重排 → diff</Badge>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 py-3 space-y-4">
          {/* 方案选择 */}
          <div className="space-y-1.5">
            <label className="text-xs text-white/60">目标方案</label>
            {plansLoading ? (
              <div className="flex items-center gap-2 text-white/50 text-xs">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载活跃方案…
              </div>
            ) : (
              <select
                aria-label="选择方案"
                value={planId ?? ''}
                onChange={(e) => {
                  setPlanId(e.target.value || null);
                  setResult(null);
                }}
                className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-white/30"
              >
                <option value="">请选择活跃方案</option>
                {activePlans.map((p) => (
                  <option key={p.planId} value={p.planId} className="bg-[hsl(220_14%_14%)]">
                    {p.planName}（{p.planId.slice(0, 8)}）
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* 任务选择 */}
          <div className="space-y-1.5">
            <label className="text-xs text-white/60">目标任务</label>
            <select
              aria-label="选择任务"
              value={taskId}
              onChange={(e) => {
                setTaskId(e.target.value);
                setResult(null);
              }}
              className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-white/30"
            >
              <option value="">请选择任务</option>
              {assignmentOptions.map((o) => (
                <option key={o.taskId} value={o.taskId} className="bg-[hsl(220_14%_14%)]">
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* 动作类型 */}
          <div className="space-y-1.5">
            <label className="text-xs text-white/60">覆盖动作</label>
            <div className="grid grid-cols-2 gap-1.5">
              {OVERRIDE_KINDS.map((k) => {
                const Icon = k.icon;
                const selected = kind === k.kind;
                return (
                  <button
                    key={k.kind}
                    type="button"
                    onClick={() => setKind(k.kind)}
                    aria-pressed={selected}
                    className={cn(
                      'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs border transition-colors',
                      selected
                        ? 'bg-white/10 border-white/30 text-white'
                        : 'border-white/10 text-white/60 hover:bg-white/5',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {k.label}
                  </button>
                );
              })}
            </div>
            {kindMeta && <p className="text-[11px] text-white/45">{kindMeta.description}</p>}
          </div>

          {/* 目标人员（仅 person 类动作）——v0.7 Batch7.3：候选资源选择器 */}
          {kindMeta?.needsTarget === 'person' && (
            <div className="space-y-1.5">
              <label className="text-xs text-white/60">
                目标人员
                {candidateOptions.length > 0 && (
                  <span className="text-white/35 ml-1">（按评分排序，含技能/负荷）</span>
                )}
              </label>
              {candidateOptions.length > 0 ? (
                <select
                  aria-label="选择目标人员（候选）"
                  value={targetPersonId}
                  onChange={(e) => setTargetPersonId(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-white/30"
                >
                  <option value="">请选择候选人员</option>
                  {candidateOptions
                    .filter((c) => c.eligible)
                    .map((c) => (
                      <option key={c.personId} value={c.personId} className="bg-[hsl(220_14%_14%)]">
                        {c.personName}（{c.personId.slice(0, 8)} · 技能
                        {c.skillMatch ? '✓' : '✗'} · 负荷 {Math.round(c.workload * 100)}% ·{' '}
                        {Math.round(c.distanceMeters)}m · 评分 {c.score.toFixed(1)}）
                      </option>
                    ))}
                  {candidateOptions.filter((c) => !c.eligible).length > 0 && (
                    <optgroup label="不可行候选（含排除原因）">
                      {candidateOptions
                        .filter((c) => !c.eligible)
                        .map((c) => (
                          <option key={c.personId} value={c.personId} className="bg-[hsl(220_14%_14%)]">
                            {c.personName}（{c.reasons.slice(0, 2).join('/')}）
                          </option>
                        ))}
                    </optgroup>
                  )}
                </select>
              ) : (
                <input
                  aria-label="目标人员 ID"
                  value={targetPersonId}
                  onChange={(e) => setTargetPersonId(e.target.value)}
                  placeholder="输入人员 ID（如 p-001）"
                  className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30"
                />
              )}
            </div>
          )}

          {/* 目标设备（仅 device 类动作）——Phase 3 / P3-T4 */}
          {kindMeta?.needsTarget === 'device' && (
            <div className="space-y-1.5">
              <label className="text-xs text-white/60">目标设备 ID</label>
              <input
                aria-label="目标设备 ID"
                value={targetDeviceId}
                onChange={(e) => setTargetDeviceId(e.target.value)}
                placeholder="输入设备 ID（如 D-001）"
                className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30"
              />
            </div>
          )}

          {/* 目标工位（仅 station 类动作）——Phase 3 / P3-T4 */}
          {kindMeta?.needsTarget === 'station' && (
            <div className="space-y-1.5">
              <label className="text-xs text-white/60">目标工位 ID</label>
              <input
                aria-label="目标工位 ID"
                value={targetStationId}
                onChange={(e) => setTargetStationId(e.target.value)}
                placeholder="输入工位 ID（如 S1）"
                className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30"
              />
            </div>
          )}

          {/* 时间窗（仅 time 类动作）——Phase 3 / P3-T4 */}
          {kindMeta?.needsTarget === 'time' && (
            <div className="space-y-1.5">
              <label className="text-xs text-white/60">调整后时间窗（epoch ms）</label>
              <div className="flex gap-1.5">
                <input
                  aria-label="开始时间 ms"
                  value={startMs}
                  onChange={(e) => setStartMs(e.target.value)}
                  placeholder="startMs"
                  inputMode="numeric"
                  className="w-1/2 bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30"
                />
                <input
                  aria-label="结束时间 ms"
                  value={endMs}
                  onChange={(e) => setEndMs(e.target.value)}
                  placeholder="endMs"
                  inputMode="numeric"
                  className="w-1/2 bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30"
                />
              </div>
            </div>
          )}

          {/* 操作人（必填，写审计）——Phase 3 / P3-T4 */}
          <div className="space-y-1.5">
            <label className="text-xs text-white/60">操作人（必填）</label>
            <input
              aria-label="操作人"
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              placeholder="输入操作人（写审计）"
              className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30"
            />
          </div>

          {/* 原因 */}
          <div className="space-y-1.5">
            <label className="text-xs text-white/60">原因（必填，写入审计）</label>
            <textarea
              aria-label="覆盖原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明人工干预原因（必填）"
              rows={2}
              className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none"
            />
          </div>

          <Button
            onClick={handleSubmit}
            disabled={overrideMutation.isPending || !planId}
            className="w-full bg-white/10 text-white hover:bg-white/20 border border-white/20"
          >
            {overrideMutation.isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> 提交覆盖并重排…
              </>
            ) : (
              <>
                <GitCompareArrows className="w-3.5 h-3.5 mr-1.5" /> 提交覆盖并重排
              </>
            )}
          </Button>

          {/* 结果 diff（Task 12/12.3：可聚焦 + aria-live，状态不只靠颜色） */}
          {result && (
            <div
              ref={resultRef}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              aria-label={`重排完成，新方案 ${result.planId.slice(0, 8)}`}
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(221_83%_53%)]"
            >
              <div className="flex items-center gap-1.5 text-emerald-300 text-xs font-medium">
                <CheckCircle2 className="w-4 h-4" /> 重排完成，新方案 {result.planId.slice(0, 8)}
              </div>
              <div className="text-xs text-white/80 space-y-1">
                <p>变更任务：{result.changed.length} 个{result.changed.slice(0, 5).map((t) => ` ${t}`).join(',')}</p>
                {result.added.length > 0 && <p className="text-emerald-300/80">新增分配：{result.added.join(', ')}</p>}
                {result.removed.length > 0 && <p className="text-red-300/80">移除分配：{result.removed.join(', ')}</p>}
                <div className="pt-1 text-[11px] text-white/50 font-mono">
                  {JSON.stringify(result.metrics)}
                </div>
              </div>
            </div>
          )}

          {/* 安全提示 */}
          <div className="flex items-start gap-1.5 text-[11px] text-white/40">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            SAFETY_BLOCK 等安全硬约束无法被任何覆盖动作绕过；每次覆盖将写入审计日志。
          </div>
        </div>
      </ScrollArea>

      {/* Task 10 / 10.2：执行前预览 Dialog（previewOverrides dry-run，确认后才真正提交） */}
      <Dialog
        open={previewOpen}
        onOpenChange={(open) => {
          // CLI-026：关闭时重置全部 preview 状态（loading/error 一并清除，
          // 原实现仅 setPreview(null)，previewLoading 残留导致按钮持续禁用）。
          if (!open) {
            setPreview(null);
            setPreviewError(null);
            setPreviewLoading(false);
          }
        }}
      >
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-white">覆盖影响预览</DialogTitle>
            <DialogDescription className="text-white/70">
              以下为后端 dry-run 计算（不落库不重排）；确认后才会真正提交覆盖并触发重排。
            </DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="py-6 text-center text-xs text-white/60">
              <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
              正在计算覆盖影响…
            </div>
          ) : previewError ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              预览失败：{previewError}
              <div className="mt-1 text-[10px] text-red-300/70">不会执行任何变更，可关闭后检查输入重试。</div>
            </div>
          ) : preview ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-md border border-white/10 bg-white/5 px-1 py-1.5">
                  <div className="text-sm font-bold text-white/90">
                    {overridePreviewSummary(preview).affectedCount}
                  </div>
                  <div className="text-[9px] text-white/50">受影响分配</div>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 px-1 py-1.5">
                  <div className="text-sm font-bold text-amber-400">
                    {overridePreviewSummary(preview).planChurn}
                  </div>
                  <div className="text-[9px] text-white/50">改派任务（换人成本）</div>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 px-1 py-1.5">
                  <div className="text-sm font-bold text-white/90">
                    {overridePreviewSummary(preview).conflictsIntroduced.length}
                  </div>
                  <div className="text-[9px] text-white/50">引入新冲突</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {overridePreviewDeltaRows(preview).map((d) => (
                  <div key={d.key} className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
                    <div className="text-[9px] text-white/50">{d.label} Δ（{d.unit || '—'}）</div>
                    <div
                      className={cn(
                        'text-sm font-semibold',
                        d.value < 0 ? 'text-emerald-400' : d.value > 0 ? 'text-red-400' : 'text-white',
                      )}
                    >
                      {d.value > 0 ? '+' : ''}
                      {d.value.toFixed(1)}
                    </div>
                  </div>
                ))}
              </div>
              {overridePreviewSummary(preview).conflictsIntroduced.length > 0 && (
                <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
                  <div className="text-[9px] text-amber-400/80">预览引入的新冲突</div>
                  {overridePreviewSummary(preview).conflictsIntroduced.slice(0, 3).map((c, i) => (
                    <div key={c.conflictId ?? i} className="mt-0.5 text-[9.5px] text-white/60">
                      · {c.type ?? '—'}：{c.message ?? ''}
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[9px] text-white/40">
                目标方案 {preview.planId.slice(0, 8)} · 候选 {preview.candidatePlanId.slice(0, 12)}（PREVIEW）
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreview(null)}
              disabled={previewLoading}
            >
              取消
            </Button>
            <Button
              ref={previewConfirmRef}
              size="sm"
              autoFocus
              onClick={confirmExecute}
              disabled={overrideMutation.isPending || previewLoading || !preview || !!previewError}
            >
              {overrideMutation.isPending ? '提交中...' : '确认执行覆盖并重排'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default OverridePanel;
