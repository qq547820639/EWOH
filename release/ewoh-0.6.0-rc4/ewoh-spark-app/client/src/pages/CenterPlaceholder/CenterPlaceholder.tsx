import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CircleAlert,
  CircleCheck,
  Database,
  Inbox,
  ListChecks,
  Loader2,
  LockKeyhole,
  Network,
  UsersRound,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@client/src/components/ui/alert';
import { Badge } from '@client/src/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@client/src/components/ui/empty';
import { Skeleton } from '@client/src/components/ui/skeleton';
import { Spinner } from '@client/src/components/ui/spinner';
import { EWOH_ROLE_LABELS, type EwohRole } from '@client/src/types/ewoh';

export interface CenterPlaceholderProps {
  title: string;
  description: string;
  route: string;
  roles: EwohRole[];
  namespaces: string[];
  capabilities: string[];
}

function LoadingState() {
  return (
    <div className="space-y-3" role="status" aria-label="加载状态">
      <div className="flex items-center gap-2 text-xs text-[hsl(218_10%_42%)]">
        <Spinner className="size-3.5" />
        <span>正在加载工作区数据</span>
      </div>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="h-8 w-1/2" />
    </div>
  );
}

function ErrorState() {
  return (
    <Alert variant="destructive">
      <CircleAlert className="size-4" />
      <AlertTitle>数据加载失败</AlertTitle>
      <AlertDescription>接口不可用或返回异常，请检查服务状态后重试。</AlertDescription>
    </Alert>
  );
}

function PermissionState({ roles }: { roles: EwohRole[] }) {
  const roleLabels = roles.map((role) => EWOH_ROLE_LABELS[role]).join('、');
  return (
    <Alert>
      <LockKeyhole className="size-4" />
      <AlertTitle>当前账号无权访问</AlertTitle>
      <AlertDescription>此中心仅对以下角色可见：{roleLabels}。</AlertDescription>
    </Alert>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <Inbox className="size-6" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function StateBlock({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-[hsl(218_10%_42%)]" />
        <h3 className="text-sm font-semibold text-[hsl(220_14%_14%)]">{title}</h3>
      </div>
      {children}
    </div>
  );
}

const CenterPlaceholder = ({
  title,
  description,
  route,
  roles,
  namespaces,
  capabilities,
}: CenterPlaceholderProps) => {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">{title}</h1>
            <Badge variant="outline" className="font-mono">
              {route}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">{description}</p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
            <Network className="size-4" />
            API 命名空间
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {namespaces.map((namespace) => (
              <Badge key={namespace} variant="outline" className="font-mono">
                {namespace}
              </Badge>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
            <UsersRound className="size-4" />
            可见角色
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {roles.map((role) => (
              <Badge key={role} variant="secondary">
                {EWOH_ROLE_LABELS[role]}
              </Badge>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
            <ListChecks className="size-4" />
            规划能力
          </div>
          <ul className="mt-3 space-y-2">
            {capabilities.map((capability) => (
              <li key={capability} className="flex items-start gap-2 text-sm text-[hsl(220_14%_14%)]">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <span>{capability}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex items-center justify-between border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-[hsl(218_10%_42%)]" />
            <h2 className="font-semibold text-[hsl(220_14%_14%)]">业务工作区</h2>
          </div>
          <Badge variant="secondary">待接入</Badge>
        </div>
        <div className="p-6">
          <EmptyState
            title={`${title}尚未接入业务数据`}
            description="接口接入后将在此处展示列表、详情与操作入口。"
          />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">状态契约</h2>
          <span className="text-xs text-[hsl(218_10%_42%)]">
            loading / error / empty / permission
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StateBlock icon={Loader2} title="加载状态">
            <LoadingState />
          </StateBlock>
          <StateBlock icon={CircleAlert} title="错误状态">
            <ErrorState />
          </StateBlock>
          <StateBlock icon={Inbox} title="空状态">
            <EmptyState title="暂无数据" description="当前筛选条件下没有可展示的记录。" />
          </StateBlock>
          <StateBlock icon={LockKeyhole} title="权限拒绝">
            <PermissionState roles={roles} />
          </StateBlock>
        </div>
      </section>
    </div>
  );
};

export default CenterPlaceholder;
