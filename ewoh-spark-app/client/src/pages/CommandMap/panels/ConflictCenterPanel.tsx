// panels/ConflictCenterPanel.tsx — 统一冲突中心（v0.7 A3 智能调度接线）
//
// 消费后端 `GET /api/scheduler/conflicts`（useSchedulerConflicts）：
// 后端从真实世界状态/预占/活跃方案聚合推导 13 类冲突（含 v0.7 新增 reservation_expiring），
// 本面板提供：类型/严重度过滤、冲突列表、详情展开、空态/加载/错误三态。
// 冲突数据不虚构：无冲突即空态提示，不展示伪造信息。

import { memo, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ShieldAlert,
  BatteryLow,
  Clock,
  WifiOff,
  Route,
  Users,
  Cpu,
  CircleAlert,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Factory,
  MapPin,
  Eye,
  Ban,
  Play,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSchedulerConflicts } from '@client/src/hooks/useSchedulerConflicts';
import { errorMessage } from '@client/src/lib/errorContract';
import {
  acknowledgeConflict,
  resolveConflict,
  suppressConflict,
} from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { getCurrentOperator } from '@client/src/lib/auth';
import { conflictVM, conflictStatusLabel, type ConflictAction } from '../vm/conflictVM';
import {
  TYPE_META,
  sortConflicts,
  lifecycleReasonValid,
  buildLifecycleActionParams,
} from './conflict-panel-logic';
import { useVirtualList } from '@client/src/lib/virtualList';
import { KeyboardTableView, type KeyboardTableColumn } from '../components/KeyboardTableView';
import type { SchedulingConflict, SchedulingConflictType } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@client/src/components/ui/dialog';

/** 冲突类型 → 图标与中文标签（前端展示语义，与后端 SchedulingConflictType 一一对应，逻辑见 conflict-panel-logic.ts）。 */
const TYPE_ICONS: Record<SchedulingConflictType, React.ComponentType<{ className?: string }>> = {
  double_booking: Users,
  resource_stale: Clock,
  person_unavailable: Users,
  device_offline: WifiOff,
  low_battery: BatteryLow,
  predecessor_violation: CircleAlert,
  station_capacity: Factory,
  forbidden_zone: ShieldAlert,
  safety_block: ShieldAlert,
  blocked_route: Route,
  stale_plan: RefreshCw,
  reservation_conflict: Clock,
  reservation_expiring: Clock,
};

const SEVERITY_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const SEVERITY_CLASS: Record<string, string> = {
  high: 'bg-red-500/15 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  low: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
};

/** 冲突生命周期状态徽标类（含文本标签，不只靠颜色——Task 12/12.3）。 */
function conflictStatusBadgeClass(status: string): string {
  return status === 'OPEN'
    ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : status === 'ACKNOWLEDGED'
      ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
      : status === 'RESOLVED'
        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
        : 'bg-slate-500/15 text-slate-400 border-slate-500/30';
}

interface ConflictCenterPanelProps {
  /** 可选：外部指定仅展示某类冲突（如地图冲突层点击跳转）。 */
  initialType?: SchedulingConflictType;
  /** 可选：点击"重排"回调（由父组件决定跳转调度方案面板）。 */
  onReplan?: (conflict: SchedulingConflict) => void;
  /** v0.7 Batch7.2：点击资源定位地图实体（父组件选中实体并聚焦）。 */
  onLocateEntity?: (entityId: string | null) => void;
  /** Phase 4 / P4-PREVIEW：打开冲突处置工作台（Preview Replan）。 */
  onPreview?: (conflict: SchedulingConflict) => void;
}

export function ConflictCenterPanel({
  initialType,
  onReplan,
  onLocateEntity,
  onPreview,
}: ConflictCenterPanelProps): React.ReactElement {
  const [typeFilter, setTypeFilter] = useState<SchedulingConflictType | undefined>(initialType);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Task 12/12.2：卡片视图（默认）/ 表格视图（键盘可达语义表格）切换。
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  // Task 10 / 10.2：生命周期操作确认对话框（替换 window.prompt，收集必填 reason）。
  const [lifecycleTarget, setLifecycleTarget] = useState<{
    conflict: SchedulingConflict;
    action: ConflictAction;
  } | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState('');
  const lifecycleReasonRef = useRef<HTMLTextAreaElement | null>(null);
  const lifecycleConfirmRef = useRef<HTMLButtonElement | null>(null);

  const { conflicts, total, isLoading, isError } = useSchedulerConflicts(
    typeFilter ? { type: typeFilter } : undefined,
    { refetchInterval: 15_000 },
  );

  // 按严重度排序：高 → 中 → 低（同严重度保持后端顺序）。
  const sorted = useMemo(() => sortConflicts(conflicts), [conflicts]);

  // 冲突列表虚拟化：行高按折叠态估算（展开行会在窗口内自然增高），只渲染可视窗口。
  const conflictList = useVirtualList<HTMLDivElement>({
    total: sorted.length,
    itemHeight: 84,
    overscan: 6,
  });

  // Phase 3 / P3-T1：生命周期展示模型（status/actions 来自后端，前端按状态机映射操作）。
  const lifecycle = useMemo(() => conflictVM(conflicts), [conflicts]);
  const lifecycleById = useMemo(
    () => new Map(lifecycle.items.map((i) => [i.conflictId, i])),
    [lifecycle],
  );

  // Task 12/12.2：冲突表格视图列定义（严重度/状态含文本标签，不只靠颜色；
  // 表格行背景与卡片不同，徽标用实底高对比配色，保证 4.5:1 文本对比度）。
  const tableSeverityClass: Record<string, string> = {
    high: 'bg-red-600 text-white border-transparent',
    medium: 'bg-amber-600 text-white border-transparent',
    low: 'bg-blue-600 text-white border-transparent',
  };
  const tableStatusClass: Record<string, string> = {
    OPEN: 'bg-red-600 text-white border-transparent',
    ACKNOWLEDGED: 'bg-amber-600 text-white border-transparent',
    RESOLVED: 'bg-emerald-600 text-white border-transparent',
    SUPPRESSED: 'bg-slate-600 text-white border-transparent',
  };
  const conflictColumns = useMemo<KeyboardTableColumn<SchedulingConflict>[]>(
    () => [
      { key: 'type', header: '类型', render: (c) => TYPE_META[c.type]?.label ?? c.type },
      {
        key: 'severity',
        header: '严重度',
        render: (c) => (
          <Badge className={cn('border text-[10px]', tableSeverityClass[c.severity] ?? 'bg-slate-600 text-white border-transparent')}>
            {SEVERITY_LABEL[c.severity] ?? c.severity}
          </Badge>
        ),
      },
      {
        key: 'status',
        header: '状态',
        render: (c) => {
          const status = lifecycleById.get(c.conflictId)?.status ?? 'OPEN';
          return (
            <Badge className={cn('border text-[10px]', tableStatusClass[status] ?? 'bg-slate-600 text-white border-transparent')}>
              {conflictStatusLabel(status)}
            </Badge>
          );
        },
      },
      { key: 'resource', header: '资源', render: (c) => c.resourceId ?? '—' },
      { key: 'message', header: '信息', render: (c) => <span className="text-white/70">{c.message}</span> },
      {
        key: 'detected',
        header: '检测时间',
        render: (c) => (c.detectedAt ? new Date(c.detectedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'),
      },
    ],
    [lifecycleById],
  );

  const queryClient = useQueryClient();

  const lifecycleMutation = useMutation({
    mutationFn: async (params: {
      conflictId: string;
      action: ConflictAction;
      operator: string;
      reason: string;
    }) => {
      if (params.action === 'acknowledge') {
        return acknowledgeConflict(params.conflictId, { operator: params.operator, reason: params.reason });
      }
      if (params.action === 'resolve') {
        return resolveConflict(params.conflictId, { operator: params.operator, reason: params.reason });
      }
      return suppressConflict(params.conflictId, { operator: params.operator, reason: params.reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerConflicts() });
      toast.success('冲突状态已更新');
    },
    onError: (e) => {
      toast.error(`操作失败：${errorMessage(e, '未知错误')}`);
    },
  });

  /** 执行生命周期操作：先经确认对话框收集 reason（reason 必填，沿用审计要求），
   *  确认后调用与原 window.prompt 时代完全一致的 API（buildLifecycleActionParams）。 */
  function runLifecycleAction(conflict: SchedulingConflict, action: ConflictAction): void {
    setLifecycleTarget({ conflict, action });
    setLifecycleReason('');
  }

  function confirmLifecycleAction(): void {
    if (!lifecycleTarget) return;
    if (!lifecycleReasonValid(lifecycleReason)) {
      toast.error('操作原因必填');
      return;
    }
    const params = buildLifecycleActionParams(
      lifecycleTarget.conflict,
      lifecycleTarget.action,
      getCurrentOperator(),
      lifecycleReason,
    );
    lifecycleMutation.mutate(params);
    setLifecycleTarget(null);
    setLifecycleReason('');
  }

  const ACTION_LABEL: Record<ConflictAction, string> = {
    acknowledge: '确认',
    resolve: '解决',
    suppress: '抑制',
  };
  const ACTION_ICON: Record<ConflictAction, React.ComponentType<{ className?: string }>> = {
    acknowledge: Eye,
    resolve: CheckCircle2,
    suppress: Ban,
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：过滤 + 计数 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-white/80">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          调度冲突
          <Badge className="ml-1 bg-card/10 text-white/80 border-white/20">
            {total}
          </Badge>
        </div>
        <div className="flex-1" />
        <select
          aria-label="按类型过滤冲突"
          value={typeFilter ?? ''}
          onChange={(e) => setTypeFilter((e.target.value || undefined) as SchedulingConflictType | undefined)}
          className="bg-card/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/80 focus:outline-none focus:border-white/30"
        >
          <option value="">全部类型</option>
          {(Object.keys(TYPE_META) as SchedulingConflictType[]).map((t) => (
            <option key={t} value={t} className="bg-[hsl(220_14%_14%)]">
              {TYPE_META[t].label}
            </option>
          ))}
        </select>
        {typeFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTypeFilter(undefined)}
            className="text-xs text-white/60 hover:text-white"
          >
            清除筛选
          </Button>
        )}
        {/* Task 12/12.2：表格视图切换（键盘可达语义表格） */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setViewMode((v) => (v === 'card' ? 'table' : 'card'))}
          aria-pressed={viewMode === 'table'}
          aria-label={viewMode === 'card' ? UI_ARIA_LABELS.switchTableView : UI_ARIA_LABELS.switchCardView}
          className="text-xs text-white/60 hover:text-white"
        >
          {viewMode === 'card' ? '表格视图' : '列表视图'}
        </Button>
      </div>

      {/* 三态：加载 / 错误 / 内容 */}
      {isLoading && conflicts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-white/60 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          正在加载冲突列表…
        </div>
      ) : isError ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-white/60 text-sm">
          <WifiOff className="w-5 h-5 text-red-400" />
          冲突列表加载失败（后端不可用或鉴权失败）
          <span className="text-xs text-white/40">请检查后端服务状态与登录鉴权是否有效</span>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-white/50 text-sm">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          暂无调度冲突
          <span className="text-xs text-white/35">
            {typeFilter ? '当前筛选条件下无冲突' : '所有资源与方案状态正常'}
          </span>
        </div>
      ) : viewMode === 'table' ? (
        <KeyboardTableView<SchedulingConflict>
          ariaLabel="冲突列表（表格视图）"
          className="flex-1"
          columns={conflictColumns}
          rows={sorted}
          rowKey={(c) => c.conflictId}
          selectedKey={expandedId}
          onActivate={(c) => setExpandedId(expandedId === c.conflictId ? null : c.conflictId)}
          itemHeight={36}
        />
      ) : (
        <div ref={conflictList.ref} className="flex-1 min-h-0 overflow-y-auto">
          <div style={{ height: conflictList.range.totalHeight, position: 'relative' }}>
            <ul
              className="divide-y divide-white/5"
              style={{ transform: `translateY(${conflictList.range.offsetY}px)` }}
            >
              {sorted.slice(conflictList.slice.start, conflictList.slice.end).map((c) => {
              const label = TYPE_META[c.type]?.label ?? c.type;
              const Icon = TYPE_ICONS[c.type] ?? CircleAlert;
              const isExpanded = expandedId === c.conflictId;
              const lc = lifecycleById.get(c.conflictId);
              const status = lc?.status ?? 'OPEN';
              const actions = lc?.actions ?? [];
              const statusClass = conflictStatusBadgeClass(status);
              return (
                <li key={c.conflictId}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : c.conflictId)}
                    aria-expanded={isExpanded}
                    className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-card/5 transition-colors"
                  >
                    <Icon className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-white/90">{label}</span>
                        <Badge className={cn('border text-[10px]', SEVERITY_CLASS[c.severity] ?? '')}>
                          {SEVERITY_LABEL[c.severity] ?? c.severity}
                        </Badge>
                        {/* Phase 3 / P3-T1：生命周期状态徽标 */}
                        <Badge className={cn('border text-[10px]', statusClass)}>
                          {conflictStatusLabel(status)}
                        </Badge>
                        {c.resourceId && (
                          <span className="text-[10px] text-white/40 font-mono">{c.resourceId}</span>
                        )}
                      </div>
                      <p className="text-xs text-white/70 mt-0.5">{c.message}</p>
                      {isExpanded && (
                        <div className="mt-2 pl-1 space-y-1.5">
                          {c.resolution && (
                            <p className="text-xs text-emerald-300/90">
                              建议处置：{c.resolution}
                            </p>
                          )}
                          <p className="text-[10px] text-white/35">
                            冲突 ID：{c.conflictId} · 快照：{c.snapshotVersion ?? 'CURRENT'}
                            {c.taskIds.length > 0 && ` · 任务：${c.taskIds.length} 个`}
                            {c.detectedAt && ` · 检测：${new Date(c.detectedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`}
                            {c.suppressUntil && ` · 抑制至：${new Date(c.suppressUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`}
                          </p>
                          {/* Phase 3 / P3-T1：生命周期操作（按状态机可用操作） */}
                          {actions.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {actions.map((action) => {
                                const ActionIcon = ACTION_ICON[action];
                                return (
                                  <Button
                                    key={action}
                                    size="sm"
                                    variant="outline"
                                    disabled={lifecycleMutation.isPending}
                                    className="text-xs border-white/20 text-white/80 hover:bg-card/10"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      runLifecycleAction(c, action);
                                    }}
                                  >
                                    <ActionIcon className="w-3 h-3 mr-1" />
                                    {ACTION_LABEL[action]}
                                  </Button>
                                );
                              })}
                            </div>
                          )}
                          {onPreview && (
                            <div className="pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onPreview(c);
                                }}
                              >
                                <Play className="w-3 h-3 mr-1" />
                                预览重排
                              </Button>
                            </div>
                          )}
                          {onReplan && (
                            <div className="pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-white/20 text-white/80 hover:bg-card/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onReplan(c);
                                }}
                              >
                                <RefreshCw className="w-3 h-3 mr-1" />
                                触发重排
                              </Button>
                            </div>
                          )}
                          {/* v0.7 Batch7.2：定位地图实体（资源 id 存在时） */}
                          {onLocateEntity && c.resourceId && (
                            <div className="pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-white/20 text-white/80 hover:bg-card/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onLocateEntity(c.resourceId);
                                }}
                              >
                                <MapPin className="w-3 h-3 mr-1" />
                                定位地图
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
            </ul>
          </div>
        </div>
      )}

      {/* Task 10 / 10.2：生命周期操作确认对话框（收集必填 reason，替换 window.prompt） */}
      <Dialog
        open={!!lifecycleTarget}
        onOpenChange={(open) => {
          if (!open) setLifecycleTarget(null);
        }}
      >
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">
              确认{lifecycleTarget ? ACTION_LABEL[lifecycleTarget.action] : ''}冲突
            </DialogTitle>
            <DialogDescription className="text-white/70">
              {lifecycleTarget
                ? `${TYPE_META[lifecycleTarget.conflict.type]?.label ?? lifecycleTarget.conflict.type} · ${lifecycleTarget.conflict.conflictId}`
                : ''}
              — 操作原因必填（写入审计）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-white/60">操作原因（必填）</label>
            <Textarea
              ref={lifecycleReasonRef}
              value={lifecycleReason}
              onChange={(e) => setLifecycleReason(e.target.value)}
              placeholder={`请输入${lifecycleTarget ? ACTION_LABEL[lifecycleTarget.action] : ''}原因...`}
              autoFocus
              className="bg-card/5 border-white/10 text-white"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setLifecycleTarget(null)}>
              取消
            </Button>
            <Button
              ref={lifecycleConfirmRef}
              size="sm"
              onClick={confirmLifecycleAction}
              disabled={lifecycleMutation.isPending || !lifecycleReasonValid(lifecycleReason)}
            >
              {lifecycleMutation.isPending ? '提交中...' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// React.memo：回调 props 由 CommandMap 提供稳定引用，store 的 selection/mode/viewport
// 写入不会连带重渲染本面板（Task 4 / P1 SSE 局部更新）。
export default memo(ConflictCenterPanel);
