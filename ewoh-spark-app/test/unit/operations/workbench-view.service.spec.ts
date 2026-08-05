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
    await service.saveView(alice, { key: 'a', role: 'operator', listKey: 'mySteps', shared: true });
    await service.saveView(bob, { key: 'b', role: 'manager', listKey: 'riskTrend', shared: false });

    const aliceViews = await service.listViews(alice);
    expect(aliceViews.map((v) => v.key)).toEqual(expect.arrayContaining(['a']));
    // Alice can see bob's shared? bob's view is NOT shared, so no.
    expect(aliceViews.map((v) => v.key)).not.toContain('b');
  });

  it('a shared view is visible to another member of the same org', async () => {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);
    await service.saveView(alice, { key: 'shared.1', role: 'operator', listKey: 'mySteps', shared: true });

    const bobViews = await service.listViews(bob);
    expect(bobViews.map((v) => v.key)).toContain('shared.1');
    // A different org cannot see it.
    const carolViews = await service.listViews(carol);
    expect(carolViews.map((v) => v.key)).not.toContain('shared.1');
  });

  it('only the owner (or admin) may delete a view', async () => {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);
    await service.saveView(alice, { key: 'owned', role: 'operator', listKey: 'mySteps' });

    await expect(service.deleteView(bob, 'owned')).rejects.toThrow(
      'only delete your own saved views',
    );
    await service.deleteView(alice, 'owned');
    await expect(service.listViews(alice)).resolves.toEqual([]);
  });

  it('rejects a view without key/role/listKey', async () => {
    const service = new WorkbenchViewService(new InMemoryWorkbenchViewStore());
    await expect(
      service.saveView(alice, { key: 'x', role: '', listKey: '' }),
    ).rejects.toThrow('requires key, role and listKey');
  });
});