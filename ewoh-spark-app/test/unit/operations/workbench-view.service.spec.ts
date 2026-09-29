import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  InMemoryWorkbenchViewStore,
  WorkbenchViewService,
} from '../../../server/modules/operations/workbench-view.service';

const alice = { userId: 'alice', primaryOrgId: 'org-1', roles: ['worker'] };
const bob = { userId: 'bob', primaryOrgId: 'org-1', roles: ['worker'] };
const carol = { userId: 'carol', primaryOrgId: 'org-2', roles: ['worker'] };

describe('WorkbenchViewService (服务端保存视图/跨设备/共享)', () => {
  it('upserts a saved view owned by the actor (server is source of truth)', async () => {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);

    const view = await service.saveView(alice, {
      key: 'operator.mySteps',
      role: 'operator',
      listKey: 'mySteps',
      filter: 'in_progress',
      sortKey: 'status',
      sortDir: 'asc',
      shared: true,
    });

    expect(view.ownerId).toBe('alice');
    expect(view.orgId).toBe('org-1');
    expect(view.filter).toBe('in_progress');
    expect(view.shared).toBe(true);
    expect(view.updatedAt).toBeTruthy();
  });

  it('lists own views plus org-shared views (cross-device sync)', async () => {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);
    await service.saveView(alice, { key: 'operator.mySteps', role: 'operator', listKey: 'mySteps', shared: true });
    await service.saveView(bob, { key: 'operator.mySteps', role: 'operator', listKey: 'mySteps', shared: false });

    const aliceViews = await service.listViews(alice);
    expect(aliceViews.map((v) => v.key)).toEqual(expect.arrayContaining(['operator.mySteps']));
    // Alice can see her own view; Bob's same-key view is private and is not returned.
    expect(aliceViews.filter((v) => v.ownerId === 'bob')).toHaveLength(0);
  });

  it('a shared view is visible to another member of the same org', async () => {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);
    await service.saveView(alice, { key: 'operator.mySteps', role: 'operator', listKey: 'mySteps', shared: true });

    const bobViews = await service.listViews(bob);
    expect(bobViews.map((v) => v.key)).toContain('operator.mySteps');
    // A different org cannot see it.
    const carolViews = await service.listViews(carol);
    expect(carolViews.map((v) => v.key)).not.toContain('operator.mySteps');
  });

  it('only the owner (or admin) may delete a view', async () => {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);
    await service.saveView(alice, { key: 'operator.mySteps', role: 'operator', listKey: 'mySteps' });

    // R2-SOP-019：InMemory store 的 get/remove 已按 (org, owner, key) 三元组
    // 归属校验（与 PostgresWorkbenchViewStore 谓词一致）——同 org 非 owner
    // 删除他人视图 → 404（不泄露存在性）；拒绝语义不变。
    await expect(service.deleteView(bob, 'operator.mySteps')).rejects.toThrow('view not found');
    await service.deleteView(alice, 'operator.mySteps');
    await expect(service.listViews(alice)).resolves.toEqual([]);
  });

  it('rejects a view without key/role/listKey', async () => {
    const service = new WorkbenchViewService(new InMemoryWorkbenchViewStore());
    await expect(
      service.saveView(alice, { key: 'x', role: '', listKey: '' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a saved view for a workbench role the caller cannot access', async () => {
    const service = new WorkbenchViewService(new InMemoryWorkbenchViewStore());
    await expect(
      service.saveView(alice, { key: 'manager.riskTrend', role: 'manager', listKey: 'riskTrend' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects mismatched key, role and listKey metadata', async () => {
    const service = new WorkbenchViewService(new InMemoryWorkbenchViewStore());
    await expect(
      service.saveView(alice, { key: 'operator.other', role: 'operator', listKey: 'mySteps' }),
    ).rejects.toThrow('view key must match');
    await expect(
      service.saveView(alice, { key: 'operator.mySteps', role: 'operator', listKey: 'delayedOrders' }),
    ).rejects.toThrow('listKey is invalid');
  });

  it('rejects an out-of-range saved view limit', async () => {
    const service = new WorkbenchViewService(new InMemoryWorkbenchViewStore());
    await expect(
      service.saveView(alice, { key: 'operator.mySteps', role: 'operator', listKey: 'mySteps', limit: 101 }),
    ).rejects.toThrow('view limit');
  });
});