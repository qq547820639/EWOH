import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  FlaskConical,
  Play,
  Shield,
  Sparkles,
  XCircle,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  activatePolicy,
  enableShadowPolicy,
  evaluatePolicyGate,
  generateShadowPlan,
  getKpi,
  listPolicyActivations,
  listPolicyReplays,
  runPolicyReplay,
} from '@client/src/api/scheduler';
import { getCurrentOperator } from '@client/src/lib/auth';
import type {
  PolicyActivationRecord,
  PolicyGateEvaluation,
  PolicyReplayRecord,
  SchedulerKpiSnapshot,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { ScrollArea } from '@client/src/components/ui/scroll-area';

/**
 * Phase 4 / Intelligence Workspace：生产 KPI + Policy Replay/Shadow/Gate/Activation。
 * 前端只展示后端权威值（KPI 聚合、replay 记录、gate 评估、激活审计），不重算。
 */
export default function IntelligenceWorkspace() {
  // CLI-021：不再 ?? 'admin' 冒充管理员身份；未登录（anonymous）时禁用
  // 关键策略操作并显式提示登录。
  const operator = getCurrentOperator();
  const operatorLoggedIn = operator !== 'anonymous';
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<'kpi' | 'policy'>('kpi');
  const [policyVersion, setPolicyVersion] = useState<string>('');
  // CLI-023：激活理由改为收集用户输入（必填），不再硬编码审计文案。
  const [activationReason, setActivationReason] = useState('');
  const [gateResult, setGateResult] = useState<PolicyGateEvaluation | null>(null);

  const kpi = useQuery({ queryKey: ['scheduler-kpi'], queryFn: () => getKpi(true) });
  const replays = useQuery({ queryKey: ['policy-replays'], queryFn: listPolicyReplays });
  const activations = useQuery({ queryKey: ['policy-activations'], queryFn: listPolicyActivations });

  const replayMut = useMutation({
    mutationFn: (version: number) => runPolicyReplay({ candidatePolicyVersion: version }),
    onSuccess: (record) => {
      toast.success(`Replay ${record.replayId} 完成（candidate v${record.candidatePolicyVersion}）`);
      qc.invalidateQueries({ queryKey: ['policy-replays'] });
    },
    onError: (e: Error) => toast.error(`Replay 失败: ${e.message}`),
  });

  const shadowMut = useMutation({
    mutationFn: (version: number) => enableShadowPolicy(version, operator),
    onSuccess: (r) => {
      toast.success(`策略 v${r.policyVersion} 已进入 SHADOW`);
      qc.invalidateQueries({ queryKey: ['policy-versions'] });
    },
    onError: (e: Error) => toast.error(`SHADOW 失败: ${e.message}`),
  });

  const shadowPlanMut = useMutation({
    mutationFn: (version: number) => generateShadowPlan(version),
    onSuccess: (r) => {
      toast.success(`Shadow Plan 已生成（${r.shadowPlan.planId}，不可派工）`);
      qc.invalidateQueries({ queryKey: ['policy-replays'] });
    },
    onError: (e: Error) => toast.error(`Shadow Plan 失败: ${e.message}`),
  });

  const gateMut = useMutation({
    mutationFn: async (version: number) => {
      const gate = await evaluatePolicyGate(version, undefined);
      setGateResult(gate);
      return gate;
    },
    onSuccess: (g) => {
      if (g.passed) toast.success('Gate 评估通过');
      else toast.error('Gate 评估未通过（见检查项）');
    },
    onError: (e: Error) => toast.error(`Gate 评估失败: ${e.message}`),
  });

  const activateMut = useMutation({
    mutationFn: (version: number) =>
      activatePolicy(version, { operator, reason: activationReason.trim() }),
    onSuccess: (r) => {
      toast.success(`策略 v${r.policyVersion} 已激活（rollback target v${r.rollbackTarget}）`);
      setGateResult(null);
      setActivationReason('');
      qc.invalidateQueries({ queryKey: ['policy-activations'] });
    },
    onError: (e: Error) => toast.error(`激活被拒: ${e.message}`),
  });

  return (
    <div className="w-80 rounded-lg border border-white/10 bg-black/60 backdrop-blur p-3 text-white shadow-xl">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-4 w-4 text-violet-400" />
        <span className="text-xs font-semibold">Intelligence Workspace</span>
        <div className="ml-auto flex gap-1">
          {(['kpi', 'policy'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px]',
                activeTab === t ? 'bg-violet-500/30 text-violet-200' : 'text-white/50 hover:bg-card/5',
              )}
            >
              {t === 'kpi' ? 'KPI' : '策略'}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="h-72 pr-1">
        {activeTab === 'kpi' && <KpiView kpi={kpi.data} loading={kpi.isLoading} />}

        {activeTab === 'policy' && (
          <div className="space-y-2">
            {/* CLI-021：未登录显式提示（不再默认 admin 身份） */}
            {!operatorLoggedIn && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[9.5px] text-amber-300">
                当前未登录（anonymous）：SHADOW / 激活操作需登录后执行。
              </div>
            )}
            <div className="flex gap-1">
              <input
                value={policyVersion}
                onChange={(e) => setPolicyVersion(e.target.value)}
                placeholder="策略版本 (int)"
                className="w-20 rounded border border-white/15 bg-card/5 px-1.5 py-1 text-[10px]"
              />
              <Button
                size="sm"
                className="h-6 text-[10px] px-2"
                disabled={!policyVersion || replayMut.isPending}
                onClick={() => replayMut.mutate(Number(policyVersion))}
              >
                {replayMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                Replay
              </Button>
              <Button
                size="sm"
                className="h-6 text-[10px] px-2"
                disabled={!policyVersion || shadowMut.isPending || !operatorLoggedIn}
                onClick={() => shadowMut.mutate(Number(policyVersion))}
              >
                <Shield className="h-3 w-3" /> SHADOW
              </Button>
              <Button
                size="sm"
                className="h-6 text-[10px] px-2"
                disabled={!policyVersion || shadowPlanMut.isPending}
                onClick={() => shadowPlanMut.mutate(Number(policyVersion))}
              >
                <FlaskConical className="h-3 w-3" /> Shadow Plan
              </Button>
            </div>

            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2"
                disabled={!policyVersion || gateMut.isPending}
                onClick={() => gateMut.mutate(Number(policyVersion))}
              >
                <BarChart3 className="h-3 w-3" /> Gate 评估
              </Button>
              <Button
                size="sm"
                className="h-6 text-[10px] px-2 bg-emerald-600/80 hover:bg-emerald-600"
                disabled={
                  !policyVersion ||
                  activateMut.isPending ||
                  !gateResult?.passed ||
                  !operatorLoggedIn ||
                  !activationReason.trim()
                }
                onClick={() => activateMut.mutate(Number(policyVersion))}
              >
                <CheckCircle2 className="h-3 w-3" /> 激活
              </Button>
            </div>

            {/* CLI-023：激活理由输入（必填，写入激活审计） */}
            <input
              value={activationReason}
              onChange={(e) => setActivationReason(e.target.value)}
              placeholder="激活理由（必填，写入审计）"
              className="w-full rounded border border-white/15 bg-card/5 px-1.5 py-1 text-[10px]"
            />

            {gateResult && <GateResultView gate={gateResult} />}

            <div className="pt-1 text-[10px] text-white/50 uppercase tracking-wide">Replay 记录</div>
            {replays.data?.slice(0, 4).map((r) => (
              <div key={r.replayId} className="rounded border border-white/10 bg-card/5 p-1.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-white/80">{r.replayId}</span>
                  <Badge className="text-[8px] px-1 bg-violet-500/20 text-violet-300">
                    v{r.candidatePolicyVersion} vs v{r.baselinePolicyVersion}
                  </Badge>
                </div>
                <div className="text-white/45">
                  snapshot {r.snapshotVersion} · seed {r.seed} · {r.perRunResults.length} runs ·{' '}
                  {r.failures.length} failures
                </div>
              </div>
            ))}
            {replays.isLoading && <div className="text-[10px] text-white/40">加载中…</div>}

            <div className="pt-1 text-[10px] text-white/50 uppercase tracking-wide">激活审计</div>
            {activations.data?.slice(0, 4).map((a: PolicyActivationRecord) => (
              <div key={a.activationId} className="rounded border border-white/10 bg-card/5 p-1.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-white/80">v{a.policyVersion}</span>
                  <Badge
                    className={cn(
                      'text-[8px] px-1',
                      a.status === 'ACTIVATED'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-amber-500/20 text-amber-300',
                    )}
                  >
                    {a.status}
                  </Badge>
                </div>
                <div className="text-white/45">
                  {/* CLI-022：createdAt 判空，缺失显式 '—'（不假设非空） */}
                  {a.operator} · rollback→v{a.rollbackTarget} ·{' '}
                  {a.createdAt ? a.createdAt.slice(0, 19) : '—'}
                </div>
              </div>
            ))}
            {activations.isLoading && <div className="text-[10px] text-white/40">加载中…</div>}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function KpiView({ kpi, loading }: { kpi?: SchedulerKpiSnapshot | null; loading: boolean }) {
  if (loading || !kpi) {
    return <div className="text-[10px] text-white/40">{loading ? '聚合中…' : '暂无 KPI 数据'}</div>;
  }
  const pct = (v: number | null | undefined, digits = 1) =>
    v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
  const ms = (v: number | null | undefined) => (v == null ? '—' : `${(v / 1000).toFixed(1)}s`);
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-white/50 uppercase tracking-wide">Delivery</div>
      <div className="grid grid-cols-2 gap-1">
        <Metric label="按时率" value={pct(kpi.delivery.onTimeRate)} />
        <Metric label="完成率" value={pct(kpi.delivery.completionRate)} />
        <Metric label="迟到 P50" value={ms(kpi.delivery.latenessP50Ms)} />
        <Metric label="迟到 P95" value={ms(kpi.delivery.latenessP95Ms)} />
        <Metric label="平均行程" value={ms(kpi.delivery.averageTravelMs)} />
        <Metric label="平均等待" value={ms(kpi.delivery.averageWaitingMs)} />
      </div>

      <div className="text-[10px] text-white/50 uppercase tracking-wide">Stability / Solver</div>
      <div className="grid grid-cols-2 gap-1">
        <Metric label="重排数" value={String(kpi.stability.replanCount ?? '—')} />
        <Metric label="冲突率" value={pct(kpi.stability.conflictRate)} />
        <Metric label="Fallback 率" value={pct(kpi.solver.heuristicFallbackRate)} />
        <Metric label="求解延迟(均值)" value={ms((kpi.solver as { solverLatencyAvgMs?: number | null }).solverLatencyAvgMs)} />
      </div>

      <div className="text-[10px] text-white/50 uppercase tracking-wide">数据质量</div>
      <div className="grid grid-cols-3 gap-1">
        <Metric label="Stale" value={pct(kpi.dataQuality.staleResourceRate)} />
        <Metric label="未知位置" value={pct(kpi.dataQuality.unknownLocationRate)} />
        <Metric label="降级路线" value={pct(kpi.dataQuality.degradedRouteRate)} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/10 bg-card/5 px-1.5 py-1">
      <div className="text-[8px] text-white/40">{label}</div>
      <div className="text-[11px] text-white/90 font-medium">{value}</div>
    </div>
  );
}

function GateResultView({ gate }: { gate: PolicyGateEvaluation }) {
  return (
    <div className="rounded border border-white/10 bg-card/5 p-1.5 text-[10px]">
      <div className="flex items-center gap-1">
        {gate.passed ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
        ) : (
          <XCircle className="h-3 w-3 text-red-400" />
        )}
        <span className={gate.passed ? 'text-emerald-300' : 'text-red-300'}>
          {gate.passed ? 'Gate 通过' : 'Gate 未通过'}
        </span>
      </div>
      <div className="mt-1 space-y-0.5">
        {gate.checks.map((c) => (
          <div key={c.name} className="flex items-center gap-1 text-[9px]">
            <span className={c.ok ? 'text-emerald-400' : 'text-red-400'}>{c.ok ? '✓' : '✗'}</span>
            <span className="text-white/60">{c.name}</span>
            <span className="ml-auto text-white/40">
              {c.actual == null ? '—' : typeof c.actual === 'number' ? c.actual.toFixed(2) : c.actual}
              {c.threshold != null ? ` / ${c.threshold}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
