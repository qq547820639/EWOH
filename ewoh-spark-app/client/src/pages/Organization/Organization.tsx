import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createOrganization, getOrganizationTree } from '../../api/organization';
import type { OrganizationTreeNode } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** 组织类型（实施配置标准枚举；与现有数据 group/factory/workshop 对齐）。 */
const ORG_TYPE_OPTIONS = [
  { value: 'group', label: '集团' },
  { value: 'factory', label: '工厂 / 基地' },
  { value: 'workshop', label: '车间' },
] as const;

const ORG_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ORG_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

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
            <span className="ml-2 text-xs text-muted-foreground">
              {ORG_TYPE_LABEL[node.orgType] ?? node.orgType}
            </span>
            {node.description ? (
              <span className="ml-2 text-xs text-muted-foreground">{node.description}</span>
            ) : null}
          </div>
          {node.children.length > 0 && <OrgTree nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

/** 树扁平化为"上级组织"下拉候选（带层级缩进前缀）。 */
function flattenTree(
  nodes: OrganizationTreeNode[],
  depth = 0,
  acc: Array<{ id: string; label: string }> = [],
): Array<{ id: string; label: string }> {
  for (const node of nodes) {
    acc.push({ id: node.id, label: `${'　'.repeat(depth)}${node.name}（${ORG_TYPE_LABEL[node.orgType] ?? node.orgType}）` });
    if (node.children.length > 0) flattenTree(node.children, depth + 1, acc);
  }
  return acc;
}

const Organization = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [orgType, setOrgType] = useState('');
  const [parentId, setParentId] = useState<string>('');
  const [description, setDescription] = useState('');

  const query = useQuery<OrganizationTreeNode[]>({
    queryKey: queryKeys.organizationTree,
    queryFn: getOrganizationTree,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const tree = query.data ?? [];
  const parentOptions = useMemo(() => flattenTree(tree), [tree]);

  const createMutation = useMutation({
    mutationFn: () =>
      createOrganization({
        name: name.trim(),
        orgType: orgType.trim(),
        ...(parentId ? { parentId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success('组织已创建');
      setOpen(false);
      setName('');
      setOrgType('');
      setParentId('');
      setDescription('');
      queryClient.invalidateQueries({ queryKey: queryKeys.organizationTree });
    },
    onError: (error) => {
      toast.error('创建失败', {
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const canSubmit = name.trim().length > 0 && orgType.trim().length > 0 && !createMutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    createMutation.mutate();
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">组织与空间</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            组织层级与数据范围（实施配置：录入甲方组织信息；运行期只读展示）。
          </p>
        </div>
        <Button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2">
          <Plus className="size-4" aria-hidden />
          新增组织
        </Button>
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
        emptyMessage="暂无组织节点，点击右上角「新增组织」录入。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="overflow-x-auto rounded-lg border border-border bg-card p-4">
          <OrgTree nodes={tree} />
        </div>
      </QueryState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新增组织</DialogTitle>
            <DialogDescription>
              录入甲方组织节点（集团 / 工厂 / 车间）。创建后展示在左侧层级树中。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="org-name" className="text-sm font-medium">
                组织名称 <span className="text-red-500">*</span>
              </label>
              <Input
                id="org-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="如：总装一车间 / 华东智造基地"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="org-type" className="text-sm font-medium">
                组织类型 <span className="text-red-500">*</span>
              </label>
              <Select value={orgType} onValueChange={setOrgType}>
                <SelectTrigger id="org-type">
                  <SelectValue placeholder="选择组织类型" />
                </SelectTrigger>
                <SelectContent>
                  {ORG_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="org-parent" className="text-sm font-medium">
                上级组织
              </label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger id="org-parent">
                  <SelectValue placeholder="（不选则作为根节点）" />
                </SelectTrigger>
                <SelectContent>
                  {parentOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="org-desc" className="text-sm font-medium">
                描述
              </label>
              <Textarea
                id="org-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="可选：组织职责、备注等"
                rows={2}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                创建
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Organization;
