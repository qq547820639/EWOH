import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Database, FileCode2, Plus, Settings2 } from 'lucide-react';
import {
  getAasSemantics,
  importAasAsset,
  listAasAssets,
  type AasAsset,
  type AasSemantics,
} from '../../api/aas';
import { listModels, type ModelRecord } from '../../api/models';
import { listSystemConfigs, type SystemConfigRecord } from '../../api/system';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

interface DataAssetsData {
  models: ModelRecord[];
  configs: SystemConfigRecord[];
}

const formatTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

const DataAssets = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [aasAssetId, setAasAssetId] = useState('');
  const [aasIdShort, setAasIdShort] = useState('');
  const [aasSubmodels, setAasSubmodels] = useState(
    '[{"id":"urn:ewoh:submodel:operations","idShort":"operations","elements":[]}]',
  );
  const [aasSemantics, setAasSemantics] = useState<AasSemantics | null>(null);
  const query = useQuery<DataAssetsData>({
    queryKey: queryKeys.dataAssets,
    queryFn: async () => {
      const [models, configs] = await Promise.all([listModels(), listSystemConfigs()]);
      return { models, configs };
    },
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const aasQuery = useQuery<AasAsset[]>({
    queryKey: queryKeys.aasAssets,
    queryFn: listAasAssets,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const addAas = useMutation({
    mutationFn: () =>
      importAasAsset({
        assetId: aasAssetId.trim(),
        idShort: aasIdShort.trim(),
        submodels: JSON.parse(aasSubmodels),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aasAssets });
      setAasAssetId('');
      setAasIdShort('');
    },
  });
  const fetchSemantics = useMutation({
    mutationFn: getAasSemantics,
    onSuccess: setAasSemantics,
  });

  const data = query.data;
  const models = data?.models ?? [];
  const configs = data?.configs ?? [];
  const aasAssets = aasQuery.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">数据资产</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
          模型注册与系统配置资产概览。
        </p>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!data}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载数据资产"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-4 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                <FileCode2 className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-[hsl(218_10%_42%)]">模型注册</p>
                <p className="mt-1 text-3xl font-semibold">{models.length}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50">
                <Settings2 className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm text-[hsl(218_10%_42%)]">系统配置</p>
                <p className="mt-1 text-3xl font-semibold">{configs.length}</p>
              </div>
            </div>
          </div>

          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Boxes className="h-4 w-4 text-violet-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">AAS 资产壳</h2>
              <span className="ml-auto rounded-full bg-[hsl(220_14%_96%)] px-2 py-1 text-xs text-[hsl(218_10%_42%)]">
                {aasAssets.length} 个资产
              </span>
            </div>
            <form
              className="grid gap-3 border-b border-[hsl(220_14%_89%)] p-5 sm:grid-cols-2 lg:grid-cols-4"
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  addAas.mutate();
                } catch {
                  // invalid JSON is surfaced by the backend
                }
              }}
            >
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
                Asset ID
                <input
                  value={aasAssetId}
                  onChange={(event) => setAasAssetId(event.target.value)}
                  placeholder="urn:ewoh:line:001"
                  className="h-9 min-w-0 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)]">
                ID Short
                <input
                  value={aasIdShort}
                  onChange={(event) => setAasIdShort(event.target.value)}
                  className="h-9 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[hsl(218_10%_42%)] sm:col-span-2">
                Submodels JSON
                <textarea
                  value={aasSubmodels}
                  onChange={(event) => setAasSubmodels(event.target.value)}
                  rows={2}
                  className="min-w-0 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 py-2 font-mono text-xs outline-none focus:border-[hsl(221_83%_53%)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={addAas.isPending || !aasAssetId.trim()}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-800 px-4 text-sm font-medium text-white disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  导入
                </button>
              </div>
            </form>
            {aasAssets.length === 0 ? (
              <div className="p-6 text-sm text-[hsl(218_10%_42%)]">暂无 AAS 资产。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">资产</th>
                      <th className="px-5 py-3 font-medium">子模型</th>
                      <th className="px-5 py-3 font-medium">导入人</th>
                      <th className="px-5 py-3 font-medium">导入时间</th>
                      <th className="px-5 py-3 font-medium">语义映射</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                    {aasAssets.map((asset) => (
                      <tr key={asset.assetId} className="hover:bg-[hsl(220_14%_96%)]">
                        <td className="px-5 py-3">
                          <div className="font-medium text-[hsl(220_14%_14%)]">{asset.idShort}</div>
                          <div className="font-mono text-xs text-[hsl(218_10%_42%)]">{asset.assetId}</div>
                        </td>
                        <td className="px-5 py-3">{asset.submodels.length}</td>
                        <td className="px-5 py-3">{asset.importedBy}</td>
                        <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                          {formatTime(asset.importedAt)}
                        </td>
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            onClick={() => fetchSemantics.mutate(asset.assetId)}
                            className="rounded-md bg-[hsl(220_14%_96%)] px-2 py-1 text-xs font-medium"
                          >
                            查看
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {aasSemantics && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-[hsl(220_14%_89%)] p-5 font-mono text-xs">
                {JSON.stringify(aasSemantics, null, 2)}
              </pre>
            )}
          </section>

          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Database className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">模型注册清单</h2>
            </div>
            {models.length === 0 ? (
              <div className="p-6 text-sm text-[hsl(218_10%_42%)]">暂无模型记录。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">模型</th>
                      <th className="px-5 py-3 font-medium">版本</th>
                      <th className="px-5 py-3 font-medium">类型</th>
                      <th className="px-5 py-3 font-medium">状态</th>
                      <th className="px-5 py-3 font-medium">创建时间</th>
                      <th className="px-5 py-3 font-medium">更新时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                    {models.map((model) => (
                      <tr key={model.id} className="hover:bg-[hsl(220_14%_96%)]">
                        <td className="px-5 py-3">
                          <div className="font-medium text-[hsl(220_14%_14%)]">{model.modelName}</div>
                          <div className="font-mono text-xs text-[hsl(218_10%_42%)]">{model.modelId}</div>
                        </td>
                        <td className="px-5 py-3 font-mono text-xs">{model.version}</td>
                        <td className="px-5 py-3 text-[hsl(218_10%_42%)]">{model.type}</td>
                        <td className="px-5 py-3">{model.status ?? '—'}</td>
                        <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                          {formatTime(model.createdAt)}
                        </td>
                        <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                          {formatTime(model.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Settings2 className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">系统配置清单</h2>
            </div>
            {configs.length === 0 ? (
              <div className="p-6 text-sm text-[hsl(218_10%_42%)]">暂无系统配置。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                    <tr>
                      <th className="px-5 py-3 font-medium">配置键</th>
                      <th className="px-5 py-3 font-medium">配置值</th>
                      <th className="px-5 py-3 font-medium">更新人</th>
                      <th className="px-5 py-3 font-medium">更新时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                    {configs.map((config) => (
                      <tr key={config.id} className="hover:bg-[hsl(220_14%_96%)]">
                        <td className="px-5 py-3 align-top font-mono text-xs">{config.configKey}</td>
                        <td className="max-w-md px-5 py-3">
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-[hsl(220_14%_96%)] p-2 text-xs">
                            {JSON.stringify(config.configValue, null, 2)}
                          </pre>
                        </td>
                        <td className="px-5 py-3">{config.updatedBy ?? '—'}</td>
                        <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                          {formatTime(config.updatedAt)}
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

export default DataAssets;
