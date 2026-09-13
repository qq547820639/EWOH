import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getHierarchy } from '../../api/spatial';
import { getWorldState } from '../../api/world';
import type { SpatialEntity, SpatialHierarchyNode, CurrentWorldState } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import { PageDutyHeader } from '../../components/app-shell/PageDutyHeader';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

interface DigitalWorldData {
  tree: SpatialHierarchyNode[];
  world: CurrentWorldState;
}

function Tree({
  nodes,
  onSelect,
  depth = 0,
}: {
  nodes: SpatialHierarchyNode[];
  onSelect: (id: string) => void;
  depth?: number;
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.entity.entityId}>
          <button
            type="button"
            onClick={() => onSelect(node.entity.entityId)}
            className="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            title={node.entity.name}
          >
            {node.entity.name}
          </button>
          {node.children.length > 0 && (
            <Tree nodes={node.children} onSelect={onSelect} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

function flattenHierarchy(nodes: SpatialHierarchyNode[]): SpatialEntity[] {
  const result: SpatialEntity[] = [];
  const walk = (list: SpatialHierarchyNode[]) => {
    for (const node of list) {
      result.push(node.entity);
      walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

const DigitalWorld = (): React.ReactElement => {
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery<DigitalWorldData>({
    queryKey: queryKeys.digitalWorld,
    queryFn: async () => {
      const [tree, world] = await Promise.all([getHierarchy(), getWorldState()]);
      return { tree, world };
    },
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const data = query.data;
  const tree = data?.tree ?? [];
  const world = data?.world;
  const allEntities = useMemo(() => flattenHierarchy(tree), [tree]);
  const selectedEntity = useMemo(
    () => allEntities.find((entity) => entity.entityId === selected) ?? null,
    [allEntities, selected],
  );
  const parentName = useMemo(() => {
    if (!selectedEntity?.parentId) return null;
    return (
      allEntities.find((entity) => entity.entityId === selectedEntity.parentId)?.name ?? null
    );
  }, [allEntities, selectedEntity]);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* DR-1 轻量收敛：页头职责条（j2-design-spec-addendum §4） */}
      <PageDutyHeader currentPath="/digital-world" />
      <header>
        <h1 className="text-2xl font-bold text-foreground">数字世界</h1>
        <p className="mt-1 text-sm text-muted-foreground">空间层级、实体与当前世界状态。</p>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!data}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载数字世界"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <section className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">空间层级</h2>
            {tree.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                暂无空间层级数据
              </div>
            ) : (
              <Tree nodes={tree} onSelect={setSelected} />
            )}
          </section>
          <section className="rounded-lg border border-border bg-card p-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold">世界状态</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                // 逐字段可选读取：世界状态响应缺字段（版本错配/半残响应）时
                // 计数降级为 0，绝不整页白屏（现场可继续看空间层级）。
                ['人员', world?.persons?.length ?? 0],
                ['设备', world?.devices?.length ?? 0],
                ['工位', world?.workstations?.length ?? 0],
                ['事件', world?.events?.length ?? 0],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-border p-4">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-semibold">{value}</p>
                </div>
              ))}
            </div>
            {selectedEntity ? (
              <div className="mt-4 rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate text-sm font-semibold">
                    {selectedEntity.name}
                  </h3>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {selectedEntity.entityType}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">实体ID</dt>
                    <dd className="break-all font-mono text-xs">{selectedEntity.entityId}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">状态</dt>
                    <dd>{selectedEntity.status || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">父级</dt>
                    <dd>{parentName ?? selectedEntity.parentId ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">坐标</dt>
                    <dd className="font-mono text-xs">
                      ({selectedEntity.x}, {selectedEntity.y})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">置信度</dt>
                    <dd>{selectedEntity.confidence}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">包围盒</dt>
                    <dd className="font-mono text-xs">
                      {selectedEntity.bboxW} × {selectedEntity.bboxH}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                当前未选择实体，点击左侧层级节点查看详情。
              </p>
            )}
          </section>
        </div>
      </QueryState>
    </div>
  );
};

export default DigitalWorld;
