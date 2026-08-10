/* Task 5 / P1：Command Map 统一 Data Freshness 指示行。
 *
 * 页面每个事实源（调度方案 / 世界·设备 / 调度上下文 ...）一个徽标，
 * 状态由 lib/dataFreshness 的 classifyFreshness 纯函数计算：
 * 调度方案源用 store.schedulerRealtime（lastEventTime + connectionState），
 * 世界/设备源用 React Query dataUpdatedAt + navigator.onLine。
 * 关键规则：SSE 断开（connectionState=OFFLINE / connected=false）时，
 * 即使存在缓存数据也绝不显示 LIVE（显示 OFFLINE）。
 */
import DataFreshnessBadge from '@client/src/components/DataFreshnessBadge';

export interface FreshnessSource {
  key: string;
  /** 事实源名称（展示用）。 */
  label: string;
  /** 数据最近更新时间（epoch ms；无则 null）。 */
  lastUpdatedAt: number | null;
  /** 连接状态（如 SchedulerStreamStatusV2 字符串；'OFFLINE' 视为断开）。 */
  connectionState?: string | null;
  /** 连接布尔。 */
  connected?: boolean;
  /** 回放激活（REPLAY）。 */
  replayActive?: boolean;
  /** Shadow-only（SHADOW）。 */
  shadowMode?: boolean;
}

export interface DataFreshnessIndicatorRowProps {
  sources: FreshnessSource[];
  className?: string;
}

/** 一行多个事实源的新鲜度徽标（每源一个 DataFreshnessBadge）。 */
export function DataFreshnessIndicatorRow({
  sources,
  className = '',
}: DataFreshnessIndicatorRowProps): React.ReactElement {
  if (sources.length === 0) return <div />;
  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 px-4 pt-2 ${className}`}
      role="group"
      aria-label="数据新鲜度"
      title="各事实源数据新鲜度（悬停查看原因）"
    >
      {/* Task 12/12.3：标签文本对比度 ≥ 4.5:1（text-white/40 不满足，提升为 white/70） */}
      <span className="text-[9px] uppercase tracking-wide text-white/70">Data Freshness</span>
      {sources.map((s) => (
        <DataFreshnessBadge
          key={s.key}
          source={s.label}
          lastUpdatedAt={s.lastUpdatedAt}
          connectionState={s.connectionState}
          connected={s.connected}
          replayActive={s.replayActive}
          shadowMode={s.shadowMode}
        />
      ))}
    </div>
  );
}

export default DataFreshnessIndicatorRow;
