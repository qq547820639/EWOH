import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DISPLAY_TIME_OPTS, DISPLAY_TIME_OPTS_MONTH_DAY } from '../../../lib/intl';
import { toast } from 'sonner';
import { CheckCircle2, Hammer, History, Loader2 } from 'lucide-react';
import { getEvents, handleEvent } from '@client/src/api/dashboard';
import { getEventContext } from '../../../api/world';
import type { EventInfo } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { getCurrentOperator } from '@client/src/lib/auth';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';
import { useVirtualList } from '@client/src/lib/virtualList';
import { KeyboardTableView, type KeyboardTableColumn } from '../components/KeyboardTableView';
import { summarizeReplayContext, type ReplayContextSummary } from '../replayContext';
import { errorMessage, errorDescription } from '@client/src/lib/errorContract';

interface EventCenterPanelProps {
  selectedEventId?: string | null;
  onSelectedEventIdChange?: (eventId: string | null) => void;
}

const STATUS_OPTIONS: { label: string; value: string | undefined }[] = [
  { label: '全部', value: undefined },
  { label: '待处理', value: 'open' },
  { label: '已处理', value: 'handled' },
];

const SEVERITY_OPTIONS: { label: string; value: string | undefined }[] = [
  { label: '全部', value: undefined },
  { label: '严重', value: 'critical' },
  { label: '高', value: 'high' },
  { label: '中', value: 'medium' },
  { label: '低', value: 'low' },
];

/**
 * 时间范围选择（2026-08-19 数据增长治理）：默认只看最近 24h 的滚动窗口，
 * 超出窗口的数据自动滚出视野；用户可切换 1h/6h/24h/7d。
 */
const TIME_RANGE_OPTIONS: { label: string; hours: number }[] = [
  { label: '1小时', hours: 1 },
  { label: '6小时', hours: 6 },
  { label: '24小时', hours: 24 },
  { label: '7天', hours: 168 },
];
const DEFAULT_TIME_RANGE_HOURS = 24;

/** R2-CP1-2：时间展示统一 Asia/Shanghai 时区（不依赖浏览器本地时区）。 */
function formatShortTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY);
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return formatShortTime(dateStr);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return formatShortTime(dateStr);
}

// ADR-027 规范词表：critical=红 / high=橙 / medium=黄 / low=绿 / unknown=灰。
function severityBadgeClass(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'high':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'medium':
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'low':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

function severityBarClass(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-500';
    case 'high':
      return 'bg-orange-500';
    case 'medium':
      return 'bg-yellow-500';
    case 'low':
      return 'bg-green-500';
    default:
      return 'bg-gray-500';
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-white/60 w-16 shrink-0">{label}</span>
      <span className="text-white/80 break-all">{value}</span>
    </div>
  );
}

export default function EventCenterPanel({
  selectedEventId = null,
  onSelectedEventIdChange,
}: EventCenterPanelProps) {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [severityFilter, setSeverityFilter] = useState<string | undefined>(undefined);
  const [timeRangeHours, setTimeRangeHours] = useState<number>(DEFAULT_TIME_RANGE_HOURS);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const [replayContext, setReplayContext] = useState<ReplayContextSummary | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');
  // Task 12/12.2：卡片视图（默认）/ 表格视图（键盘可达语义表格）切换。
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const queryClient = useQueryClient();

  const selectedId = selectedEventId ?? internalSelectedId;
  const changeSelectedId = (eventId: string | null) => {
    setInternalSelectedId(eventId);
    onSelectedEventIdChange?.(eventId);
  };

  useEffect(() => {
    if (selectedEventId) {
      setStatusFilter(undefined);
      setSeverityFilter(undefined);
    }
    setReplayContext(null);
    setContextError('');
  }, [selectedEventId]);

  // CLI-025：异步回放上下文加载的取消守卫——卸载/重复触发后不再 setState。
  const replayContextAliveRef = useRef(0);
  useEffect(() => {
    return () => {
      // 卸载：全部在途 token 失效（++ 产生的 token 恒 ≥1）。
      replayContextAliveRef.current = 0;
    };
  }, []);

  const { data: events, isLoading, isError } = useQuery<EventInfo[]>({
    queryKey: [...queryKeys.events(statusFilter), 'range', timeRangeHours],
    queryFn: () => getEvents(50, statusFilter, timeRangeHours),
    refetchInterval: 5000,
  });

  const handleMutation = useMutation({
    mutationFn: ({
      eventId,
      action,
    }: {
      eventId: string;
      action: 'acknowledge' | 'handle';
    }) =>
      handleEvent(eventId, {
        handlerAction: action === 'acknowledge' ? 'acknowledge' : 'manual_handle',
        handlerNote: action === 'handle' ? '指挥地图人工处置' : undefined,
        operator: getCurrentOperator(),
      }),
    onSuccess: (updated) => {
      toast.success(`事件已${updated.status === 'handled' ? '处理' : '更新'}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.events() });
    },
    onError: (err) => {
      toast.error('事件操作失败', {
        description: errorDescription(err),
      });
    },
  });

  const filteredEvents = useMemo(() => {
    if (!events) return [];
    if (!severityFilter) return events;
    return events.filter((e) => e.severity === severityFilter);
  }, [events, severityFilter]);

  // Task 11/11.2：事件列表虚拟化（行高按固定值估算，只渲染可视窗口 + overscan）。
  const eventList = useVirtualList<HTMLDivElement>({
    total: filteredEvents.length,
    itemHeight: 56,
    overscan: 6,
  });

  const selectedEvent = useMemo(() => {
    if (!filteredEvents || !selectedId) return null;
    return (
      filteredEvents.find((e) => e.id === selectedId || e.eventId === selectedId) ?? null
    );
  }, [filteredEvents, selectedId]);

  // Task 12/12.2：事件表格视图列定义（语义文本，不只靠颜色）。
  const eventColumns = useMemo<KeyboardTableColumn<EventInfo>[]>(
    () => [
      { key: 'title', header: '事件', render: (e) => <span className="text-white/90">{e.title}</span> },
      { key: 'device', header: '设备', render: (e) => e.deviceId ?? '—' },
      { key: 'time', header: '时间', render: (e) => timeAgo(e.createdAt) },
      {
        key: 'severity',
        header: '严重度',
        render: (e) => (
          <Badge className={cn('text-[9px] px-1.5 py-0', severityBadgeClass(e.severity))}>
            {e.severity}
          </Badge>
        ),
      },
      { key: 'status', header: '状态', render: (e) => e.status ?? '—' },
    ],
    [],
  );

  const loadReplayContext = async (eventId: string) => {
    // CLI-025：请求序号守卫（竞态时旧响应丢弃；卸载后由清理 effect 置 0 使全部失效）。
    const token = ++replayContextAliveRef.current;
    setContextLoading(true);
    setContextError('');
    try {
      const context = await getEventContext(eventId, 10);
      if (token !== replayContextAliveRef.current) return;
      setReplayContext(summarizeReplayContext(context));
    } catch (error) {
      if (token !== replayContextAliveRef.current) return;
      setContextError(errorMessage(error, '回放上下文加载失败'));
    } finally {
      if (token === replayContextAliveRef.current) setContextLoading(false);
    }
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      changeSelectedId(id);
    }
  };

  return (
    <div className="h-full flex bg-[hsl(220_14%_14%)] text-white">
      {/* Left: event list */}
      <div className="flex-1 flex flex-col min-h-0 border-r border-white/10">
        {/* Filters */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
          <div className="flex gap-1">
            {STATUS_OPTIONS.map((opt) => (
              <Button
                key={opt.label}
                variant={statusFilter === opt.value ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => setStatusFilter(opt.value)}
                aria-pressed={statusFilter === opt.value}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <div className="w-px h-4 bg-card/10" />
          <div className="flex gap-1">
            {SEVERITY_OPTIONS.map((opt) => (
              <Button
                key={opt.label}
                variant={severityFilter === opt.value ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => setSeverityFilter(opt.value)}
                aria-pressed={severityFilter === opt.value}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <div className="w-px h-4 bg-card/10" />
          {/* 时间范围选择（默认 24h 滚动窗口，可选 1h/6h/24h/7d） */}
          <div className="flex gap-1" role="group" aria-label="时间范围">
            {TIME_RANGE_OPTIONS.map((opt) => (
              <Button
                key={opt.label}
                variant={timeRangeHours === opt.hours ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => setTimeRangeHours(opt.hours)}
                aria-pressed={timeRangeHours === opt.hours}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <div className="w-px h-4 bg-card/10" />
          {/* Task 12/12.2：表格视图切换（键盘可达语义表格） */}
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2"
            onClick={() => setViewMode((v) => (v === 'card' ? 'table' : 'card'))}
            aria-pressed={viewMode === 'table'}
            aria-label={viewMode === 'card' ? UI_ARIA_LABELS.switchTableView : UI_ARIA_LABELS.switchCardView}
          >
            {viewMode === 'card' ? '表格视图' : '列表视图'}
          </Button>
        </div>

        {/* Event list（Task 11/11.2 虚拟化 + Task 12/12.2 表格视图） */}
        {isLoading ? (
          <div className="flex-1 p-4 text-center text-sm text-white/70" role="status" aria-live="polite">
            加载中...
          </div>
        ) : isError ? (
          <div className="flex-1 p-4 text-center text-sm text-red-400" role="status" aria-live="polite">
            加载失败
          </div>
        ) : !filteredEvents || filteredEvents.length === 0 ? (
          <div className="flex-1 p-4 text-center text-sm text-white/70" role="status" aria-live="polite">
            暂无数据
          </div>
        ) : viewMode === 'table' ? (
          <KeyboardTableView<EventInfo>
            ariaLabel="事件列表（表格视图）"
            className="flex-1"
            columns={eventColumns}
            rows={filteredEvents}
            rowKey={(e) => e.id}
            selectedKey={selectedId}
            onActivate={(e) => changeSelectedId(e.id)}
            itemHeight={32}
          />
        ) : (
          <div ref={eventList.ref} className="flex-1 min-h-0 overflow-y-auto">
            <div style={{ height: eventList.range.totalHeight, position: 'relative' }}>
              <div className="divide-y divide-white/5" style={{ transform: `translateY(${eventList.range.offsetY}px)` }}>
                {filteredEvents.slice(eventList.slice.start, eventList.slice.end).map((ev) => (
                <div
                  key={ev.id}
                  onClick={() => changeSelectedId(ev.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => handleRowKeyDown(event, ev.id)}
                  aria-pressed={selectedId === ev.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-card/5 transition-colors',
                    selectedId === ev.id && 'bg-card/10',
                  )}
                >
                  <div
                    className={cn(
                      'w-1 h-8 rounded-full shrink-0',
                      severityBarClass(ev.severity),
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white/90 truncate">
                      {ev.title}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-white/60">{ev.deviceId}</span>
                      <span className="text-[10px] text-white/60">
                        {timeAgo(ev.createdAt)}
                      </span>
                    </div>
                  </div>
                  <Badge
                    className={cn('text-[9px] px-1.5 py-0', severityBadgeClass(ev.severity))}
                  >
                    {ev.severity}
                  </Badge>
                </div>
              ))}
                </div>
              </div>
            </div>
          )}
      </div>

      {/* Right: event detail */}
      <div className="w-80 p-3 overflow-y-auto shrink-0">
        {selectedEvent ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge className={severityBadgeClass(selectedEvent.severity)}>
                {selectedEvent.severity}
              </Badge>
              <Badge variant="outline" className="text-white/60">
                {selectedEvent.status}
              </Badge>
            </div>
            <div className="text-sm font-medium text-white/90">{selectedEvent.title}</div>
            <div className="space-y-2 text-xs">
              <DetailRow label="事件ID" value={selectedEvent.eventId} />
              <DetailRow label="事件编码" value={selectedEvent.eventCode} />
              <DetailRow label="事件类型" value={selectedEvent.eventType} />
              <DetailRow label="设备ID" value={selectedEvent.deviceId} />
              <DetailRow label="状态" value={selectedEvent.status} />
              <DetailRow
                label="创建时间"
                value={
                  selectedEvent.createdAt
                    ? new Date(selectedEvent.createdAt).toLocaleString('zh-CN', DISPLAY_TIME_OPTS)
                    : '—'
                }
              />
              <DetailRow label="处置动作" value={selectedEvent.handlerAction ?? '—'} />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full h-7 text-[10px]"
              disabled={contextLoading}
              onClick={() => loadReplayContext(selectedEvent.eventId)}
              aria-label={`回放上下文：${selectedEvent.title}`}
            >
              {contextLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <History className="w-3 h-3" />
              )}
              回放上下文
            </Button>
            {replayContext && (
              <div className="rounded-lg border border-white/10 bg-card/5 p-2 text-xs">
                <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
                  事发前 / 事发时 / 处置后
                </div>
                <DetailRow
                  label="前"
                  value={
                    replayContext.beforeTs
                      ? new Date(replayContext.beforeTs).toLocaleTimeString('zh-CN', DISPLAY_TIME_OPTS)
                      : '无'
                  }
                />
                <DetailRow
                  label="中"
                  value={
                    replayContext.duringTs
                      ? new Date(replayContext.duringTs).toLocaleTimeString('zh-CN', DISPLAY_TIME_OPTS)
                      : '无'
                  }
                />
                <DetailRow
                  label="后"
                  value={
                    replayContext.afterTs
                      ? new Date(replayContext.afterTs).toLocaleTimeString('zh-CN', DISPLAY_TIME_OPTS)
                      : '无'
                  }
                />
                <DetailRow label="事件" value={String(replayContext.timelineCount)} />
              </div>
            )}
            {contextError && (
              <p className="rounded bg-red-500/10 p-2 text-[10px] text-red-400">
                {contextError}
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 h-7 text-[10px]"
                disabled={
                  selectedEvent.status === 'handled' || handleMutation.isPending
                }
                aria-label={`确认事件：${selectedEvent.title}`}
                onClick={() =>
                  handleMutation.mutate({
                    eventId: selectedEvent.eventId,
                    action: 'acknowledge',
                  })
                }
              >
                {handleMutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3 h-3" />
                )}
                确认
              </Button>
              <Button
                size="sm"
                className="flex-1 h-7 text-[10px]"
                disabled={
                  selectedEvent.status === 'handled' || handleMutation.isPending
                }
                aria-label={`处置事件：${selectedEvent.title}`}
                onClick={() =>
                  handleMutation.mutate({
                    eventId: selectedEvent.eventId,
                    action: 'handle',
                  })
                }
              >
                {handleMutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Hammer className="w-3 h-3" />
                )}
                处置
              </Button>
            </div>
          </div>
        ) : selectedId ? (
          <div className="h-full flex items-center justify-center text-sm text-white/60">
            未在当前事件列表中找到该事件
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-white/60">
            选择左侧事件查看详情
          </div>
        )}
      </div>
    </div>
  );
}
