import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { evaluatePolicyGate, getKpiHistory } from '../../api/scheduler';
import type { PolicyGateEvaluation } from '@shared/api.interface';

/**
 * PolicyGatePanel —— 调度策略门禁指标看板（NO-87b）。
 *
 * 愿景要求"数据来源、更新时间、可信度"可见：策略激活门禁的每条检查
 * （实际值 vs 阈值、ok/skipped/failed）在这里随时间可见，指标漂移早发现
 * （而不是等激活被拒时才发现 on_time_rate 已滑到阈值之下）。
 *
 * 三态语义（与 golden 场景一致）：
 *   · 全部通过且证据齐 → "可激活（无需确认）"；
 *   · 有 skipped 检查 → "可激活，但需显式确认（缺数据）"；
 *   · 有 failed 检查 → "已拒绝（不达标）——ack 无法豁免"。
 * 评估为只读（不产生激活/审计记录）；轮询 60s。
 */
export function PolicyGatePanel({ version = 2 }: { version?: number }): React.ReactElement {
  const query = useQuery({
    queryKey: ['policy-gate', version],
    queryFn: () => evaluatePolicyGate(version),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: ['policy-gate-history'],
    queryFn: () => getKpiHistory(12),
    refetchInterval: 120_000,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="policy-gate-loading">
        <Loader2 className="size-3 animate-spin" aria-hidden /> 正在评估策略门禁…
      </p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <p className="text-sm text-risk-blocked-foreground" data-testid="policy-gate-error">
        策略门禁读取失败：{query.error instanceof Error ? query.error.message : '未知错误'}
      </p>
    );
  }

  const gate: PolicyGateEvaluation = query.data;
  const failed = gate.checks.filter((c) => !c.skipped && !c.ok);
  const skipped = gate.checks.filter((c) => c.skipped);
  const state = failed.length > 0
    ? { label: '已拒绝（指标不达标）', tone: 'text-risk-blocked-foreground' }
    : skipped.length > 0
      ? { label: '可激活，但需显式确认（部分检查缺数据）', tone: 'text-risk-degraded-foreground' }
      : { label: '可激活（全部检查通过）', tone: 'text-risk-normal-foreground' };

  return (
    <section className="space-y-2" data-testid="policy-gate-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground">策略门禁（候选 v{version}）</span>
        <Badge variant="outline" className={state.tone}>{state.label}</Badge>
        {gate.insufficientEvidence && (
          <Badge variant="outline" className="text-risk-degraded-foreground">证据不足（激活需显式确认）</Badge>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2 font-medium">检查</th>
            <th className="py-1 pr-2 font-medium">实际</th>
            <th className="py-1 pr-2 font-medium">阈值</th>
            <th className="py-1 font-medium">结论</th>
          </tr>
        </thead>
        <tbody>
          {gate.checks.map((check) => (
            <tr key={check.name} className="border-t border-border">
              <td className="py-1 pr-2 font-mono text-xs">{check.name}</td>
              <td className="py-1 pr-2">{check.actual ?? '—'}</td>
              <td className="py-1 pr-2">{check.threshold}</td>
              <td className={`py-1 text-xs ${
                check.skipped
                  ? 'text-muted-foreground'
                  : check.ok
                    ? 'text-risk-normal-foreground'
                    : 'text-risk-blocked-foreground font-semibold'
              }`}>
                {check.skipped ? '缺数据（未验证）' : check.ok ? '通过' : '不达标'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        结论三态：通过 / 缺数据（未验证 ≠ 通过）/ 不达标（激活被拒，ack 无法豁免）。
      </p>
      <TrendSection history={historyQuery.data} historyLoading={historyQuery.isLoading} />
    </section>
  );
}

/** NO-89a：KPI 趋势（最近快照序列）——漂移早发现，数字随时间可见。 */
function TrendSection({
  history,
  historyLoading,
}: {
  history: Array<{ periodEnd: string; kpi: { onTimeRate: number | null; latenessP95Ms: number | null } }> | undefined;
  historyLoading: boolean;
}): React.ReactElement | null {
  if (historyLoading) {
    return <p className="text-xs text-muted-foreground">正在读取 KPI 历史…</p>;
  }
  if (!Array.isArray(history) || history.length === 0) {
    return null; // 没有持久化快照（如清库后）→ 如实缺项，不伪造趋势
  }
  return (
    <div className="space-y-1" data-testid="policy-gate-trend">
      <p className="text-xs font-medium text-foreground">KPI 趋势（最近 {history.length} 个快照，按周期倒序）</p>
      {(() => {
        // NO-90b：on-time 趋势 sparkline（SVG 折线；缺数据点断开不连线——不伪造连续性）
        const points = [...history]
          .reverse()
          .map((h) => h.kpi.onTimeRate)
          .map((v, i) => ({ v, i }));
        const known = points.filter((p) => p.v != null) as Array<{ v: number; i: number }>;
        if (known.length < 2) return null;
        const width = 220;
        const height = 36;
        const xs = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * width : 0);
        const ys = (v: number) => height - Math.max(0, Math.min(1, v)) * height;
        const segments: string[] = [];
        let current: string[] = [];
        for (const p of points) {
          if (p.v == null) {
            if (current.length > 1) segments.push(current.join(' '));
            current = [];
          } else {
            current.push(`${xs(p.i).toFixed(1)},${ys(p.v).toFixed(1)}`);
          }
        }
        if (current.length > 1) segments.push(current.join(' '));
        // 阈值参考线（0.8，与门禁同源）
        const thresholdY = ys(0.8);
        // NO-99b：悬停 tooltip——按周期倒序展示每个快照的值（title 原生可达）
        const tip = history
          .map((h) => `${h.periodEnd.slice(0, 16).replace('T', ' ')} on-time=${h.kpi.onTimeRate ?? '缺数据'}`)
          .join('\n');
        return (
          <svg width={width} height={height} className="block" role="img" aria-label="on-time 趋势">
            <title>{`on-time 趋势（旧→新）：\n${tip}`}</title>
            <line x1="0" x2={width} y1={thresholdY} y2={thresholdY} stroke="currentColor" strokeDasharray="3 3" className="text-muted-foreground" strokeWidth="0.5" />
            {segments.map((seg, idx) => (
              <polyline key={idx} points={seg} fill="none" stroke="currentColor" className="text-primary" strokeWidth="1.5" />
            ))}
          </svg>
        );
      })()}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-0.5 pr-2 font-medium">周期结束</th>
            <th className="py-0.5 pr-2 font-medium">on-time</th>
            <th className="py-0.5 font-medium">lateness p95 (ms)</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.periodEnd} className="border-t border-border">
              <td className="py-0.5 pr-2 font-mono">{h.periodEnd.slice(0, 16).replace('T', ' ')}</td>
              <td className={`py-0.5 pr-2 ${h.kpi.onTimeRate == null ? 'text-muted-foreground' : h.kpi.onTimeRate >= 0.8 ? 'text-risk-normal-foreground' : 'text-risk-blocked-foreground'}`}>
                {h.kpi.onTimeRate == null ? '缺数据' : h.kpi.onTimeRate.toFixed(2)}
              </td>
              <td className={`py-0.5 ${h.kpi.latenessP95Ms == null ? 'text-muted-foreground' : h.kpi.latenessP95Ms <= 1_800_000 ? 'text-risk-normal-foreground' : 'text-risk-blocked-foreground'}`}>
                {h.kpi.latenessP95Ms == null ? '缺数据' : h.kpi.latenessP95Ms}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default PolicyGatePanel;
