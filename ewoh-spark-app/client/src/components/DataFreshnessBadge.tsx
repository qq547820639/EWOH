import { Badge } from './ui/badge';
import { toneBadge } from '../lib/statusTone';
import { DISPLAY_TIME_OPTS } from '../lib/intl';
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

/** 新鲜度状态 → 深色主题徽标样式（与 Command Map 徽标风格一致，CLI-336：
 *  全部使用语义设计令牌）。
 *
 *  A11Y（UX-009 axe color-contrast）：软底（/20）+ 主色文字在深色表面上不达标
 *  （实测 warning/20 = 4.16:1、info/20 ≈ 3.5:1 → serious）。凡「软底 + 文字」
 *  一律使用 *-on-soft 前景令牌：按所在表面取值（亮底深字、深底亮字）。 */
export const FRESHNESS_STATUS_CLASSES: Record<FreshnessStatus, string> = {
  LIVE: toneBadge.normal,
  DELAYED: toneBadge.degraded,
  STALE: 'bg-warning/20 text-warning-on-soft border-warning/30',
  OFFLINE: 'bg-destructive/20 text-destructive-on-soft border-destructive/30',
  REPLAY: toneBadge.conflict,
  SHADOW: 'bg-info/20 text-info-on-soft border-info/30',
  RESYNCING: 'bg-info/20 text-info-on-soft border-info/30',
  DEGRADED: toneBadge.degraded,
};

function formatUpdatedAt(ts: number | null | undefined): string {
  if (ts == null) return '未知';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleTimeString('zh-CN', DISPLAY_TIME_OPTS);
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
          // A11Y/一致性：新鲜度色调切换必须「立即生效」。reduced-motion 全局规则把
          // transition-duration 压到 0.01ms，而 transition-property 仍是初始值 all，
          // 于是每次色调变化都会生成一条 CSSTransition；在帧饥饿（无头浏览器、
          // 高负载现场终端）下 currentTime 停在 0，computed style 长时间返回**旧色调**
          // （实测 axe 采样到「过期」橙色叠在 /20 软底上 = 4.16:1 serious）。
          // 显式置空 transition-property：既不产生过渡，也不会把旧色调当事实展示。
          className={`gap-1 border border-white/10 px-1.5 py-0 text-[9px] [transition-property:none] ${FRESHNESS_STATUS_CLASSES[status]} ${className}`}
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
