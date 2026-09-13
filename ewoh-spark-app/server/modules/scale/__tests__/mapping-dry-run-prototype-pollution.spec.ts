/// <reference types="jest" />
/* dryRunMapping 原型污染回归（CWE-1321）：
 * mapping rule.to 含 `__proto__` 中间段时，writeJsonPath 的链式遍历会把
 * current 指针引到 Object.prototype（`{}['__proto__']` 即 Object.prototype，
 * typeof 为 'object' 直接过守卫），最终赋值变成全局原型污染——进程级生效、
 * 重启前不可恢复，影响后续所有请求。修复后必须以 ILLEGAL_TARGET_PATH
 * 结构化报错拒绝该条规则，且绝不触碰 Object.prototype。 */
import { ScaleService } from '../scale.service';

const actor = { userId: 'u1', primaryOrgId: 'org-1', roles: ['dispatcher'] };

function serviceWithRules(rules: Array<Record<string, unknown>>): ScaleService {
  const row = {
    packageId: 'MAP-POLLUTE',
    packageType: 'mapping',
    name: 'pwn-mapping',
    version: '1.0.0',
    status: 'draft',
    manifestJson: {
      mappingSchemaVersion: 'v1',
      source: { system: 'mes', schemaRef: 's1' },
      target: { system: 'erp', schemaRef: 't1' },
      rules,
    },
  };
  // 只需要 getAssetPackage 的 select().from().where() 链返回该行。
  const dbStub = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
  };
  const auditStub = { appendAuditLog: async () => undefined };
  return new ScaleService(dbStub as never, auditStub as never);
}

afterEach(() => {
  // 防御：即便断言失败也不把污染带进同进程的其它测试。
  delete (Object.prototype as Record<string, unknown>).polluted;
});

it('rule.to 含 __proto__ 段：不得污染 Object.prototype，且以 ILLEGAL_TARGET_PATH 报错', async () => {
  const service = serviceWithRules([{ from: 'a.b', to: '__proto__.polluted' }]);
  const result = await service.dryRunMapping(
    'MAP-POLLUTE',
    { a: { b: 'pwned' } },
    actor as never,
  );
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(result.passed).toBe(false);
  expect(
    result.errors.some((entry) => entry.code === 'ILLEGAL_TARGET_PATH'),
  ).toBe(true);
});

it('rule.to 末段为 __proto__：同样拒绝（改写对象原型）', async () => {
  const service = serviceWithRules([{ from: 'a.b', to: 'evil.__proto__' }]);
  const result = await service.dryRunMapping(
    'MAP-POLLUTE',
    { a: { b: { injected: true } } },
    actor as never,
  );
  expect(
    result.errors.some((entry) => entry.code === 'ILLEGAL_TARGET_PATH'),
  ).toBe(true);
});

it('合法 rule.to 仍正常写入 mapped 输出（守卫不破坏既有路径）', async () => {
  const service = serviceWithRules([{ from: 'a.b', to: 'target.field' }]);
  const result = await service.dryRunMapping(
    'MAP-POLLUTE',
    { a: { b: 'v' } },
    actor as never,
  );
  expect(result.passed).toBe(true);
  expect((result.mapped as Record<string, unknown>).target).toEqual({
    field: 'v',
  });
});
