/* CommandCenterView.tsx — 指挥中心纯展示视图（NO-13ae / ADR-080，§17）。
 *
 * KPI 网格 + 近期事件分页列表（2026-08-21：固定 6 条 → 分页，默认 20 条/页，
 * 页大小 20/50/100/200/500，翻页 + 页码跳转）；零网络零状态
 * （数据与分页状态由父级 React Query 注入）。
 * 图标按 key 映射（lucide 组件不进纯逻辑层）。
 */
import { Activity, AlertTriangle, Cpu, Users, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { OverviewStats, EventInfo } from '@shared/api.interface';
import {
  buildCommandCenterKpis,
  buildEventSubtitle,
  formatEventTimestamp,
} from './commandCenterLogic';
import { Button } from '../../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

/** 「近期事件」分页大小选项（默认 20 条/页；选择器 20/50/100/200/500）。 */
export const EVENT_PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500] as const;

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
  /** 事件总数（分页标题展示）。 */
  totalEvents?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  isEventsLoading?: boolean;
}

export const CommandCenterView = ({
  overview,
  events = [],
  totalEvents = 0,
  page = 1,
  pageSize = 20,
  totalPages = 1,
  onPageChange,
  onPageSizeChange,
  isEventsLoading = false,
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
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
          <h2 className="font-semibold text-foreground">
            近期事件
            {totalEvents > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                共 {totalEvents} 条
              </span>
            )}
          </h2>
          {/* 分页大小选择器（2026-08-21） */}
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange?.(Number(v))}
          >
            <SelectTrigger className="h-8 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} 条/页
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* 列表容器：高度约束 + 内部滚动（避免整页被长列表撑开不可控）。 */}
        <div className="max-h-[420px] overflow-y-auto">
          {isEventsLoading && events.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">正在加载事件…</div>
          ) : events.length === 0 ? (
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
        </div>
        {/* 翻页控件 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            第 {page}/{totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0"
              disabled={page <= 1}
              onClick={() => onPageChange?.(1)}
              aria-label="首页"
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0"
              disabled={page <= 1}
              onClick={() => onPageChange?.(page - 1)}
              aria-label="上一页"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={page}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1) onPageChange?.(v);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onPageChange?.(Number((e.target as HTMLInputElement).value));
                }
              }}
              className="h-7 w-14 rounded-md border border-border bg-background px-2 text-center text-xs text-foreground outline-none focus:border-ring"
              aria-label="页码跳转"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0"
              disabled={page >= totalPages}
              onClick={() => onPageChange?.(page + 1)}
              aria-label="下一页"
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 p-0"
              disabled={page >= totalPages}
              onClick={() => onPageChange?.(totalPages)}
              aria-label="末页"
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default CommandCenterView;
