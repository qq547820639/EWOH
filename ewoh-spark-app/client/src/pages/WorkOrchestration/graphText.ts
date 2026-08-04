import type { GraphLayoutEdge, GraphNode } from './graphLayout';

/**
 * UX-007 7.4：Work Graph / DAG 的文本替代视图。
 * 纯函数生成节点/边/关键路径的可读文本描述，供「文本视图」切换与屏读器使用。
 */

export interface GraphTextNode {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string;
  critical: boolean;
}

export interface GraphTextEdge {
  id: string;
  from: string;
  to: string;
  blocking: boolean;
}

export interface GraphTextAlt {
  heading: string;
  nodeCount: number;
  edgeCount: number;
  criticalPath: string | null;
  nodes: GraphTextNode[];
  edges: GraphTextEdge[];
}

/** 从关键路径字符串中解析出节点 id 集合。 */
export function parseCriticalNodeIds(criticalPath?: string): Set<string> {
  const ids = new Set<string>();
  if (!criticalPath) return ids;
  for (const token of criticalPath.split(/[→>,\s]+/)) {
    const trimmed = token.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}

export function buildGraphTextAlt(
  nodes: GraphNode[],
  edges: GraphLayoutEdge[],
  criticalPath?: string,
): GraphTextAlt {
  const criticalIds = parseCriticalNodeIds(criticalPath);
  return {
    heading: '交付因果图（文本替代）',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    criticalPath: criticalPath?.trim() ? criticalPath : null,
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      owner: node.owner,
      critical: criticalIds.has(node.id),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      blocking: Boolean(edge.blocking),
    })),
  };
}

/** 生成一份可读的纯文本摘要（用于屏读器、复制或打印）。 */
export function graphTextToPlainText(alt: GraphTextAlt): string {
  const lines: string[] = [alt.heading];
  lines.push(`节点数：${alt.nodeCount}，依赖边数：${alt.edgeCount}`);
  if (alt.criticalPath) lines.push(`关键路径：${alt.criticalPath}`);
  lines.push('');
  lines.push('节点列表：');
  for (const node of alt.nodes) {
    lines.push(
      `- ${node.id}（${node.title}）类型=${node.type} 状态=${node.status} 负责人=${node.owner}${
        node.critical ? ' [关键路径]' : ''
      }`,
    );
  }
  if (alt.edges.length > 0) {
    lines.push('');
    lines.push('依赖关系：');
    for (const edge of alt.edges) {
      lines.push(`- ${edge.from} → ${edge.to}${edge.blocking ? '（阻塞）' : ''}`);
    }
  }
  return lines.join('\n');
}