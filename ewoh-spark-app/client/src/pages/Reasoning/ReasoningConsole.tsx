import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, RefreshCw, ShieldAlert, Eye } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { errorDescription } from '@client/src/lib/errorContract';
import { getLiveFacts, evaluateLive } from '@client/src/api/reasoning';
import {
  buildRiskRows,
  buildSkippedRows,
  riskSummary,
  type LiveConclusionInput,
  type LiveEvidenceInput,
  type LiveSkippedInput,
} from './reasoningConsoleLogic';

/**
 * 实时风险（观测推导）—— NO-25a 的交互面。
 *
 * 这里显示的**不是**"系统猜的风险"，而是：确定性规则在**当前世界模型 + 最近观测读数**
 * 上的命中结果，每条都带依据（数值/阈值/观测时间/数据质量/来源）与未被采用的数据
 * （过期、低置信、未声明能力……）。现场因此能回答两个问题：
 *   · 这个风险为什么出现？（点开依据）
 *   · 我明明看到读数超标，为什么没报警？（看"未采用数据"的原因）
 *
 * 交互上刻意区分两种动作：
 *   · 「查看事实」= 只读投影（不评估、不落账）；
 *   · 「立即评估」= 真正跑规则并把结论落 L4 台账（人工触发，不自动轮询写库）。
 */
export default function ReasoningConsole() {
  const [evaluated, setEvaluated] = useState<{
    conclusions: LiveConclusionInput[];
    evidence: LiveEvidenceInput[];
    skipped: LiveSkippedInput[];
    inferenceIds: Array<{ conclusionId: string; inferenceId: string }>;
    snapshotVersion: number;
    generatedAt: string;
    readingsConsidered: number;
    mode: 'live' | 'readonly';
  } | null>(null);

  const factsQuery = useQuery({
    queryKey: ['reasoning', 'live-facts'],
    queryFn: getLiveFacts,
    enabled: false,
    retry: false,
  });

  const evaluateMutation = useMutation({
    mutationFn: () => evaluateLive(),
    onSuccess: (data) => {
      setEvaluated({
        // 实时评估的结论来自本次规则命中（与依据/台账 id 同源）
        conclusions: data.conclusions,
        evidence: data.evidence,
        skipped: data.skipped,
        inferenceIds: data.inferenceIds,
        snapshotVersion: data.snapshotVersion,
        generatedAt: data.generatedAt,
        readingsConsidered: data.readingsConsidered,
        mode: 'live',
      });
    },
  });

  const view = useMemo(() => {
    if (evaluated) return evaluated;
    const data = factsQuery.data;
    if (!data) return null;
    return {
      // 只读投影不跑规则：结论为空是对的（不拿旧的评估结果冒充"当前风险"）
      conclusions: [] as LiveConclusionInput[],
      evidence: data.evidence,
      skipped: data.skipped,
      inferenceIds: [] as Array<{ conclusionId: string; inferenceId: string }>,
      snapshotVersion: data.snapshotVersion,
      generatedAt: data.generatedAt,
      readingsConsidered: data.readingsConsidered,
      mode: 'readonly' as const,
    };
  }, [evaluated, factsQuery.data]);

  const rows = useMemo(
    () => buildRiskRows(view?.conclusions ?? [], view?.evidence ?? [], view?.inferenceIds ?? []),
    [view],
  );
  const skippedRows = useMemo(() => buildSkippedRows(view?.skipped ?? []), [view]);
  const summary = riskSummary(rows, view?.evidence.length ?? 0, skippedRows.length);
  const busy = evaluateMutation.isPending || factsQuery.isFetching;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Activity className="h-7 w-7 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">实时风险（观测推导）</h1>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="reasoning-summary">
              {summary.label}
            </p>
            {view && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="reasoning-provenance">
                世界模型版本 {view.snapshotVersion} · 生成于{' '}
                {new Date(view.generatedAt).toLocaleString('zh-CN')} · 参与判定读数{' '}
                {view.readingsConsidered} 条 ·{' '}
                {view.mode === 'live' ? '本次已落 L4 台账' : '只读视图（未评估、未落账）'}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            data-testid="reasoning-view-facts"
            disabled={busy}
            onClick={() => factsQuery.refetch()}
          >
            <Eye className="mr-1 h-4 w-4" />
            查看事实
          </Button>
          <Button data-testid="reasoning-evaluate" disabled={busy} onClick={() => evaluateMutation.mutate()}>
            <RefreshCw className="mr-1 h-4 w-4" />
            {evaluateMutation.isPending ? '评估中…' : '立即评估'}
          </Button>
        </div>
      </header>

      {(evaluateMutation.isError || factsQuery.isError) && (
        <div className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked-foreground">
          {evaluateMutation.isError
            ? `评估失败：${errorDescription(evaluateMutation.error)}`
            : `事实视图读取失败：${errorDescription(factsQuery.error)}`}
        </div>
      )}

      {!view && !busy && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          尚未评估。点「立即评估」按当前世界模型与最近观测读数跑一遍确定性规则；
          点「查看事实」只看事实与依据（不评估、不落账）。
        </div>
      )}

      {view && (
        <>
          <section data-testid="reasoning-risks">
            <h2 className="mb-3 text-lg font-semibold text-foreground">命中结论</h2>
            {rows.length === 0 ? (
              <div
                className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground"
                data-testid="reasoning-empty"
              >
                当前没有规则命中：世界模型与最近观测读数没有触发任何已注册规则。
              </div>
            ) : (
              <ul className="space-y-3">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="rounded-lg border border-border bg-card p-4"
                    data-testid={`reasoning-risk-${row.ruleId}-${row.subjectId}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-risk-degraded-foreground" />
                        <span className="font-medium text-foreground">{row.ruleLabel}</span>
                        <span className="font-mono text-xs text-muted-foreground">{row.subjectId}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" data-testid={`reasoning-severity-${row.key}`}>
                          {row.severity}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          依据 {row.evidenceCount} 条
                          {row.inferenceId ? ` · 台账 ${row.inferenceId}` : ' · 未落账（只读视图）'}
                        </span>
                        {/* NO-58b：感知门控只允许"提示"时必须显式可见（原则 5/6：建议要带约束与原因）。 */}
                        {row.advisoryOnly && (
                          <Badge variant="destructive" data-testid={`reasoning-advisory-${row.key}`}>
                            {row.advisoryLabel}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-sm text-foreground">{row.explanation}</p>
                    {row.evidenceSummary && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid={`reasoning-evidence-${row.key}`}>
                        依据：{row.evidenceSummary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="reasoning-skipped">
            <h2 className="mb-3 text-lg font-semibold text-foreground">
              未采用的观测数据（{skippedRows.length}）
            </h2>
            {skippedRows.length === 0 ? (
              <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
                没有需要说明的未采用数据：窗口内的读数都通过了新鲜度、置信度与能力声明检查。
              </div>
            ) : (
              <ul className="space-y-2">
                {skippedRows.map((row) => (
                  <li
                    key={row.key}
                    className="rounded-lg border border-border bg-card p-3 text-xs"
                    data-testid={`reasoning-skipped-${row.key}`}
                  >
                    <span className="font-mono text-foreground">{row.subject}</span>
                    <span className="ml-2 text-risk-degraded-foreground">{row.reasonLabel}</span>
                    <span className="ml-2 text-muted-foreground">{row.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {view.evidence.length > 0 && (
            <section data-testid="reasoning-thresholds">
              <h2 className="mb-3 text-lg font-semibold text-foreground">本次生效阈值</h2>
              <p className="text-xs text-muted-foreground">
                振动超标线 {view.evidence[0].threshold}
                {view.evidence[0].unit}（ISO 10816 类 II 的"不可接受"线）；读数新鲜度窗口与最低置信度
                由服务端统一口径决定，超出即不参与判定。
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
