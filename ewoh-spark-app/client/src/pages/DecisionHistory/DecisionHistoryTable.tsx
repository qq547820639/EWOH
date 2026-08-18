/* DecisionHistoryTable.tsx — 决策历史纯展示表（NO-13q / ADR-066，§18）。
 *
 * 纯展示组件（行模型 props，零网络）：契约字段透出（kind/status/authority/
 * riskLevel/subject/decidedAt/selected.reason/approver/evidence）——
 * 展示层不做二次解释；skippedInvalid 由控制台层显式横幅呈现。
 */
import { cn } from '@client/src/lib/utils';
import { RISK_TONE_TEXT, type DecisionHistoryRow } from './decisionHistoryLogic';

export interface DecisionHistoryTableProps {
  rows: DecisionHistoryRow[];
  total: number;
  skippedInvalid: number;
  sourcesSummary: string;
}

export function DecisionHistoryTable({
  rows,
  total,
  skippedInvalid,
  sourcesSummary,
}: DecisionHistoryTableProps): React.ReactElement {
  return (
    <div data-testid="decision-history-table">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="decision-history-total">共 {total} 条</span>
        <span data-testid="decision-history-sources">{sourcesSummary}</span>
        {skippedInvalid > 0 && (
          <span
            data-testid="decision-history-skipped-invalid"
            className="rounded border border-risk-degraded/30 bg-risk-degraded/10 px-2 py-0.5 text-risk-degraded"
          >
            非法记录 {skippedInvalid} 条已显式跳过（§33 不静默丢弃）
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div
          data-testid="decision-history-empty"
          className="rounded-lg border border-border bg-muted p-6 text-center text-sm text-muted-foreground"
        >
          暂无决策记录（含过滤条件）
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-foreground">决策 ID</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">类型</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">状态</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">权威</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">风险</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">主体</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">时间</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">依据</th>
                <th className="px-3 py-2 text-left font-semibold text-foreground">审批人</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {rows.map((row) => (
                <tr key={row.decisionId} data-testid="decision-history-row">
                  <td className="px-3 py-2 font-mono text-xs text-foreground">{row.decisionId}</td>
                  <td className="px-3 py-2 text-foreground">{row.kindLabel}</td>
                  <td className="px-3 py-2 text-foreground">{row.statusLabel}</td>
                  <td className="px-3 py-2 text-foreground">{row.authorityLabel}</td>
                  <td className={cn('px-3 py-2 font-semibold', RISK_TONE_TEXT[row.riskTone])}>{row.riskLevel}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{row.subject}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.decidedAt}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.selectedReason}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.approver ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
