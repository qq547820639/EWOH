import { useMemo } from 'react';
import { Play, Pause, Radio, Clock, Square } from 'lucide-react';
import dayjs from 'dayjs';
import type { ReplaySnapshot } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { eventAccessibleLabel, UI_ARIA_LABELS } from '../../../lib/a11y';

const SPEEDS = [1, 2, 5];

interface TimelineEvent {
  ts: string;
  eventId: string;
  severity: string;
  title: string;
  lane?: string;
  entityId?: string;
  sourceType?: string;
  status?: string;
}

interface TimelinePanelProps {
  snapshots?: ReplaySnapshot[];
  isLoading?: boolean;
  isError?: boolean;
  replayMode: boolean;
  onReplayModeChange: (next: boolean) => void;
  replayTime: string | null;
  onReplayTimeChange: (time: string | null) => void;
  paused: boolean;
  onPausedChange: (next: boolean) => void;
  speed: number;
  onSpeedChange: (next: number) => void;
  onSelectEvent: (eventId: string) => void;
  onCreateItem?: (event: TimelineEvent) => void;
}

export default function TimelinePanel({
  snapshots,
  isLoading = false,
  isError = false,
  replayMode,
  onReplayModeChange,
  replayTime,
  onReplayTimeChange,
  paused,
  onPausedChange,
  speed,
  onSpeedChange,
  onSelectEvent,
  onCreateItem,
}: TimelinePanelProps): React.ReactElement {
  const allEvents: TimelineEvent[] = useMemo(() => {
    if (!snapshots) return [];
    const events: TimelineEvent[] = [];
    for (const snap of snapshots) {
      for (const ev of snap.events) {
        events.push({ ts: snap.ts, ...ev });
      }
    }
    return events;
  }, [snapshots]);

  const { now, minTime } = useMemo(() => {
    const n = Date.now();
    return { now: n, minTime: n - 60 * 60 * 1000 };
  }, []);

  const ticks = useMemo(() => {
    const result: { label: string; ratio: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const t = now - i * 10 * 60 * 1000;
      result.push({
        label: dayjs(t).format('HH:mm'),
        ratio: (t - minTime) / (now - minTime),
      });
    }
    return result;
  }, [now, minTime]);

  const timeToRatio = (ts: string): number => {
    const t = new Date(ts).getTime();
    return Math.max(0, Math.min(1, (t - minTime) / (now - minTime)));
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const time = minTime + ratio * (now - minTime);
    onReplayTimeChange(new Date(time).toISOString());
  };

  const handleTimelineKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const stepMs = 5 * 60 * 1000;
    const base = replayTime ? new Date(replayTime).getTime() : now;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = base - stepMs;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = base + stepMs;
    else if (e.key === 'Home') next = minTime;
    else if (e.key === 'End') next = now;
    if (next !== null) {
      e.preventDefault();
      onReplayTimeChange(new Date(Math.max(minTime, Math.min(now, next))).toISOString());
    }
  };

  const selectedSnapshot = useMemo(() => {
    if (!snapshots || !replayTime) return null;
    const target = new Date(replayTime).getTime();
    let closest: ReplaySnapshot | null = null;
    let minDiff = Infinity;
    for (const snap of snapshots) {
      const diff = Math.abs(new Date(snap.ts).getTime() - target);
      if (diff < minDiff) {
        minDiff = diff;
        closest = snap;
      }
    }
    return closest;
  }, [snapshots, replayTime]);

  const selectEvent = (event: TimelineEvent) => {
    onReplayTimeChange(event.ts);
    onSelectEvent(event.eventId);
  };

  return (
    <div className="h-full flex bg-[hsl(220_14%_14%)] text-white">
      {/* Left controls */}
      <div className="w-52 flex flex-col gap-3 p-3 border-r border-white/10 shrink-0">
        <Button
          variant={replayMode ? 'default' : 'secondary'}
          size="sm"
          onClick={() => onReplayModeChange(!replayMode)}
          className="w-full"
          aria-pressed={replayMode}
          aria-label={replayMode ? UI_ARIA_LABELS.exitReplay : UI_ARIA_LABELS.enterReplay}
        >
          {replayMode ? <Square className="w-3.5 h-3.5" /> : <Radio className="w-3.5 h-3.5" />}
          {replayMode ? '退出回放' : '进入回放'}
        </Button>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-white/60">倍速</span>
          <div className="flex gap-1">
            {SPEEDS.map((s) => (
              <Button
                key={s}
                variant={speed === s ? 'default' : 'outline'}
                size="sm"
                disabled={!replayMode}
                onClick={() => onSpeedChange(s)}
                className="flex-1 h-7 text-xs"
                aria-pressed={speed === s}
                aria-label={`${s} 倍速`}
              >
                {s}x
              </Button>
            ))}
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={!replayMode}
          onClick={() => onPausedChange(!paused)}
          className="w-full"
          aria-pressed={paused}
          aria-label={paused ? UI_ARIA_LABELS.resumeReplay : UI_ARIA_LABELS.pauseReplay}
        >
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {paused ? '继续' : '暂停'}
        </Button>

        <div className="mt-auto text-xs text-white/70">
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            选中时间
          </div>
          <div className="mt-1 text-white/80">
            {replayTime ? dayjs(replayTime).format('MM-DD HH:mm:ss') : '未选择'}
          </div>
          {replayMode && (
            <div className="mt-1 text-[10px] text-cyan-400/80">
              {paused ? '已暂停' : `按时间轴快照播放 · ${speed}x`}
            </div>
          )}
        </div>
      </div>

      {/* Right: timeline + events */}
      <div className="flex-1 flex flex-col min-h-0">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-white/70">
            加载中...
          </div>
        ) : isError ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-400">
            回放数据加载失败
          </div>
        ) : !snapshots || snapshots.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-white/70">
            暂无回放快照，请先积累世界状态历史
          </div>
        ) : (
          <>
            {/* Timeline track */}
            <div
              className="relative flex-1 mx-3 mt-2 cursor-pointer"
              onClick={handleTimelineClick}
              onKeyDown={handleTimelineKeyDown}
              role="slider"
              tabIndex={0}
              aria-label="回放时间轴"
              aria-valuemin={minTime}
              aria-valuemax={now}
              aria-valuenow={replayTime ? new Date(replayTime).getTime() : now}
              aria-valuetext={replayTime ? dayjs(replayTime).format('MM-DD HH:mm:ss') : '未选择'}
            >
              {/* Axis line */}
              <div className="absolute left-0 right-0 top-1/2 h-px bg-white/20" />

              {/* Ticks */}
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className="absolute flex flex-col items-center"
                  style={{
                    left: `${tick.ratio * 100}%`,
                    top: '50%',
                    transform: 'translateX(-50%)',
                  }}
                >
                  <div className="w-px h-1.5 bg-white/30" />
                  <span className="text-[9px] text-white/60 mt-0.5 whitespace-nowrap">
                    {tick.label}
                  </span>
                </div>
              ))}

              {/* Event markers */}
              {allEvents.map((ev, i) => {
                const ratio = timeToRatio(ev.ts);
                const color =
                  ev.severity === 'L3'
                    ? 'bg-red-500'
                    : ev.severity === 'L2'
                      ? 'bg-orange-500'
                      : 'bg-yellow-500';
                return (
                  <button
                    key={`${ev.eventId}-${i}`}
                    type="button"
                    title={`${ev.title} (${ev.severity}) - 点击查看`}
                    aria-label={eventAccessibleLabel(ev.title, ev.severity)}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectEvent(ev);
                    }}
                    className={cn(
                      'absolute w-2.5 h-2.5 rounded-full border border-white/20 -translate-x-1/2 -translate-y-1/2 cursor-pointer hover:scale-125 transition-transform',
                      color,
                    )}
                    style={{ left: `${ratio * 100}%`, top: 'calc(50% - 10px)' }}
                  />
                );
              })}

              {/* Current replay time marker */}
              {replayTime && (
                <div
                  className="absolute top-2 bottom-6 w-0.5 bg-cyan-400 -translate-x-1/2 pointer-events-none"
                  style={{ left: `${timeToRatio(replayTime) * 100}%` }}
                >
                  <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-cyan-400" />
                </div>
              )}
            </div>

            {/* Bottom: events at selected time */}
            <div className="h-12 mx-3 mb-2 border-t border-white/10 pt-1.5">
              {selectedSnapshot && selectedSnapshot.events.length > 0 ? (
                <div className="flex items-center gap-2 overflow-x-auto h-full">
                  <span className="text-[10px] text-white/60 shrink-0">事件:</span>
                  {selectedSnapshot.events.map((ev, i) => (
                    <div
                      key={`${ev.eventId}-${i}`}
                      className="flex items-center gap-1 shrink-0"
                    >
                      <button
                        type="button"
                        aria-label={eventAccessibleLabel(ev.title, ev.severity)}
                        onClick={() => selectEvent({ ts: selectedSnapshot.ts, ...ev })}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-white/5 hover:bg-white/10"
                      >
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            ev.severity === 'L3'
                              ? 'bg-red-500'
                              : ev.severity === 'L2'
                                ? 'bg-orange-500'
                                : 'bg-yellow-500',
                          )}
                        />
                        <span className="text-white/80">{ev.title}</span>
                        {ev.lane && (
                          <span className="text-white/40 border-l border-white/10 pl-1">
                            {ev.lane}
                          </span>
                        )}
                      </button>
                      {onCreateItem && (
                        <button
                          type="button"
                          onClick={() =>
                            onCreateItem({ ts: selectedSnapshot.ts, ...ev })
                          }
                          className="rounded px-1.5 py-0.5 text-[10px] text-cyan-300 hover:bg-cyan-400/10"
                        >
                          跟进
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-white/60 h-full flex items-center">
                  {replayTime ? '该时刻无事件' : '点击时间轴选择回放时刻'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
