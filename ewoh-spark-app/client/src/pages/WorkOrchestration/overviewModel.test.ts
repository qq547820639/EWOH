import type { WorkGraph } from '../../api/work';
import {
  computeNextAction,
  deriveExecutionOverview,
  isDoneStatus,
  isIncompleteItem,
} from './overviewModel';

const baseGraph = (overrides: Partial<WorkGraph> = {}): WorkGraph => ({
  schema: 'ewoh:///work-graph/v1',
  generatedAt: '2026-08-04T00:00:00.000Z',
  sourceRoot: '/repo',
  criticalPath: 'A -> B',
  summary: {
    itemCount: 0,
    edgeCount: 0,
    actorCount: 0,
    artifactCount: 0,
    evidenceCount: 0,
    gateCount: 0,
    riskCount: 0,
    decisionCount: 0,
    statusCounts: {},
    conflicts: [],
  },
  items: [],
  edges: [],
  actors: [],
  evidence: [],
  gates: [],
  risks: [],
  resources: [],
  handoffs: [],
  ...overrides,
});

describe('isDoneStatus / isIncompleteItem', () => {
  it('识别已完成状态', () => {
    expect(isDoneStatus('Done')).toBe(true);
    expect(isDoneStatus('Passed')).toBe(true);
    expect(isDoneStatus('approved')).toBe(true);
    expect(isDoneStatus('In Progress')).toBe(false);
    expect(isDoneStatus('Pending')).toBe(false);
  });

  it('isIncompleteItem 与 isDoneStatus 相反', () => {
    expect(isIncompleteItem({ id: 'A', title: 'a', type: 'task', status: 'Done', owner: 'x' })).toBe(false);
    expect(isIncompleteItem({ id: 'A', title: 'a', type: 'task', status: 'In Progress', owner: 'x' })).toBe(true);
  });
});

describe('deriveExecutionOverview', () => {
  const graph = baseGraph({
    items: [
      { id: 'T-1', title: '完成的任务', type: 'task', status: 'Done', owner: 'AG-00' },
      { id: 'T-2', title: '进行中', type: 'task', status: 'In Progress', owner: 'AG-00', priority: 'high' },
      { id: 'T-3', title: '待办', type: 'task', status: 'Pending', owner: 'AG-01', priority: 'low' },
    ],
    actors: [
      { actorId: 'AG-00', name: 'Agent 0', kind: 'agent', role: 'ops' },
      { actorId: 'AG-01', name: 'Agent 1', kind: 'agent', role: 'ops' },
    ],
    gates: [
      { gateId: 'G0', title: '已通过', calculatedStatus: 'passed' },
      { gateId: 'G1', title: '待批准', calculatedStatus: 'requires_approval', humanDecision: null },
    ],
    evidence: [
      {
        evidenceId: 'E1',
        workItemId: 'T-2',
        kind: 'test',
        path: 'a.md',
        checksum: 'x',
        result: 'passed',
        expiresAt: '2026-08-05T00:00:00.000Z',
      },
      {
        evidenceId: 'E2',
        workItemId: 'T-3',
        kind: 'test',
        path: 'b.md',
        checksum: 'y',
        result: 'passed',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    ],
    risks: [
      { id: 'R-1', title: '高风险', severity: 'high', status: 'open' },
      { id: 'R-2', title: '低风险', severity: 'low', status: 'open' },
    ],
    resources: [
      { resourceId: 'RES-1', name: 'Python', kind: 'environment', status: 'missing' },
      { resourceId: 'RES-2', name: 'Node', kind: 'environment', status: 'available' },
    ],
  });

  it('识别当前门禁、阻塞任务、待批准数', () => {
    const overview = deriveExecutionOverview(graph);
    expect(overview.currentGate?.gateId).toBe('G1');
    expect(overview.gatesAwaitingApproval).toBe(1);
    expect(overview.blockedCount).toBe(2);
    expect(overview.counts.pending).toBe(2);
    expect(overview.counts.done).toBe(1);
  });

  it('识别即将过期/已过期证据', () => {
    const overview = deriveExecutionOverview(graph);
    expect(overview.expiringEvidence.some((e) => e.evidenceId === 'E1')).toBe(true);
    expect(overview.expiringEvidence.some((e) => e.evidenceId === 'E2')).toBe(false);
  });

  it('识别需要人类决定的开放式高风险', () => {
    const overview = deriveExecutionOverview(graph);
    expect(overview.needsHumanDecision.some((r) => r.id === 'R-1')).toBe(true);
    expect(overview.needsHumanDecision.some((r) => r.id === 'R-2')).toBe(false);
  });

  it('识别资源冲突', () => {
    const overview = deriveExecutionOverview(graph);
    expect(overview.resourceConflicts.some((r) => r.resourceId === 'RES-1')).toBe(true);
    expect(overview.resourceConflictCount).toBe(1);
  });

  it('计算 Agent 负载', () => {
    const overview = deriveExecutionOverview(graph);
    const ag0 = overview.overloaded.find((a) => a.actorId === 'AG-00');
    expect(ag0?.load).toBe(1);
  });

  it('下一最优行动优先门禁批准', () => {
    const overview = deriveExecutionOverview(graph);
    expect(overview.nextAction?.kind).toBe('gate');
    if (overview.nextAction?.kind === 'gate') {
      expect(overview.nextAction.entity.gateId).toBe('G1');
    }
  });

  it('无待批准门禁时下一行动为优先级最高的未完成任务', () => {
    const noOpenGate = baseGraph({
      items: [
        { id: 'T-2', title: '进行中', type: 'task', status: 'In Progress', owner: 'AG-00', priority: 'high' },
        { id: 'T-3', title: '待办', type: 'task', status: 'Pending', owner: 'AG-01', priority: 'low' },
      ],
      gates: [{ gateId: 'G0', title: '已通过', calculatedStatus: 'passed' }],
    });
    const next = computeNextAction(noOpenGate, null, noOpenGate.items);
    expect(next?.kind).toBe('item');
    if (next?.kind === 'item') {
      expect(next.entity.id).toBe('T-2');
    }
  });

  it('全部完成时无下一行动', () => {
    const allDone = baseGraph({
      items: [{ id: 'T-1', title: '完成', type: 'task', status: 'Done', owner: 'AG-00' }],
    });
    const next = computeNextAction(allDone, null, allDone.items);
    expect(next).toBeNull();
  });
});