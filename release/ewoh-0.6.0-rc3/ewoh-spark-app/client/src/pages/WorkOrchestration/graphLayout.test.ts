import { buildGraphLayout, filterGraphItems, statusTone } from './graphLayout';

const items = [
  {
    id: 'W0',
    title: 'baseline',
    type: 'wave',
    status: 'Done',
    owner: 'AG-00',
  },
  {
    id: 'G2',
    title: 'contracts',
    type: 'gate',
    status: 'Passed',
    owner: 'AG-04',
  },
  {
    id: 'G10',
    title: 'production',
    type: 'gate',
    status: 'Pending',
    owner: 'AG-51',
  },
];

const edges = [
  { id: 'E-1', from: 'W0', to: 'G2', edgeType: 'depends' },
  { id: 'E-2', from: 'G2', to: 'G10', edgeType: 'depends' },
];

describe('graphLayout', () => {
  it('builds layered wave and gate nodes', () => {
    const layout = buildGraphLayout(items, edges, 'waves-gates');
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(700);
    expect(layout.height).toBeGreaterThan(300);
  });

  it('filters to waves only', () => {
    const layout = buildGraphLayout(items, edges, 'waves');
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
  });

  it('builds all nodes when scope is all', () => {
    const layout = buildGraphLayout(items, edges, 'all');
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
  });

  it('maps status to a tone', () => {
    expect(statusTone('Passed')).toBe('emerald');
    expect(statusTone('Blocked')).toBe('red');
    expect(statusTone('In Progress')).toBe('blue');
    expect(statusTone('Pending')).toBe('amber');
  });

  it('filters graph items by id, title, owner, status, or wave', () => {
    const filtered = filterGraphItems(items, 'contracts');
    expect(filtered.map((item) => item.id)).toEqual(['G2']);
    expect(filterGraphItems(items, 'AG-00').map((item) => item.id)).toEqual(['W0']);
    expect(filterGraphItems(items, 'missing')).toEqual([]);
    expect(filterGraphItems(items, '')).toHaveLength(3);
  });
});
