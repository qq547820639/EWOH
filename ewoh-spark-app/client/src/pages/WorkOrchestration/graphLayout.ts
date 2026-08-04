export interface GraphNode {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string;
  wave?: string;
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
  wave?: string;
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
          wave: item.wave,
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

/**
 * 没有 wave 字段时，未分组阶段的兜底 key（W3.4 阶段折叠）。
 * 当节点未携带 wave 时可按阈值分阶段，key 为形如 "s0"、"s1" 的字符串。
 */
export const STAGE_UNGROUPED = '__standalone__';
/** 无 wave 字段时按该阈值把节点切成若干阶段。 */
export const STAGE_THRESHOLD = 20;

export interface GraphStage {
  key: string;
  label: string;
  itemIds: string[];
}

/**
 * 按 item.wave 字段（若存在）把节点分组；否则按阈值（每阶段最多 STAGE_THRESHOLD 个）
 * 把节点切成若干「阈值阶段」。纯函数，供阶段折叠与 UI 使用。
 */
export function groupStagesByWave(
  items: SearchableGraphItem[],
  threshold = STAGE_THRESHOLD,
): GraphStage[] {
  const hasWave = items.some((item) => item.wave);
  if (hasWave) {
    const byWave = new Map<string, string[]>();
    for (const item of items) {
      const key = item.wave || STAGE_UNGROUPED;
      const bucket = byWave.get(key) ?? [];
      bucket.push(item.id);
      byWave.set(key, bucket);
    }
    return [...byWave.entries()]
      .map(([key, itemIds]) => ({
        key,
        label: key === STAGE_UNGROUPED ? '未分组' : `波次 ${key}`,
        itemIds,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  if (threshold <= 0 || items.length === 0) {
    return [{ key: STAGE_UNGROUPED, label: '全部', itemIds: items.map((item) => item.id) }];
  }
  const stageCount = Math.max(1, Math.ceil(items.length / threshold));
  const stages: GraphStage[] = [];
  for (let index = 0; index < stageCount; index += 1) {
    const slice = items.slice(index * threshold, (index + 1) * threshold);
    stages.push({ key: `s${index}`, label: `阶段 ${index + 1}`, itemIds: slice.map((item) => item.id) });
  }
  return stages;
}

/** 阶段汇总节点 id 统一以 `:stage` 结尾，便于识别非真实节点。 */
export function isStageSummaryNode(id: string): boolean {
  return id.endsWith(':stage');
}

export interface StageCollapseResult {
  items: SearchableGraphItem[];
  collapsedKeys: string[];
}

/**
 * 把 collapsedStages 中指定的阶段折叠为单个汇总节点；未折叠的阶段原样保留。
 * 汇总节点继承父阶段类型（gate/wave 优先），并聚合状态（含红色则视为 Blocked）。
 */
export function applyStageCollapse(
  items: SearchableGraphItem[],
  collapsedStages: Set<string>,
  threshold = STAGE_THRESHOLD,
): StageCollapseResult {
  const stages = groupStagesByWave(items, threshold);
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: SearchableGraphItem[] = [];
  const collapsedKeys: string[] = [];
  for (const stage of stages) {
    const members = stage.itemIds
      .map((id) => byId.get(id))
      .filter((item): item is SearchableGraphItem => Boolean(item));
    if (collapsedStages.has(stage.key) && members.length > 1) {
      const hasRed = members.some((member) => statusTone(member.status) === 'red');
      const hasGate = members.some((member) => member.type === 'gate');
      out.push({
        id: `${stage.key}:stage`,
        title: `${stage.label}（${members.length} 节点）`,
        type: hasGate ? 'gate' : 'wave',
        status: hasRed ? 'Blocked' : 'Done',
        owner: '—',
        wave: stage.key,
        summary: `${stage.label} 汇总，共 ${members.length} 个节点`,
      });
      collapsedKeys.push(stage.key);
    } else {
      out.push(...members);
    }
  }
  return { items: out, collapsedKeys };
}

/** 按 scope 过滤节点（buildGraphLayout 内部同款逻辑，供折叠前使用）。 */
export function filterItemsByScope(
  items: LayoutItem[],
  scope: WorkGraphScope,
): LayoutItem[] {
  if (scope === 'all') return items;
  if (scope === 'gates') return items.filter((item) => item.type === 'gate');
  if (scope === 'waves') return items.filter((item) => item.type === 'wave');
  return items.filter((item) => item.type === 'gate' || item.type === 'wave');
}

/**
 * 追踪 nodeId 的全部上游依赖（含间接依赖，遍历 edges）。不包含 nodeId 自身。
 */
export function traceUpstream(edges: GraphLayoutEdge[], nodeId: string): Set<string> {
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of edges) {
      if (edge.to === current && !result.has(edge.from)) {
        result.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return result;
}

/**
 * 追踪 nodeId 的全部下游受影响节点（含间接影响，遍历 edges）。不包含 nodeId 自身。
 */
export function traceDownstream(edges: GraphLayoutEdge[], nodeId: string): Set<string> {
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of edges) {
      if (edge.from === current && !result.has(edge.to)) {
        result.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return result;
}

/**
 * 异常回流高亮节点集合：阻塞边（blocking=true）两端、以及红色状态节点及其上游依赖。
 * 用于把阻断性/异常路径用醒目颜色标出。
 */
export function exceptionBackflowNodes(
  nodes: GraphNode[],
  edges: GraphLayoutEdge[],
): Set<string> {
  const result = new Set<string>();
  for (const edge of edges) {
    if (edge.blocking) {
      result.add(edge.from);
      result.add(edge.to);
    }
  }
  for (const node of nodes) {
    if (statusTone(node.status) === 'red') {
      result.add(node.id);
      for (const dep of traceUpstream(edges, node.id)) result.add(dep);
    }
  }
  return result;
}
