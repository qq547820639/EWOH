import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUpCircle, Boxes, Factory, GitCompareArrows, Layers3, ListChecks, PackageSearch, Play, RotateCcw, Workflow } from 'lucide-react';
import {
  advanceWorkflowInstance,
  fleetRollback,
  fleetUpgrade,
  generateSupportBundle,
  getFleetStatus,
  getWorkflowExample,
  installScenarioPack,
  listFactoryDifferences,
  listWorkflowInstances,
  getScaleCompatibility,
  listScaleAssets,
  listScaleProfiles,
  listScaleTemplates,
  registerFactoryDifference,
  resolveFactoryDifference,
  runScaleOnboarding,
  startWorkflowInstance,
  uninstallScenarioPack,
  type FactoryDifference,
  type FleetRollbackResult,
  type FleetUpgradeResult,
  type OnboardingRunResult,
  type SupportBundleResult,
  type WorkflowInstance,
} from '../../api/scale';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import { parseWorkflowRoles, workflowRolesReady } from './workflowRoles';

interface ScaleData {
  templates: Awaited<ReturnType<typeof listScaleTemplates>>;
  profiles: Awaited<ReturnType<typeof listScaleProfiles>>;
  assets: Awaited<ReturnType<typeof listScaleAssets>>;
  compatibility: Awaited<ReturnType<typeof getScaleCompatibility>>;
}

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';

const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const Scale = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [factoryName, setFactoryName] = useState('');
  const [lastRun, setLastRun] = useState<OnboardingRunResult | null>(null);
  const [diffFactoryName, setDiffFactoryName] = useState('');
  const [diffKey, setDiffKey] = useState('');
  const [diffCategory, setDiffCategory] = useState('general');
  const [diffValue, setDiffValue] = useState('true');
  const [supportBundle, setSupportBundle] = useState<SupportBundleResult | null>(
    null,
  );
  const [fleetPackageId, setFleetPackageId] = useState('');
  const [fleetRing, setFleetRing] = useState('');
  const [fleetResult, setFleetResult] = useState<
    FleetUpgradeResult | FleetRollbackResult | null
  >(null);
  const [workflowEntityId, setWorkflowEntityId] = useState('');
  // R2-CP2-006：角色默认空串（原硬编码 'dispatcher' 预填会以伪造角色推进工作流，
  // 参照 CLI-201 修复模式）；提交前经 workflowRolesReady 显式校验非空。
  const [workflowRoles, setWorkflowRoles] = useState('');

  const query = useQuery<ScaleData>({
    queryKey: queryKeys.scaleDashboard,
    queryFn: async () => {
      const [templates, profiles, assets, compatibility] = await Promise.all([
        listScaleTemplates(),
        listScaleProfiles(),
        listScaleAssets(),
        getScaleCompatibility(),
      ]);
      return { templates, profiles, assets, compatibility };
    },
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const onboarding = useMutation({
    mutationFn: () => runScaleOnboarding(factoryName.trim()),
    onSuccess: (result) => {
      setLastRun(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleTemplates });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleProfiles });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleAssets });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleCompatibility });
      setFactoryName('');
    },
    // CLI-209：失败 toast 透传 err.message。
    onError: (err) => {
      toast.error('工厂 onboarding 失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const differencesQuery = useQuery<FactoryDifference[]>({
    queryKey: queryKeys.scaleDifferences,
    queryFn: listFactoryDifferences,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const registerDiff = useMutation({
    mutationFn: () =>
      registerFactoryDifference({
        factoryName: diffFactoryName.trim(),
        key: diffKey.trim(),
        category: diffCategory.trim() || 'general',
        value: parseJsonValue(diffValue),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleDifferences });
      setDiffFactoryName('');
      setDiffKey('');
      setDiffCategory('general');
      setDiffValue('true');
    },
    onError: (err) => {
      toast.error('差异登记失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const resolveDiff = useMutation({
    mutationFn: resolveFactoryDifference,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleDifferences });
    },
    onError: (err) => {
      toast.error('差异解决失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const bundleMutation = useMutation({
    mutationFn: generateSupportBundle,
    onSuccess: setSupportBundle,
  });

  const fleetQuery = useQuery({
    queryKey: queryKeys.scaleFleetStatus,
    queryFn: getFleetStatus,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const upgradeFleet = useMutation({
    mutationFn: () => fleetUpgrade(fleetPackageId.trim(), fleetRing || undefined),
    onSuccess: (result) => {
      setFleetResult(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleFleetStatus });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleDashboard });
      setFleetPackageId('');
    },
    onError: (err) => {
      toast.error('Fleet 升级失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const rollbackFleet = useMutation({
    mutationFn: () => fleetRollback(fleetRing || undefined),
    onSuccess: (result) => {
      setFleetResult(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleFleetStatus });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleDashboard });
    },
    onError: (err) => {
      toast.error('Fleet 回滚失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const workflowExampleQuery = useQuery({
    queryKey: ['workflow-example'],
    queryFn: getWorkflowExample,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const workflowInstancesQuery = useQuery<WorkflowInstance[]>({
    queryKey: queryKeys.workflowInstances,
    queryFn: listWorkflowInstances,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const startWorkflow = useMutation({
    mutationFn: () => {
      if (!workflowExampleQuery.data) {
        throw new Error('workflow example is not loaded');
      }
      return startWorkflowInstance(
        workflowExampleQuery.data,
        workflowEntityId.trim(),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowInstances });
      setWorkflowEntityId('');
    },
    onError: (err) => {
      toast.error('工作流启动失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const advanceWorkflow = useMutation({
    mutationFn: (key: string) =>
      advanceWorkflowInstance(
        key,
        workflowRoles
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowInstances });
    },
    onError: (err) => {
      toast.error('工作流推进失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const installScenario = useMutation({
    mutationFn: installScenarioPack,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleDashboard });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleAssets });
    },
    onError: (err) => {
      toast.error('场景包安装失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const uninstallScenario = useMutation({
    mutationFn: uninstallScenarioPack,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleDashboard });
      queryClient.invalidateQueries({ queryKey: queryKeys.scaleAssets });
    },
    onError: (err) => {
      toast.error('场景包卸载失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const data = query.data;
  const templates = data?.templates ?? [];
  const profiles = data?.profiles ?? [];
  const assets = data?.assets ?? [];
  const compatibility = data?.compatibility;
  const differences = differencesQuery.data ?? [];
  const fleetStatus = fleetQuery.data;
  const workflowInstances = workflowInstancesQuery.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">规模化运营</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            工厂模板、Profile、资产包与兼容目录。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <GitCompareArrows className="h-4 w-4 text-emerald-600" />
          核心版本：{compatibility?.coreVersion ?? '—'}
        </div>
        <button
          type="button"
          disabled={bundleMutation.isPending}
          onClick={() => bundleMutation.mutate()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <PackageSearch className="h-4 w-4" />
          {bundleMutation.isPending ? '生成中' : '生成诊断包'}
        </button>
      </header>

      {supportBundle && (
        <div className="rounded-lg border border-border bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          诊断包 {supportBundle.bundleId} 已生成，工厂数{' '}
          {supportBundle.factoryCount}，包含敏感信息：
          {supportBundle.includesSecrets ? '是' : '否'}
        </div>
      )}
      {bundleMutation.isError && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {bundleMutation.error instanceof Error
            ? bundleMutation.error.message
            : '诊断包生成失败'}
        </div>
      )}

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!data}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载规模化运营数据"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                <Factory className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">工厂模板</p>
                <p className="mt-1 text-3xl font-semibold">{templates.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50">
                <Layers3 className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">工厂 Profile</p>
                <p className="mt-1 text-3xl font-semibold">{profiles.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50">
                <Boxes className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">资产包</p>
                <p className="mt-1 text-3xl font-semibold">{assets.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-50">
                <GitCompareArrows className="h-5 w-5 text-violet-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">兼容资产</p>
                <p className="mt-1 text-3xl font-semibold">
                  {compatibility?.compatibleCount ?? 0}
                  <span className="text-sm font-normal text-muted-foreground">
                    {' '}
                    / {compatibility?.incompatibleCount ?? 0} 不兼容
                  </span>
                </p>
              </div>
            </div>
          </div>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
              <Play className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-foreground">工厂上线运行</h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <input
                  value={factoryName}
                  onChange={(event) => setFactoryName(event.target.value)}
                  placeholder="输入新工厂名称"
                  className="h-9 w-56 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  disabled={!factoryName.trim() || onboarding.isPending}
                  onClick={() => onboarding.mutate()}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
                >
                  <Play className="h-4 w-4" />
                  {onboarding.isPending ? '运行中' : '执行 F0-F6'}
                </button>
              </div>
            </div>
            {onboarding.isError && (
              <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
                {onboarding.error instanceof Error
                  ? onboarding.error.message
                  : '上线运行失败'}
              </div>
            )}
            {lastRun && (
              <div className="border-b border-border px-5 py-4">
                <p className="text-sm">
                  运行 {lastRun.runId}：{' '}
                  <span
                    className={
                      lastRun.overall === 'passed'
                        ? 'font-medium text-emerald-600'
                        : 'font-medium text-red-600'
                    }
                  >
                    {lastRun.overall}
                  </span>
                  <span className="ml-3 text-xs text-muted-foreground">
                    Profile {lastRun.profileId}
                  </span>
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {lastRun.steps.map((step) => (
                    <span
                      key={step.code}
                      className={`rounded-md px-2 py-1 text-xs font-medium ${
                        step.passed
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {step.code} {step.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {templates.length === 0 && assets.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">暂无规模化资产。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">资产</th>
                      <th className="px-5 py-3 font-medium">类型</th>
                      <th className="px-5 py-3 font-medium">版本</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">兼容</th>
                      <th className="px-5 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {assets.map((asset) => {
                      const row = compatibility?.assets.find(
                        (item) => item.packageId === asset.packageId,
                      );
                      return (
                        <tr key={asset.packageId} className="hover:bg-muted">
                          <td className="px-5 py-3">
                            <div className="font-medium text-foreground">
                              {asset.name}
                            </div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {asset.packageId}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-muted-foreground">
                            {asset.packageType}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs">{asset.version}</td>
                          <td className="px-5 py-3">{asset.status ?? '—'}</td>
                          <td className="px-5 py-3">
                            {row ? (
                              <span
                                className={`rounded-md px-2 py-1 text-xs font-medium ${
                                  row.compatible
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : 'bg-red-50 text-red-700'
                                }`}
                              >
                                {row.reason}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-5 py-3">
                            {asset.packageType === 'scenario' && (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={
                                    asset.status === 'installed' ||
                                    installScenario.isPending
                                  }
                                  onClick={() =>
                                    installScenario.mutate(asset.packageId)
                                  }
                                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                                >
                                  安装
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    asset.status !== 'installed' ||
                                    uninstallScenario.isPending
                                  }
                                  onClick={() =>
                                    uninstallScenario.mutate(asset.packageId)
                                  }
                                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
                                >
                                  卸载
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <Workflow className="h-4 w-4 text-sky-600" />
              <h2 className="font-semibold text-foreground">Workflow 实例</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                {workflowExampleQuery.data?.workflowId ?? '未加载示例'} ·{' '}
                {workflowInstances.length} 个实例
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-4">
              <input
                value={workflowEntityId}
                onChange={(event) => setWorkflowEntityId(event.target.value)}
                placeholder="实体 ID"
                className="h-9 w-52 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <input
                value={workflowRoles}
                onChange={(event) => setWorkflowRoles(event.target.value)}
                placeholder="角色（逗号分隔）"
                className="h-9 w-56 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <button
                type="button"
                disabled={
                  !workflowEntityId.trim() ||
                  !workflowExampleQuery.data ||
                  startWorkflow.isPending
                }
                onClick={() => startWorkflow.mutate()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-medium text-white disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                启动实例
              </button>
            </div>
            {startWorkflow.isError && (
              <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
                {startWorkflow.error instanceof Error
                  ? startWorkflow.error.message
                  : '启动失败'}
              </div>
            )}
            {workflowInstances.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">暂无 Workflow 实例。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">实例键</th>
                      <th className="px-5 py-3 font-medium">实体</th>
                      <th className="px-5 py-3 font-medium">当前步骤</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">更新时间</th>
                      <th className="px-5 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {workflowInstances.map((instance) => (
                      <tr key={instance.key} className="hover:bg-muted">
                        <td className="px-5 py-3 font-mono text-xs">{instance.key}</td>
                        <td className="px-5 py-3">{instance.entityId}</td>
                        <td className="px-5 py-3 font-medium">{instance.currentStep}</td>
                        <td className="px-5 py-3">{instance.status}</td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">
                          {formatTime(instance.updatedAt)}
                        </td>
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            disabled={
                              instance.status !== 'active' ||
                              advanceWorkflow.isPending ||
                              // R2-CP2-006：角色未显式填写时禁止推进（不以空/伪造角色提交）。
                              !workflowRolesReady(workflowRoles)
                            }
                            onClick={() => advanceWorkflow.mutate(instance.key)}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
                          >
                            推进
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <ArrowUpCircle className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-foreground">Fleet 升级环</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                工厂 {fleetStatus?.factoryCount ?? 0} · 环分布{' '}
                {Object.entries(fleetStatus?.ringCounts ?? {})
                  .map(([ring, count]) => `${ring}:${count}`)
                  .join(' / ')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-4">
              <input
                value={fleetPackageId}
                onChange={(event) => setFleetPackageId(event.target.value)}
                placeholder="资产包 ID"
                className="h-9 w-56 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <select
                value={fleetRing}
                onChange={(event) => setFleetRing(event.target.value)}
                className="h-9 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              >
                <option value="">全部环</option>
                {/* CLI-208：升级环选项由后端 fleetStatus.ringCounts 派生
                    （原前端硬编码 6 环，与后端实际环集合漂移）。 */}
                {Object.keys(fleetStatus?.ringCounts ?? {}).map(
                  (ring) => (
                    <option key={ring} value={ring}>
                      {ring}
                    </option>
                  ),
                )}
              </select>
              <button
                type="button"
                disabled={!fleetPackageId.trim() || upgradeFleet.isPending}
                onClick={() => upgradeFleet.mutate()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-50"
              >
                <ArrowUpCircle className="h-4 w-4" />
                升级
              </button>
              <button
                type="button"
                disabled={rollbackFleet.isPending}
                onClick={() => rollbackFleet.mutate()}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-foreground disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                回滚
              </button>
            </div>
            {(upgradeFleet.isError || rollbackFleet.isError) && (
              <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
                {(upgradeFleet.error ?? rollbackFleet.error) instanceof Error
                  ? (upgradeFleet.error ?? rollbackFleet.error)?.message
                  : 'Fleet 操作失败'}
              </div>
            )}
            {fleetResult && (
              <div className="border-b border-border px-5 py-3 text-sm text-foreground">
                {fleetResult && 'updatedProfiles' in fleetResult
                  ? `升级 ${fleetResult.targetRing}：更新 ${fleetResult.updatedProfiles}，跳过 ${fleetResult.skippedProfiles}`
                  : fleetResult && 'rolledBackProfiles' in fleetResult
                    ? `回滚 ${fleetResult.targetRing}：回滚 ${fleetResult.rolledBackProfiles}，跳过 ${fleetResult.skippedProfiles}`
                    : ''}
              </div>
            )}
            {fleetStatus && fleetStatus.profiles.length > 0 && (
              <div className="flex flex-wrap gap-2 px-5 py-4">
                {fleetStatus.profiles.map((profile) => (
                  <span
                    key={profile.profileId}
                    className="rounded-md bg-muted px-3 py-1.5 text-xs text-foreground"
                  >
                    {profile.factoryName} · {profile.upgradeRing} · {profile.status}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <Layers3 className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-foreground">工厂 Profile</h2>
            </div>
            {profiles.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">暂无工厂 Profile。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">工厂</th>
                      <th className="px-5 py-3 font-medium">模板</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">安装时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {profiles.map((profile) => (
                      <tr key={profile.profileId} className="hover:bg-muted">
                        <td className="px-5 py-3">
                          <div className="font-medium text-foreground">
                            {profile.factoryName}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {profile.profileId}
                          </div>
                        </td>
                        <td className="px-5 py-3 font-mono text-xs">
                          {profile.templateId}
                        </td>
                        <td className="px-5 py-3">{profile.status}</td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">
                          {formatTime(profile.installedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <ListChecks className="h-4 w-4 text-violet-600" />
              <h2 className="font-semibold text-foreground">工厂差异</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-4">
              <input
                value={diffFactoryName}
                onChange={(event) => setDiffFactoryName(event.target.value)}
                placeholder="工厂名称"
                className="h-9 w-44 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <input
                value={diffKey}
                onChange={(event) => setDiffKey(event.target.value)}
                placeholder="差异键"
                className="h-9 w-44 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <input
                value={diffCategory}
                onChange={(event) => setDiffCategory(event.target.value)}
                placeholder="分类"
                className="h-9 w-36 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <input
                value={diffValue}
                onChange={(event) => setDiffValue(event.target.value)}
                placeholder="值 (JSON)"
                className="h-9 w-36 rounded-lg border border-border px-3 text-sm outline-none focus:border-blue-500"
              />
              <button
                type="button"
                disabled={!diffFactoryName.trim() || !diffKey.trim() || registerDiff.isPending}
                onClick={() => registerDiff.mutate()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white disabled:opacity-50"
              >
                登记差异
              </button>
            </div>
            {registerDiff.isError && (
              <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
                {registerDiff.error instanceof Error
                  ? registerDiff.error.message
                  : '登记失败'}
              </div>
            )}
            {differences.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">暂无工厂差异。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">差异键</th>
                      <th className="px-5 py-3 font-medium">工厂</th>
                      <th className="px-5 py-3 font-medium">分类</th>
                      <th className="px-5 py-3 font-medium">值</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">更新时间</th>
                      <th className="px-5 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {differences.map((difference) => (
                      <tr key={difference.key} className="hover:bg-muted">
                        <td className="px-5 py-3 font-mono text-xs">{difference.key}</td>
                        <td className="px-5 py-3">{difference.factoryName}</td>
                        <td className="px-5 py-3">{difference.category}</td>
                        <td className="px-5 py-3 font-mono text-xs">
                          {typeof difference.value === 'string'
                            ? difference.value
                            : JSON.stringify(difference.value)}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`rounded-md px-2 py-1 text-xs font-medium ${
                              difference.status === 'resolved'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {difference.status}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">
                          {formatTime(difference.updatedAt)}
                        </td>
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            disabled={
                              difference.status === 'resolved' ||
                              resolveDiff.isPending
                            }
                            onClick={() => resolveDiff.mutate(difference.key)}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
                          >
                            解决
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </QueryState>
    </div>
  );
};

export default Scale;
