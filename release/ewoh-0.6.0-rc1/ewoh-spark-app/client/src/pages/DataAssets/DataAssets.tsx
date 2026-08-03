import { useQuery } from '@tanstack/react-query';
import { Database, FileCode2, Settings2 } from 'lucide-react';
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
  const query = useQuery<DataAssetsData>({
    queryKey: queryKeys.dataAssets,
    queryFn: async () => {
      const [models, configs] = await Promise.all([listModels(), listSystemConfigs()]);
      return { models, configs };
    },
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const data = query.data;
  const models = data?.models ?? [];
  const configs = data?.configs ?? [];

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
