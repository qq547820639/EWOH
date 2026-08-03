import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { createPlan, createSuggestion, type AiPlan, type AiSuggestion } from '../../api/ai';
import { getCurrentOperator } from '../../lib/auth';
import { Button } from '@client/src/components/ui/button';

const AiDecision = (): React.ReactElement => {
  const [problem, setProblem] = useState('工位积压与人员负荷建议');
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null);
  const [plan, setPlan] = useState<AiPlan | null>(null);

  const suggestionMutation = useMutation({
    mutationFn: () =>
      createSuggestion({
        triggeredBy: getCurrentOperator(),
        problem,
        snapshot: {
          version: 1,
          from: new Date(Date.now() - 3600000).toISOString(),
          to: new Date().toISOString(),
          records: 60,
        },
      }),
    onSuccess: (result) => {
      setSuggestion(result);
      setPlan(null);
    },
  });

  const planMutation = useMutation({
    mutationFn: () =>
      createPlan(suggestion!.id, {
        shift: 'A',
        note: '规则型轻量推演',
        operator: getCurrentOperator(),
      }),
    onSuccess: setPlan,
  });

  const busy = suggestionMutation.isPending || planMutation.isPending;
  const errorMessage =
    suggestionMutation.error instanceof Error
      ? suggestionMutation.error.message
      : planMutation.error instanceof Error
        ? planMutation.error.message
        : null;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">AI 决策中心</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
          A2 建议与 A3 方案仅在人工触发后生成。
        </p>
      </header>

      <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
        <label className="block text-sm font-medium text-[hsl(220_14%_14%)]" htmlFor="ai-problem">
          问题描述
        </label>
        <textarea
          id="ai-problem"
          value={problem}
          onChange={(event) => setProblem(event.target.value)}
          disabled={busy}
          className="mt-2 min-h-24 w-full rounded-lg border border-[hsl(220_14%_89%)] p-3 text-sm outline-none focus:border-[hsl(221_83%_53%)] disabled:opacity-60"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busy}
            onClick={() => suggestionMutation.mutate()}
            className="inline-flex items-center gap-2"
          >
            {suggestionMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {suggestionMutation.isPending ? '生成中...' : '生成 AI 建议'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !suggestion}
            onClick={() => planMutation.mutate()}
            className="inline-flex items-center gap-2"
          >
            {planMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {planMutation.isPending ? '推演中...' : '生成调度方案'}
          </Button>
        </div>
      </div>

      {suggestionMutation.isSuccess && !planMutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="size-4" />
          建议生成成功，可继续生成调度方案。
        </div>
      )}

      {planMutation.isSuccess && plan && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <CheckCircle2 className="size-4" />
          模拟方案 {plan.id} 已生成 · is_simulation={String(plan.isSimulation)} · status={plan.status}
        </div>
      )}

      {errorMessage && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {errorMessage}
        </div>
      )}

      {suggestion && (
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">建议结果</h2>
          <p className="mt-2 text-sm">{suggestion.suggestion}</p>
          <ul className="mt-3 space-y-1 text-sm text-[hsl(218_10%_42%)]">
            {suggestion.confirmItems.map((item, index) => (
              <li key={`${item}-${index}`}>· {item}</li>
            ))}
          </ul>
        </section>
      )}

      {plan && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="font-semibold text-emerald-800">模拟方案 {plan.id}</h2>
          <p className="mt-1 text-sm text-emerald-700">
            is_simulation={String(plan.isSimulation)} · status={plan.status}
          </p>
        </section>
      )}
    </div>
  );
};

export default AiDecision;
