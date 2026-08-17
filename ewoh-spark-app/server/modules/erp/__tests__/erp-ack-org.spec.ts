/// <reference types="jest" />
/* R2-SAM-001 回归：ackOutbound 的 SELECT/UPDATE 必须带 org 归属谓词——
 * 非 global_admin 只能确认/失败化本 org 的 ERP outbound；
 * global_admin 放行；缺失 org 上下文 → 401（requireOrgId）。 */
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ErpService } from '../erp.service';

/** 递归收集 drizzle SQL 谓词里的绑定参数值（Param.value）。 */
function collectParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const withChunks = node as { queryChunks?: unknown[] };
  if (Array.isArray(withChunks.queryChunks)) {
    for (const chunk of withChunks.queryChunks) {
      collectParams(chunk, out);
    }
    return out;
  }
  if ('value' in (node as Record<string, unknown>)) {
    out.push((node as { value: unknown }).value);
  }
  return out;
}

/**
 * 模拟带 org 谓词的行可见性：
 * - actorOrgId 提供 && 谓词参数含 actorOrgId && 行归属不同 → 不可见（谓词过滤）；
 * - 谓词不含 actorOrgId（global_admin 分支未强制 org）→ 全可见。
 */
function makeDb(rowOrgId: string, actorOrgId?: string) {
  const row = {
    eventId: 'EVT-1',
    eventCode: 'ERP_OUTBOUND',
    orgId: rowOrgId,
    status: 'pending',
    evidenceJson: { attempts: 0 },
  };
  const visibleUnder = (cond: unknown): boolean => {
    const params = collectParams(cond);
    if (actorOrgId === undefined || !params.includes(actorOrgId)) return true;
    return rowOrgId === actorOrgId;
  };
  const selectWhere = jest.fn((cond: unknown) => ({
    then: (resolve: (rows: unknown[]) => void) => resolve(visibleUnder(cond) ? [row] : []),
  }));
  const updateWhere = jest.fn((cond: unknown) => ({
    returning: () =>
      Promise.resolve(
        visibleUnder(cond)
          ? [{ ...row, status: 'sent', evidenceJson: { attempts: 1 }, handlerAction: 'sent' }]
          : [],
      ),
  }));
  const db = {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: selectWhere })) })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: updateWhere })),
    })),
  };
  return { db, selectWhere, updateWhere };
}

function makeService(rowOrgId: string, actorOrgId?: string) {
  const { db, selectWhere, updateWhere } = makeDb(rowOrgId, actorOrgId);
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const service = new ErpService(db as never, audit as never, {} as never);
  return { service, selectWhere, updateWhere, audit };
}

const ACTOR_A = {
  userId: 'u-a',
  primaryOrgId: 'org-a',
  accessibleOrgIds: ['org-a'],
  roles: ['workshop_lead'],
  isGlobalAdmin: false,
};

describe('R2-SAM-001: ackOutbound org 谓词 + 归属校验', () => {
  it('本 org 行：SELECT/UPDATE 谓词均含本 org 参数，确认成功', async () => {
    const { service, selectWhere, updateWhere } = makeService('org-a', 'org-a');
    const updated = await service.ackOutbound('EVT-1', { success: true }, ACTOR_A as never);
    expect(updated.status).toBe('sent');
    expect(collectParams(selectWhere.mock.calls[0][0])).toContain('org-a');
    expect(collectParams(updateWhere.mock.calls[0][0])).toContain('org-a');
  });

  it('他 org 行：org 谓词过滤后不可见 → 404（不再可跨租户 ack）', async () => {
    const { service } = makeService('org-b', 'org-a');
    await expect(
      service.ackOutbound('EVT-1', { success: true }, ACTOR_A as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('global_admin：谓词无 org 强制参数，跨 org 行仍可运维 ack', async () => {
    const { service, selectWhere } = makeService('org-b');
    const admin = { ...ACTOR_A, isGlobalAdmin: true } as never;
    const updated = await service.ackOutbound('EVT-1', { success: true }, admin);
    expect(updated.status).toBe('sent');
    expect(collectParams(selectWhere.mock.calls[0][0])).not.toContain('org-a');
  });

  it('缺失 org 上下文 → 401（fail-closed）', async () => {
    const { service } = makeService('org-a');
    await expect(
      service.ackOutbound('EVT-1', { success: true }, undefined),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('UPDATE 被并发状态 CAS 拦截 → 409（既有语义保留）', async () => {
    const { db } = makeDb('org-a', 'org-a');
    const conflictDb = {
      ...db,
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: () => Promise.resolve([]) })),
        })),
      })),
    };
    const service = new ErpService(conflictDb as never, { appendAuditLog: jest.fn() } as never, {} as never);
    await expect(
      service.ackOutbound('EVT-1', { success: true }, ACTOR_A as never),
    ).rejects.toThrow(ConflictException);
  });
});
