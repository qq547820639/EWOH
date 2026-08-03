import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, AlertTriangle, X, Eye, Zap } from 'lucide-react';
import dayjs from 'dayjs';
import { getEvents } from '@client/src/api/dashboard';
import { queryKeys } from '@client/src/hooks/queryKeys';
import type { EventInfo } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';

interface AlertToastProps {
  onViewEvent: (eventId: string) => void;
  onHandleEvent: (eventId: string) => void;
}

const POLL_INTERVAL_MS = 3000;
const RECENT_WINDOW_MS = 10_000;
const TOAST_DURATION_MS = 5000;

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return dayjs(dateStr).format('HH:mm:ss');
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  return dayjs(dateStr).format('HH:mm');
}

const AlertToast = ({
  onViewEvent,
  onHandleEvent,
}: AlertToastProps): React.ReactElement => {
  const { data: events } = useQuery<EventInfo[]>({
    queryKey: queryKeys.events('open'),
    queryFn: () => getEvents(30, 'open'),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const recentL3 = useMemo(() => {
    if (!events) return [];
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return events
      .filter((e) => e.severity === 'L3')
      .filter((e) => {
        if (!e.createdAt) return false;
        return new Date(e.createdAt).getTime() >= cutoff;
      })
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
  }, [events]);

  // Track which event ids we have already toasted.
  const toastedRef = useRef<Set<string>>(new Set());
  const [activeToast, setActiveToast] = useState<EventInfo | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const alertListRef = useRef<HTMLDivElement>(null);
  const wasExpandedRef = useRef(false);

  useEffect(() => {
    if (expanded) {
      wasExpandedRef.current = true;
      window.requestAnimationFrame(() => alertListRef.current?.focus());
    } else if (wasExpandedRef.current) {
      wasExpandedRef.current = false;
      bellButtonRef.current?.focus();
    }
  }, [expanded]);

  // Detect newly-arrived L3 events.
  useEffect(() => {
    if (recentL3.length === 0) return;
    const fresh = recentL3.find((e) => !toastedRef.current.has(e.eventId));
    if (!fresh) return;
    toastedRef.current.add(fresh.eventId);
    setUnread((prev) => {
      const next = new Set(prev);
      next.add(fresh.eventId);
      return next;
    });
    setActiveToast(fresh);
  }, [recentL3]);

  // Auto-dismiss toast after 5s.
  useEffect(() => {
    if (!activeToast) return;
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      setActiveToast(null);
    }, TOAST_DURATION_MS);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [activeToast]);

  const handleDismissToast = () => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setActiveToast(null);
  };

  const handleView = (eventId: string) => {
    onViewEvent(eventId);
    setUnread((prev) => {
      const next = new Set(prev);
      next.delete(eventId);
      return next;
    });
    handleDismissToast();
  };

  const handleHandle = (eventId: string) => {
    onHandleEvent(eventId);
    setUnread((prev) => {
      const next = new Set(prev);
      next.delete(eventId);
      return next;
    });
    handleDismissToast();
  };

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (next) {
        // Mark all as read when expanded.
        setUnread(new Set());
      }
      return next;
    });
  };

  const unreadCount = unread.size;

  return (
    <div className="fixed top-14 right-3 z-[60] flex flex-col items-end gap-2 pointer-events-none">
      {/* Active toast card */}
      <AnimatePresence>
        {activeToast && (
          <motion.div
            key={`toast-${activeToast.eventId}`}
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ duration: 0.25 }}
            className="pointer-events-auto w-80 rounded-lg border border-red-500/40 bg-[hsl(0_60%_12%)]/95 backdrop-blur-sm shadow-lg shadow-red-900/30 p-3"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-2">
              <div className="w-7 h-7 shrink-0 rounded-md bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-4 h-4 text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <Badge className="text-[9px] px-1 py-0 bg-red-500/20 text-red-400 border-red-500/30">
                    L3
                  </Badge>
                  <span className="text-xs font-semibold text-white truncate">
                    {activeToast.title}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-white/60">
                  <span className="truncate">设备: {activeToast.deviceId}</span>
                  <span className="text-white/60">
                    {timeAgo(activeToast.createdAt)}
                  </span>
                </div>
              </div>
              <button
                onClick={handleDismissToast}
                className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white shrink-0"
                aria-label={UI_ARIA_LABELS.dismissAlertToast}
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            <div className="mt-2 flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2 flex-1 border-white/10"
                onClick={() => handleView(activeToast.eventId)}
                aria-label={`${UI_ARIA_LABELS.viewAlert}：${activeToast.title}`}
              >
                <Eye className="w-3 h-3" />
                查看详情
              </Button>
              <Button
                size="sm"
                className="h-6 text-[10px] px-2 flex-1 bg-red-500/80 hover:bg-red-500 border-red-400/40"
                onClick={() => handleHandle(activeToast.eventId)}
                aria-label={`${UI_ARIA_LABELS.handleAlert}：${activeToast.title}`}
              >
                <Zap className="w-3 h-3" />
                快速处置
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Expanded alert list */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="alert-list"
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-auto w-80 rounded-lg border border-white/10 bg-[hsl(220_14%_12%)]/95 backdrop-blur-sm shadow-lg p-2"
            ref={alertListRef}
            tabIndex={-1}
            role="region"
            aria-label="L3 告警列表"
            aria-live="polite"
            id="alert-list"
          >
            <div className="flex items-center justify-between px-1 pb-1.5 border-b border-white/10">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3 text-red-400" />
                <span className="text-[10px] text-white/70">L3 告警列表</span>
              </div>
              <span className="text-[9px] text-white/60 tabular-nums">
                {recentL3.length} 条近 10s
              </span>
            </div>
            <div className="mt-1 max-h-64 overflow-y-auto">
              {recentL3.length === 0 ? (
                <div className="text-[10px] text-white/60 text-center py-4">
                  暂无近 10s 内 L3 告警
                </div>
              ) : (
                <div className="space-y-1">
                  {recentL3.map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-start gap-1.5 p-1.5 rounded bg-white/5 hover:bg-white/10"
                    >
                      <div className="w-1 self-stretch rounded-full bg-red-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-white/90 truncate">
                          {ev.title}
                        </div>
                        <div className="flex items-center gap-1.5 text-[9px] text-white/60">
                          <span className="truncate">{ev.deviceId}</span>
                          <span>·</span>
                          <span>{timeAgo(ev.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <button
                          className="text-[9px] px-1 py-0.5 rounded bg-white/5 hover:bg-white/10 text-white/70"
                          onClick={() => handleView(ev.eventId)}
                          aria-label={`${UI_ARIA_LABELS.viewAlert}：${ev.title}`}
                        >
                          详情
                        </button>
                        <button
                          className="text-[9px] px-1 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300"
                          onClick={() => handleHandle(ev.eventId)}
                          aria-label={`${UI_ARIA_LABELS.handleAlert}：${ev.title}`}
                        >
                          处置
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bell icon button */}
      <button
        ref={bellButtonRef}
        onClick={toggleExpanded}
        className={cn(
          'pointer-events-auto relative w-9 h-9 rounded-full border border-white/10 bg-[hsl(220_14%_14%)]/95 backdrop-blur-sm shadow-md flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors',
          expanded && 'bg-white/10 text-white',
        )}
        title={expanded ? '收起告警' : '展开告警'}
        aria-expanded={expanded}
        aria-controls="alert-list"
        aria-label={expanded ? UI_ARIA_LABELS.collapseAlertList : UI_ARIA_LABELS.expandAlertList}
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
    </div>
  );
};

export default AlertToast;
