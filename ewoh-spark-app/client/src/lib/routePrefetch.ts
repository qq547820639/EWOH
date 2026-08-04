/**
 * UX-008「性能工程」— 路由预取。
 *
 * 在侧边导航项 hover / 聚焦时提前加载对应页面模块（配合 app.tsx 的 React.lazy 按需加载），
 * 从而把"点击切换路由"的等待转移到"空闲时预取"，降低路由切换的感知延迟。
 *
 * 仅对体量较大的页面启用预取，限制并发与重复加载。
 */

type RouteLoader = () => Promise<unknown>;

const PREFETCHABLE_ROUTES: Record<string, RouteLoader> = {
  '/command-center': () => import('../pages/CommandCenter/CommandCenter'),
  '/work-orchestration': () => import('../pages/WorkOrchestration/WorkOrchestration'),
  '/command-map': () => import('../pages/CommandMap/CommandMap'),
  '/role-workbench': () => import('../pages/RoleWorkbench/RoleWorkbench'),
  '/mobile-workbench': () => import('../pages/MobileWorkbench/MobileWorkbench'),
  '/digital-world': () => import('../pages/DigitalWorld/DigitalWorld'),
  '/scale': () => import('../pages/Scale/Scale'),
  '/operations': () => import('../pages/Operations/Operations'),
};

const PREFETCHED = new Set<string>();

/**
 * 预取某一路由对应的页面模块。幂等：已预取或不在预取表内的路径直接忽略。
 * 失败时从缓存中移除，允许下次重试。
 */
export function prefetchRoute(path: string): void {
  const loader = PREFETCHABLE_ROUTES[path];
  if (!loader || PREFETCHED.has(path)) return;
  PREFETCHED.add(path);
  loader().catch(() => {
    PREFETCHED.delete(path);
  });
}

export function isRoutePrefetchable(path: string): boolean {
  return Boolean(PREFETCHABLE_ROUTES[path]);
}