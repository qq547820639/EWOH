/**
 * organizationLogic.test.ts — Organization 数据页纯逻辑测试（ADR-084，§17/§33）。
 */
import {
  ORG_TYPE_OPTIONS,
  ORG_TYPE_LABEL,
  orgTypeLabel,
  flattenTree,
  canSubmitOrg,
} from './organizationLogic';
import type { OrgNode } from './organizationLogic';

describe('organizationLogic', () => {
  describe('ORG_TYPE_OPTIONS / ORG_TYPE_LABEL', () => {
    it('has three entries covering group/factory/workshop', () => {
      expect(ORG_TYPE_OPTIONS).toHaveLength(3);
      expect(ORG_TYPE_LABEL.group).toBe('集团');
      expect(ORG_TYPE_LABEL.factory).toBe('工厂 / 基地');
      expect(ORG_TYPE_LABEL.workshop).toBe('车间');
    });
  });

  describe('orgTypeLabel', () => {
    it('returns Chinese label for known types', () => {
      expect(orgTypeLabel('group')).toBe('集团');
      expect(orgTypeLabel('factory')).toBe('工厂 / 基地');
    });

    it('falls back to raw value for unknown types', () => {
      expect(orgTypeLabel('warehouse')).toBe('warehouse');
    });
  });

  describe('flattenTree', () => {
    const tree: OrgNode[] = [
      {
        id: 'g1',
        name: '总部',
        orgType: 'group',
        children: [
          {
            id: 'f1',
            name: '华东基地',
            orgType: 'factory',
            children: [
              { id: 'w1', name: '总装一车间', orgType: 'workshop', children: [] },
            ],
          },
          {
            id: 'f2',
            name: '华南基地',
            orgType: 'factory',
            children: [],
          },
        ],
      },
    ];

    it('flattens tree with depth-indented labels', () => {
      const options = flattenTree(tree);
      expect(options).toHaveLength(4);
      expect(options[0]).toEqual({ id: 'g1', label: '总部（集团）' });
      expect(options[1].id).toBe('f1');
      expect(options[1].label).toContain('华东基地');
      expect(options[1].label).toContain('　'); // full-width space indent
      expect(options[2].id).toBe('w1');
      expect(options[2].label).toContain('总装一车间');
      // deeper indent
      expect(options[2].label.split('　').length).toBeGreaterThan(
        options[1].label.split('　').length,
      );
    });

    it('returns empty for empty tree', () => {
      expect(flattenTree([])).toEqual([]);
    });

    it('handles flat tree (no children)', () => {
      const flat: OrgNode[] = [
        { id: 'a', name: 'A', orgType: 'group', children: [] },
      ];
      expect(flattenTree(flat)).toEqual([{ id: 'a', label: 'A（集团）' }]);
    });

    it('unknown orgType falls back to raw value in label', () => {
      const nodes: OrgNode[] = [
        { id: 'x', name: 'X', orgType: 'warehouse', children: [] },
      ];
      expect(flattenTree(nodes)[0].label).toContain('warehouse');
    });
  });

  describe('canSubmitOrg', () => {
    it('true when name and orgType are non-empty and not pending', () => {
      expect(canSubmitOrg('总装一车间', 'workshop', false)).toBe(true);
    });

    it('false when name is empty', () => {
      expect(canSubmitOrg('', 'workshop', false)).toBe(false);
      expect(canSubmitOrg('   ', 'workshop', false)).toBe(false);
    });

    it('false when orgType is empty', () => {
      expect(canSubmitOrg('总装一车间', '', false)).toBe(false);
    });

    it('false when pending', () => {
      expect(canSubmitOrg('总装一车间', 'workshop', true)).toBe(false);
    });
  });
});
