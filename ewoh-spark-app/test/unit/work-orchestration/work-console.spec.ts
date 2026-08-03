import {
  computeBlockedItems,
  computeGraphSummary,
  computeMissingEvidence,
} from '../../../../tools/work-console/index.js';

const graph = {
  generatedAt: '2026-08-04T00:00:00.000Z',
  sourceRoot: '/tmp/ewoh-test',
  criticalPath: 'A -> B',
  summary: {
    itemCount: 4,
    edgeCount: 3,
    actorCount: 1,
    artifactCount: 0,
    evidenceCount: 1,
    gateCount: 2,
    riskCount: 0,
    decisionCount: 0,
    statusCounts: {},
    conflicts: [],
  },
  items: [
    { id: 'T-1', title: 'Blocked task', type: 'task', status: 'Blocked', owner: 'AG-00' },
    { id: 'T-2', title: 'Downstream task', type: 'task', status: 'Validation', owner: 'AG-11' },
    { id: 'T-3', title: 'Done task', type: 'task', status: 'Done', owner: 'AG-30' },
    { id: 'G10', title: 'Production gate', type: 'gate', status: 'Passed locally, production pending', owner: 'AG-00' },
  ],
  edges: [
    { id: 'E-1', from: 'T-1', to: 'T-2', edgeType: 'depends', blocking: true },
  ],
  evidence: [
    {
      evidenceId: 'EVD-1',
      workItemId: 'T-3',
      kind: 'test',
      path: '.codex/artifacts/work/evidence/round-test.md',
      checksum: 'abc',
      result: 'passed',
      status: 'stale',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  ],
  gates: [
    {
      gateId: 'G10',
      title: 'Production gate',
      calculatedStatus: 'passed',
      humanDecision: null,
      conditions: ['production drill'],
    },
    {
      gateId: 'G11',
      title: 'Acceptance',
      calculatedStatus: 'requires_approval',
      humanDecision: null,
      conditions: ['signoff'],
    },
  ],
  invariants: [],
};

describe('work console blocker diagnosis', () => {
  it('finds blocked items, downstream impact, and unblock owners', () => {
    const result = computeBlockedItems(graph);

    expect(result.blockedItems.map((item) => item.id)).toEqual(['T-1']);
    expect(result.affectedItems.map((item) => item.id)).toEqual(['T-2']);
    expect(result.unblockOwners).toEqual(['AG-00']);
  });

  it('flags done items whose only evidence is stale', () => {
    const result = computeMissingEvidence(graph);

    expect(result.map((item) => item.id)).toEqual(['T-2', 'T-3']);
    expect(result.find((item) => item.id === 'T-3')?.staleEvidence).toEqual([
      'EVD-1',
    ]);
  });

  it('summarizes gates requiring human approval', () => {
    const result = computeGraphSummary(graph, '/tmp/ewoh-test');

    expect(result.gateSummary.requiresApproval.map((gate) => gate.gateId)).toEqual([
      'G10',
      'G11',
    ]);
    expect(result.invariantConflicts).toEqual([]);
    expect(result.canUnblock).toBe(true);
  });
});
