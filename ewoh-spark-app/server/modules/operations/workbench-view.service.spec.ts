import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  InMemoryWorkbenchViewStore,
  WorkbenchViewService,
} from './workbench-view.service';

describe('WorkbenchViewService shared-view deletion', () => {
  const owner = { userId: 'owner-1', primaryOrgId: 'org-1', roles: ['worker'] };
  const admin = { userId: 'admin-1', primaryOrgId: 'org-1', roles: ['global_admin'] };
  const member = { userId: 'member-1', primaryOrgId: 'org-1', roles: ['worker'] };

  async function createSharedService() {
    const store = new InMemoryWorkbenchViewStore();
    const service = new WorkbenchViewService(store);
    await service.saveView(owner, {
      key: 'operator.mySteps',
      role: 'operator',
      listKey: 'mySteps',
      filter: 'fault',
      shared: true,
    });
    return { service, store };
  }

  it('lists own and shared views without crossing organizations', async () => {
    const { service } = await createSharedService();
    await service.saveView(
      { userId: 'other-org', primaryOrgId: 'org-2', roles: [] },
      { key: 'operator.mySteps', role: 'operator', listKey: 'mySteps', shared: true },
    );
    const views = await service.listViews(member);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ ownerId: owner.userId, orgId: 'org-1' });
  });

  it('allows a global admin to delete a shared view in the same org', async () => {
    const { service } = await createSharedService();
    await expect(service.deleteView(admin, 'operator.mySteps')).resolves.toBeUndefined();
    await expect(service.listViews(member)).resolves.toEqual([]);
  });

  it('rejects a non-owner member deleting a shared view', async () => {
    const { service } = await createSharedService();
    await expect(service.deleteView(member, 'operator.mySteps')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects deletion of a view absent from the requester org', async () => {
    const { service } = await createSharedService();
    await expect(
      service.deleteView(
        { userId: 'any', primaryOrgId: 'org-2', roles: ['global_admin'] },
        'operator.mySteps',
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
