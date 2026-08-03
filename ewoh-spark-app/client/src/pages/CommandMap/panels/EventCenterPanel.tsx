import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
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
import { ScrollArea } from '@client/src/components/ui/scroll-area';
import { summarizeReplayContext, type ReplayContextSummary } from '../replayContext';

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
  { label: 'L1', value: 'L1' },
  { label: 'L2', value: 'L2' },
  { label: 'L3', value: 'L3' },
];

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return dayjs(dateStr).format('MM-DD HH:mm');
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return dayjs(dateStr).format('MM-DD HH:mm');
}

function severityBadgeClass(severity: string): string {
  switch (severity) {
    case 'L3':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'L2':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'L1':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

function severityBarClass(severity: string): string {
  switch (severity) {
    case 'L3':
      return 'bg-red-500';
    case 'L2':
      return 'bg-orange-500';
    case 'L1':
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
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const [replayContext, setReplayContext] = useState<ReplayContextSummary | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');
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

  const { data: events, isLoading, isError } = useQuery<EventInfo[]>({
    queryKey: queryKeys.events(statusFilter),
    queryFn: () => getEvents(50, statusFilter),
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
      queryClient.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (err) => {
      toast.error('事件操作失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const filteredEvents = useMemo(() => {
    if (!events) return [];
    if (!severityFilter) return events;
    return events.filter((e) => e.severity === severityFilter);
  }, [events, severityFilter]);

  const selectedEvent = useMemo(() => {
    if (!filteredEvents || !selectedId) return null;
    return (
      filteredEvents.find((e) => e.id === selectedId || e.eventId === selectedId) ?? null
    );
  }, [filteredEvents, selectedId]);

  const loadReplayContext = async (eventId: string) => {
    setContextLoading(true);
    setContextError('');
    try {
      const context = await getEventContext(eventId, 10);
      setReplayContext(summarizeReplayContext(context));
    } catch (error) {
      setContextError(error instanceof Error ? error.message : '回放上下文加载失败');
    } finally {
      setContextLoading(false);
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
          <div className="w-px h-4 bg-white/10" />
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
        </div>

        {/* Event list */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-white/70" role="status" aria-live="polite">
              加载中...
            </div>
          ) : isError ? (
            <div className="p-4 text-center text-sm text-red-400" role="status" aria-live="polite">
              加载失败
            </div>
          ) : !filteredEvents || filteredEvents.length === 0 ? (
            <div className="p-4 text-center text-sm text-white/70" role="status" aria-live="polite">
              暂无数据
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {filteredEvents.map((ev) => (
                <div
                  key={ev.id}
                  onClick={() => changeSelectedId(ev.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => handleRowKeyDown(event, ev.id)}
                  aria-pressed={selectedId === ev.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors',
                    selectedId === ev.id && 'bg-white/10',
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
          )}
        </ScrollArea>
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
                    ? dayjs(selectedEvent.createdAt).format('YYYY-MM-DD HH:mm:ss')
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
              <div className="rounded-lg border border-white/10 bg-white/5 p-2 text-xs">
                <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
                  事发前 / 事发时 / 处置后
                </div>
                <DetailRow
                  label="前"
                  value={
                    replayContext.beforeTs
                      ? dayjs(replayContext.beforeTs).format('HH:mm:ss')
                      : '无'
                  }
                />
                <DetailRow
                  label="中"
                  value={
                    replayContext.duringTs
                      ? dayjs(replayContext.duringTs).format('HH:mm:ss')
                      : '无'
                  }
                />
                <DetailRow
                  label="后"
                  value={
                    replayContext.afterTs
                      ? dayjs(replayContext.afterTs).format('HH:mm:ss')
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
