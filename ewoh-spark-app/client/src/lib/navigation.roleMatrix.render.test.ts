/* FE-2 角色矩阵的渲染级回归：真实渲染 Layout 侧栏，锁死三条不变量。
 *
 * 为什么还要一层渲染测试：roleMatrix.test.ts 校验的是"导航数据 vs 后端 @Roles"，
 * 但用户感知到的是**侧栏里出现了什么链接**。数据一致 ≠ 渲染正确（组件可能
 * 绕过 getVisibleNavGroups，或分组折叠把唯一入口藏掉）。这里用
 * renderToStaticMarkup + MemoryRouter 渲染真实 Layout，断言：
 *   1. viewer 的侧栏非空，且就是 /reasoning（此前侧栏为空 + 落地 403）；
 *   2. 渲染出来的每条链接，都必须能被该角色真的打开（不出现"链到 403"）；
 *   3. 具体整改点：班组长不再看到工厂运行台、调度不再看到审批控制台。
 * 做法沿用仓库既有零网络 smoke（见 pages/static-pages.render.test.tsx）：
 * mock lucide-react 图标与 Layout 的重型子组件，不发任何请求。
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import * as path from 'node:path';
import { EWOH_ROLES } from '@client/src/types/ewoh';
import { defaultLandingPath, getVisibleNavGroups, navGroups } from './navigation';
import { IMPLICIT_ADMIN_ROLE, PAGE_API_CONTRACT } from './roleMatrix';
import { buildBackendRouteTable, findBackendRoute } from './roleMatrixBackend';

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_: unknown, key: string) => {
        const Icon = (props: Record<string, unknown>) =>
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('react').createElement('span', { 'data-icon': key, ...props });
        Icon.displayName = key;
        return Icon;
      },
    },
  ),
);

/** 当前登录账号（可切换角色），Layout 通过 getAuthUser() 读取。 */
let currentUser: { username: string; roles: string[] } = { username: 'u', roles: [] };

jest.mock('../lib/auth', () => ({
  getAuthUser: () => currentUser,
  revokeSession: jest.fn(),
}));

// Layout 的重型子组件：均与本次角色矩阵无关，mock 掉保证零网络、零状态。
jest.mock('../components/app-shell/ContextBar', () => () => null);
jest.mock('../components/app-shell/FavoriteViewsMenu', () => () => null);
jest.mock('../components/app-shell/GlobalSearchCommand', () => () => null);
jest.mock('../components/app-shell/OnlineStatusBadge', () => () => null);
jest.mock('../components/app-shell/PendingInbox', () => () => null);
jest.mock('../components/app-shell/RecentAccessMenu', () => () => null);
jest.mock('../components/app-shell/AiAssistant', () => () => null);
jest.mock('../components/app-shell/useOfflineSnapshot', () => ({
  useOfflineSnapshot: () => null,
}));
jest.mock('../components/OnboardingQuickStart', () => () => null);
jest.mock('./routePrefetch', () => ({ prefetchRoute: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Layout = require('../components/Layout').default as () => ReactElement;

/** 侧栏里渲染出的链接（只取侧栏 <nav class="flex-1 ..."> 段，排除面包屑的"首页"）。 */
function sidebarHrefs(markup: string): string[] {
  const start = markup.indexOf('<nav class="flex-1');
  if (start < 0) return [];
  const end = markup.indexOf('</nav>', start);
  const segment = markup.slice(start, end < 0 ? undefined : end);
  return [...segment.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

function renderSidebar(roles: string[], initialPath: string): string[] {
  currentUser = { username: 'u', roles };
  const markup = renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [initialPath] }, createElement(Layout)),
  );
  return sidebarHrefs(markup);
}

const APP_ROOT = path.resolve(__dirname, '../../..');
const TABLE = buildBackendRouteTable(path.join(APP_ROOT, 'server/modules'), APP_ROOT);

/** 某角色能否真正打开某页面（与 roleMatrix.test.ts 同一判定：页面主查询全放行）。 */
function roleCanOpen(role: string, page: string): boolean {
  if (role === IMPLICIT_ADMIN_ROLE) return true;
  const refs = PAGE_API_CONTRACT[page];
  if (!refs) return false;
  return refs.every((ref) => {
    const route = findBackendRoute(TABLE, ref);
    return route ? route.roles.includes(role) : false;
  });
}

describe('角色矩阵渲染级回归（真实 Layout 侧栏）', () => {
  it('viewer：侧栏非空，唯一入口是只读落点 /reasoning', () => {
    const hrefs = renderSidebar(['viewer'], '/reasoning');
    expect(hrefs).toEqual(['/reasoning']);
  });

  it('viewer：侧栏不出现工厂运行台（否则 403 → Forbidden → 又链回工厂运行台的死循环）', () => {
    const hrefs = renderSidebar(['viewer'], '/reasoning');
    expect(hrefs).not.toContain('/factory-operations');
  });

  it('workshop_lead：不再看到工厂运行台（后端不放行其主查询），班次工作台仍在', () => {
    const hrefs = renderSidebar(['workshop_lead'], '/command-map');
    expect(hrefs).toContain('/command-map');
    expect(hrefs).not.toContain('/factory-operations');
  });

  it('dispatcher：不再看到审批控制台（后端否决其审批主查询）', () => {
    const hrefs = renderSidebar(['dispatcher'], '/scheduling');
    expect(hrefs).toContain('/scheduling');
    expect(hrefs).not.toContain('/approval-console');
  });

  it('safety_admin：审批控制台已可见（后端放行、此前前端无入口）', () => {
    const hrefs = renderSidebar(['safety_admin'], '/approval-console');
    expect(hrefs).toContain('/approval-console');
  });

  it('每个角色的落地页都在侧栏里可达，且渲染出的链接没有一条是 403', () => {
    const problems: string[] = [];
    for (const role of EWOH_ROLES) {
      const landing = defaultLandingPath([role]);
      const hrefs = renderSidebar([role], landing);
      if (!hrefs.includes(landing)) {
        problems.push(`${role}: 落地页 ${landing} 未出现在侧栏（hrefs=${JSON.stringify(hrefs)}）`);
      }
      for (const href of hrefs) {
        if (!roleCanOpen(role, href)) {
          problems.push(`${role}: 侧栏渲染出 403 链接 ${href}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('侧栏渲染集合与 getVisibleNavGroups 一致（组件不得绕过角色过滤）', () => {
    const problems: string[] = [];
    for (const role of EWOH_ROLES) {
      const landing = defaultLandingPath([role]);
      const expected = getVisibleNavGroups([role]).flatMap((group) =>
        group.items.map((item) => item.to),
      );
      const hrefs = renderSidebar([role], landing);
      const unexpected = hrefs.filter((href) => !expected.includes(href));
      if (unexpected.length > 0) {
        problems.push(
          `${role}: 渲染出未授权入口 [${unexpected.join(', ')}]；` +
            `应可见=${JSON.stringify(expected)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('navGroups 里不存在重复路径（重复会让渲染出两条同目标链接）', () => {
    const paths = navGroups.flatMap((group) => group.items.map((item) => item.to));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
