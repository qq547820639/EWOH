/// <reference types="jest" />
/* R2-SOP-001 / NEST-223 回归：durable 资源锁四操作必须强制租户上下文——
 * 缺失 org 的 actor 直接 400（BadRequestException），绝不回退 'default'
 * 共享 org（跨租户误共享/误回收 + 'default' 传入 appendAudit 的 ::uuid
 * cast 500 两条路径都在此收口）。 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { WorkOrchestrationService } from '../work-orchestration.service';

const TASK_BOARD = `# Task Board

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-001 | Index artifacts | AG-11 | Done | output/work-graph.json |
`;

const PHASE = `# EWOH Phase State

## Current Phase

Final 6.0 work orchestration wave
`;

function makePersistence() {
  return {
    recoverExpiredLocks: jest.fn().mockResolvedValue(0),
    listActiveLocks: jest.fn().mockResolvedValue([]),
    acquireLockWithAudit: jest.fn().mockImplementation(async (lock: Record<string, unknown>) => ({
      resourceId: lock.resourceId,
      holder: lock.holder,
      purpose: lock.purpose,
      acquiredAt: '2026-08-17T00:00:00Z',
      expiresAt: null,
      active: true,
      version: 1,
    })),
    releaseLock: jest.fn().mockResolvedValue({ released: true, holder: 'u1' }),
    renewLock: jest.fn().mockImplementation(async (input: Record<string, unknown>) => ({
      resourceId: input.resourceKey,
      holder: input.holder,
      acquiredAt: '2026-08-17T00:00:00Z',
      renewedAt: '2026-08-17T00:01:00Z',
      expiresAt: null,
      active: true,
      version: 1,
    })),
  };
}

describe('R2-SOP-001: durable 锁操作 org 上下文强制（无 default 回退）', () => {
  let artifactsDir: string;
  let persistence: ReturnType<typeof makePersistence>;
  let service: WorkOrchestrationService;
  const ACTOR = { userId: 'u1', primaryOrgId: 'org-111' };

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'ewoh-work-org-'));
    const files: Record<string, string> = {
      'task-board.md': TASK_BOARD,
      'phase-state.md': PHASE,
      'intent-anchor.md': '# Intent\n',
      'understanding.md': '# Understanding\n',
      'work/task-graph.md': '# Task Graph\n',
      'authoritative-plan-final6.txt': 'Final 6.0\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = join(artifactsDir, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    process.env.EWOH_WORK_ARTIFACTS_DIR = artifactsDir;
    process.env.EWOH_WORK_WRITABLE = 'true';
    persistence = makePersistence();
    service = new WorkOrchestrationService(persistence as never);
  });

  afterEach(() => {
    delete process.env.EWOH_WORK_ARTIFACTS_DIR;
    delete process.env.EWOH_WORK_WRITABLE;
  });

  it('getResourcesDurable：actor 缺失 org → 400，不触碰持久层', async () => {
    await expect(
      service.getResourcesDurable({ userId: 'u1' }),
    ).rejects.toThrow(BadRequestException);
    expect(persistence.recoverExpiredLocks).not.toHaveBeenCalled();
  });

  it('getResourcesDurable：带 org → 锁域以该 org 收敛', async () => {
    await service.getResourcesDurable(ACTOR);
    expect(persistence.recoverExpiredLocks).toHaveBeenCalledWith('org-111');
    expect(persistence.listActiveLocks).toHaveBeenCalledWith('org-111');
  });

  it('acquireResourceDurable：actor 缺失 org → 400（绝不挂 default org）', async () => {
    await expect(
      service.acquireResourceDurable('res-1', { purpose: 'p' }, { userId: 'u1' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(persistence.acquireLockWithAudit).not.toHaveBeenCalled();
  });

  it('acquireResourceDurable：带 org → 锁与审计行均带该 org', async () => {
    await service.acquireResourceDurable('res-1', { purpose: 'p' }, ACTOR);
    expect(persistence.acquireLockWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-111', resourceKey: 'res-1' }),
      expect.objectContaining({ orgId: 'org-111' }),
    );
  });

  it('releaseResourceDurable：actor 缺失 org → 400；带 org → 以该 org 释放', async () => {
    await expect(
      service.releaseResourceDurable('res-1', { userId: 'u1' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(persistence.releaseLock).not.toHaveBeenCalled();

    await service.releaseResourceDurable('res-1', { ...ACTOR, isGlobalAdmin: false });
    expect(persistence.releaseLock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-111' }),
    );
  });

  it('renewResourceLock：actor 缺失 org → 400；带 org → 以该 org 续租', async () => {
    await expect(
      service.renewResourceLock('res-1', {}, { userId: 'u1' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(persistence.renewLock).not.toHaveBeenCalled();

    await service.renewResourceLock('res-1', { expiresAt: '2099-01-01T00:00:00Z' }, ACTOR);
    expect(persistence.renewLock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-111' }),
    );
  });
});
