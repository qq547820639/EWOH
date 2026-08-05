import { useState } from 'react';
import { readAppContext, writeAppContext, type AppContext } from '@/lib/appContext';
import { sessionLifecycle } from '@/lib/runtimeLifecycle';
import OrgEnvSwitcher from './OrgEnvSwitcher';
import VersionFreshnessBadge from './VersionFreshnessBadge';

/**
 * 常驻上下文指示条：明确展示当前正在操作的组织/工厂/产线/环境 + 版本
 * + 数据新鲜度，并对真实数据接入前标注「演示/待接入真数据」。
 */
const ContextBar = () => {
  const [context, setContext] = useState<AppContext>(() => readAppContext());

  const update = (partial: Partial<AppContext>) => {
    const next = { ...context, ...partial };
    setContext(next);
    writeAppContext(next);
    // 组织（租户）切换：释放旧租户会话资源，新会话在全新的生命周期 scope 上重建。
    if (partial.orgId !== undefined && partial.orgId !== context.orgId) {
      sessionLifecycle.disposeForReason('tenant-switch');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] bg-white px-4 py-1.5 text-xs">
      <OrgEnvSwitcher context={context} onChange={update} />
      <span className="mx-1 hidden h-4 w-px bg-[hsl(220_14%_89%)] md:block" aria-hidden />
      <VersionFreshnessBadge context={context} />
      <span className="ml-auto text-[11px] text-[hsl(218_10%_42%)]">
        演示 / 待接入真数据
      </span>
    </div>
  );
};

export default ContextBar;