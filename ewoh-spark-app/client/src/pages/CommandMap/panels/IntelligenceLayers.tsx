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
import {
  describeCapabilityRequirements,
  describeRelaxationSuggestions,
  formatCapabilityInput,
  parseCapabilityInput,
} from '../vm/taskRequirementsVM';
import { candidateExplainVM, type CandidateExplainItem } from '../vm/candidateExplainVM';
import { Badge } from '@client/src/components/ui/badge';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';
import { useVirtualList } from '@client/src/lib/virtualList';
import { buildPlanIssueItems, hasUnregisteredCode } from './intelligence-layers-logic';
import type { PlanIssueItem } from './intelligence-layers-logic';
import React from 'react';

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
  /** NO-16a：保存任务能力要求（父层调 API + 刷新候选）；缺省则只读展示。 */
  onSaveRequirements?: (
    taskId: string,
    deviceNames: string[],
    stationNames: string[],
    approvalId?: string,
  ) => void;
  savingRequirements?: boolean;
  /** 上次保存返回的"当前无法匹配"提示。 */
  requirementWarnings?: string[];
  /** NO-20a：放宽高风险能力需审批时的提示与入口。 */
  approvalRequired?: { message: string; relaxedHighRisk: string[] } | null;
  onRequestApproval?: (taskId: string, deviceNames: string[], stationNames: string[]) => void;
  pendingApprovalId?: string | null;
  /** NO-22a：审批时效文案（"还有多久能用"；无通过时间时如实说明）。 */
  pendingApprovalFreshness?: string | null;
  onRefreshApproval?: () => void;
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
      return 'bg-card/10 text-white/70 border-white/10';
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
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[10px] font-semibold text-white/80 hover:bg-card/5"
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

/**
 * 问题条目列表（导出以便静态渲染测试直接断言——冲突层默认折叠，
 * `renderToStaticMarkup` 看不到折叠内容，而"未派工原因可读"必须被钉住）。
 */
export function PlanIssueList({ items }: { items: PlanIssueItem[] }): React.ReactElement {
  const hasUnregistered = hasUnregisteredCode(items);
  return (
    <div className="space-y-1">
      {hasUnregistered && (
        <div className="text-[10px] text-amber-400/80">
          存在未登记原因（已保留原始码）：请把新码补进共享词表，现场才能看到中文解释。
        </div>
      )}
      {items.map((c, i) => (
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

/** 冲突层：问题条目由纯逻辑模块聚合（violations + 分配失败/阻断 + 决策轨迹排除原因）。 */
function ConflictLayer({ plan }: { plan: SchedulingPlanV2 }) {
  const conflicts = useMemo(() => buildPlanIssueItems(plan), [plan]);

  if (conflicts.length === 0) {
    return (
      <div className="text-[10px] text-emerald-400/80 flex items-center gap-1">
        <Check className="w-3 h-3" /> 后端未上报冲突
      </div>
    );
  }
  return <PlanIssueList items={conflicts} />;
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
  // CLI-020：加括号修复优先级——原式解析为 (rec.actualStart ?? (rec.actualStartMs != null))
  // ? String(...) : null，actualStart 值被丢弃且可能渲染 "undefined"。
  const actualStart =
    rec.actualStart ?? (rec.actualStartMs != null ? String(rec.actualStartMs) : null);
  const actualEnd =
    rec.actualEnd ?? (rec.actualEndMs != null ? String(rec.actualEndMs) : null);
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

function CandidateRow({ item }: { item: CandidateExplainItem }) {
  return (
    <div
      className={cn(
        'rounded border px-2 py-1',
        item.eligible
          ? 'border-emerald-500/30 bg-emerald-500/10'
          : 'border-red-500/20 bg-card/5 opacity-85',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-white/90 font-medium">{item.personName}</span>
        <Badge
          className={cn(
            'text-[8px] px-1',
            item.eligible
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
              : 'bg-red-500/20 text-red-400 border-red-500/30',
          )}
        >
          {item.eligible ? '合格' : '排除'}
        </Badge>
        {item.eligible && item.rank != null && (
          <Badge className="text-[8px] px-1 bg-violet-500/20 text-violet-300 border-violet-500/30">
            #{item.rank}
          </Badge>
        )}
        {item.isLockedAssignee && (
          <Badge className="text-[8px] px-1 bg-sky-500/20 text-sky-300 border-sky-500/30">
            锁定受让人
          </Badge>
        )}
        {item.skillMatch && (
          <Badge className="text-[8px] px-1 bg-blue-500/20 text-blue-400 border-blue-500/30">
            技能匹配
          </Badge>
        )}
        {item.reservationConflict && (
          <Badge className="text-[8px] px-1 bg-amber-500/20 text-amber-400 border-amber-500/30">
            占用冲突
          </Badge>
        )}
      </div>
      <div className="mt-0.5 text-[9px] text-white/60">
        {item.eligible && item.rank != null && (
          <span className="mr-1.5 text-violet-300">评分 {item.score.toFixed(1)}</span>
        )}
        ETA {item.etaSeconds.toFixed(0)}s · {item.distanceMeters.toFixed(0)}m · 负荷{' '}
        {(item.workload * 100).toFixed(0)}%{item.batteryPct != null && ` · 电量 ${item.batteryPct.toFixed(0)}%`}
      </div>
      {item.reasons.length > 0 && (
        <div className="mt-0.5 text-[9px] text-white/45">
          {Array.from(new Set(item.reasons)).map((r) => (
            <div key={`reason-${r}`}>· {r}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 候选资源面板（P0）：candidateExplainVM 统一展示模型——合格按评分排序（带 rank），
 *  排除分组显示硬约束原因；locked/preferred 状态透传后端字段，前端不判资格。 */
export function CandidatesList({
  candidates,
  selectedTaskId,
  onSaveRequirements,
  savingRequirements,
  requirementWarnings,
  approvalRequired,
  onRequestApproval,
  pendingApprovalId,
  pendingApprovalFreshness,
  onRefreshApproval,
}: {
  candidates: TaskCandidatesResponse | null;
  selectedTaskId: string | null;
  /** 保存任务能力要求（父层负责调 API 与刷新候选）。 */
  onSaveRequirements?: (
    taskId: string,
    deviceNames: string[],
    stationNames: string[],
    approvalId?: string,
  ) => void;
  savingRequirements?: boolean;
  /** 上次保存返回的"当前无法匹配"提示（不阻断写入，但必须可见）。 */
  requirementWarnings?: string[];
  /** NO-20a：保存需要审批时展示（含服务端原因与审批入口）。 */
  approvalRequired?: { message: string; relaxedHighRisk: string[] } | null;
  /** 发起审批（父层调 API）；返回审批号后由现场复制/检查后重试。 */
  onRequestApproval?: (taskId: string, deviceNames: string[], stationNames: string[]) => void;
  /** 已发起的审批号（等待/已通过；重试保存时带上）。 */
  pendingApprovalId?: string | null;
  /** NO-22a：审批时效文案（"还有多久能用"；未通过/无通过时间时如实说明）。 */
  pendingApprovalFreshness?: string | null;
  /** 检查审批状态（父层调 API；已通过则可直接重试保存）。 */
  onRefreshApproval?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deviceInput, setDeviceInput] = useState('');
  const [stationInput, setStationInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [approvalIdInput, setApprovalIdInput] = useState('');

  if (!selectedTaskId) {
    return <div className="text-[10px] text-white/40">在优先级层点击任务以查看候选资源</div>;
  }
  if (!candidates) {
    return <div className="text-[10px] text-white/40">候选加载中…</div>;
  }
  const vm = candidateExplainVM(candidates);
  // 注意：候选为空时**不能**提前 return——"没有候选"恰恰是最需要看到并修改
  // 能力要求的场景（要求写错会让任务永远匹配不到资源）。
  const hasAnyCandidate = vm.eligible.length > 0 || vm.rejected.length > 0;
  const relaxationNotes = describeRelaxationSuggestions(candidates);
  const beginEdit = () => {
    setDeviceInput(formatCapabilityInput(candidates.requiredDeviceCapabilities));
    setStationInput(formatCapabilityInput(candidates.requiredStationCapabilities));
    setParseError(null);
    setEditing(true);
  };
  const submit = () => {
    const device = parseCapabilityInput(deviceInput);
    const station = parseCapabilityInput(stationInput);
    const errors = [...device.errors, ...station.errors];
    if (errors.length > 0) {
      // 前端先拦（与后端同口径），避免"点了保存才发现 400"
      setParseError(errors.join('；'));
      return;
    }
    setParseError(null);
    // 放宽高风险能力时，审批号随保存一起提交（服务端会逐字核对是否"正好批准了本次变更"）
    onSaveRequirements?.(
      selectedTaskId,
      device.names,
      station.names,
      approvalIdInput.trim() || undefined,
    );
    setEditing(false);
  };

  return (
    <div className="space-y-1">
      <div className="text-[9px] text-white/50">
        {candidates.taskTitle ?? candidates.taskId} · 求解器 {candidates.solverVersion} ·{' '}
        {vm.eligibleCount} 合格 / {vm.rejectedCount} 排除
      </div>
      {/* 能力要求：决定该任务能被哪些资源承接；写错会让任务永远匹配不到资源 */}
      <div className="rounded border border-white/10 px-2 py-1" data-testid="task-capability-requirements">
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-white/60">能力要求</span>
          <span className="text-[9px] text-white/80" data-testid="task-capability-summary">
            {describeCapabilityRequirements(candidates)}
          </span>
          {onSaveRequirements && !editing && (
            <button
              type="button"
              className="ml-auto text-[9px] text-cyan-300 hover:underline"
              data-testid="task-capability-edit"
              onClick={beginEdit}
            >
              修改
            </button>
          )}
        </div>
        {editing && (
          <div className="mt-1 space-y-1">
            <label className="block text-[9px] text-white/50">
              设备能力（逗号/顿号分隔，留空=不要求）
              <input
                className="mt-0.5 w-full rounded border border-white/15 bg-transparent px-1 py-0.5 text-[10px] text-white"
                value={deviceInput}
                data-testid="task-capability-device-input"
                onChange={(e) => setDeviceInput(e.target.value)}
                placeholder="exo-lift、vacuum"
              />
            </label>
            <label className="block text-[9px] text-white/50">
              工位能力（留空=不要求）
              <input
                className="mt-0.5 w-full rounded border border-white/15 bg-transparent px-1 py-0.5 text-[10px] text-white"
                value={stationInput}
                data-testid="task-capability-station-input"
                onChange={(e) => setStationInput(e.target.value)}
                placeholder="workstation"
              />
            </label>
            {parseError && (
              <div className="text-[9px] text-red-400" role="alert" data-testid="task-capability-error">
                {parseError}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-cyan-400/40 px-1.5 py-0.5 text-[9px] text-cyan-200 disabled:opacity-50"
                data-testid="task-capability-save"
                disabled={Boolean(savingRequirements)}
                onClick={submit}
              >
                {savingRequirements ? '保存中…' : '保存并要求重排'}
              </button>
              <button
                type="button"
                className="text-[9px] text-white/50 hover:underline"
                onClick={() => setEditing(false)}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {approvalRequired && (
          <div className="mt-1 space-y-1 rounded border border-amber-400/40 px-1.5 py-1" data-testid="task-capability-approval">
            <div className="text-[9px] text-amber-300">{approvalRequired.message}</div>
            {onRequestApproval && (
              <button
                type="button"
                className="rounded border border-amber-400/40 px-1.5 py-0.5 text-[9px] text-amber-200"
                data-testid="task-capability-request-approval"
                onClick={() => onRequestApproval(selectedTaskId, [], [])}
              >
                发起安全审批（放宽{approvalRequired.relaxedHighRisk.join('、')}）
              </button>
            )}
            {pendingApprovalId && (
              <div className="space-y-1 text-[9px] text-white/70">
                <div data-testid="task-capability-approval-id">审批号：{pendingApprovalId}（等待安全管理员审批）</div>
                {pendingApprovalFreshness && (
                  <div className="text-[9px] text-white/60" data-testid="task-capability-approval-freshness">
                    {pendingApprovalFreshness}
                  </div>
                )}
                {onRefreshApproval && (
                  <button
                    type="button"
                    className="rounded border border-white/20 px-1.5 py-0.5 text-[9px] text-white/80"
                    data-testid="task-capability-refresh-approval"
                    onClick={onRefreshApproval}
                  >
                    检查审批状态
                  </button>
                )}
              </div>
            )}
            <label className="block text-[9px] text-white/60">
              已获批？粘贴审批号后重新保存
              <input
                className="mt-0.5 w-full rounded border border-white/15 bg-transparent px-1 py-0.5 text-[10px] text-white"
                value={approvalIdInput}
                data-testid="task-capability-approval-input"
                onChange={(e) => setApprovalIdInput(e.target.value)}
                placeholder="审批实例 id"
              />
            </label>
          </div>
        )}
        {requirementWarnings && requirementWarnings.length > 0 && (
          <ul className="mt-1 space-y-0.5" data-testid="task-capability-warnings">
            {requirementWarnings.map((w) => (
              <li key={w} className="text-[9px] text-amber-300">
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!hasAnyCandidate && (
        <div className="text-[10px] text-white/40" data-testid="task-candidates-empty">
          后端未返回候选资源
        </div>
      )}
      {/* NO-17a：零候选且因能力被挡时，给出"放宽哪一项会得到什么"的建议。
          只建议——不自动放宽，改要求仍是人工动作（面板内的"修改"入口就在上方）。 */}
      {relaxationNotes.length > 0 && (
        <ul className="space-y-0.5" data-testid="task-capability-relaxation">
          {relaxationNotes.map((note) => (
            <li key={note} className="text-[9px] text-amber-300">
              {note}
            </li>
          ))}
        </ul>
      )}
      {vm.eligible.map((c) => (
        <CandidateRow key={`${c.personId}-${c.deviceId ?? 'none'}-ok`} item={c} />
      ))}
      {vm.rejected.map((c) => (
        <CandidateRow key={`${c.personId}-${c.deviceId ?? 'none'}-no`} item={c} />
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
  onSaveRequirements,
  savingRequirements,
  requirementWarnings,
  approvalRequired,
  onRequestApproval,
  pendingApprovalId,
  pendingApprovalFreshness,
  onRefreshApproval,
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

  // Task 11/11.2：智能驾驶舱内长列表虚拟化（大方案 500-1000 assignments 只渲染可视窗口）。
  const priorityList = useVirtualList<HTMLDivElement>({
    total: priorityTasks.length,
    itemHeight: 48,
    overscan: 4,
  });
  const deviationList = useVirtualList<HTMLDivElement>({
    total: plan?.assignments.length ?? 0,
    itemHeight: 20,
    overscan: 4,
  });

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
          aria-label={UI_ARIA_LABELS.closeIntelligencePanel}
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
            {/* 优先级层（Task 11/11.2 虚拟化） */}
            <Section title="优先级层" icon={<Flag className="w-3 h-3 text-red-400" />}>
              <div
                ref={priorityList.ref}
                className="max-h-64 overflow-y-auto rounded border border-white/10"
              >
                {priorityTasks.length === 0 && (
                  <div className="text-[10px] text-white/40">方案无分配任务</div>
                )}
                <div style={{ height: priorityList.range.totalHeight, position: 'relative' }}>
                  <div className="space-y-1" style={{ transform: `translateY(${priorityList.range.offsetY}px)` }}>
                    {priorityTasks.slice(priorityList.slice.start, priorityList.slice.end).map(({ assignment, priority, unassigned }) => {
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
                          : 'border-white/10 bg-card/5 hover:bg-card/10',
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
                </div>
              </div>
            </Section>

            {/* 候选资源层 */}
            <Section
              title="候选资源"
              icon={<Users className="w-3 h-3 text-cyan-400" />}
              defaultOpen={!!selectedTaskId}
            >
              <CandidatesList
                candidates={candidates}
                selectedTaskId={selectedTaskId}
                onSaveRequirements={onSaveRequirements}
                savingRequirements={savingRequirements}
                requirementWarnings={requirementWarnings}
                approvalRequired={approvalRequired}
                onRequestApproval={onRequestApproval}
                pendingApprovalId={pendingApprovalId}
                onRefreshApproval={onRefreshApproval}
              />
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
                <div
                  ref={deviationList.ref}
                  className="max-h-48 overflow-y-auto rounded border border-white/10"
                >
                  <div style={{ height: deviationList.range.totalHeight, position: 'relative' }}>
                    <div className="space-y-1" style={{ transform: `translateY(${deviationList.range.offsetY}px)` }}>
                      {plan.assignments
                        .slice(deviationList.slice.start, deviationList.slice.end)
                        .map((a) => (
                          <ExecutionDeviation key={a.assignmentId} assignment={a} />
                        ))}
                    </div>
                  </div>
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