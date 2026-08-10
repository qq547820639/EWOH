import { Badge } from './ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './ui/tooltip';
import {
  classifyFreshness,
  freshnessReason,
  FRESHNESS_STATUS_LABELS,
  type FreshnessInput,
  type FreshnessStatus,
} from '@client/src/lib/dataFreshness';

/** 新鲜度状态 → 深色主题徽标样式（与 Command Map 徽标风格一致）。 */
export const FRESHNESS_STATUS_CLASSES: Record<FreshnessStatus, string> = {
  LIVE: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  DELAYED: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  STALE: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  OFFLINE: 'bg-red-500/20 text-red-400 border-red-500/30',
  REPLAY: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  SHADOW: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  RESYNCING: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  DEGRADED: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

function formatUpdatedAt(ts: number | null | undefined): string {
  if (ts == null) return '未知';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatLagMs(lagMs: number | null | undefined): string {
  if (lagMs == null || !Number.isFinite(lagMs)) return '—';
  return `${Math.max(0, Math.round(lagMs / 1000))}s`;
}

export interface DataFreshnessBadgeProps extends Omit<FreshnessInput, 'now'> {
  /** 事实源名称（调度方案 / 世界·设备 / 调度上下文 ...）。 */
  source: string;
  /** 显式滞后（ms），仅在调用方已知时传入；缺省按 lastUpdatedAt 计算。 */
  lagMs?: number | null;
  className?: string;
}

/**
 * 单个事实源的新鲜度徽标：状态 + 更新时间 + 滞后 + 原因（tooltip）。
 * 状态经 classifyFreshness 纯函数计算
 * （LIVE/DELAYED/STALE/OFFLINE/REPLAY/SHADOW/RESYNCING/DEGRADED）。
 */
export function DataFreshnessBadge({
  source,
  lastUpdatedAt,
  connectionState,
  connected,
  replayActive,
  shadowMode,
  lagMs,
  className = '',
}: DataFreshnessBadgeProps): React.ReactElement {
  const status = classifyFreshness({
    lastUpdatedAt,
    lagMs: lagMs ?? undefined,
    connectionState,
    connected,
    replayActive,
    shadowMode,
  });
  const reason = freshnessReason({
    lastUpdatedAt,
    lagMs: lagMs ?? undefined,
    connectionState,
    connected,
    replayActive,
    shadowMode,
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={`gap-1 border border-white/10 px-1.5 py-0 text-[9px] ${FRESHNESS_STATUS_CLASSES[status]} ${className}`}
        >
          <span className="font-medium text-white/80">{source}</span>
          <span className="font-semibold">{FRESHNESS_STATUS_LABELS[status]}</span>
          <span className="tabular-nums text-white/55">{formatUpdatedAt(lastUpdatedAt)}</span>
          {lagMs != null && (
            <span className="tabular-nums text-white/45">滞后 {formatLagMs(lagMs)}</span>
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <span>
          {source} · {reason}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export default DataFreshnessBadge;
