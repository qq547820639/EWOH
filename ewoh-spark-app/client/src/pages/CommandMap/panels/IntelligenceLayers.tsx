import { useMemo, useState } from 'react';
import {
  Brain,
  Flag,
  Users,
  AlertTriangle,
  GitCompareArrows,
  Activity,
  ChevronDown,
  X,
  Sparkles,
  Check,
  ChevronRight,
} from 'lucide-react';
import type {
  SchedulingPlanV2,
  SchedulingAssignment,
  TaskCandidatesResponse,
  TaskCandidateResource,
  SpatialEntity,
  CurrentWorldState,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Badge } from '@client/src/components/ui/badge';

/**
 * 智能调度驾驶舱（Task 8）右侧叠加层。
 *
 * 纯展示层：所有业务值（有效优先级、候选/排除原因、冲突、方案差异、执行偏差）
 * 均直接来自后端返回，前端不重新计算资格 / 优先级 / 调度逻辑。
 */

interface IntelligenceLayersProps {
  plan: SchedulingPlanV2 | null;
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  candidates: TaskCandidatesResponse | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onClose: () => void;
}

/** 由后端 priority.level 映射徽标颜色（展示用，非调度逻辑）。 */
function priorityLevelClass(level?: string): string {
  switch (level) {
    case 'urgent':
    case 'critical':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'high':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'medium':
    case 'normal':
      return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case 'low':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    default:
      return 'bg-white/10 text-white/70 border-white/10';
  }
}

/** 后端 priority.level 的触点颜色（地图徽标用）。 */
function priorityLevelColor(level?: string): string {
  switch (level) {
    case 'urgent':
    case 'critical':
      return '#ef4444';
    case 'high':
      return '#f97316';
    case 'medium':
    case 'normal':
      return '#f59e0b';
    case 'low':
      return '#3b82f6';
    default:
      return '#a855f7';
  }
}

function Section({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-white/10 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[10px] font-semibold text-white/80 hover:bg-white/5"
      >
        {icon}
        <span>{title}</span>
        <ChevronDown
          className={cn('w-3 h-3 ml-auto text-white/40 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && <div className="px-3 pb-3 space-y-1.5">{children}</div>}
    </div>
  );
}

/** 冲突层：从方案 violations + 分配失败/阻断 + 决策轨迹排除原因 + 候选 reservation 冲突聚合。 */
function ConflictLayer({ plan }: { plan: SchedulingPlanV2 }) {
  const conflicts = useMemo(() => {
    const items: Array<{ severity: 'error' | 'warn' | 'info'; text: string }> = [];
    for (const v of plan.violations ?? []) {
      const rec = v as Record<string, unknown>;
      const kind = String(rec.kind ?? rec.type ?? 'violation');
      const detail = String(rec.detail ?? rec.reason ?? rec.message ?? '');
      items.push({
        severity: 'error',
        text: `违反约束 · ${kind}${detail ? `：${detail}` : ''}`,
      });
    }
    for (const a of plan.assignments) {
      if (a.status === 'blocked' || a.status === 'failed') {
        items.push({
          severity: 'error',
          text: `任务 ${a.taskId} 分配状态 ${a.status}${a.reasons[0] ? `：${a.reasons[0]}` : ''}`,
        });
      }
    }
    for (const a of plan.assignments) {
      for (const rej of a.decisionTrace?.rejectedAlternatives ?? []) {
        const reason = Array.isArray(rej.reason) ? rej.reason.join('；') : '';
        if (!reason) continue;
        items.push({
          severity: 'info',
          text: `候选 ${rej.personId ?? rej.deviceId ?? '资源'} 被排除：${reason}`,
        });
      }
    }
    return items;
  }, [plan]);

  if (conflicts.length === 0) {
    return (
      <div className="text-[10px] text-emerald-400/80 flex items-center gap-1">
        <Check className="w-3 h-3" /> 后端未上报冲突
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {conflicts.map((c, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start gap-1 text-[10px]',
            c.severity === 'error'
              ? 'text-red-400'
              : c.severity === 'warn'
                ? 'text-amber-400'
                : 'text-white/50',
          )}
        >
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 方案差异：展示后端 baselineDelta（较基线）与求解停留信息。 */
function PlanDelta({ plan }: { plan: SchedulingPlanV2 }) {
  const entries = useMemo(() => {
    const rec = (plan.baselineDelta ?? {}) as Record<string, unknown>;
    const labels: Record<string, string> = {
      lateMinutesDelta: '延期',
      walkingMetersDelta: '移动',
      stationWaitMinutesDelta: '等待',
      maxWorkloadDelta: '负荷',
      changeCostDelta: '变更',
      deltaLateMinutes: '延期',
      deltaWalkingMeters: '移动',
      deltaStationWait: '等待',
      deltaMaxWorkload: '负荷',
      deltaChangeCost: '变更',
    };
    return Object.entries(rec)
      .map(([k, v]) => ({ key: k, label: labels[k] ?? k, value: v }))
      .filter((e) => typeof e.value === 'number');
  }, [plan]);

  return (
    <div className="space-y-1">
      {entries.length === 0 && (
        <div className="text-[10px] text-white/40">后端未提供方案差异（baselineDelta）</div>
      )}
      {entries.map((e) => {
        const v = e.value as number;
        return (
          <div key={e.key} className="flex items-center justify-between text-[10px]">
            <span className="text-white/60">{e.label}</span>
            <span
              className={cn(
                'tabular-nums',
                v <= 0 ? 'text-emerald-400' : 'text-red-400',
              )}
            >
              较基线 {v > 0 ? '+' : ''}
              {v.toFixed(0)}
            </span>
          </div>
        );
      })}
      {plan.solverStatus && (
        <div className="pt-1 text-[9px] text-white/40">
          求解器: {plan.solverVersion} · {plan.solverStatus}
          {typeof plan.objective === 'number' && ` · 目标 ${plan.objective.toFixed(0)}`}
          {plan.fallbackReason && ` · 降级: ${plan.fallbackReason}`}
        </div>
      )}
    </div>
  );
}

/** 执行偏差：仅当后端提供实际执行数据时展示（planned vs actual）。 */
function ExecutionDeviation({ assignment }: { assignment: SchedulingAssignment }) {
  // 方案分配可能携带实际执行字段（若后端下发后回填）。前端仅透传展示。
  const rec = assignment as unknown as AssignmentRecord;
  const actualStart = rec.actualStart ?? rec.actualStartMs != null ? String(rec.actualStartMs) : null;
  const actualEnd = rec.actualEnd ?? rec.actualEndMs != null ? String(rec.actualEndMs) : null;
  const hasActual = actualStart != null || actualEnd != null;
  if (!hasActual) return null;
  return (
    <div className="text-[10px] text-white/60">
      计划 {assignment.plannedStart ?? '—'} → 实际{' '}
      {actualStart ?? '—'}
      {actualEnd ? ` / ${actualEnd}` : ''}
    </div>
  );
}

type AssignmentRecord = Record<string, unknown> & {
  actualStart?: string | null;
  actualEnd?: string | null;
  actualStartMs?: number | null;
  actualEndMs?: number | null;
};

/** 候选资源面板：展示后端返回的候选并高亮合格项（含 ETA/距离/排除原因）。 */
function CandidatesList({
  candidates,
  selectedTaskId,
}: {
  candidates: TaskCandidatesResponse | null;
  selectedTaskId: string | null;
}) {
  if (!selectedTaskId) {
    return <div className="text-[10px] text-white/40">在优先级层点击任务以查看候选资源</div>;
  }
  if (!candidates) {
    return <div className="text-[10px] text-white/40">候选加载中…</div>;
  }
  const list: TaskCandidateResource[] = candidates.candidates ?? [];
  if (list.length === 0) {
    return <div className="text-[10px] text-white/40">后端未返回候选资源</div>;
  }
  return (
    <div className="space-y-1">
      <div className="text-[9px] text-white/50">
        {candidates.taskTitle ?? candidates.taskId} · 求解器 {candidates.solverVersion}
      </div>
      {list.map((c, i) => (
        <div
          key={`${c.personId}-${c.deviceId ?? 'none'}-${i}`}
          className={cn(
            'rounded border px-2 py-1',
            c.eligible
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : 'border-white/10 bg-white/5 opacity-80',
          )}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-white/90 font-medium">{c.personName}</span>
            <Badge
              className={cn(
                'text-[8px] px-1',
                c.eligible
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  : 'bg-red-500/20 text-red-400 border-red-500/30',
              )}
            >
              {c.eligible ? '合格' : '排除'}
            </Badge>
            {c.skillMatch && (
              <Badge className="text-[8px] px-1 bg-blue-500/20 text-blue-400 border-blue-500/30">
                技能匹配
              </Badge>
            )}
            {c.reservationConflict && (
              <Badge className="text-[8px] px-1 bg-amber-500/20 text-amber-400 border-amber-500/30">
                占用冲突
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-[9px] text-white/60">
            ETA {c.etaSeconds.toFixed(0)}s · {(c.distanceMeters ?? 0).toFixed(0)}m · 负荷{' '}
            {(c.workload * 100).toFixed(0)}%{c.batteryPct != null && ` · 电量 ${c.batteryPct.toFixed(0)}%`}
          </div>
          {c.reasons.length > 0 && (
            <div className="mt-0.5 text-[9px] text-white/45">
              {c.reasons.map((r, j) => (
                <div key={j}>· {r}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const IntelligenceLayers = ({
  plan,
  entities,
  worldState,
  candidates,
  selectedTaskId,
  onSelectTask,
  onClose,
}: IntelligenceLayersProps): React.ReactElement => {
  const priorityTasks = useMemo(() => {
    if (!plan) return [];
    return plan.assignments.map((a) => {
      const p = a.decisionTrace?.priority;
      const unassigned = !a.personId;
      return { assignment: a, priority: p, unassigned };
    });
  }, [plan]);

  const resourceCount = useMemo(() => {
    if (!worldState) return { persons: 0, devices: 0, workstations: 0 };
    return {
      persons: worldState.persons.length,
      devices: worldState.devices.length,
      workstations: worldState.workstations.length,
    };
  }, [worldState]);

  return (
    <div className="pointer-events-auto flex h-full w-[320px] flex-col overflow-hidden rounded-lg border border-white/10 bg-[hsl(220_14%_14%)]/95 text-white shadow-2xl backdrop-blur">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 shrink-0">
        <Brain className="w-3.5 h-3.5 text-violet-400" />
        <span className="text-xs font-semibold text-white/90">智能调度驾驶舱</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="text-white/50 hover:text-white"
          aria-label="关闭智能调度驾驶舱"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!plan ? (
          <div className="p-4 text-[11px] text-white/50">
            请先在「调度方案」面板生成并选择一个方案，导出智能调度驾驶舱图层。
          </div>
        ) : (
          <>
            {/* 优先级层 */}
            <Section title="优先级层" icon={<Flag className="w-3 h-3 text-red-400" />}>
              {priorityTasks.length === 0 && (
                <div className="text-[10px] text-white/40">方案无分配任务</div>
              )}
              <div className="space-y-1">
                {priorityTasks.map(({ assignment, priority, unassigned }) => {
                  const active = selectedTaskId === assignment.taskId;
                  return (
                    <button
                      key={assignment.assignmentId}
                      type="button"
                      onClick={() => onSelectTask(active ? null : assignment.taskId)}
                      className={cn(
                        'w-full text-left rounded border px-2 py-1 transition-colors',
                        active
                          ? 'border-violet-500/40 bg-violet-500/10'
                          : 'border-white/10 bg-white/5 hover:bg-white/10',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        {unassigned && (
                          <Badge className="text-[8px] px-1 bg-red-500/20 text-red-400 border-red-500/30">
                            未分配
                          </Badge>
                        )}
                        <span className="text-[10px] text-white/90 font-medium truncate">
                          {assignment.taskId}
                        </span>
                        <ChevronRight
                          className={cn(
                            'w-3 h-3 ml-auto text-white/40',
                            active && 'rotate-90 text-white/80',
                          )}
                        />
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {priority ? (
                          <>
                            <Badge
                              className={cn(
                                'text-[8px] px-1',
                                priorityLevelClass(priority.level),
                              )}
                            >
                              有效优先级 {priority.score.toFixed(2)}
                            </Badge>
                            <span className="text-[9px] text-white/50">
                              {priority.factors.map((f) => f.label).join(' · ')}
                            </span>
                          </>
                        ) : (
                          <span className="text-[9px] text-white/40">后端未提供优先级因子</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Section>

            {/* 候选资源层 */}
            <Section
              title="候选资源"
              icon={<Users className="w-3 h-3 text-cyan-400" />}
              defaultOpen={!!selectedTaskId}
            >
              <CandidatesList candidates={candidates} selectedTaskId={selectedTaskId} />
            </Section>

            {/* 冲突层 */}
            <Section
              title="冲突层"
              icon={<AlertTriangle className="w-3 h-3 text-amber-400" />}
              defaultOpen={false}
            >
              <ConflictLayer plan={plan} />
            </Section>

            {/* 方案差异 + 执行偏差 */}
            <Section title="方案差异" icon={<GitCompareArrows className="w-3 h-3 text-emerald-400" />}>
              <PlanDelta plan={plan} />
            </Section>
            <Section title="执行偏差" icon={<Activity className="w-3 h-3 text-blue-400" />}>
              {plan.assignments.some((a) => (a as unknown as AssignmentRecord).actualStart != null) ? (
                <div className="space-y-1">
                  {plan.assignments.map((a) => (
                    <ExecutionDeviation key={a.assignmentId} assignment={a} />
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-white/40">
                  暂无可用的实际执行数据（planned vs actual）
                </div>
              )}
            </Section>

            {/* 资源可用性概览 */}
            <Section title="资源可用性" icon={<Sparkles className="w-3 h-3 text-violet-400" />}>
              <div className="text-[10px] text-white/60">
                人员 {resourceCount.persons} · 设备 {resourceCount.devices} · 工位{' '}
                {resourceCount.workstations}
                <span className="text-white/35">（状态见地图资源层）</span>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
};

export default IntelligenceLayers;