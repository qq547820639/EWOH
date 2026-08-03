import {
  DatabaseOrgHierarchyProvider,
  ORG_SCOPE_CACHE_TTL_MS,
  OrgScopeService,
  type OrgHierarchyProvider,
} from '../../../server/modules/shared/org-scope.service';

describe('OrgScopeService', () => {
  const nodes = {
    a: { id: 'a', parentId: null, config: { theme: 'light', rate: 1 } },
    b: { id: 'b', parentId: 'a', config: { rate: 2 } },
    c: { id: 'c', parentId: 'b', config: {} },
  };

  function createProvider(): OrgHierarchyProvider & {
    loadOrg: jest.Mock;
    loadChildren: jest.Mock;
  } {
    return {
      loadOrg: jest.fn(async (orgId: string) => nodes[orgId as keyof typeof nodes] ?? null),
      loadChildren: jest.fn(async (parentId: string) =>
        Object.values(nodes).filter((node) => node.parentId === parentId),
      ),
    } as OrgHierarchyProvider & { loadOrg: jest.Mock; loadChildren: jest.Mock };
  }

  it('resolves child scope, inherited config, and reuses a 5-minute cache', async () => {
    const provider = createProvider();
    const service = new OrgScopeService(provider);

    const first = await service.resolveOrgScope('c');
    expect(first.orgIds).toEqual(['c']);
    expect(first.ancestorIds).toEqual(['a', 'b']);
    expect(first.inheritedConfig).toEqual({ theme: 'light', rate: 2 });
    expect(first.cached).toBe(false);

    const second = await service.resolveOrgScope('c');
    expect(second).toBe(first);
    expect(second.cached).toBe(true);

    const loadOrgCalls = provider.loadOrg.mock.calls.length;
    await service.resolveOrgScope('c');
    expect(provider.loadOrg.mock.calls.length).toBe(loadOrgCalls);

    const b = await service.resolveOrgScope('b');
    expect(b.orgIds).toEqual(['b', 'c']);
    expect(b.inheritedConfig).toEqual({ theme: 'light', rate: 2 });
  });

  it('invalidates cached subtrees and notifies listeners', async () => {
    const provider = createProvider();
    const service = new OrgScopeService(provider);
    const listener = jest.fn();
    const unsubscribe = service.onInvalidate(listener);

    await service.resolveOrgScope('b');
    await service.resolveOrgScope('c');
    expect(service.getCacheSize()).toBe(2);

    service.invalidate('b');
    expect(listener).toHaveBeenCalledWith('b');
    expect(service.getCacheSize()).toBe(0);

    const refreshed = await service.resolveOrgScope('c');
    expect(refreshed.cached).toBe(false);

    unsubscribe();
    service.invalidate('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('expires cache entries after the 5-minute TTL', async () => {
    jest.useFakeTimers();
    try {
      const service = new OrgScopeService(createProvider());
      await service.resolveOrgScope('a');

      jest.advanceTimersByTime(ORG_SCOPE_CACHE_TTL_MS + 1);
      const refreshed = await service.resolveOrgScope('a');
      expect(refreshed.cached).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves parent, child, and grandchild org ids', async () => {
    const service = new OrgScopeService(createProvider());

    const scope = await service.resolveOrgScope('a');

    expect(scope.orgIds).toEqual(['a', 'b', 'c']);
  });

  it('loads the org hierarchy from ewoh_organization rows', async () => {
    const root = { id: 'row-root', org_id: 'org-root', parent_id: null };
    const child = { id: 'row-child', org_id: 'org-child', parent_id: 'row-root' };
    const grandchild = {
      id: 'row-grand',
      org_id: 'org-grand',
      parent_id: 'row-child',
    };
    const execute = jest.fn(async (statement: unknown) => {
      const text = JSON.stringify(statement);
      if (text.includes('ewoh_find_org_children')) {
        if (text.includes('org-child') || text.includes('row-child')) {
          return [grandchild];
        }
        return [child];
      }
      if (text.includes('ewoh_find_org(')) {
        if (text.includes('row-child')) return [child];
        if (text.includes('row-grand')) return [grandchild];
        return [root];
      }
      return [];
    });

    const provider = new DatabaseOrgHierarchyProvider({ execute } as never);
    const service = new OrgScopeService(provider);

    const scope = await service.resolveOrgScope('org-root');

    expect(scope.orgIds).toEqual(['org-root', 'org-child', 'org-grand']);
  });
});
