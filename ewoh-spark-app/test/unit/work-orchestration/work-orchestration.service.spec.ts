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

  it('returns an offline GitHub sync plan derived from graph items', async () => {
    const plan = (await service.getGitSyncStatus()) as {
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

  it('revokes a gate decision and returns it to no-decision when no prior decision', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    service.recordGateDecision(
      'G2',
      { decision: 'approved' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    const result = service.revokeGateDecision(
      'G2',
      { reason: 'revert' },
      { userId: 'user-2', primaryOrgId: 'org-1' },
    );
    expect(result.revoked).toBe(true);
    expect(result.revokedBy).toBe('user-2');
    expect(result.restored).toBeNull();
    expect(service.getGates().find((gate) => gate.gateId === 'G2')?.humanDecision).toBeNull();
    const history = service.getGateHistory('G2');
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe('revoked');
    expect(history[0].reason).toBe('revert');
  });

  it('revokes a gate decision and restores the previous decision', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    service.recordGateDecision(
      'G2',
      { decision: 'approved' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    service.recordGateDecision(
      'G2',
      { decision: 'conditional' },
      { userId: 'user-2', primaryOrgId: 'org-1' },
    );
    const result = service.revokeGateDecision(
      'G2',
      {},
      { userId: 'user-3', primaryOrgId: 'org-1' },
    );
    expect(result.restored).toEqual({ gateId: 'G2', decision: 'approved' });
    expect(service.getGates().find((gate) => gate.gateId === 'G2')?.humanDecision).toBe(
      'approved',
    );
    const history = service.getGateHistory('G2');
    expect(history.map((entry) => entry.action)).toEqual(['decision', 'revoked']);
  });

  it('rejects revoking a gate with no recorded decision', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    expect(() =>
      service.revokeGateDecision('G2', {}, { userId: 'user-1', primaryOrgId: 'org-1' }),
    ).toThrow('no decision to revoke');
  });

  it('rejects revoking or querying history for a missing gate', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    expect(() =>
      service.revokeGateDecision('G-X', {}, { userId: 'user-1', primaryOrgId: 'org-1' }),
    ).toThrow('not found');
    expect(() => service.getGateHistory('G-X')).toThrow('not found');
  });

  it('explains why a work item is blocked via blocking dependencies', () => {
    const reason = service.getBlockedReason('W1');
    expect(reason.blocked).toBe(true);
    expect(reason.explanation).toContain('W1 被 W0 阻塞');
    expect(reason.explanation).toContain('W0 尚未完成');
  });

  it('reports a work item as unblocked when no blocking reasons exist', () => {
    const reason = service.getBlockedReason('T-001');
    expect(reason.blocked).toBe(false);
    expect(reason.explanation).toContain('T-001 当前未受阻塞');
  });

  it('blocks writes when EWOH_WORK_WRITABLE is not enabled', () => {
    expect(() =>
      service.createHandoff(
        { fromActor: 'A', toActor: 'B', scope: 'scope' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).toThrow('EWOH_WORK_WRITABLE');
  });

  it('requires approved=true before applying the git sync plan', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    expect(() =>
      service.applyGitSync({ idempotencyKey: 'k-1', approved: false }),
    ).toThrow('approved=true');
  });

  it('requires an idempotencyKey for git sync apply', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    expect(() => service.applyGitSync({ approved: true })).toThrow(
      'idempotencyKey',
    );
  });

  it('returns the recorded result for a repeated idempotency key', () => {
    process.env.EWOH_WORK_WRITABLE = 'true';
    const workDir = join(process.env.EWOH_WORK_ARTIFACTS_DIR!, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, 'git-sync-apply.json'),
      JSON.stringify([
        {
          idempotencyKey: 'k-dup',
          result: { status: 'live', appliedAt: '2026-01-01T00:00:00.000Z', created: [] },
        },
      ]),
      'utf8',
    );
    const result = service.applyGitSync({
      idempotencyKey: 'k-dup',
      approved: true,
    }) as { status: string; appliedAt: string };
    expect(result.status).toBe('live');
    expect(result.appliedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('sanitizes invalid site readiness report errors', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ewoh-repo-'));
    const artifacts = join(repoRoot, 'artifacts');
    mkdirSync(join(repoRoot, 'catalog', 'factory-sites'), { recursive: true });
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      join(repoRoot, 'catalog', 'factory-sites', 'bad.json'),
      '{not-json',
      'utf8',
    );
    process.env.EWOH_WORK_ARTIFACTS_DIR = artifacts;
    const localService = new WorkOrchestrationService();

    const result = localService.getSiteReadiness();

    expect(result).toHaveLength(1);
    expect(result[0].ready).toBe(false);
    expect(result[0].error).toBe('Invalid site readiness report');
  });
});

describe('WorkOrchestrationService durable (DB-backed) paths', () => {
  let artifactsDir: string;

  function fakePersistence(overrides: Record<string, unknown> = {}) {
    return {
      recoverExpiredLocks: jest.fn().mockResolvedValue(0),
      listActiveLocks: jest.fn().mockResolvedValue([]),
      acquireLock: jest.fn().mockResolvedValue({
        resourceId: 'res-1',
        holder: 'user-1',
        purpose: undefined,
        acquiredAt: '2026-01-01T00:00:00.000Z',
        expiresAt: undefined,
        active: true,
        version: 1,
      }),
      acquireLockWithAudit: jest.fn().mockResolvedValue({
        resourceId: 'res-1',
        holder: 'user-1',
        purpose: undefined,
        acquiredAt: '2026-01-01T00:00:00.000Z',
        expiresAt: undefined,
        active: true,
        version: 1,
      }),
      releaseLock: jest.fn().mockResolvedValue({ released: true, holder: 'user-1' }),
      renewLock: jest.fn().mockResolvedValue({
        resourceId: 'res-1',
        holder: 'user-1',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        renewedAt: '2026-01-01T00:00:00.000Z',
        active: true,
        version: 2,
      }),
      createHandoffWithTransfer: jest.fn().mockImplementation(async (record) => ({
        handoffId: record.handoffId,
        fromActor: record.fromActor,
        toActor: record.toActor,
        scope: record.scope,
        contextPack: record.contextPack,
        openQuestions: record.openQuestions ?? [],
        acceptance: record.acceptance,
        state: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
      getHandoff: jest.fn().mockResolvedValue({
        handoffId: 'HO-1',
        scope: 'scope-x',
        state: 'open',
      }),
      acceptHandoffWithTaskUpdate: jest
        .fn()
        .mockResolvedValue({ handoffId: 'HO-1', state: 'accepted' }),
      updateHandoffStatus: jest.fn().mockResolvedValue({ handoffId: 'HO-1', state: 'closed' }),
      setIdempotencyAndCreate: jest.fn().mockImplementation(async (_s, _k, creator) => ({
        created: true,
        result: await creator(),
      })),
      updateGitSyncWithEvidence: jest.fn().mockResolvedValue(undefined),
      upsertEvidenceMetadata: jest.fn().mockResolvedValue(undefined),
      createReplicationSession: jest.fn().mockResolvedValue({
        sessionId: 'RS-1',
        factoryId: 'factory-1',
        status: 'running',
        progress: 0,
      }),
      advanceReplicationWithEvidence: jest.fn().mockResolvedValue({
        sessionId: 'RS-1',
        factoryId: 'factory-1',
        step: 'install',
        status: 'running',
        progress: 50,
      }),
      ...overrides,
    };
  }

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
    process.env.EWOH_WORK_WRITABLE = 'true';
  });

  afterEach(() => {
    delete process.env.EWOH_WORK_ARTIFACTS_DIR;
    delete process.env.EWOH_WORK_WRITABLE;
  });

  it('getResourcesDurable reads lock state from the database rather than the in-memory Map', async () => {
    const persistence = fakePersistence({
      listActiveLocks: jest.fn().mockResolvedValue([
        {
          resourceId: 'RES-node-js',
          holder: 'user-9',
          purpose: 'install',
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: undefined,
          active: true,
        },
      ]),
    });
    const service = new WorkOrchestrationService(persistence as never);
    const resources = await service.getResourcesDurable({ userId: 'u1', primaryOrgId: 'org-1' });
    expect(persistence.recoverExpiredLocks).toHaveBeenCalledWith('org-1');
    expect(persistence.listActiveLocks).toHaveBeenCalledWith('org-1');
    const locked = resources.find((entry: { resourceId: string }) => entry.resourceId === 'RES-node-js');
    expect(locked?.lock).toEqual({
      holder: 'user-9',
      purpose: 'install',
      acquiredAt: '2026-01-01T00:00:00.000Z',
      expiresAt: undefined,
    });
  });

  it('createHandoffDurable persists the handoff via DomainPersistenceService', async () => {
    const persistence = fakePersistence();
    const service = new WorkOrchestrationService(persistence as never);
    const handoff = await service.createHandoffDurable(
      { fromActor: 'AG-11', toActor: 'ORCH-05', scope: 'scope-x', acceptance: 'tests pass' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(persistence.createHandoffWithTransfer).toHaveBeenCalled();
    expect(handoff.status).toBe('open');
    expect((handoff as { persisted?: string }).persisted).toBe('postgres');
  });

  it('updateHandoffStatusDurable accepts a handoff within a transaction', async () => {
    const persistence = fakePersistence();
    const service = new WorkOrchestrationService(persistence as never);
    const updated = await service.updateHandoffStatusDurable(
      'HO-1',
      { status: 'accepted', reason: 'verified' },
      { userId: 'user-2', primaryOrgId: 'org-1' },
    );
    expect(persistence.getHandoff).toHaveBeenCalledWith('HO-1');
    expect(persistence.acceptHandoffWithTaskUpdate).toHaveBeenCalledWith(
      'HO-1',
      expect.objectContaining({ result: 'handoff_accepted' }),
    );
    expect(updated.status).toBe('accepted');
  });

  it('updateHandoffStatusDurable rejects an illegal transition before touching the DB', async () => {
    const persistence = fakePersistence({
      getHandoff: jest.fn().mockResolvedValue({ handoffId: 'HO-1', scope: 'x', state: 'open' }),
    });
    const service = new WorkOrchestrationService(persistence as never);
    await expect(
      service.updateHandoffStatusDurable(
        'HO-1',
        { status: 'closed' },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).rejects.toThrow(/not allowed/);
    expect(persistence.acceptHandoffWithTaskUpdate).not.toHaveBeenCalled();
  });

  it('acquireResourceDurable competes for the lock via the database unique constraint', async () => {
    const persistence = fakePersistence();
    const service = new WorkOrchestrationService(persistence as never);
    const resourceId = service.getResources()[0].resourceId;
    const lock = await service.acquireResourceDurable(
      resourceId,
      { purpose: 'install', confirm: true },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(persistence.acquireLockWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({ holder: 'user-1', orgId: 'org-1' }),
      expect.objectContaining({ action: 'work.resource.lock', entityId: resourceId }),
    );
    expect((lock as { persisted?: string }).persisted).toBe('postgres');
  });

  it('releaseResourceDurable releases the lock holder via the database', async () => {
    const persistence = fakePersistence();
    const service = new WorkOrchestrationService(persistence as never);
    const resourceId = service.getResources()[0].resourceId;
    const result = await service.releaseResourceDurable(resourceId, {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });
    expect(persistence.releaseLock).toHaveBeenCalledWith(
      expect.objectContaining({ holder: 'user-1', orgId: 'org-1' }),
    );
    expect(result.released).toBe(true);
  });

  it('registerEvidenceDurable persists evidence metadata into the database', async () => {
    const persistence = fakePersistence();
    const service = new WorkOrchestrationService(persistence as never);
    const result = await service.registerEvidenceDurable({
      evidenceId: 'EVD-1',
      workItemId: 'T-001',
      verifier: 'user-1',
      result: 'passed',
    });
    expect(persistence.upsertEvidenceMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: 'EVD-1' }),
    );
    expect(result.persisted).toBe('postgres');
  });

  it('advanceReplicationDurable advances the step and emits output evidence atomically', async () => {
    const persistence = fakePersistence();
    const service = new WorkOrchestrationService(persistence as never);
    const session = await service.advanceReplicationDurable(
      'RS-1',
      { step: 'install', progress: 50 },
      { evidenceId: 'EVD-RS-1', workItemId: 'RS-1', verifier: 'user-1', result: 'step_advanced' },
    );
    expect(persistence.advanceReplicationWithEvidence).toHaveBeenCalledWith(
      'RS-1',
      expect.objectContaining({ step: 'install' }),
      expect.objectContaining({ evidenceId: 'EVD-RS-1' }),
    );
    expect(session.persisted).toBe('postgres');
  });

  it('durable lock methods fail closed when DB persistence is absent (P2 SSOT: no silent filesystem fallback)', async () => {
    // 安全语义（P2-WorkOrchestration SSOT）：Durable 写操作在 DomainPersistence
    // 未注入时必须显式失败，不得静默回退到 filesystem/in-memory 双 SSOT。
    const service = new WorkOrchestrationService();
    const resource = service.getResources()[0];
    await expect(
      service.acquireResourceDurable(
        resource.resourceId,
        { purpose: 'test', confirm: true },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).rejects.toThrow('Durable persistence unavailable');
    await expect(
      service.releaseResourceDurable(resource.resourceId, {
        userId: 'user-1',
        primaryOrgId: 'org-1',
        isGlobalAdmin: true,
      }),
    ).rejects.toThrow('Durable persistence unavailable');
  });

  it('P2-WorkOrchestration SSOT：无 DomainPersistence 注入时 Durable 写路径 fail-closed', async () => {
    // 模拟 production 下 DB 持久化不可用（未注入）——写操作必须显式失败，
    // 不得静默回退到 filesystem/in-memory 双 SSOT。
    const service = new WorkOrchestrationService();
    await expect(
      service.acquireResourceDurable(
        'res-1',
        { purpose: 'test', confirm: true },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).rejects.toThrow('Durable persistence unavailable');

    await expect(
      service.releaseResourceDurable('res-1', {
        userId: 'user-1',
        primaryOrgId: 'org-1',
        isGlobalAdmin: true,
      }),
    ).rejects.toThrow('Durable persistence unavailable');

    await expect(
      service.createHandoffDurable(
        {
          fromActor: 'a',
          toActor: 'b',
          scope: 'x',
        },
        { userId: 'user-1', primaryOrgId: 'org-1' },
      ),
    ).rejects.toThrow('Durable persistence unavailable');
  });

  it('P2-WorkOrchestration SSOT：只读 fallback（getResources）不失败（合理降级）', async () => {
    const service = new WorkOrchestrationService();
    const res = service.getResources();
    expect(Array.isArray(res)).toBe(true);
  });
});
