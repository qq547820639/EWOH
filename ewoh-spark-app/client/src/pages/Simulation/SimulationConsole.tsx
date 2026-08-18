// SimulationConsole.tsx — 仿真运行控制台（R-57 / ADR-036，§10 Level 6 生产消费面）。
//
// L6 仿真决策支持面：操作员在控制台触发四类确定性评估（what_if/capacity/
// layout/material_flow），结果落 ewoh_simulation_run 权威台账（契约 + 事件 +
// §13 三层隔离），列表/详情消费同一台账。
// 原则：预检只做 UX 提示（服务端 validateSimulationRun + 评估器权威 fail-closed）；
// 失败显式呈现 failureReason + 可重试（新 runId）；无数据显式空态；不伪造结果。
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { runSimulation, listSimulationRuns, type SimulationRun } from '../../api/simulation';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import {
  SIMULATION_KIND_LABELS,
  SIMULATION_PARAMETER_EXAMPLES,
  SIMULATION_STATUS_LABELS,
  TONE_BORDER,
  TONE_TEXT,
  buildResultSummary,
  buildRunListRows,
  parseParametersJson,
  validateSimulationParameters,
  type ConsoleTone,
} from './simulationConsoleLogic';
import { SimulationRunList } from './SimulationRunList';

const KIND_ORDER = ['what_if', 'capacity', 'layout', 'material_flow'] as const;


function ResultPanel({ run }: { run: SimulationRun }): React.ReactElement {
  const summary = run.results ? buildResultSummary(run.kind, run.results) : [];
  return (
    <div className="mt-4 rounded-lg border border-border bg-muted p-4" data-testid="simulation-result">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{run.runId}</span>
        <span className={cn('text-xs', TONE_TEXT[run.status === 'failed' ? 'negative' : run.status === 'completed' ? 'positive' : 'neutral'])}>
          {SIMULATION_STATUS_LABELS[run.status] ?? run.status}
        </span>
        <span className="text-xs text-muted-foreground">引擎 {run.engineVersion}</span>
      </div>
      {run.status === 'failed' && run.failureReason && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-risk-blocked/30 bg-risk-blocked/10 p-2 text-sm text-risk-blocked">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span data-testid="simulation-failure-reason">{run.failureReason}</span>
        </div>
      )}
      {summary.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          {summary.map((row) => (
            <div key={row.label} className="text-sm">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className={cn('font-medium tabular-nums', TONE_TEXT[row.tone])}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-2 text-xs text-muted-foreground">
        基准快照 v{typeof run.baseRef?.snapshotVersion === 'number' ? run.baseRef.snapshotVersion : '—'}
        {typeof run.baseRef?.scenarioId === 'string' && run.baseRef.scenarioId !== '' ? ` · 场景 ${run.baseRef.scenarioId}` : ''}
        {' · '}isSimulation={String(run.isSimulation)}
      </div>
    </div>
  );
}

const SimulationConsole = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<string>('what_if');
  const [snapshotVersion, setSnapshotVersion] = useState('0');
  const [scenarioId, setScenarioId] = useState('');
  const [parametersText, setParametersText] = useState(SIMULATION_PARAMETER_EXAMPLES.what_if);
  const [precheckErrors, setPrecheckErrors] = useState<string[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SimulationRun | null>(null);

  const runsQuery = useQuery({
    queryKey: queryKeys.simulationRuns({}),
    queryFn: () => listSimulationRuns({}),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const runMutation = useMutation({
    mutationFn: () => {
      const parsed = parseParametersJson(parametersText);
      if (parsed.errors.length > 0) {
        throw new Error(`参数错误：${parsed.errors.join('；')}`);
      }
      const validation = validateSimulationParameters(kind, parsed.parameters);
      if (validation.length > 0) {
        throw new Error(`参数预检未通过：${validation.join('；')}`);
      }
      const snapshotNumber = Number(snapshotVersion);
      // CLI-223：空字符串显式拒绝（Number('')===0 会静默通过整数校验）。
      if (
        snapshotVersion.trim() === '' ||
        !Number.isInteger(snapshotNumber) ||
        snapshotNumber < 0
      ) {
        throw new Error('快照版本必须是非负整数（不能为空）');
      }
      return runSimulation({
        kind,
        baseRef: {
          snapshotVersion: snapshotNumber,
          scenarioId: scenarioId.trim() !== '' ? scenarioId.trim() : undefined,
        },
        parameters: parsed.parameters as Record<string, unknown>,
      });
    },
    onSuccess: (response) => {
      setPrecheckErrors([]);
      setLastResult(response.run);
      setSelectedRunId(response.run.runId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.simulationRuns({}) });
    },
    onError: (error) => {
      setPrecheckErrors(error instanceof Error ? [error.message] : ['运行失败']);
      setLastResult(null);
    },
  });

  const onKindChange = (nextKind: string) => {
    setKind(nextKind);
    setParametersText(SIMULATION_PARAMETER_EXAMPLES[nextKind] ?? '{}');
    setPrecheckErrors([]);
  };

  const rows = buildRunListRows(runsQuery.data);
  const selectedRun =
    runsQuery.data?.find((run) => run.runId === selectedRunId) ?? null;
  const runError = runMutation.isError || runsQuery.isError;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">仿真推演</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          L6 确定性仿真（What-if / 产能 / 布局 / 物料流）：结果落权威台账并显式标记
          isSimulation，绝不写生产世界状态（ADR-025 / §13）。
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        {/* 运行面板 */}
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="flex items-center gap-1.5 font-semibold text-foreground">
            <FlaskConical className="size-4" /> 新建仿真运行
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-foreground">评估类型</span>
              <select
                value={kind}
                onChange={(event) => onKindChange(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-sm outline-none focus:border-primary"
                aria-label="评估类型"
              >
                {KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {SIMULATION_KIND_LABELS[k] ?? k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">基准快照版本</span>
              <input
                type="number"
                min={0}
                step={1}
                value={snapshotVersion}
                onChange={(event) => setSnapshotVersion(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border p-2 text-sm outline-none focus:border-primary"
                aria-label="基准快照版本"
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="font-medium text-foreground">场景标识（可选）</span>
              <input
                type="text"
                value={scenarioId}
                onChange={(event) => setScenarioId(event.target.value)}
                placeholder="如 shift-b-what-if"
                className="mt-1 w-full rounded-lg border border-border p-2 text-sm outline-none focus:border-primary"
                aria-label="场景标识"
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="font-medium text-foreground">评估参数（JSON，示例可改写）</span>
              <textarea
                value={parametersText}
                onChange={(event) => setParametersText(event.target.value)}
                disabled={runMutation.isPending}
                className="mt-1 min-h-40 w-full rounded-lg border border-border p-3 font-mono text-xs outline-none focus:border-primary disabled:opacity-60"
                aria-label="评估参数"
              />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
              {runMutation.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              运行评估
            </Button>
            {runMutation.isSuccess && lastResult?.status === 'completed' && (
              <span className="flex items-center gap-1 text-sm text-risk-normal">
                <CheckCircle2 className="size-4" /> 评估完成
              </span>
            )}
          </div>
          {precheckErrors.length > 0 && (
            <ul className="mt-3 space-y-1 rounded border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked" data-testid="simulation-precheck-errors">
              {precheckErrors.map((message) => (
                <li key={message} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  {message}
                </li>
              ))}
            </ul>
          )}
          {lastResult && <ResultPanel run={lastResult} />}
        </section>

        {/* 运行台账 */}
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-semibold text-foreground">运行台账（本租户）</h2>
          {runsQuery.isLoading && (
            <p className="mt-3 text-sm text-muted-foreground">台账加载中…</p>
          )}
          {runsQuery.isError && (
            <div className="mt-3 rounded border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked">
              台账加载失败
              <button
                type="button"
                onClick={() => runsQuery.refetch()}
                className="ml-2 underline underline-offset-2"
              >
                重试
              </button>
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && rows.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">暂无仿真运行记录</p>
          )}
          <SimulationRunList
            rows={rows}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
          {selectedRun && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-foreground">运行详情</h3>
              <ResultPanel run={selectedRun} />
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">查看原始参数</summary>
                <pre className="mt-1 overflow-auto rounded bg-muted p-2 font-mono">
                  {JSON.stringify(selectedRun.parameters ?? {}, null, 2)}
                </pre>
              </details>
            </div>
          )}
          {runError && !runMutation.isError && (
            <p className="mt-3 text-sm text-risk-blocked">部分数据加载失败，请重试。</p>
          )}
        </section>
      </div>
    </div>
  );
};

export default SimulationConsole;
