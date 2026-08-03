import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FlaskConical, Search } from 'lucide-react';
import {
  evaluateFeatureFlags,
  listSystemConfigs,
  type FeatureFlagEvaluationResult,
  type SystemConfigRecord,
} from '../../api/system';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

const System = (): React.ReactElement => {
  const [flagKeys, setFlagKeys] = useState('');
  const [flagRing, setFlagRing] = useState('');
  const [flagFactory, setFlagFactory] = useState('');
  const [flagRoles, setFlagRoles] = useState('');
  const [evaluation, setEvaluation] = useState<FeatureFlagEvaluationResult[]>([]);
  const query = useQuery<SystemConfigRecord[]>({
    queryKey: queryKeys.systemConfigs,
    queryFn: listSystemConfigs,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const evaluate = useMutation({
    mutationFn: () =>
      evaluateFeatureFlags(
        flagKeys
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
        {
          factoryId: flagFactory.trim() || undefined,
          upgradeRing: flagRing.trim() || undefined,
          roles: flagRoles
            .split(',')
            .map((role) => role.trim())
            .filter(Boolean),
        },
      ),
    onSuccess: setEvaluation,
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">系统管理</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">组织化配置与敏感值脱敏展示。</p>
      </header>

      <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[hsl(220_14%_14%)]">
          <FlaskConical className="h-4 w-4 text-[hsl(221_83%_53%)]" />
          功能开关评估
        </h2>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            evaluate.mutate();
          }}
        >
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            开关键（逗号分隔）
            <input
              value={flagKeys}
              onChange={(event) => setFlagKeys(event.target.value)}
              placeholder="feature.scale.canary"
              className="h-9 min-w-0 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            升级环
            <select
              value={flagRing}
              onChange={(event) => setFlagRing(event.target.value)}
              className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm"
            >
              <option value="">默认</option>
              <option value="dev">dev</option>
              <option value="integration">integration</option>
              <option value="shadow">shadow</option>
              <option value="pilot">pilot</option>
              <option value="small">small</option>
              <option value="full">full</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            工厂 ID
            <input
              value={flagFactory}
              onChange={(event) => setFlagFactory(event.target.value)}
              className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            角色（逗号分隔）
            <input
              value={flagRoles}
              onChange={(event) => setFlagRoles(event.target.value)}
              placeholder="dispatcher,workshop_lead"
              className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={evaluate.isPending || !flagKeys.trim()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-800 px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              评估
            </button>
          </div>
        </form>
        {evaluation.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                <tr>
                  <th className="px-3 py-2 font-medium">开关</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">原因</th>
                  <th className="px-3 py-2 font-medium">定位</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.map((result) => (
                  <tr key={result.key} className="border-b border-[hsl(220_14%_96%)] last:border-0">
                    <td className="break-all px-3 py-2 font-mono text-xs">{result.key}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${
                          result.enabled
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {result.enabled ? '开启' : '关闭'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">{result.reason}</td>
                    <td className="px-3 py-2 text-xs">
                      {result.targetingApplied ? '已应用' : '默认'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || rows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载系统配置"
        emptyMessage="暂无系统配置。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="break-all font-mono text-sm font-medium">{row.configKey}</span>
                <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">
                  {row.updatedAt
                    ? new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false })
                    : '—'}
                </span>
              </div>
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[hsl(220_14%_96%)] p-3 text-xs">
                {JSON.stringify(row.configValue, null, 2)}
              </pre>
              <p className="mt-2 text-xs text-[hsl(218_10%_42%)]">更新人：{row.updatedBy ?? '—'}</p>
            </div>
          ))}
        </div>
      </QueryState>
    </div>
  );
};

export default System;
