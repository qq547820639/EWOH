import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ArrowUpRight, LogOut, Menu, X } from 'lucide-react';
import { EWOH_ROLE_LABELS } from '@client/src/types/ewoh';
import { getVisibleNavGroups } from '../lib/navigation';
import { getAuthUser, revokeSession } from '../lib/auth';
import { UI_ARIA_LABELS } from '../lib/a11y';
import AppBreadcrumb from './app-shell/AppBreadcrumb';
import ContextBar from './app-shell/ContextBar';
import FavoriteViewsMenu from './app-shell/FavoriteViewsMenu';
import GlobalSearchCommand from './app-shell/GlobalSearchCommand';
import OnlineStatusBadge from './app-shell/OnlineStatusBadge';
import PageSkeleton from './app-shell/PageSkeleton';
import PendingInbox from './app-shell/PendingInbox';
import RecentAccessMenu from './app-shell/RecentAccessMenu';
import AiAssistant from './app-shell/AiAssistant';
import { useOfflineSnapshot } from './app-shell/useOfflineSnapshot';
import OnboardingQuickStart from './OnboardingQuickStart';
import { prefetchRoute } from '../lib/routePrefetch';

const Layout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = getAuthUser();
  const navGroups = getVisibleNavGroups(user?.roles ?? []);
  const offlineSnapshot = useOfflineSnapshot();
  const pendingCount = offlineSnapshot?.pendingCount ?? 0;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasSidebarOpenRef = useRef(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (sidebarOpen) {
      wasSidebarOpenRef.current = true;
      window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (wasSidebarOpenRef.current) {
      wasSidebarOpenRef.current = false;
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }, [sidebarOpen]);

  const handleLogout = async () => {
    // CLI-324：revokeSession 失败（网络断开/后端不可用）时仍完成本地登出，
    // 避免 token 过期用户被卡在已登录界面。
    // BUG-003 修复：使用 window.location.replace 替代 navigate，避免
    // React Router 在 sessionLifecycle.dispose 后状态不一致导致导航失效。
    try {
      await revokeSession();
    } catch {
      // 服务端会话由过期机制兜底；本地凭证清理见 revokeSession 内部实现。
    }
    // 强制跳转 —— replace 避免后退按钮回到已登出页面
    window.location.replace('/login');
  };

  return (
    <div className="flex w-screen h-screen bg-muted">
      <a
        href="#main-content"
        /* R2-CC2-002：跳转链接表面色改设计令牌（bg-card 在 dark 主题下与浅色前景冲突，WCAG 1.4.3 失败）。 */
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary focus:shadow-lg"
      >
        {UI_ARIA_LABELS.skipToContent}
      </a>
      {/* 侧边导航栏 */}
      <aside
        /* R2-CC2-002：侧栏表面色 bg-card→bg-card 令牌（dark 主题下白底浅字不可读）。 */
        className={`fixed inset-y-0 left-0 z-50 flex w-56 flex-col bg-card border-r border-border transition-transform duration-200 lg:static lg:translate-x-0 lg:shrink-0 ${
          sidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
        aria-label="侧边导航"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSidebarOpen(false);
        }}
      >
        <div className="flex items-center gap-2 px-5 h-16 border-b border-border">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-white font-bold text-sm">
            E
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">EWOH</div>
            <div className="text-xs text-muted-foreground">具身工厂操作系统</div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted lg:hidden"
            aria-label={UI_ARIA_LABELS.closeNavigation}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-4">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isMap = item.to === '/command-map';
                    const roleText = item.roles
                      .map((role) => EWOH_ROLE_LABELS[role])
                      .join(' · ');
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        title={roleText}
                        data-roles={item.roles.join(',')}
                        onMouseEnter={() => prefetchRoute(item.to)}
                        onFocus={() => prefetchRoute(item.to)}
                        onClick={() => setSidebarOpen(false)}
                      >
                        {({ isActive }) => (
                          <span
                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                              isMap
                                ? 'bg-gradient-to-r from-primary to-risk-conflict text-white hover:opacity-90'
                                : isActive
                                  ? 'bg-primary text-white'
                                  : 'text-foreground hover:bg-muted'
                            }`}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate leading-5">{item.label}</span>
                              <span
                                className={`block truncate text-[10px] leading-4 ${
                                  isMap
                                    ? 'text-white/80'
                                    : isActive
                                    // 蓝底(hsl(221 83% 53%))上 text-white/75 对比度仅 3.61:1，不达 WCAG AA(4.5:1)
                                    ? 'text-white'
                                    : 'text-muted-foreground'
                                }`}
                              >
                                {roleText}
                              </span>
                            </span>
                            {isMap && <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />}
                          </span>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>
        <div className="px-5 py-4 border-t border-border">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {user?.username ?? '未登录'}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                外骨骼作业健康监测
              </p>
            </div>
            {/* 2026-08-18：主题切换已移至指挥地图顶栏（compact icon-only）；此处移除。 */}
            <button
              type="button"
              onClick={handleLogout}
              title="退出登录"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={UI_ARIA_LABELS.logout}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* 主内容区 */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-w-0 flex-1 flex-col overflow-auto outline-none"
      >
        {/* R2-CC2-002：顶栏表面色 bg-card→bg-card 令牌（dark 主题下可读）。 */}
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-foreground hover:bg-muted lg:hidden"
            aria-label={UI_ARIA_LABELS.openNavigation}
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 lg:hidden">
            {/* R2-CC2-002：主色底前景 text-white→text-primary-foreground 令牌（dark 下 primary 提亮后纯白字对比不足）。 */}
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">
              E
            </div>
            <span className="text-sm font-semibold text-foreground">EWOH</span>
          </div>
          <AppBreadcrumb pathname={location.pathname} />
          <div className="ml-auto flex items-center gap-1.5">
            <AiAssistant />
            <GlobalSearchCommand navGroups={navGroups} />
            <RecentAccessMenu pathname={location.pathname} />
            <FavoriteViewsMenu pathname={location.pathname} />
            <PendingInbox pendingCount={pendingCount} />
            <OnlineStatusBadge snapshot={offlineSnapshot} />
          </div>
        </div>
        <ContextBar />
        {user && !onboardingDismissed && (
          <OnboardingQuickStart
            userId={user.userId}
            roles={user.roles}
            onClose={() => setOnboardingDismissed(true)}
          />
        )}
        <Suspense fallback={<PageSkeleton />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
};

export default Layout;
