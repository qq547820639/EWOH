import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkOrchestrationService } from '@server/modules/work-orchestration/work-orchestration.service';

const TASK_BOARD = `# Task Board

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-001 | Index artifacts | AG-11 | Done | output/work-graph.json |
| T-002 | Build control plane | ORCH-05 | In Progress | pending |
`;

const GATES = `# Gates

| Gate | Meaning | Current status | Evidence required |
|------|---------|----------------|-------------------|
| G2 | Contracts frozen | Passed | audit scripts |
| G10 | Production ready | Pending | production drill |
`;

const AGENTS = `# Agents

| ID | Role | Ownership | Local mapping |
|----|------|-----------|---------------|
| AG-11 | Backend shared | server/modules/shared | worker |
| ORCH-05 | Console | tools/work-console | worker |
`;

const RISKS = `# Risks

| ID | Risk | Level | Current mitigation | Escalation |
|----|------|-------|--------------------|------------|
| R-001 | Drift | High | schema audit | block gate |
`;

const DECISIONS = `# Decisions

| ID | Date | Decision | Rationale | Reversibility |
|----|------|----------|-----------|---------------|
| D-033 | 2026-08-04 | Adopt Final 6.0 | authoritative | reversible |
`;

const TASK_GRAPH = `# Task Graph

## Critical Path

indexer -> console -> evidence -> acceptance

## Waves

| Wave | Parallel work | Waits for | Exit |
|------|---------------|-----------|------|
| W0 | contracts | none | frozen |
| W1 | console | W0 | rendered |
`;

const PHASE = `# EWOH Phase State

## Current Phase

Final 6.0 work orchestration wave
`;

describe('WorkOrchestrationService', () => {
  let artifactsDir: string;
  let service: WorkOrchestrationService;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'ewoh-work-'));
    const files: Record<string, string> = {
      'task-board.md': TASK_BOARD,
      'gates.md': GATES,
      'agent-registry.md': AGENTS,
      'risk-register.md': RISKS,
      'decision-log.md': DECISIONS,
      'phase-state.md': PHASE,
      'state.json': '{"status":"active"}',
      'intent-anchor.md': '# Intent\n',
      'understanding.md': '# Understanding\n',
      'work/task-graph.md': TASK_GRAPH,
      'authoritative-plan-final6.txt': 'Final 6.0\n',
      'work/evidence/round1.md': '# Round 1\nPASSED\nT-001\n',
      'inventory/environment.md':
        '# Environment\n\n| Tool | Version | Notes |\n|------|---------|-------|\n| Node.js | 22 | available |\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = join(artifactsDir, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    process.env.EWOH_WORK_ARTIFACTS_DIR = artifactsDir;
    delete process.env.EWOH_WORK_WRITABLE;
    service = new WorkOrchestrationService();
  });

  afterEach(() => {
    delete process.env.EWOH_WORK_ARTIFACTS_DIR;
    delete process.env.EWOH_WORK_WRITABLE;
  });

  it('indexes artifact files into a canonical graph', () => {
    const graph = service.getGraph();
    expect(graph.schema).toBe('ewoh:///work-graph/v1');
    expect(graph.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['T-001', 'T-002', 'G2', 'G10', 'W0', 'W1']),
    );
    expect(graph.summary.conflicts).toEqual([]);
    expect(graph.evidence.length).toBe(1);
  });

  it('separates rule status from human approval for G10+', () => {
    const gates = service.getGates();
    const g2 = gates.find((gate) => gate.gateId === 'G2');
    const g10 = gates.find((gate) => gate.gateId === 'G10');
    expect(g2?.calculatedStatus).toBe('passed');
    expect(g10?.calculatedStatus).toBe('requires_approval');
  });

  it('reports the current phase and writable flag', () => {
    const overview = service.getOverview();
    expect(overview.phase).toContain('Final 6.0');
    expect(overview.writable).toBe(false);
  });

  it('returns an offline GitHub sync plan derived from graph items', () => {
    const plan = service.getGitSyncStatus() as {
      schema: string;
      itemCount: number;
      missingCount: number;
      items: Array<{ workItemId: string }>;
    };
    expect(plan.schema).toBe('ewoh:///git-sync/v1');
    expect(plan.itemCount).toBeGreaterThan(0);
    expect(plan.items.map((entry) => entry.workItemId)).toEqual(
      expect.arrayContaining(['T-001', 'T-002', 'W0', 'W1']),
    );
  });

  it('filters and limits work items by query', () => {
    const items = service.getItems({ q: 'Index', limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('T-001');
    const evidence = service.getEvidence({ q: 'round1' });
    expect(evidence).toHaveLength(1);
  });

  it('returns a bounded evidence content preview', () => {
    const preview = service.getEvidenceContent('EVD-round1');
    expect(preview.evidenceId).toBe('EVD-round1');
    expect(preview.content).toContain('PASSED');
    expect(preview.lines).toBeGreaterThan(0);
    expect(() => service.getEvidenceContent('EVD-missing')).toThrow('not found');
  });

  it('acquires and releases resource locks with file persistence', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const resource = service.getResources()[0];
    expect(resource).toBeDefined();
    const lock = service.acquireResource(
      resource.resourceId,
      { purpose: 'test', confirm: true },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(lock.active).toBe(true);
    expect(() =>
      service.acquireResource(
        resource.resourceId,
        { purpose: 'again', confirm: true },
        { userId: 'user-2', primaryOrgId: 'org-1' },
      ),
    ).toThrow('locked');
    const released = service.releaseResource(resource.resourceId, {
      userId: 'user-1',
      primaryOrgId: 'org-1',
      isGlobalAdmin: true,
    });
    expect(released.released).toBe(true);
  });

  it('auto-expires resource locks after expiresAt', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const resource = service.getResources()[0];
    service.acquireResource(
      resource.resourceId,
      {
        purpose: 'expired test',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        confirm: true,
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    const refreshed = service.getResources();
    expect(refreshed.find((entry) => entry.resourceId === resource.resourceId)?.lock).toBeNull();
  });

  it('creates a handoff markdown record when writable', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const handoff = service.createHandoff(
      {
        fromActor: 'AG-11',
        toActor: 'ORCH-05',
        scope: 'hand over console wave',
        acceptance: 'tests pass',
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(handoff.status).toBe('open');
    expect(
      readFileSync(join(artifactsDir, 'work', 'handoffs', `${handoff.handoffId}.md`), 'utf8'),
    ).toContain('hand over console wave');
    expect(service.getHandoffs()).toHaveLength(1);
  });

  it('transitions handoff state and persists it to markdown', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const handoff = service.createHandoff(
      {
        fromActor: 'AG-11',
        toActor: 'ORCH-05',
        scope: 'state transition',
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    const updated = service.updateHandoffStatus(
      handoff.handoffId,
      { status: 'accepted', reason: 'verified' },
      { userId: 'user-2', primaryOrgId: 'org-1' },
    );
    expect(updated.status).toBe('accepted');
    expect(updated.updatedBy).toBe('user-2');
    expect(
      readFileSync(
        join(artifactsDir, 'work', 'handoffs', `${handoff.handoffId}.md`),
        'utf8',
      ),
    ).toContain('Status: accepted');
    expect(service.getHandoffs()[0].status).toBe('accepted');
  });

  it('rejects illegal handoff transitions', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const handoff = service.createHandoff(
      { fromActor: 'AG-11', toActor: 'ORCH-05', scope: 'illegal transition' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(() =>
      service.updateHandoffStatus(
        handoff.handoffId,
        { status: 'closed' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).toThrow(/not allowed/);

    service.updateHandoffStatus(
      handoff.handoffId,
      { status: 'accepted' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(() =>
      service.updateHandoffStatus(
        handoff.handoffId,
        { status: 'accepted' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).toThrow(/not allowed/);
  });

  it('records human gate decisions into the decision file', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const record = service.recordGateDecision(
      'G2',
      { decision: 'approved', conditions: ['contracts frozen'] },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(record.decision).toBe('approved');
    expect(service.getGates().find((gate) => gate.gateId === 'G2')?.humanDecision).toBe(
      'approved',
    );
  });

  it('records gate decisions in batch', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const result = service.recordGateDecisions(
      { gateIds: ['G2', 'G10'], decision: 'conditional' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(result.recorded).toBe(2);
    const gates = service.getGates();
    expect(gates.find((gate) => gate.gateId === 'G2')?.humanDecision).toBe('conditional');
    expect(gates.find((gate) => gate.gateId === 'G10')?.humanDecision).toBe('conditional');
  });

  it('keeps gate decision history when a decision changes and is idempotent on repeat', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const first = service.recordGateDecision(
      'G2',
      { decision: 'approved', conditions: ['contracts frozen'] },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    const repeated = service.recordGateDecision(
      'G2',
      { decision: 'approved', conditions: ['contracts frozen'] },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(repeated.decidedAt).toBe(first.decidedAt);

    const changed = service.recordGateDecision(
      'G2',
      { decision: 'conditional', conditions: ['add evidence'] },
      { userId: 'user-2', primaryOrgId: 'org-1' },
    );
    expect(changed.decision).toBe('conditional');
    const historyFile = join(artifactsDir, 'work', 'gate-decision-history.json');
    expect(existsSync(historyFile)).toBe(true);
    const history = JSON.parse(readFileSync(historyFile, 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('approved');
    expect(history[0].decidedAt).toBe(first.decidedAt);
  });

  it('blocks writes when EWOH_WORK_WRITABLE is not enabled', () => {
    expect(() =>
      service.createHandoff(
        { fromActor: 'A', toActor: 'B', scope: 'scope' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).toThrow('EWOH_WORK_WRITABLE');
  });
});
