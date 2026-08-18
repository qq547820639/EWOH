/* CommandCenterView.tsx — 指挥中心纯展示视图（NO-13ae / ADR-080，§17）。
 *
 * KPI 网格 + 近期事件列表；零网络零状态（数据由父级 React Query 注入）。
 * 图标按 key 映射（lucide 组件不进纯逻辑层）。
 */
import { Activity, AlertTriangle, Cpu, Users } from 'lucide-react';
import type { OverviewStats, EventInfo } from '@shared/api.interface';
import {
  buildCommandCenterKpis,
  buildEventSubtitle,
  formatEventTimestamp,
} from './commandCenterLogic';

const KPI_ICONS = {
  deviceTotal: Cpu,
  deviceOnline: Activity,
  eventOpen: AlertTriangle,
  eventCritical: AlertTriangle,
  avgLoad: Users,
  workerCount: Users,
} as const;

export interface CommandCenterViewProps {
  overview?: OverviewStats | null;
  events?: EventInfo[];
}

export const CommandCenterView = ({
  overview,
  events = [],
}: CommandCenterViewProps): React.ReactElement => {
  const kpis = buildCommandCenterKpis(overview);
  return (
    <div className="space-y-6" data-testid="command-center-view">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {kpis.map((kpi) => {
          const Icon = KPI_ICONS[kpi.key];
          return (
            <div
              key={kpi.key}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon className="size-4" />
                {kpi.label}
              </div>
              <div className="mt-2 text-2xl font-semibold text-foreground">
                {kpi.value}
              </div>
            </div>
          );
        })}
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold text-foreground">近期事件</h2>
        </div>
        {events.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">暂无事件记录。</div>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {event.title || event.eventCode}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {buildEventSubtitle(event)}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatEventTimestamp(event.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default CommandCenterView;
