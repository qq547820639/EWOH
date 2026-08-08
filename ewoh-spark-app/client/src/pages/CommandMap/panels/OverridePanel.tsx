// panels/OverridePanel.tsx — 人工覆盖中心（v0.7 A3 智能调度接线）
//
// 消费 `usePlanOverrides`（POST /plans/:planId/overrides）：
// 将人工干预（锁定资源 / 排除资源 / 偏好资源 / 加急 / 调时）转换为调度约束，
// 触发 V2 重排并展示 before/after diff。覆盖动作的合法性由后端校验（SAFETY_BLOCK 不可绕过）。
//
// 交互链：选择方案 → 选择任务 → 选择动作类型 → 选择目标资源/时间 → 提交 → 展示 diff。

import { useMemo, useState } from 'react';
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
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getActivePlans, getTaskCandidates } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { usePlanOverrides } from '@client/src/hooks/usePlanOverrides';
import type {
  PlanOverrideAction,
  PlanOverrideKind,
  SchedulingPlanV2,
  TaskCandidateResource,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { ScrollArea } from '@client/src/components/ui/scroll-area';

/** 覆盖动作定义（六类，对应后端 PlanOverrideKind 子集）。 */
const OVERRIDE_KINDS: Array<{
  kind: PlanOverrideKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  needsTarget: 'person' | 'station' | 'none';
}> = [
  { kind: 'LOCK_PERSON', label: '锁定人员', icon: Lock, description: '固定该任务的人员分配（重排不可更换）', needsTarget: 'person' },
  { kind: 'EXCLUDE_RESOURCE', label: '排除资源', icon: XCircle, description: '禁止为该任务分配指定资源', needsTarget: 'person' },
  { kind: 'PREFER_RESOURCE', label: '偏好资源', icon: Star, description: '优先分配指定资源（软约束）', needsTarget: 'person' },
  { kind: 'BOOST', label: '加急', icon: Zap, description: '提升该任务优先级（缩小 score）', needsTarget: 'none' },
  { kind: 'LOCK_TIME', label: '锁定时间', icon: Clock, description: '固定计划时间窗（重排不可挪动）', needsTarget: 'none' },
];

interface OverridePanelProps {
  /** 外部传入的已选方案（若为空则从活跃方案列表选择）。 */
  planId?: string | null;
}

export function OverridePanel({ planId: externalPlanId }: OverridePanelProps): React.ReactElement {
  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: () => getActivePlans(),
    enabled: !externalPlanId,
    refetchInterval: 30_000,
  });

  const activePlans: SchedulingPlanV2[] = useMemo(() => plans ?? [], [plans]);
  const [planId, setPlanId] = useState<string | null>(externalPlanId ?? null);
  const [taskId, setTaskId] = useState<string>('');
  const [kind, setKind] = useState<PlanOverrideKind>('LOCK_PERSON');
  const [targetPersonId, setTargetPersonId] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [result, setResult] = useState<{
    planId: string;
    changed: string[];
    added: string[];
    removed: string[];
    metrics: Record<string, number>;
  } | null>(null);

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
    if (!taskId) {
      toast.error('请先选择要覆盖的任务');
      return null;
    }
    if (kindMeta?.needsTarget === 'person' && !targetPersonId) {
      toast.error('请选择目标人员');
      return null;
    }
    return {
      kind,
      taskId,
      personId: kindMeta?.needsTarget === 'person' ? targetPersonId : undefined,
      reason: reason || undefined,
    };
  }

  function handleSubmit() {
    const action = buildAction();
    if (!action || !planId) return;
    overrideMutation.mutate(
      { actions: [action], reason: reason || undefined },
      {
        onSuccess: (res) => {
          toast.success('覆盖已生效，已触发重排');
          setResult({
            planId: res.planId,
            changed: res.diff.changedTaskIds,
            added: res.diff.addedTaskIds,
            removed: res.diff.removedTaskIds,
            metrics: res.diff.metricsDelta,
          });
        },
        onError: (e) => {
          toast.error(`覆盖失败：${e instanceof Error ? e.message : '未知错误'}`);
        },
      },
    );
  }

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

          {/* 原因 */}
          <div className="space-y-1.5">
            <label className="text-xs text-white/60">原因（写入审计）</label>
            <textarea
              aria-label="覆盖原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明人工干预原因（可选）"
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

          {/* 结果 diff */}
          {result && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
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
    </div>
  );
}

export default OverridePanel;
