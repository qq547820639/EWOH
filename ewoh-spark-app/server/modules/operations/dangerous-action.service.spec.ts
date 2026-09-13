/// <reference types="jest" />
/* 危险动作确认流回归：
 * 1) 未知 action kind 必须 400（原实现直接查 ACTION_LABELS/ACTION_TEMPLATES
 *    表，TypeError → 500）；
 * 2) 幂等键必须带租户前缀——裸 `dangerous:{action}:{type}:{id}` 在以表
 *    owner 连接（RLS 不生效）的部署下会让 A/B 租户对同形 (type,id) 的
 *    确认互相吞并（B 拿到 A 的 actionId、B 的确认审计丢失）。 */
import { BadRequestException } from '@nestjs/common';
import { DangerousActionService } from './dangerous-action.service';
import type { DangerousConfirmInput } from './dangerous-action.service';

function makeDeps() {
  const keys: string[] = [];
  const stored = new Map<string, { actionId: string }>();
  const idempotencyService = {
    // 与真实 IdempotencyService 相同的重放语义：同 key 返回既有结果，不重复执行。
    executeWithPayload: async (key: string, _payload: unknown, op: () => Promise<{ actionId: string }>) => {
      keys.push(key);
      const existing = stored.get(key);
      if (existing) return existing;
      const result = await op();
      stored.set(key, result);
      return result;
    },
  };
  const audits: Array<{ orgId?: string }> = [];
  const auditService = {
    appendAuditLog: async (entry: { orgId?: string }) => {
      audits.push(entry);
    },
  };
  return { keys, audits, idempotencyService, auditService };
}

describe('DangerousActionService.confirm/preview', () => {
  it('未知 kind → 400（而非 TypeError 500）', async () => {
    const deps = makeDeps();
    const service = new DangerousActionService(
      deps.idempotencyService as never,
      deps.auditService as never,
    );
    expect(() =>
      service.preview({ action: 'nope' as never, targetType: 'workOrder', targetId: 'WO-1' }),
    ).toThrow(BadRequestException);
    await expect(
      service.confirm(
        { userId: 'u1', primaryOrgId: 'org-A' },
        { action: 'nuke' as never, targetType: 'workOrder', targetId: 'WO-1' },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(deps.audits).toHaveLength(0);
  });

  it('同一 (action,target) 在不同租户使用不同幂等键（不互相吞并）', async () => {
    const deps = makeDeps();
    const service = new DangerousActionService(
      deps.idempotencyService as never,
      deps.auditService as never,
    );
    const input: DangerousConfirmInput = {
      action: 'delete',
      targetType: 'workOrder',
      targetId: 'WO-1',
    };
    await service.confirm({ userId: 'u1', primaryOrgId: 'org-A' }, input);
    await service.confirm({ userId: 'u2', primaryOrgId: 'org-B' }, input);
    expect(deps.keys).toHaveLength(2);
    expect(deps.keys[0]).not.toBe(deps.keys[1]);
    expect(deps.keys[0]).toContain('org-A');
    expect(deps.keys[1]).toContain('org-B');
    // 两个租户各自留下确认审计（B 的确认不再被 A 的记录吞掉）。
    expect(deps.audits.map((a) => a.orgId)).toEqual(['org-A', 'org-B']);
  });

  it('同租户重放同 key：幂等键稳定（回放返回同一动作）', async () => {
    const deps = makeDeps();
    const service = new DangerousActionService(
      deps.idempotencyService as never,
      deps.auditService as never,
    );
    const input: DangerousConfirmInput = {
      action: 'cancel',
      targetType: 'maintenanceTask',
      targetId: 'MT-9',
    };
    const first = await service.confirm({ userId: 'u1', primaryOrgId: 'org-A' }, input);
    const replay = await service.confirm({ userId: 'u1', primaryOrgId: 'org-A' }, input);
    expect(deps.keys[0]).toBe(deps.keys[1]);
    expect(replay.actionId).toBe(first.actionId);
  });
});
