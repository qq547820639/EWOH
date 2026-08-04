import {
  applyStageCollapse,
  buildGraphLayout,
  exceptionBackflowNodes,
  filterGraphItems,
  filterItemsByScope,
  groupStagesByWave,
  statusTone,
  traceDownstream,
  traceUpstream,
} from './graphLayout';

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

  it('groups items by wave when present', () => {
    const withWave = [
      { ...items[0], wave: 'W1' },
      { ...items[1], wave: 'W1' },
      { ...items[2], wave: 'W2' },
    ];
    const stages = groupStagesByWave(withWave);
    expect(stages).toHaveLength(2);
    expect(stages.find((s) => s.key === 'W1')?.itemIds).toEqual(['W0', 'G2']);
    expect(stages.find((s) => s.key === 'W2')?.itemIds).toEqual(['G10']);
  });

  it('groups items by threshold when no wave present', () => {
    const stages = groupStagesByWave(items, 2);
    expect(stages).toHaveLength(2);
    expect(stages[0].itemIds).toEqual(['W0', 'G2']);
    expect(stages[1].itemIds).toEqual(['G10']);
  });

  it('collapses a stage into a single summary node', () => {
    const withWave = [
      { ...items[0], wave: 'W1' },
      { ...items[1], wave: 'W1' },
    ];
    const result = applyStageCollapse(withWave, new Set(['W1']));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('W1:stage');
    expect(result.items[0].title).toContain('2 节点');
    expect(result.collapsedKeys).toEqual(['W1']);
  });

  it('keeps non-collapsed stages intact', () => {
    const withWave = [
      { ...items[0], wave: 'W1' },
      { ...items[1], wave: 'W1' },
      { ...items[2], wave: 'W2' },
    ];
    const result = applyStageCollapse(withWave, new Set(['W1']));
    expect(result.items.map((i) => i.id)).toEqual(['W1:stage', 'G10']);
  });

  it('filters items by scope without collapsing', () => {
    expect(filterItemsByScope(items, 'waves').map((i) => i.id)).toEqual(['W0']);
    expect(filterItemsByScope(items, 'gates').map((i) => i.id)).toEqual(['G2', 'G10']);
    expect(filterItemsByScope(items, 'all')).toHaveLength(3);
  });

  it('traces upstream and downstream dependencies', () => {
    const upstream = traceUpstream(edges, 'G10');
    expect([...upstream].sort()).toEqual(['G2', 'W0']);
    const downstream = traceDownstream(edges, 'W0');
    expect([...downstream].sort()).toEqual(['G10', 'G2']);
    expect(traceUpstream(edges, 'W0').size).toBe(0);
    expect(traceDownstream(edges, 'G10').size).toBe(0);
  });

  it('collects exception backflow nodes from blocking edges and red status', () => {
    const nodes = buildGraphLayout(
      [
        { ...items[0], status: 'Failed' },
        items[1],
        items[2],
      ],
      edges,
      'all',
    ).nodes;
    const layoutEdges = [
      { id: 'E-1', from: 'W0', to: 'G2', edgeType: 'depends' },
      { id: 'E-2', from: 'G2', to: 'G10', edgeType: 'depends', blocking: true },
    ];
    const set = exceptionBackflowNodes(nodes, layoutEdges);
    expect(set.has('G10')).toBe(true); // blocking 边 to 端
    expect(set.has('G2')).toBe(true); // blocking 边 from 端
    expect(set.has('W0')).toBe(true); // 红色节点已含，且其上游无更多
  });
});
