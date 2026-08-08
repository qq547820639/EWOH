// panels/ConflictCenterPanel.tsx — 统一冲突中心（v0.7 A3 智能调度接线）
//
// 消费后端 `GET /api/scheduler/conflicts`（useSchedulerConflicts）：
// 后端从真实世界状态/预占/活跃方案聚合推导 13 类冲突（含 v0.7 新增 reservation_expiring），
// 本面板提供：类型/严重度过滤、冲突列表、详情展开、空态/加载/错误三态。
// 冲突数据不虚构：无冲突即空态提示，不展示伪造信息。

import { useMemo, useState } from 'react';
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
} from 'lucide-react';
import { useSchedulerConflicts } from '@client/src/hooks/useSchedulerConflicts';
import { TYPE_META, sortConflicts } from './conflict-panel-logic';
import type { SchedulingConflict, SchedulingConflictType } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { ScrollArea } from '@client/src/components/ui/scroll-area';

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

interface ConflictCenterPanelProps {
  /** 可选：外部指定仅展示某类冲突（如地图冲突层点击跳转）。 */
  initialType?: SchedulingConflictType;
  /** 可选：点击"重排"回调（由父组件决定跳转调度方案面板）。 */
  onReplan?: (conflict: SchedulingConflict) => void;
  /** v0.7 Batch7.2：点击资源定位地图实体（父组件选中实体并聚焦）。 */
  onLocateEntity?: (entityId: string | null) => void;
}

export function ConflictCenterPanel({
  initialType,
  onReplan,
  onLocateEntity,
}: ConflictCenterPanelProps): React.ReactElement {
  const [typeFilter, setTypeFilter] = useState<SchedulingConflictType | undefined>(initialType);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { conflicts, total, isLoading, isError } = useSchedulerConflicts(
    typeFilter ? { type: typeFilter } : undefined,
    { refetchInterval: 15_000 },
  );

  // 按严重度排序：高 → 中 → 低（同严重度保持后端顺序）。
  const sorted = useMemo(() => sortConflicts(conflicts), [conflicts]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：过滤 + 计数 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-white/80">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          调度冲突
          <Badge className="ml-1 bg-white/10 text-white/80 border-white/20">
            {total}
          </Badge>
        </div>
        <div className="flex-1" />
        <select
          aria-label="按类型过滤冲突"
          value={typeFilter ?? ''}
          onChange={(e) => setTypeFilter((e.target.value || undefined) as SchedulingConflictType | undefined)}
          className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/80 focus:outline-none focus:border-white/30"
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
          <span className="text-xs text-white/40">请检查 FEISHU_API_TOKEN 配置与后端服务状态</span>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-white/50 text-sm">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          暂无调度冲突
          <span className="text-xs text-white/35">
            {typeFilter ? '当前筛选条件下无冲突' : '所有资源与方案状态正常'}
          </span>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <ul className="divide-y divide-white/5">
            {sorted.map((c) => {
              const label = TYPE_META[c.type]?.label ?? c.type;
              const Icon = TYPE_ICONS[c.type] ?? CircleAlert;
              const isExpanded = expandedId === c.conflictId;
              return (
                <li key={c.conflictId}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : c.conflictId)}
                    aria-expanded={isExpanded}
                    className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
                  >
                    <Icon className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-white/90">{label}</span>
                        <Badge className={cn('border text-[10px]', SEVERITY_CLASS[c.severity] ?? '')}>
                          {SEVERITY_LABEL[c.severity] ?? c.severity}
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
                          </p>
                          {onReplan && (
                            <div className="pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-white/20 text-white/80 hover:bg-white/10"
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
                                className="text-xs border-white/20 text-white/80 hover:bg-white/10"
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
        </ScrollArea>
      )}
    </div>
  );
}

export default ConflictCenterPanel;
