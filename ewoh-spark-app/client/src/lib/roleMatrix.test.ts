/* FE-2 角色矩阵一致性门禁。
 *
 * 背景：角色事实是双源的——前端 client/src/lib/navigation.ts 的 navGroups[].roles，
 * 后端 server/modules/shared/route-role.policy.ts + 各 controller 的 @Roles。
 * 此前两者没有任何比对测试（navigation.ia.test.ts 只锁前端结构），
 * 于是漂移不会被发现，直接表现为两类线上事故：
 *   · 前端给入口、后端拒绝 → 用户点进去 403，或页面主查询失败被渲染成"暂无数据"；
 *   · 后端放行、前端无入口 → 角色面板的承诺落空。
 *
 * 本测试把两边接起来：
 *   1. 断言契约里的每条路由都真实存在于后端路由表（后端改名/删路由 → 失败）；
 *   2. 断言 navGroups 的每个页面都登记了契约、契约里没有多余页面（新增页面必须登记）；
 *   3. 403 门禁：前端可见角色 ⊆ 后端放行角色（越权入口 / 后端收窄角色 → 失败）；
 *   4. 死入口门禁：后端**显式**放行的角色 ⊆ 前端可见角色
 *      （ANY_AUTHENTICATED 开放读路由除外——那是"谁都能读"，导航按任务域裁剪是产品决策）。
 *
 * 失败信息一律打印两侧角色集，便于直接定位该改前端还是该改后端。
 */
import * as path from 'node:path';
import { navGroups } from './navigation';
import { IMPLICIT_ADMIN_ROLE, PAGE_API_CONTRACT, CONTRACT_ROLE_UNIVERSE } from './roleMatrix';
import {
  buildBackendRouteTable,
  findBackendRoute,
  type BackendRoute,
} from './roleMatrixBackend';

const APP_ROOT = path.resolve(__dirname, '../../..');
const MODULES_ROOT = path.join(APP_ROOT, 'server/modules');

const TABLE: BackendRoute[] = buildBackendRouteTable(MODULES_ROOT, APP_ROOT);

const NAV_ROLES: Record<string, string[]> = Object.fromEntries(
  navGroups.flatMap((group) => group.items.map((item) => [item.to, item.roles as string[]])),
);

/** hasRoleAccess 对 global_admin 无条件放行，比对时两边都先摘掉它。 */
function withoutAdmin(roles: readonly string[]): string[] {
  return roles.filter((role) => role !== IMPLICIT_ADMIN_ROLE);
}

describe('roleMatrix 契约完整性', () => {
  it('后端路由表可解析且覆盖全部 controller（零遗漏，含默认拒绝路由）', () => {
    expect(TABLE.length).toBeGreaterThan(400);
    const undeclared = TABLE.filter((route) => route.roles.length === 0 && !route.isPublic);
    expect(
      undeclared.map((route) => `${route.controller} ${route.method} ${route.path}`),
    ).toEqual([]);
  });

  it('契约里的每条路由都真实存在（后端改名/改前缀/删路由即失败）', () => {
    const dangling: string[] = [];
    for (const [page, refs] of Object.entries(PAGE_API_CONTRACT)) {
      for (const ref of refs) {
        if (!findBackendRoute(TABLE, ref)) {
          dangling.push(`${page} → ${ref.method} ${ref.path}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('页面路径与契约一一对应（新增页面必须登记门禁，否则本测试失败）', () => {
    const navPaths = Object.keys(NAV_ROLES).sort();
    const contractPaths = Object.keys(PAGE_API_CONTRACT).sort();
    expect(contractPaths).toEqual(navPaths);
  });

  it('前端角色全集与 types/ewoh.ts 注册表同源', () => {
    const navRoleUniverse = new Set(
      navGroups.flatMap((group) => group.items.flatMap((item) => item.roles as string[])),
    );
    const unknown = [...navRoleUniverse].filter(
      (role) => !CONTRACT_ROLE_UNIVERSE.includes(role),
    );
    expect(unknown).toEqual([]);
  });
});

describe('roleMatrix 一致性门禁（前端导航 vs 后端 @Roles）', () => {
  const pages = Object.keys(PAGE_API_CONTRACT);

  it('403 门禁：前端可见角色不得超出后端放行（含 hasRoleAccess 的隐含 global_admin）', () => {
    const violations: string[] = [];
    for (const page of pages) {
      const gates = PAGE_API_CONTRACT[page].map((ref) => findBackendRoute(TABLE, ref)!);
      // 角色必须能调用页面的**每一条**主查询，否则部分内容 403。
      const backendAllowed = withoutAdmin(
        gates.reduce<string[]>(
          (acc, gate, idx) =>
            idx === 0 ? [...gate.roles] : acc.filter((role) => gate.roles.includes(role)),
          [],
        ),
      );
      const overreach = withoutAdmin(NAV_ROLES[page]).filter(
        (role) => !backendAllowed.includes(role),
      );
      if (overreach.length > 0) {
        violations.push(
          `${page}: 前端多给了 [${overreach.join(', ')}]；` +
            `前端=${JSON.stringify(withoutAdmin(NAV_ROLES[page]))} ` +
            `后端=${JSON.stringify(backendAllowed)} ` +
            `(门禁: ${PAGE_API_CONTRACT[page].map((r) => `${r.method} ${r.path}`).join(' + ')})`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('死入口门禁：后端显式放行的角色必须有前端入口（开放读 ANY_AUTHENTICATED 路由除外）', () => {
    const violations: string[] = [];
    for (const page of pages) {
      const gates = PAGE_API_CONTRACT[page].map((ref) => findBackendRoute(TABLE, ref)!);
      // 只要有一条门禁路由是"任何登录用户可读"，前端按任务域裁剪即为合法。
      if (gates.some((gate) => gate.open)) continue;
      const backendAllowed = withoutAdmin(
        gates.reduce<string[]>(
          (acc, gate, idx) =>
            idx === 0 ? [...gate.roles] : acc.filter((role) => gate.roles.includes(role)),
          [],
        ),
      );
      const frontendVisible = new Set(NAV_ROLES[page]);
      const missingEntry = backendAllowed.filter((role) => !frontendVisible.has(role));
      if (missingEntry.length > 0) {
        violations.push(
          `${page}: 后端放行但前端无入口 [${missingEntry.join(', ')}]；` +
            `后端=${JSON.stringify(backendAllowed)} ` +
            `前端=${JSON.stringify(withoutAdmin(NAV_ROLES[page]))}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('每个页面都必须有角色可见（不得存在谁都进不去的死页面）', () => {
    // 只看 navGroups 是否为空：roles=[global_admin] 是合法的（hasRoleAccess 对
    // global_admin 无条件放行），不属于死页面。
    const orphan = pages.filter((page) => NAV_ROLES[page].length === 0);
    expect(orphan).toEqual([]);
  });
});
