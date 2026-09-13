import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BellRing, RefreshCw } from 'lucide-react';
import {
  dismissLearningSignal,
  listLearningSignals,
  promoteLearningSignal,
  scanLearningSignals,
  type LearningSignalDto,
} from '../../api/learning';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { parseError } from '../../lib/errorContract';
import {
  buildLearningSignalView,
  scanResultLabel,
  validateSignalCandidate,
} from './learningConsoleLogic';

/**
 * 运行记忆信号卡片（NO-54a 学习回路接线）。
 *
 * 页面回答四个问题：**看到什么**（实测快照 + 证据 + 时间）、**为什么**（假设/影响/风险）、
 * **可信吗**（样本量与可信度；样本不足直接写"不给结论"）、**能做什么**（可执行的给方向与基线，
 * 目标值由人填 → 生成提案；不可执行的写明理由，只能提示）。
 *
 * 边界（写死在文案里，避免被误读）：
 *  - 信号 **不是提案**：扫描只写信号台账；点"生成提案"才创建提案，且仍要过影子评估与人审；
 *  - 平台 **不替现场决定数值**：只给方向（放宽/收紧）与依据，目标阈值由人填；
 *  - 忽略 **必须给理由**：否则下次没人知道这条运行记忆为什么被作废。
 */
export function LearningSignalsCard(): React.ReactElement {
  const client = useQueryClient();
  const [windowDays, setWindowDays] = useState(30);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [candidateBySignal, setCandidateBySignal] = useState<Record<string, string>>({});
  const [reasonBySignal, setReasonBySignal] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const signalsQuery = useQuery({
    queryKey: ['learning', 'signals'],
    queryFn: () => listLearningSignals({ limit: 50 }),
    staleTime: 15_000,
  });

  const scan = useMutation({
    mutationFn: () => scanLearningSignals(windowDays),
    onSuccess: (result) => {
      setScanNote(scanResultLabel(result));
      setActionError(null);
      void client.invalidateQueries({ queryKey: ['learning', 'signals'] });
    },
    onError: (error) => setActionError(parseError(error).message),
  });

  const promote = useMutation({
    mutationFn: (input: { signalId: string; candidateValue: number; note: string }) =>
      promoteLearningSignal(input.signalId, {
        candidateValue: input.candidateValue,
        note: input.note.trim() || undefined,
      }),
    onSuccess: (result) => {
      setActionError(null);
      setCandidateBySignal((prev) => ({ ...prev, [result.signal.signalId]: '' }));
      void client.invalidateQueries({ queryKey: ['learning', 'signals'] });
      void client.invalidateQueries({ queryKey: ['learning', 'proposals'] });
    },
    onError: (error) => setActionError(parseError(error).message),
  });

  const dismiss = useMutation({
    mutationFn: (input: { signalId: string; reason: string }) =>
      dismissLearningSignal(input.signalId, input.reason.trim()),
    onSuccess: (_result, input) => {
      setActionError(null);
      setReasonBySignal((prev) => ({ ...prev, [input.signalId]: '' }));
      void client.invalidateQueries({ queryKey: ['learning', 'signals'] });
    },
    onError: (error) => setActionError(parseError(error).message),
  });

  const signals: LearningSignalDto[] = signalsQuery.data ?? [];
  const views = useMemo(
    () => signals.map((signal) => ({ signal, view: buildLearningSignalView(signal) })),
    [signals],
  );
  const openCount = views.filter((entry) => entry.view.canDecide).length;

  return (
    <section
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-labelledby="learning-signals-title"
      data-testid="learning-signals"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="learning-signals-title" className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="size-4" /> 运行记忆信号
        </h2>
        <div className="flex items-center gap-2">
          <Badge variant={openCount > 0 ? 'destructive' : 'outline'}>待处理 {openCount}</Badge>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            窗口
            <select
              className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}
              aria-label="统计窗口（天）"
            >
              {[7, 30, 90].map((days) => (
                <option key={days} value={days}>{days} 天</option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={scan.isPending}
            onClick={() => scan.mutate()}
            data-testid="learning-signals-scan"
          >
            <RefreshCw className="size-3" />扫描运行记忆
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        把提醒治理、数据质量积压、执行偏差复发的**实测事实**变成带证据的信号。
        信号≠提案：点"生成提案"才会创建提案，且仍要过影子评估与**人审**才可能生效；
        平台只给方向与依据，目标阈值由人填写。
      </p>

      {scanNote && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="learning-signals-scan-note">
          {scanNote}
        </p>
      )}
      {actionError && (
        <p className="mt-2 text-xs text-risk-blocked-foreground" role="alert" data-testid="learning-signals-error">
          {actionError}
        </p>
      )}
      {signalsQuery.isError && (
        <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert">
          信号读取失败：{parseError(signalsQuery.error).message}——这里不会显示成"没有信号"。
        </p>
      )}

      {/* 读取失败时**不**显示空态："没有信号"与"读不到信号"是两件事（原则 7）。 */}
      {!signalsQuery.isLoading && !signalsQuery.isError && views.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="learning-signals-empty">
          暂无信号（未扫描或未达门槛；"没有信号"≠"现场没问题"）
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {views.map(({ signal, view }) => {
          const candidate = candidateBySignal[signal.signalId] ?? '';
          const reason = reasonBySignal[signal.signalId] ?? '';
          const validation = validateSignalCandidate(candidate, view.actionable?.baselineValue ?? null);
          return (
            <li
              key={signal.signalId}
              className="rounded-lg border border-border p-3"
              data-testid="learning-signal-row"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={view.severityTone === 'critical' ? 'destructive' : 'outline'}>
                    {view.severity}
                  </Badge>
                  <span className="truncate text-sm font-medium">{view.kindLabel}</span>
                  <span className="truncate text-xs text-muted-foreground">{view.subjectLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={view.confidenceKnown ? 'secondary' : 'outline'}>{view.confidenceLabel}</Badge>
                  <Badge variant="outline">{view.statusLabel}</Badge>
                </div>
              </div>

              <p className="mt-1 text-xs text-muted-foreground" data-testid="learning-signal-evidence">
                {view.evidenceLabel} · 窗口 {signal.windowDays} 天
              </p>

              {view.metricLines.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="learning-signal-metrics">
                  {view.metricLines.map((line) => (
                    <li key={line.label} className="text-muted-foreground">
                      {line.label}：<span className="text-foreground">{line.value}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 space-y-0.5 text-xs">
                <p><span className="text-muted-foreground">假设：</span>{view.hypothesis}</p>
                <p><span className="text-muted-foreground">预期影响：</span>{view.expectedEffect}</p>
                <p className="text-risk-degraded-foreground"><span className="text-muted-foreground">风险：</span>{view.risk}</p>
                {view.missing.length > 0 && (
                  <p className="text-risk-degraded-foreground" data-testid="learning-signal-missing">
                    缺什么：{view.missing.join('；')}
                  </p>
                )}
              </div>

              {view.actionable ? (
                <div className="mt-2 rounded-md border border-border bg-muted p-2 text-xs" data-testid="learning-signal-actionable">
                  <p>
                    可生成提案：{view.actionable.directionLabel} · 参数 {view.actionable.ruleId}/{view.actionable.parameter}
                    （当前生效 {view.actionable.baselineValue}，来源 {view.actionable.baselineSource}）
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      placeholder="目标阈值"
                      inputMode="decimal"
                      value={candidate}
                      onChange={(event) =>
                        setCandidateBySignal((prev) => ({ ...prev, [signal.signalId]: event.target.value }))
                      }
                      aria-label={`${signal.signalId} 目标阈值`}
                    />
                    <input
                      className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      placeholder="备注（可选，写入提案/审计）"
                      value={reason}
                      onChange={(event) =>
                        setReasonBySignal((prev) => ({ ...prev, [signal.signalId]: event.target.value }))
                      }
                      aria-label={`${signal.signalId} 备注`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={!validation.ok || promote.isPending}
                      onClick={() =>
                        promote.mutate({
                          signalId: signal.signalId,
                          candidateValue: validation.value as number,
                          note: reason,
                        })
                      }
                      data-testid="learning-signal-promote"
                    >
                      生成提案
                    </Button>
                    {!validation.ok && candidate !== '' && (
                      <span className="text-risk-degraded-foreground">{validation.reason}</span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="learning-signal-not-actionable">
                  不可生成提案：{view.notActionableReason ?? '未说明理由'}
                </p>
              )}

              {view.canDecide ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="min-w-[14rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                    placeholder="忽略理由（必填：为什么这条运行记忆不处理）"
                    value={reason}
                    onChange={(event) =>
                      setReasonBySignal((prev) => ({ ...prev, [signal.signalId]: event.target.value }))
                    }
                    aria-label={`${signal.signalId} 忽略理由`}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={reason.trim() === '' || dismiss.isPending}
                    onClick={() => dismiss.mutate({ signalId: signal.signalId, reason })}
                    data-testid="learning-signal-dismiss"
                  >
                    忽略
                  </Button>
                </div>
              ) : (
                view.decisionLabel && (
                  <p className="mt-2 text-xs text-muted-foreground" data-testid="learning-signal-decision">
                    <BellRing className="mr-1 inline size-3" />
                    {view.decisionLabel}
                  </p>
                )
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default LearningSignalsCard;
