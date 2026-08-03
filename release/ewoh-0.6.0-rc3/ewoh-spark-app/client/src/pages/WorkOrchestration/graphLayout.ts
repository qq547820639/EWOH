export interface GraphNode {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayoutEdge {
  id: string;
  from: string;
  to: string;
  edgeType: string;
  blocking?: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphLayoutEdge[];
  width: number;
  height: number;
}

export type WorkGraphScope = 'waves' | 'gates' | 'waves-gates' | 'all';

interface LayoutItem {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string;
}

export interface SearchableGraphItem {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string;
  wave?: string;
  summary?: string;
}

export function filterGraphItems(
  items: SearchableGraphItem[],
  query: string,
): SearchableGraphItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    [item.id, item.title, item.owner, item.status, item.wave, item.summary]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}

interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  edgeType: string;
}

export function buildGraphLayout(
  items: LayoutItem[],
  edges: LayoutEdge[],
  scope: WorkGraphScope = 'waves-gates',
): GraphLayout {
  const selected = items.filter((item) => {
    if (scope === 'all') return true;
    if (scope === 'gates') return item.type === 'gate';
    if (scope === 'waves') return item.type === 'wave';
    return item.type === 'gate' || item.type === 'wave';
  });
  const nodeSet = new Set(selected.map((item) => item.id));
  const relevantEdges = edges.filter(
    (edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to),
  );
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const item of selected) {
    indegree.set(item.id, 0);
    adjacency.set(item.id, []);
  }
  for (const edge of relevantEdges) {
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const layers = new Map<string, number>();
  for (const item of selected) layers.set(item.id, 0);
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const processed: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    processed.push(id);
    for (const target of adjacency.get(id) ?? []) {
      const current = indegree.get(target) ?? 0;
      indegree.set(target, Math.max(0, current - 1));
      layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(id) ?? 0) + 1));
      if ((indegree.get(target) ?? 0) === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  for (const item of selected) {
    if (!processed.includes(item.id)) {
      layers.set(item.id, 0);
    }
  }
  const byLayer = new Map<number, LayoutItem[]>();
  for (const item of selected) {
    const layer = layers.get(item.id) ?? 0;
    const bucket = byLayer.get(layer) ?? [];
    bucket.push(item);
    byLayer.set(layer, bucket);
  }
  const nodeWidth = 224;
  const nodeHeight = 74;
  const horizontalGap = 52;
  const verticalGap = 24;
  const layerWidth = nodeWidth + horizontalGap;
  const maxRows = Math.max(1, ...[...byLayer.values()].map((bucket) => bucket.length));
  const width = Math.max(720, (byLayer.size + 1) * layerWidth + 40);
  const height = Math.max(320, maxRows * (nodeHeight + verticalGap) + 40);
  const nodes: GraphNode[] = [];
  for (const [layer, bucket] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    bucket
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((item, index) => {
        nodes.push({
          id: item.id,
          title: item.title,
          type: item.type,
          status: item.status,
          owner: item.owner,
          x: 24 + layer * layerWidth,
          y: 24 + index * (nodeHeight + verticalGap),
          width: nodeWidth,
          height: nodeHeight,
        });
      });
  }
  return { nodes, edges: relevantEdges, width, height };
}

export function statusTone(status: string): string {
  const value = status.toLowerCase();
  if (value.includes('pass') || value.includes('done') || value.includes('approved')) {
    return 'emerald';
  }
  if (value.includes('fail') || value.includes('blocked') || value.includes('reject')) {
    return 'red';
  }
  if (value.includes('validation') || value.includes('in progress') || value.includes('installed')) {
    return 'blue';
  }
  if (value.includes('approval') || value.includes('pending') || value.includes('proposed')) {
    return 'amber';
  }
  return 'slate';
}
