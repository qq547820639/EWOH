/* Task 8 / 8.1：回放工作台（时间轴标签页）。
 *
 * 拥有时间轴面板（TimelinePanel，React.lazy 独立 chunk）的组合；回放播放循环
 * 与 replay 状态仍留在 CommandMapShell（useCommandMapController 唯一状态源），
 * 本组件仅按 props 接线渲染。
 */
import React from 'react';
import type { ReactElement } from 'react';
import type { ReplaySnapshot } from '@shared/api.interface';
import { MapPanelFallback } from './CommandMapShell';

const TimelinePanel = React.lazy(() => import('./panels/TimelinePanel'));

interface ReplayWorkspaceProps {
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
  onCreateItem: (event: { eventId: string; title: string; ts: string }) => void;
}

const ReplayWorkspace = ({
  snapshots,
  isLoading,
  isError,
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
}: ReplayWorkspaceProps): ReactElement => (
  <React.Suspense fallback={<MapPanelFallback />}>
    <TimelinePanel
      snapshots={snapshots}
      isLoading={isLoading}
      isError={isError}
      replayMode={replayMode}
      onReplayModeChange={onReplayModeChange}
      replayTime={replayTime}
      onReplayTimeChange={onReplayTimeChange}
      paused={paused}
      onPausedChange={onPausedChange}
      speed={speed}
      onSpeedChange={onSpeedChange}
      onSelectEvent={onSelectEvent}
      onCreateItem={onCreateItem}
    />
  </React.Suspense>
);

export default ReplayWorkspace;
