/* Phase 4 / P4-COMPARE：Plan Compare 地图叠加层（BASELINE / CANDIDATE / DIFF）。
 *
 * 数据 = planCompareMapVM（后端 PlanCompareResult 权威 diff + 坐标映射）。
 * 纯视觉：不重算任何业务语义；变化表达 = 颜色 + 线型 + 徽标 + before/after 标记
 * 组合（不依赖颜色作为唯一表达）。
 */
import React from 'react';
import { memo } from 'react';
import type { PlanCompareMapVM, CompareMapEntry, PlanCompareMode } from '../vm/planCompareVM';

interface PlanCompareLayerProps {
  vm: PlanCompareMapVM;
  focusedTaskId: string | null;
  onFocusTask: (taskId: string | null) => void;
  /** 未变化任务（candidate 中未触及的 assignment）用于低干扰上下文。 */
  unchangedTaskIds?: string[];
}

const CHANGE_COLOR: Record<string, string> = {
  ADDED: '#10b981',
  REMOVED: '#ef4444',
  PERSON_CHANGED: '#f59e0b',
  DEVICE_CHANGED: '#8b5cf6',
  STATION_CHANGED: '#06b6d4',
  TIME_CHANGED: '#facc15',
  ROUTE_CHANGED: '#3b82f6',
  ETA_CHANGED: '#ec4899',
};

const DEFAULT_COLOR = '#e2e8f0';

function changeColor(changeTypes: CompareMapEntry['changeTypes']): string {
  for (const ct of changeTypes) {
    if (CHANGE_COLOR[ct]) return CHANGE_COLOR[ct];
  }
  return DEFAULT_COLOR;
}

function changeBadge(changeTypes: CompareMapEntry['changeTypes']): string {
  // 取最有信息量的变化类型做徽标文字（前端不判断，仅展示后端分类）。
  const priority: PlanCompareMode[] = [];
  void priority;
  if (changeTypes.includes('ADDED')) return 'ADD';
  if (changeTypes.includes('REMOVED')) return 'RMV';
  if (changeTypes.includes('STATION_CHANGED')) return 'STA';
  if (changeTypes.includes('PERSON_CHANGED')) return 'PER';
  if (changeTypes.includes('DEVICE_CHANGED')) return 'DEV';
  if (changeTypes.includes('ROUTE_CHANGED')) return 'RTE';
  if (changeTypes.includes('ETA_CHANGED')) return 'ETA';
  if (changeTypes.includes('TIME_CHANGED')) return 'TME';
  return changeTypes[0]?.slice(0, 3) ?? 'CHG';
}

/** 单条 diff 的地图标记（含 before/after 双标记 + 变化连接线）。 */
function DiffMarker({
  entry,
  focused,
  onFocus,
}: {
  entry: CompareMapEntry;
  focused: boolean;
  onFocus: (taskId: string) => void;
}) {
  const color = changeColor(entry.changeTypes);
  const before = entry.before?.point ?? null;
  const after = entry.after?.point ?? null;
  const main = after ?? before;
  if (!main) return null;

  const strokeDash = entry.changeTypes.includes('REMOVED') ? '4 3' : undefined;

  return (
    <g
      data-diff-task={entry.taskId}
      transform={`translate(${main.x} ${main.y})`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onFocus(entry.taskId);
      }}
    >
      {/* 变化连接线（before → after） */}
      {before && after && (before.x !== after.x || before.y !== after.y) && (
        <line
          x1={before.x - main.x}
          y1={before.y - main.y}
          x2={after.x - main.x}
          y2={after.y - main.y}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="6 3"
          opacity={0.7}
        />
      )}
      {/* 主标记（after 优先；REMOVED 用 before） */}
      <circle
        r={focused ? 11 : 8}
        fill={color}
        fillOpacity={focused ? 0.45 : 0.25}
        stroke={color}
        strokeWidth={focused ? 2.5 : 1.5}
        strokeDasharray={strokeDash}
      />
      {/* 徽标（非颜色唯一表达：文字 + 形状） */}
      <rect x={10} y={-8} width={30} height={13} rx={3} fill={color} fillOpacity={0.92} />
      <text x={25} y={2} textAnchor="middle" fontSize={8} fontWeight={700} fill="#0f172a">
        {changeBadge(entry.changeTypes)}
      </text>
      {/* before/after 双标（STATION/PERSON/DEVICE 变化时） */}
      {before && after && (
        <g>
          <circle
            cx={before.x - main.x}
            cy={before.y - main.y}
            r={4}
            fill="#0f172a"
            stroke="#ef4444"
            strokeWidth={1.5}
          />
          <circle
            cx={after.x - main.x}
            cy={after.y - main.y}
            r={4}
            fill="#0f172a"
            stroke="#10b981"
            strokeWidth={1.5}
          />
        </g>
      )}
    </g>
  );
}

/** Unchanged 上下文标记（低干扰、可点击聚焦）。 */
function UnchangedMarker({
  point,
  taskId,
  onFocus,
}: {
  point: { x: number; y: number };
  taskId: string;
  onFocus: (taskId: string) => void;
}) {
  return (
    <g
      data-unchanged-task={taskId}
      transform={`translate(${point.x} ${point.y})`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onFocus(taskId);
      }}
    >
      <circle r={3.5} fill="#1e293b" stroke="#475569" strokeWidth={1} opacity={0.85} />
    </g>
  );
}

/** BASELINE/CANDIDATE：只渲染对应侧 assignment 点（无变化分类，仅位置）。 */
function SideMarkers({
  entries,
  mode,
  unchangedPoints,
}: {
  entries: CompareMapEntry[];
  mode: 'BASELINE' | 'CANDIDATE';
  unchangedPoints: Array<{ taskId: string; point: { x: number; y: number } }>;
}) {
  return (
    <g data-compare-mode={mode}>
      {entries.map((e) => {
        const snap = mode === 'BASELINE' ? e.before : e.after;
        const pt = snap?.point;
        if (!pt) return null;
        return (
          <g key={`${mode}-${e.taskId}`} transform={`translate(${pt.x} ${pt.y})`}>
            <circle
              r={6}
              fill={mode === 'BASELINE' ? '#64748b' : '#38bdf8'}
              fillOpacity={0.4}
              stroke={mode === 'BASELINE' ? '#94a3b8' : '#7dd3fc'}
              strokeWidth={1.5}
            />
            <text x={10} y={2} fontSize={7.5} fill="#cbd5e1">
              {e.taskId.slice(-4)}
            </text>
          </g>
        );
      })}
      {unchangedPoints.map((u) => (
        <circle
          key={`${mode}-u-${u.taskId}`}
          cx={u.point.x}
          cy={u.point.y}
          r={3}
          fill="none"
          stroke={mode === 'BASELINE' ? '#475569' : '#0ea5e9'}
          strokeWidth={1}
          opacity={0.5}
        />
      ))}
    </g>
  );
}

/** Plan Compare 地图叠加层（三模式切换由 VM.mode 决定；纯视觉）。React.memo：vm/焦点/未变点引用未变时跳过重渲染。 */
export const PlanCompareLayer = memo(function PlanCompareLayer({
  vm,
  focusedTaskId,
  onFocusTask,
  unchangedTaskIds = [],
  unchangedPoints,
}: PlanCompareLayerProps & {
  unchangedPoints?: Array<{ taskId: string; point: { x: number; y: number } }>;
}): React.ReactElement | null {
  if (vm.entries.length === 0 && unchangedTaskIds.length === 0) return null;

  if (vm.mode === 'BASELINE' || vm.mode === 'CANDIDATE') {
    const side = vm.mode;
    return (
      <g data-layer="plan-compare">
        <SideMarkers
          entries={vm.entries}
          mode={side}
          unchangedPoints={unchangedPoints ?? []}
        />
      </g>
    );
  }

  return (
    <g data-layer="plan-compare" data-mode="DIFF">
      {vm.entries.map((e) => (
        <DiffMarker
          key={`diff-${e.taskId}`}
          entry={e}
          focused={focusedTaskId === e.taskId}
          onFocus={onFocusTask}
        />
      ))}
      {unchangedPoints?.map((u) => (
        <UnchangedMarker
          key={`unch-${u.taskId}`}
          point={u.point}
          taskId={u.taskId}
          onFocus={onFocusTask}
        />
      ))}
    </g>
  );
});
