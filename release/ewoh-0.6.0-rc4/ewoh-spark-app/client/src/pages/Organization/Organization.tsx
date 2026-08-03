import { useQuery } from '@tanstack/react-query';
import { getOrganizationTree } from '../../api/organization';
import type { OrganizationTreeNode } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

function OrgTree({ nodes, depth = 0 }: { nodes: OrganizationTreeNode[]; depth?: number }) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.id}>
          <div
            className="rounded-md px-2 py-1 text-sm"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            <span className="font-medium">{node.name}</span>
            <span className="ml-2 text-xs text-[hsl(218_10%_42%)]">{node.orgType}</span>
          </div>
          {node.children.length > 0 && <OrgTree nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

const Organization = (): React.ReactElement => {
  const query = useQuery<OrganizationTreeNode[]>({
    queryKey: queryKeys.organizationTree,
    queryFn: getOrganizationTree,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const tree = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">组织与空间</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">组织层级与数据范围。</p>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || tree.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载组织树"
        emptyMessage="暂无组织节点。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="overflow-x-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <OrgTree nodes={tree} />
        </div>
      </QueryState>
    </div>
  );
};

export default Organization;
