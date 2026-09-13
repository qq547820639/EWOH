/* roleMatrixBackend 单元回归（2026-09-13 对抗自查）。
 *
 * 背景：roleMatrix.test.ts 用"全量真路由表 vs 前端导航"做门禁，但解析器自身
 * 的语法覆盖没有独立测试——此前三个静默误析（都是拿真 controller 源码实测复现的）：
 *   1. `@Roles(...CONST)` 常量展开被当成"未声明"→ 静默回退类级/FALLBACK 角色：
 *      POST /api/approvals/:id/bypass（实际 global_admin）被解析成三角色；
 *      POST /api/shifts（SHIFT_WRITE_ROLES 四角色）被解析成 ANY_AUTH 七角色；
 *   2. `@Sse('v2/stream')` 不在动词表里 → 整条路由从表里消失；
 *   3. `@Get(['/', '*'])` 数组路径解析成垃圾路径字符串。
 * 这里用最小源码样例把三条口径钉死；全树级的端到端比对仍在 roleMatrix.test.ts。
 */
import { parseControllerSource } from './roleMatrixBackend';

const NO_FALLBACK: Record<string, string[]> = {};
const ANY_AUTH = ['viewer', 'worker', 'global_admin'];

function parse(source: string) {
  return parseControllerSource(source, NO_FALLBACK, ANY_AUTH);
}

describe('roleMatrixBackend 解析口径（与 roles.guard.canActivate 一致）', () => {
  it('@Roles(...同文件常量)：解析常量内容，而不是回退到类级角色', () => {
    const routes = parse(`
      import { Roles } from '../shared/roles.decorator';

      export const SHIFT_WRITE_ROLES = [
        'global_admin',
        'dispatcher',
      ] as const;

      @Controller('api/shifts')
      @Roles(...ANY_AUTHENTICATED_ROLES)
      export class ShiftController {
        @Post()
        @Roles(...SHIFT_WRITE_ROLES)
        upsert() {}
      }
    `);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'POST', path: '/api/shifts' });
    // 关键断言：方法级常量展开生效（不是类级 ANY_AUTH 的七角色）
    expect(routes[0].roles).toEqual(['global_admin', 'dispatcher']);
    expect(routes[0].open).toBe(false);
  });

  it('@Roles(...未在文件内定义的常量)：抛错（fail-loud），绝不静默回退类级角色', () => {
    expect(() =>
      parse(`
        @Controller('api/approvals')
        @Roles('workshop_lead', 'safety_admin')
        export class ApprovalController {
          @Post(':id/bypass')
          @Roles(...IMPORTED_BYPASS_ROLES)
          bypass() {}
        }
      `),
    ).toThrow(/IMPORTED_BYPASS_ROLES/);
  });

  it('@Sse：按 GET 路由登记（Nest 底层即 GET），不丢路由', () => {
    const routes = parse(`
      @Controller('api/scheduler')
      export class SchedulerController {
        @Sse('v2/stream')
        stream() {}
      }
    `);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/scheduler/v2/stream' });
  });

  it('@Get([\'/\', \'*\'])：数组路径逐元素展开成多条路由', () => {
    const routes = parse(`
      @Controller()
      @Public()
      export class ViewController {
        @Get(['/', '*'])
        render() {}
      }
    `);
    expect(routes.map((r) => r.path).sort()).toEqual(['/', '/*']);
    expect(routes.every((r) => r.isPublic)).toBe(true);
    expect(routes.every((r) => r.roles.length === 0)).toBe(true);
  });

  it('@Get() 无参路径：仍产出单条路由（前缀即路径）', () => {
    const routes = parse(`
      @Controller('api/tasks')
      @Roles('dispatcher')
      export class TaskController {
        @Get()
        list() {}
      }
    `);
    expect(routes).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/tasks', roles: ['dispatcher'] }),
    ]);
  });
});
