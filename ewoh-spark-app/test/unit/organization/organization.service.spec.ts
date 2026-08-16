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

import { OrganizationService } from '../../../server/modules/organization/organization.service';
import { ewohOrganization } from '@server/database/schema';

describe('OrganizationService createOrganization org 归属（NO-13aa / ADR-075 续）', () => {
  it('org 行归属 = 自身 id（应用侧确定性 UUID，001 ewoh_org_visible RLS 对齐）', async () => {
    const insertRows: Array<Record<string, unknown>> = [];
    const db = {
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          if (table === ewohOrganization) insertRows.push(row);
          return { returning: jest.fn(async () => [row]) };
        }),
      })),
    };
    const svc = new OrganizationService(db as never, undefined as never);
    const created = await svc.createOrganization({
      name: '测试车间',
      orgType: 'workshop',
    } as never);
    expect(created).toBeDefined();
    const row = insertRows[0];
    expect(row.id).toBeDefined();
    expect(row.orgId).toBe(row.id);
  });
});
