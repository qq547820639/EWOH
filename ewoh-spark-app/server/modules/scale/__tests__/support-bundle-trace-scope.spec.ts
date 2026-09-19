/**
 * generateSupportBundle trace 租户作用域钉死（R2-SNZ-007 回归）。
 *
 * TracingService.list 是 fail-closed 的：非 global_admin 缺 actor → 400
 * （"org context missing: trace list requires tenant context"）；global_admin
 * 缺 actor → 返回全租户混存 traces。两者都不可接受：前者让支持包端点对
 * 非 global 调用方整体 400，后者把其他租户的 trace 泄漏进单租户支持包。
 * ScaleService.generateSupportBundle 因此必须把 actor 透传给 list()
 * （2026-09-18 E2E ewoh-http 实测回归：漏传导致 POST
 * /api/scale/fleet/support-bundle 稳定 400）。
 */
/// <reference types="jest" />
import { ScaleService } from '../scale.service';
import type { TracingService } from '../../tracing/tracing.service';
import type { AuditService } from '../../shared/audit.service';
import type { OrgContext } from '../../shared/org-context.interceptor';
import { ewohFactoryProfile, ewohFactoryTemplate, ewohAssetPackage } from '@server/database/schema';

const ACTOR: OrgContext = {
  userId: 'bundle-user',
  primaryOrgId: 'org-1',
  role: 'dispatcher',
  accessibleOrgIds: ['org-1'],
  isGlobalAdmin: false,
};

/** thenable select 链（fleetStatus 的三个 listX 均为 select/from/where/orderBy）。 */
function makeDb(): any {
  const chain: any = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return {
    select: () => ({
      from: () => chain,
    }),
  };
}

describe('generateSupportBundle trace 租户作用域（R2-SNZ-007）', () => {
  it('把 actor 透传给 tracingService.list，trace 只含本租户记录', async () => {
    const list = jest.fn().mockReturnValue([
      { traceId: 't-1', path: '/api/me', orgId: 'org-1' },
    ]);
    const auditService = {
      appendAuditLog: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    const svc = new ScaleService(
      makeDb(),
      auditService,
      { list } as unknown as TracingService,
    );

    const bundle = await svc.generateSupportBundle(ACTOR);

    expect(list).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ primaryOrgId: 'org-1', isGlobalAdmin: false }),
    );
    expect(bundle.orgId).toBe('org-1');
    expect(bundle.traceCount).toBe(1);
    expect(bundle.traces).toEqual([expect.objectContaining({ traceId: 't-1' })]);
  });

  it('无 tracingService 时 bundle 照常生成（traceCount=0，traces 空数组）', async () => {
    const auditService = {
      appendAuditLog: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    const svc = new ScaleService(makeDb(), auditService, undefined);

    const bundle = await svc.generateSupportBundle(ACTOR);

    expect(bundle.orgId).toBe('org-1');
    expect(bundle.traceCount).toBe(0);
    expect(bundle.traces).toEqual([]);
  });
});

// ewohFactoryProfile / ewohFactoryTemplate / ewohAssetPackage 仅用于保证
// schema 表身份在本测试模块图中加载（fleetStatus 按表身份构建查询）。
void [ewohFactoryProfile, ewohFactoryTemplate, ewohAssetPackage];
