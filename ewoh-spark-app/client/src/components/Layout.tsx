import { useEffect, useRef, useState } from 'react';
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
import PendingInbox from './app-shell/PendingInbox';
import RecentAccessMenu from './app-shell/RecentAccessMenu';
import { useOfflineSnapshot } from './app-shell/useOfflineSnapshot';
import { prefetchRoute } from '../lib/routePrefetch';

const Layout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = getAuthUser();
  const navGroups = getVisibleNavGroups(user?.roles ?? []);
  const offlineSnapshot = useOfflineSnapshot();
  const pendingCount = offlineSnapshot?.pendingCount ?? 0;
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    await revokeSession();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex w-screen h-screen bg-[hsl(220_14%_96%)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[hsl(221_83%_53%)] focus:shadow-lg"
      >
        {UI_ARIA_LABELS.skipToContent}
      </a>
      {/* 侧边导航栏 */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-56 flex-col bg-white border-r border-[hsl(220_14%_89%)] transition-transform duration-200 lg:static lg:translate-x-0 lg:shrink-0 ${
          sidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
        aria-label="侧边导航"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSidebarOpen(false);
        }}
      >
        <div className="flex items-center gap-2 px-5 h-16 border-b border-[hsl(220_14%_89%)]">
          <div className="w-8 h-8 rounded-lg bg-[hsl(221_83%_53%)] flex items-center justify-center text-white font-bold text-sm">
            E
          </div>
          <div>
            <div className="text-sm font-semibold text-[hsl(220_14%_14%)]">EWOH</div>
            <div className="text-xs text-[hsl(218_10%_42%)]">具身工厂操作系统</div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)] lg:hidden"
            aria-label={UI_ARIA_LABELS.closeNavigation}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-4">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[hsl(218_10%_42%)]">
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
                                ? 'bg-gradient-to-r from-[hsl(221_83%_53%)] to-[hsl(250_73%_55%)] text-white hover:opacity-90'
                                : isActive
                                  ? 'bg-[hsl(221_83%_53%)] text-white'
                                  : 'text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]'
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
                                      ? 'text-white/75'
                                      : 'text-[hsl(218_10%_42%)]'
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
        <div className="px-5 py-4 border-t border-[hsl(220_14%_89%)]">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-[hsl(220_14%_14%)]">
                {user?.username ?? '未登录'}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-[hsl(218_10%_42%)]">
                外骨骼作业健康监测
              </p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              title="退出登录"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)] hover:text-[hsl(220_14%_14%)]"
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
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[hsl(220_14%_89%)] bg-white px-4">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)] lg:hidden"
            aria-label={UI_ARIA_LABELS.openNavigation}
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 lg:hidden">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[hsl(221_83%_53%)] text-[10px] font-bold text-white">
              E
            </div>
            <span className="text-sm font-semibold text-[hsl(220_14%_14%)]">EWOH</span>
          </div>
          <AppBreadcrumb pathname={location.pathname} />
          <div className="ml-auto flex items-center gap-1.5">
            <GlobalSearchCommand navGroups={navGroups} />
            <RecentAccessMenu pathname={location.pathname} />
            <FavoriteViewsMenu pathname={location.pathname} />
            <PendingInbox pendingCount={pendingCount} />
            <OnlineStatusBadge snapshot={offlineSnapshot} />
          </div>
        </div>
        <ContextBar />
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
