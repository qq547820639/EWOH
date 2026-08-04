import type { WorkEdge, WorkEvidence, WorkGate, WorkGraph } from '../../api/work';
import { isDoneStatus } from './overviewModel';

/**
 * 批量处理门禁的推导模型（纯函数，便于单测）。
 * 领域约定：gateId 与 graph 中 item.id 一致；evidence 通过 workItemId 关联到节点。
 */

/** 批量预览中的单条门禁行。 */
export interface GateBatchPreviewRow {
  gateId: string;
  title: string;
  status: string;
  humanDecision: string | null;
  /** 关联证据数量（workItemId === gateId 的 evidence 数量）。 */
  evidenceCount: number;
  /** 决定该门禁将影响的下游节点数。 */
  downstreamCount: number;
  /** 是否缺失相关证据。 */
  missingEvidence: boolean;
  /** 是否可执行批量记录。 */
  executable: boolean;
  /** 不可执行原因（可执行时为 null）。 */
  reason: string | null;
}

export interface GateBatchPreview {
  rows: GateBatchPreviewRow[];
  executableCount: number;
  nonExecutableCount: number;
  missingEvidenceCount: number;
  /** 可执行门禁影响的下游节点总数。 */
  affectedDownstreamTotal: number;
}

/**
 * 基于 edges 反向传播，计算每个起始节点（from）决定后影响的下游节点数。
 * 只统计命中 graph.items 的节点，避免把非节点 id 计入。
 */
export function computeDownstreamCounts(
  edges: WorkEdge[],
  itemIds: Set<string>,
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const counts = new Map<string, number>();
  const sources = new Set<string>();
  for (const edge of edges) sources.add(edge.from);
  for (const source of sources) {
    const seen = new Set<string>();
    const queue = [source];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) continue;
      for (const target of adjacency.get(id) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    counts.set(source, [...seen].filter((id) => itemIds.has(id)).length);
  }
  return counts;
}

/** 统计每个 workItem 关联的证据数量。 */
export function computeEvidenceCounts(
  evidence: WorkEvidence[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of evidence) {
    counts.set(entry.workItemId, (counts.get(entry.workItemId) ?? 0) + 1);
  }
  return counts;
}

/**
 * 判定单个门禁是否可批量执行，并给出不可执行原因。
 * 不可执行情形：已通过 / 已作决定 / 无证据。
 */
export function gateExecutability(
  gate: WorkGate,
  evidenceCount: number,
): { executable: boolean; reason: string | null } {
  if (isDoneStatus(gate.calculatedStatus)) {
    return { executable: false, reason: '门禁已通过，无需重复记录决定' };
  }
  if (gate.humanDecision) {
    return { executable: false, reason: '已有决定，可先撤销再重试' };
  }
  if (evidenceCount === 0) {
    return { executable: false, reason: '缺失证据，缺乏依据' };
  }
  return { executable: true, reason: null };
}

/** 汇总批量预览：区分可执行/不可执行，并计算影响范围与缺失证据统计。 */
export function deriveGateBatchPreview(
  graph: WorkGraph,
  gates: WorkGate[],
): GateBatchPreview {
  const itemIds = new Set((graph.items ?? []).map((item) => item.id));
  const downstream = computeDownstreamCounts(graph.edges ?? [], itemIds);
  const evidenceCounts = computeEvidenceCounts(graph.evidence ?? []);

  const rows = gates.map((gate) => {
    const evidenceCount = evidenceCounts.get(gate.gateId) ?? 0;
    const { executable, reason } = gateExecutability(gate, evidenceCount);
    return {
      gateId: gate.gateId,
      title: gate.title,
      status: gate.calculatedStatus,
      humanDecision: gate.humanDecision ?? null,
      evidenceCount,
      downstreamCount: downstream.get(gate.gateId) ?? 0,
      missingEvidence: evidenceCount === 0,
      executable,
      reason,
    };
  });

  const executable = rows.filter((row) => row.executable);
  const nonExecutable = rows.filter((row) => !row.executable);
  return {
    rows,
    executableCount: executable.length,
    nonExecutableCount: nonExecutable.length,
    missingEvidenceCount: rows.filter((row) => row.missingEvidence).length,
    affectedDownstreamTotal: executable.reduce(
      (sum, row) => sum + row.downstreamCount,
      0,
    ),
  };
}