import { buildOrgTree, coarseHealthRisk } from '../../../server/modules/organization/organization.service';

describe('OrganizationService pure helpers', () => {
  it('builds a tree with stable root order', () => {
    const tree = buildOrgTree([
      { id: 'c', name: 'C', orgType: 'workshop', parentId: 'a', status: 'active', description: null },
      { id: 'a', name: 'A', orgType: 'group', parentId: null, status: 'active', description: null },
      { id: 'b', name: 'B', orgType: 'base', parentId: 'a', status: 'active', description: null },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('a');
    expect(tree[0].children.map((node) => node.id).sort()).toEqual(['b', 'c']);
  });

  it('maps sensitive load values to coarse risk', () => {
    expect(coarseHealthRisk({ loadLevel: 0.9 })).toBe('high');
    expect(coarseHealthRisk({ fatigueLevel: 0.6 })).toBe('medium');
    expect(coarseHealthRisk(null)).toBe('low');
  });
});
