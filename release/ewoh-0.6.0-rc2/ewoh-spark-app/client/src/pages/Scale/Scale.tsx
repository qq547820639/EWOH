import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Factory, GitCompareArrows, Layers3, Play } from 'lucide-react';
import {
  getScaleCompatibility,
  listScaleAssets,
  listScaleProfiles,
  listScaleTemplates,
  runScaleOnboarding,
  type OnboardingRunResult,
} from '../../api/scale';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

interface ScaleData {
  templates: Awaited<ReturnType<typeof listScaleTemplates>>;
  profiles: Awaited<ReturnType<typeof listScaleProfiles>>;
  assets: Awaited<ReturnType<typeof listScaleAssets>>;
  compatibility: Awaited<ReturnType<typeof getScaleCompatibility>>;
}

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

const Scale = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [factoryName, setFactoryName] = useState('');
  const [lastRun, setLastRun] = useState<OnboardingRunResult | null>(null);

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
  });

  const data = query.data;
  const templates = data?.templates ?? [];
  const profiles = data?.profiles ?? [];
  const assets = data?.assets ?? [];
  const compatibility = data?.compatibility;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">规模化运营</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            工厂模板、Profile、资产包与兼容目录。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-3 py-2 text-xs text-[hsl(218_10%_42%)]">
          <GitCompareArrows className="h-4 w-4 text-emerald-600" />
          核心版本：{compatibility?.coreVersion ?? '—'}
        </div>
      </header>

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
            <div className="flex items-center gap-4 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                <Factory className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-[hsl(218_10%_42%)]">工厂模板</p>
                <p className="mt-1 text-3xl font-semibold">{templates.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50">
                <Layers3 className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm text-[hsl(218_10%_42%)]">工厂 Profile</p>
                <p className="mt-1 text-3xl font-semibold">{profiles.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50">
                <Boxes className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm text-[hsl(218_10%_42%)]">资产包</p>
                <p className="mt-1 text-3xl font-semibold">{assets.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-50">
                <GitCompareArrows className="h-5 w-5 text-violet-600" />
              </div>
              <div>
                <p className="text-sm text-[hsl(218_10%_42%)]">兼容资产</p>
                <p className="mt-1 text-3xl font-semibold">
                  {compatibility?.compatibleCount ?? 0}
                  <span className="text-sm font-normal text-[hsl(218_10%_42%)]">
                    {' '}
                    / {compatibility?.incompatibleCount ?? 0} 不兼容
                  </span>
                </p>
              </div>
            </div>
          </div>

          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Play className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">工厂上线运行</h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <input
                  value={factoryName}
                  onChange={(event) => setFactoryName(event.target.value)}
                  placeholder="输入新工厂名称"
                  className="h-9 w-56 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  disabled={!factoryName.trim() || onboarding.isPending}
                  onClick={() => onboarding.mutate()}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-[hsl(221_83%_53%)] px-4 text-sm font-medium text-white disabled:opacity-50"
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
              <div className="border-b border-[hsl(220_14%_89%)] px-5 py-4">
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
                  <span className="ml-3 text-xs text-[hsl(218_10%_42%)]">
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
              <div className="p-6 text-sm text-[hsl(218_10%_42%)]">暂无规模化资产。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">资产</th>
                      <th className="px-5 py-3 font-medium">类型</th>
                      <th className="px-5 py-3 font-medium">版本</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">兼容</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                    {assets.map((asset) => {
                      const row = compatibility?.assets.find(
                        (item) => item.packageId === asset.packageId,
                      );
                      return (
                        <tr key={asset.packageId} className="hover:bg-[hsl(220_14%_96%)]">
                          <td className="px-5 py-3">
                            <div className="font-medium text-[hsl(220_14%_14%)]">
                              {asset.name}
                            </div>
                            <div className="font-mono text-xs text-[hsl(218_10%_42%)]">
                              {asset.packageId}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-[hsl(218_10%_42%)]">
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Layers3 className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">工厂 Profile</h2>
            </div>
            {profiles.length === 0 ? (
              <div className="p-6 text-sm text-[hsl(218_10%_42%)]">暂无工厂 Profile。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] text-left text-sm">
                  <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">工厂</th>
                      <th className="px-5 py-3 font-medium">模板</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">安装时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                    {profiles.map((profile) => (
                      <tr key={profile.profileId} className="hover:bg-[hsl(220_14%_96%)]">
                        <td className="px-5 py-3">
                          <div className="font-medium text-[hsl(220_14%_14%)]">
                            {profile.factoryName}
                          </div>
                          <div className="font-mono text-xs text-[hsl(218_10%_42%)]">
                            {profile.profileId}
                          </div>
                        </td>
                        <td className="px-5 py-3 font-mono text-xs">
                          {profile.templateId}
                        </td>
                        <td className="px-5 py-3">{profile.status}</td>
                        <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                          {formatTime(profile.installedAt)}
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
