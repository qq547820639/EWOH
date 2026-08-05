import { Badge } from './ui/badge';
import { DataSourceBadge } from './DataSourceBadge';
import {
  credibilitySummary,
  formatTimestamp,
  percent,
  type CredibilityInfo,
} from '../lib/credibility';

/**
 * UX-001 数据可信度组件 —— 复用的结构化可信度摘要。
 *
 * 展示：数据来源类型 / 采集时间 / 最近同步（含过期标记）/ 离线缓存 / 模拟回放 /
 * 完整性 / 置信度 / 是否可用于决策。
 * 适用于指挥中心、地图、设备、告警、质量、报告、导出等视图，统一数据可信度呈现。
 */
export function DataCredibility({
  info,
  maxAgeMs,
  className,
}: {
  info: CredibilityInfo;
  maxAgeMs?: number;
  className?: string;
}): React.ReactElement {
  const summary = credibilitySummary(info, undefined, maxAgeMs);

  return (
    <dl
      className={`grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3 text-xs ${className ?? ''}`}
    >
      <div className="col-span-2 flex flex-wrap items-center gap-2">
        <dt className="text-[hsl(218_10%_42%)]">来源</dt>
        <dd>
          <DataSourceBadge source={summary.sourceType} />
        </dd>
        {summary.isOfflineCache && <Badge variant="outline">离线缓存</Badge>}
        {summary.isSimulatedOrReplay && <Badge variant="outline">模拟/回放</Badge>}
      </div>

      <div>
        <dt className="text-[hsl(218_10%_42%)]">采集时间</dt>
        <dd className="mt-0.5 text-[hsl(220_14%_14%)]">
          {formatTimestamp(summary.collectedAt)}
        </dd>
      </div>

      <div>
        <dt className="text-[hsl(218_10%_42%)]">最近同步</dt>
        <dd className="mt-0.5 text-[hsl(220_14%_14%)]">
          {formatTimestamp(summary.lastSyncedAt)}
          {summary.isStale && (
            <span className="ml-1 text-xs font-medium text-orange-600">（已过期）</span>
          )}
        </dd>
      </div>

      <div>
        <dt className="text-[hsl(218_10%_42%)]">完整性</dt>
        <dd className="mt-0.5 text-[hsl(220_14%_14%)]">
          {summary.completeness === undefined ? '—' : percent(summary.completeness)}
        </dd>
      </div>

      <div>
        <dt className="text-[hsl(218_10%_42%)]">置信度</dt>
        <dd className="mt-0.5 text-[hsl(220_14%_14%)]">
          {summary.confidence === undefined ? '—' : percent(summary.confidence)}
        </dd>
      </div>

      <div className="col-span-2">
        <dt className="inline text-[hsl(218_10%_42%)]">可用于决策</dt>
        <dd className="ml-2 inline">
          {summary.decisionEligible ? (
            <span className="font-semibold text-[hsl(130_54%_42%)]">是</span>
          ) : (
            <span className="font-semibold text-[hsl(2_84%_62%)]">否</span>
          )}
        </dd>
      </div>
    </dl>
  );
}