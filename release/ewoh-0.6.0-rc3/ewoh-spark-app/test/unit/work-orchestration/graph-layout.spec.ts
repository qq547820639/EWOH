import { buildGraphLayout, statusTone } from '../../../client/src/pages/WorkOrchestration/graphLayout';

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

describe('work graph layout', () => {
  it('builds a layered layout from waves and gates', () => {
    const layout = buildGraphLayout(items, edges, 'waves-gates');
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(700);
    expect(layout.height).toBeGreaterThan(300);
  });

  it('filters to a single node scope', () => {
    const layout = buildGraphLayout(items, edges, 'waves');
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
  });

  it('maps statuses to deterministic tones', () => {
    expect(statusTone('Passed')).toBe('emerald');
    expect(statusTone('Blocked')).toBe('red');
    expect(statusTone('In Progress')).toBe('blue');
    expect(statusTone('Pending')).toBe('amber');
  });
});
