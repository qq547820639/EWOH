import type { GraphLayoutEdge, GraphNode } from './graphLayout';
import {
  buildGraphTextAlt,
  graphTextToPlainText,
  parseCriticalNodeIds,
} from './graphText';

const nodes: GraphNode[] = [
  { id: 'wave-1', title: '波次一', type: 'wave', status: 'approved', owner: 'alice', x: 0, y: 0, width: 224, height: 74 },
  { id: 'gate-1', title: '发布门禁', type: 'gate', status: 'in_progress', owner: 'bob', x: 0, y: 0, width: 224, height: 74 },
];

const edges: GraphLayoutEdge[] = [
  { id: 'e1', from: 'wave-1', to: 'gate-1', edgeType: 'depends' },
  { id: 'e2', from: 'gate-1', to: 'wave-1', edgeType: 'blocks', blocking: true },
];

describe('parseCriticalNodeIds', () => {
  it('parses arrow-separated critical path tokens', () => {
    expect([...parseCriticalNodeIds('wave-1 → gate-1 > wave-2')]).toEqual(['wave-1', 'gate-1', 'wave-2']);
  });

  it('returns empty set for empty input', () => {
    expect(parseCriticalNodeIds(undefined).size).toBe(0);
  });
});

describe('buildGraphTextAlt', () => {
  it('builds a structured text alternative for the graph', () => {
    const alt = buildGraphTextAlt(nodes, edges, 'wave-1 → gate-1');
    expect(alt.nodeCount).toBe(2);
    expect(alt.edgeCount).toBe(2);
    expect(alt.criticalPath).toBe('wave-1 → gate-1');
    expect(alt.nodes.find((n) => n.id === 'wave-1')?.critical).toBe(true);
    expect(alt.nodes.find((n) => n.id === 'gate-1')?.critical).toBe(true);
    expect(alt.edges.find((e) => e.id === 'e2')?.blocking).toBe(true);
  });

  it('sets criticalPath to null when empty', () => {
    const alt = buildGraphTextAlt(nodes, edges, '');
    expect(alt.criticalPath).toBeNull();
  });
});

describe('graphTextToPlainText', () => {
  it('renders a readable human summary', () => {
    const alt = buildGraphTextAlt(nodes, edges, 'wave-1 → gate-1');
    const text = graphTextToPlainText(alt);
    expect(text).toContain('节点数：2');
    expect(text).toContain('关键路径：wave-1 → gate-1');
    expect(text).toContain('wave-1（波次一）');
    expect(text).toContain('wave-1 → gate-1');
    expect(text).toContain('（阻塞）');
  });
});