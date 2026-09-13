import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readAppContext, writeAppContext, formatDataFreshness, type AppContext } from '@/lib/appContext';
import { getAuthUser, onAuthChange } from '@/lib/auth';
import { listOrganizations } from '@/api/organization';
import OrgEnvSwitcher from './OrgEnvSwitcher';
import VersionFreshnessBadge from './VersionFreshnessBadge';

/**
 * 常驻上下文指示条：明确展示当前正在操作的组织/工厂/产线/环境 + 版本
 * + 数据新鲜度。仅当上下文尚无真实数据时间（lastDataUpdatedAt 为 null，
 * 即真实后端契约未接入）时才展示「演示 / 待接入真数据」标注；一旦接入
 * 真实数据则切换为最近数据更新时间（CLI-303：标注随接入状态动态控制，
 * 不再永久硬编码展示）。
 */
const ContextBar = () => {
  const [authenticatedOrg, setAuthenticatedOrg] = useState(() => getAuthUser()?.orgId ?? '');
  const [context, setContext] = useState<AppContext>(() => ({
    ...readAppContext(),
    orgId: authenticatedOrg,
  }));

  useEffect(() => onAuthChange(({ current }) => {
    const orgId = current?.orgId ?? '';
    setAuthenticatedOrg(orgId);
    setContext((previous) => ({ ...previous, orgId }));
  }), []);

  // 组织名解析（2026-09-11）：raw UUID 对用户不可读。解析失败时退回 UUID
  // 并保留"未识别名称"提示——不伪造、不阻塞渲染。
  const orgsQuery = useQuery({
    queryKey: ['context-bar', 'organizations'],
    queryFn: listOrganizations,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const orgName = orgsQuery.data?.find((org) => org.id === authenticatedOrg)?.name ?? null;
  const orgLabel = orgName ?? (authenticatedOrg || '未认证');

  const update = (partial: Partial<AppContext>) => {
    const next = { ...context, ...partial, orgId: authenticatedOrg };
    setContext(next);
    writeAppContext(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-1.5 text-xs">
      <OrgEnvSwitcher context={context} orgLabel={orgLabel} onChange={update} />
      <span className="mx-1 hidden h-4 w-px bg-border md:block" aria-hidden />
      <VersionFreshnessBadge context={context} />
      <span className="ml-auto text-[11px] text-muted-foreground">
        {context.lastDataUpdatedAt
          ? `数据更新于 ${formatDataFreshness(context.lastDataUpdatedAt)}`
          : '演示 / 待接入真数据'}
      </span>
    </div>
  );
};

export default ContextBar;
