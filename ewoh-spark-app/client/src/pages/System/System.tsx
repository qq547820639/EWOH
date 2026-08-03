import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Database, FlaskConical, Plus, Search, Undo2 } from 'lucide-react';
import {
  evaluateFeatureFlags,
  listSystemConfigs,
  type FeatureFlagEvaluationResult,
  type SystemConfigRecord,
} from '../../api/system';
import {
  approveParameter,
  getParameterSummary,
  listParameters,
  registerParameter,
  retireParameter,
  rollbackParameter,
  updateParameter,
  type Parameter,
  type ParameterSummary,
} from '../../api/parameters';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

const parseParameterValue = (type: string, raw: string): unknown => {
  if (type === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  if (type === 'integer') {
    const value = Number(raw);
    return Number.isInteger(value) ? value : raw;
  }
  if (type === 'boolean') {
    return raw === 'true';
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
};

const System = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [flagKeys, setFlagKeys] = useState('');
  const [flagRing, setFlagRing] = useState('');
  const [flagFactory, setFlagFactory] = useState('');
  const [flagRoles, setFlagRoles] = useState('');
  const [evaluation, setEvaluation] = useState<FeatureFlagEvaluationResult[]>([]);
  const [paramKey, setParamKey] = useState('');
  const [paramName, setParamName] = useState('');
  const [paramType, setParamType] = useState('string');
  const [paramValue, setParamValue] = useState('');
  const [paramApproval, setParamApproval] = useState(false);
  const [paramUpdateValues, setParamUpdateValues] = useState<Record<string, string>>({});
  const query = useQuery<SystemConfigRecord[]>({
    queryKey: queryKeys.systemConfigs,
    queryFn: listSystemConfigs,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const parametersQuery = useQuery<Parameter[]>({
    queryKey: queryKeys.parameters,
    queryFn: listParameters,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const parameterSummaryQuery = useQuery<ParameterSummary>({
    queryKey: queryKeys.parameterSummary,
    queryFn: getParameterSummary,
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

  const invalidateParameters = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.parameters });
    queryClient.invalidateQueries({ queryKey: queryKeys.parameterSummary });
  };

  const addParameter = useMutation({
    mutationFn: () =>
      registerParameter({
        key: paramKey.trim(),
        name: paramName.trim(),
        dataType: paramType as Parameter['dataType'],
        current: parseParameterValue(paramType, paramValue),
        approvalRequired: paramApproval,
      }),
    onSuccess: () => {
      invalidateParameters();
      setParamKey('');
      setParamName('');
      setParamValue('');
      setParamApproval(false);
    },
  });

  const changeParameter = useMutation({
    mutationFn: (vars: { key: string; value: string; type: string }) =>
      updateParameter(vars.key, {
        current: parseParameterValue(vars.type, vars.value),
        note: 'system registry update',
      }),
    onSuccess: () => {
      invalidateParameters();
      setParamUpdateValues({});
    },
  });

  const approveParam = useMutation({
    mutationFn: approveParameter,
    onSuccess: invalidateParameters,
  });
  const rollbackParam = useMutation({
    mutationFn: rollbackParameter,
    onSuccess: invalidateParameters,
  });
  const retireParam = useMutation({
    mutationFn: retireParameter,
    onSuccess: invalidateParameters,
  });

  const rows = query.data ?? [];
  const parameters = parametersQuery.data ?? [];
  const parameterSummary = parameterSummaryQuery.data;

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

      <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[hsl(220_14%_14%)]">
            <Database className="h-4 w-4 text-[hsl(221_83%_53%)]" />
            参数注册中心
          </h2>
          <div className="flex flex-wrap gap-2 text-xs text-[hsl(218_10%_42%)]">
            <span className="rounded-md bg-[hsl(220_14%_96%)] px-2 py-1">
              总数 {parameterSummary?.totalCount ?? 0}
            </span>
            <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-700">
              待审批 {parameterSummary?.pendingApprovalCount ?? 0}
            </span>
            <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">
              已过期 {parameterSummary?.expiredCount ?? 0}
            </span>
          </div>
        </div>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
          onSubmit={(event) => {
            event.preventDefault();
            addParameter.mutate();
          }}
        >
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            参数键
            <input
              value={paramKey}
              onChange={(event) => setParamKey(event.target.value)}
              placeholder="oee.availability.target"
              className="h-9 min-w-0 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            名称
            <input
              value={paramName}
              onChange={(event) => setParamName(event.target.value)}
              className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            类型
            <select
              value={paramType}
              onChange={(event) => setParamType(event.target.value)}
              className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm"
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="integer">integer</option>
              <option value="boolean">boolean</option>
              <option value="json">json</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
            当前值
            <input
              value={paramValue}
              onChange={(event) => setParamValue(event.target.value)}
              className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs font-medium text-[hsl(218_10%_42%)]">
            <input
              type="checkbox"
              checked={paramApproval}
              onChange={(event) => setParamApproval(event.target.checked)}
              className="h-4 w-4 accent-[hsl(221_83%_53%)]"
            />
            需要审批
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={addParameter.isPending || !paramKey.trim() || !paramName.trim()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-800 px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              登记
            </button>
          </div>
        </form>
        <div className="mt-4">
          <QueryState
            isLoading={parametersQuery.isLoading}
            isFetching={parametersQuery.isFetching}
            isError={parametersQuery.isError}
            isEmpty={parameters.length === 0}
            onRefresh={() => parametersQuery.refetch()}
            errorMessage="参数加载失败"
            emptyMessage="暂无参数"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">参数</th>
                    <th className="px-3 py-2 font-medium">类型</th>
                    <th className="px-3 py-2 font-medium">当前值</th>
                    <th className="px-3 py-2 font-medium">版本</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {parameters.map((parameter) => {
                    const currentText =
                      parameter.current &&
                      typeof parameter.current === 'object'
                        ? JSON.stringify(parameter.current)
                        : String(parameter.current ?? '');
                    const updateValue =
                      paramUpdateValues[parameter.key] ?? currentText;
                    return (
                      <tr
                        key={parameter.key}
                        className="border-b border-[hsl(220_14%_96%)] last:border-0"
                      >
                        <td className="px-3 py-2">
                          <p className="font-medium text-[hsl(220_14%_14%)]">
                            {parameter.name}
                          </p>
                          <p className="break-all font-mono text-xs text-[hsl(218_10%_42%)]">
                            {parameter.key}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-xs">{parameter.dataType}</td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1.5">
                            <input
                              value={updateValue}
                              onChange={(event) =>
                                setParamUpdateValues((current) => ({
                                  ...current,
                                  [parameter.key]: event.target.value,
                                }))
                              }
                              className="h-8 min-w-0 w-32 rounded-md border border-[hsl(220_14%_89%)] px-2 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                changeParameter.mutate({
                                  key: parameter.key,
                                  value: updateValue,
                                  type: parameter.dataType,
                                })
                              }
                              className="inline-flex h-8 shrink-0 items-center rounded-md bg-slate-800 px-2 text-xs font-medium text-white"
                            >
                              更新
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2">v{parameter.version}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-1 text-xs ${
                              parameter.status === 'active'
                                ? 'bg-emerald-50 text-emerald-700'
                                : parameter.status === 'pending'
                                  ? 'bg-amber-50 text-amber-700'
                                  : parameter.status === 'retired'
                                    ? 'bg-slate-100 text-slate-500'
                                    : 'bg-blue-50 text-blue-700'
                            }`}
                          >
                            {parameter.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {parameter.status === 'pending' && (
                              <button
                                type="button"
                                onClick={() => approveParam.mutate(parameter.key)}
                                className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-2 text-xs font-medium text-white"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                审批
                              </button>
                            )}
                            {parameter.history.length > 0 && (
                              <button
                                type="button"
                                onClick={() => rollbackParam.mutate(parameter.key)}
                                className="inline-flex h-8 items-center gap-1 rounded-md bg-slate-800 px-2 text-xs font-medium text-white"
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                                回滚
                              </button>
                            )}
                            {parameter.status !== 'retired' && (
                              <button
                                type="button"
                                onClick={() => retireParam.mutate(parameter.key)}
                                className="inline-flex h-8 items-center gap-1 rounded-md bg-red-600 px-2 text-xs font-medium text-white"
                              >
                                <Ban className="h-3.5 w-3.5" />
                                停用
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
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
