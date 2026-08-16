/* SimulationRunList.tsx — 仿真运行台账纯展示列表（NO-13s / ADR-068，§17）。
 *
 * 纯展示组件（行模型 props，零网络）：运行台账行（runId/kind 标签/状态
 * 标签+语调/结果摘要头条/失败原因）透出；选中态 aria-pressed。展示层
 * 不做二次解释；行模型由 buildRunListRows 构建（simulationConsoleLogic）。
 */
import { cn } from '@client/src/lib/utils';
import {
  TONE_BORDER,
  TONE_TEXT,
  type RunListRow,
} from './simulationConsoleLogic';

export interface SimulationRunListProps {
  rows: RunListRow[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}

export function SimulationRunList({
  rows,
  selectedRunId,
  onSelectRun,
}: SimulationRunListProps): React.ReactElement {
  return (
    <ul className="mt-3 space-y-1.5" data-testid="simulation-run-list">
      {rows.map((row) => (
        <li key={row.runId}>
          <button
            type="button"
            onClick={() => onSelectRun(row.runId)}
            aria-pressed={selectedRunId === row.runId}
            className={cn(
              'w-full rounded border p-2.5 text-left',
              TONE_BORDER[row.tone],
              selectedRunId === row.runId && 'ring-2 ring-[hsl(221_83%_53%)]/40',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-xs text-[hsl(220_14%_14%)]">{row.runId}</span>
              <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">{row.kindLabel}</span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2">
              <span className={cn('text-xs font-medium', TONE_TEXT[row.tone])}>{row.statusLabel}</span>
              <span className="min-w-0 truncate text-xs text-[hsl(218_10%_42%)]">{row.headline}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
