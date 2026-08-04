import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Lock, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { listWorkResources, acquireResourceLock, releaseResourceLock } from '../../api/work';
import { useVirtualList } from '../../lib/virtualList';
import { formatLockRemaining, formatTime, StatusBadge, WriteConfirmDialog } from './shared';

/** 行高估算（px），资源行含两行文本，取值略高。 */
const ROW_HEIGHT = 64;
const VIRTUAL_MAX_HEIGHT = 560;

const ResourcesPanel = ({ writable }: { writable: boolean }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [resourceId, setResourceId] = useState('');
  const [lockPurpose, setLockPurpose] = useState('');
  const [confirmLock, setConfirmLock] = useState(false);
  const [pendingLock, setPendingLock] = useState(false);
  const [pendingRelease, setPendingRelease] = useState<string | null>(null);

  const resourcesQuery = useQuery({
    queryKey: queryKeys.workResources,
    queryFn: listWorkResources,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const lockMutation = useMutation({
    mutationFn: () =>
      acquireResourceLock(resourceId.trim(), {
        purpose: lockPurpose.trim() || undefined,
        confirm: confirmLock,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workResources });
      setResourceId('');
      setLockPurpose('');
      setConfirmLock(false);
      toast.success('资源已加锁');
    },
  });
  const releaseMutation = useMutation({
    mutationFn: (id: string) => releaseResourceLock(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workResources });
      toast.success('资源已释放');
    },
  });

  const resources = resourcesQuery.data ?? [];
  const { ref, range, slice } = useVirtualList<HTMLDivElement>({
    total: resources.length,
    itemHeight: ROW_HEIGHT,
  });
  const visibleRows = resources.slice(slice.start, slice.end);
  const renderedCount = slice.end - slice.start;
  const bottomSpacer = Math.max(
    0,
    range.totalHeight - range.offsetY - renderedCount * ROW_HEIGHT,
  );

  return (
    <QueryState
      isLoading={resourcesQuery.isLoading}
      isFetching={resourcesQuery.isFetching}
      isError={resourcesQuery.isError}
      isStale={resourcesQuery.isStale}
      isEmpty={!resourcesQuery.data}
      onRefresh={() => resourcesQuery.refetch()}
      errorMessage={resourcesQuery.error instanceof Error ? resourcesQuery.error.message : '资源数据加载失败'}
      loadingMessage="正在读取资源与锁"
      updatedAt={resourcesQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <Database className="h-4 w-4 text-violet-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">资源与锁</h2>
          {resources.length > 0 && (
            <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
              共 {resources.length} 条 · 虚拟化渲染 {renderedCount} 行
            </span>
          )}
          {writable && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
                placeholder="资源 ID"
                className="h-9 w-48 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
              />
              <input
                value={lockPurpose}
                onChange={(event) => setLockPurpose(event.target.value)}
                placeholder="占用目的"
                className="h-9 w-48 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
              />
              <label className="flex items-center gap-2 text-xs text-[hsl(218_10%_42%)]">
                <input
                  type="checkbox"
                  checked={confirmLock}
                  onChange={(event) => setConfirmLock(event.target.checked)}
                  className="h-4 w-4"
                />
                双重确认
              </label>
              <button
                type="button"
                disabled={!resourceId.trim() || lockMutation.isPending}
                onClick={() => setPendingLock(true)}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                <Lock className="h-4 w-4" />
                加锁
              </button>
            </div>
          )}
        </div>
        <div
          ref={ref}
          className="overflow-auto"
          style={{ maxHeight: VIRTUAL_MAX_HEIGHT }}
          data-testid="resources-virtual-scroll"
        >
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-[hsl(220_14%_89%)] bg-white text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">资源</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">持有者</th>
                <th className="px-5 py-3 font-medium">获取时间</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {range.start > 0 && (
                <tr aria-hidden style={{ height: range.offsetY }} />
              )}
              {visibleRows.map((resource) => (
                <tr key={resource.resourceId} className="hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3">
                    <div className="font-medium text-[hsl(220_14%_14%)]">{resource.name}</div>
                    <div className="font-mono text-xs text-[hsl(218_10%_42%)]">
                      {resource.resourceId}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs">{resource.kind}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={resource.status} />
                  </td>
                  <td className="px-5 py-3 text-xs">{resource.lock?.holder ?? '—'}</td>
                  <td className="px-5 py-3 text-xs">
                    {resource.lock ? formatTime(resource.lock.acquiredAt) : '—'}
                    {resource.lock?.expiresAt && (
                      <div className="mt-0.5 text-[10px] text-[hsl(218_10%_42%)]">
                        剩余 {formatLockRemaining(resource.lock.expiresAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {writable &&
                      (resource.lock ? (
                        <button
                          type="button"
                          disabled={releaseMutation.isPending}
                          onClick={() => setPendingRelease(resource.resourceId)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] disabled:opacity-40"
                        >
                          <Unlock className="h-3.5 w-3.5" />
                          释放
                        </button>
                      ) : (
                        <span className="text-xs text-[hsl(218_10%_42%)]">空闲</span>
                      ))}
                  </td>
                </tr>
              ))}
              {bottomSpacer > 0 && <tr aria-hidden style={{ height: bottomSpacer }} />}
            </tbody>
          </table>
        </div>
      </section>

      <WriteConfirmDialog
        open={pendingLock}
        title="确认加锁"
        description={`将为资源 ${resourceId.trim() || '—'} 加锁。`}
        actionLabel="确认加锁"
        tone="primary"
        rollbackPoint="可通过「释放」回滚该加锁。"
        onCancel={() => setPendingLock(false)}
        onConfirm={() => {
          setPendingLock(false);
          lockMutation.mutate();
        }}
      />

      <WriteConfirmDialog
        open={Boolean(pendingRelease)}
        title="确认释放锁"
        description={pendingRelease ? `将释放资源 ${pendingRelease} 的锁。` : ''}
        actionLabel="确认释放"
        tone="danger"
        rollbackPoint="释放后需重新走加锁流程以恢复占用。"
        onCancel={() => setPendingRelease(null)}
        onConfirm={() => {
          if (pendingRelease) releaseMutation.mutate(pendingRelease);
          setPendingRelease(null);
        }}
      />
    </QueryState>
  );
};

export default ResourcesPanel;