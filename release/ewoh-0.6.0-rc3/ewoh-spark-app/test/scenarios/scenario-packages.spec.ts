import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { nextTaskStatus } from '../../server/modules/task/task.service';
import { nextAlertStatus } from '../../server/modules/alert/alert.service';
import { AiService } from '../../server/modules/ai/ai.service';
import { ControlService } from '../../server/modules/control/control.service';
import { ApprovalService } from '../../server/modules/approval/approval.service';
import { ResourceService } from '../../server/modules/resource/resource.service';
import { WorldCursorService, CursorExpiredError } from '../../server/modules/world-cursor/world-cursor.service';
import { AuditChainService } from '../../server/modules/shared/audit-chain.service';
import { buildOrgTree, coarseHealthRisk } from '../../server/modules/organization/organization.service';
import { FakeSqlDb } from '../helpers/fake-sql-db';

// Unit smoke coverage for SP-01..SP-08. The real HTTP + PostgreSQL assertions
// live in test/e2e/ewoh-http.e2e.spec.ts (npm run test:e2e).
const repoRoot = resolve(__dirname, '../../..');

describe('EWOH scenario packages (unit smoke)', () => {
  it('SP-01 person/exo safety: org tree + coarse risk + alert handling', () => {
    const tree = buildOrgTree([
      { id: 'group', name: 'G', orgType: 'group', parentId: null, status: 'active', description: null },
      { id: 'factory', name: 'F', orgType: 'factory', parentId: 'group', status: 'active', description: null },
    ]);
    expect(tree[0].children[0].id).toBe('factory');
    expect(coarseHealthRisk({ loadLevel: 0.85 })).toBe('high');
    expect(nextAlertStatus('open', 'acknowledge')).toBe('acknowledged');
  });

  it('SP-02 task scheduling: task state + preorder reservation + approval', async () => {
    let status = 'draft';
    for (const action of ['submit', 'skip_approval', 'dispatch', 'receive', 'start', 'complete']) {
      status = nextTaskStatus(status, action)!;
    }
    expect(status).toBe('completed');

    const resource = new ResourceService(new FakeSqlDb() as never);
    resource.seedInventory([{ resourceId: 'tool-a', quantity: 2 }]);
    const preorder = await resource.createPreorder('tool-a', 2);
    await expect(resource.createPreorder('tool-a', 1)).rejects.toThrow();
    await resource.issue(preorder.id, 2);

    const approval = new ApprovalService();
    const instance = approval.createApproval({ entityType: 'task', entityId: 'task-1', roles: ['lead'] });
    approval.stepAction(instance.id, instance.steps[0].id, 'approve');
    expect(approval.getApproval(instance.id).status).toBe('approved');
  });

  it('SP-03 AI decision: no pre-generation, manual suggestion/plan only', async () => {
    const ai = new AiService();
    expect(await ai.getSnapshotVersion()).toBe(0);
    const suggestion = await ai.createSuggestion({
      triggeredBy: 'user-1',
      problem: '积压',
      snapshot: { version: 1, from: 't0', to: 't1', records: 80 },
    });
    expect(suggestion.confirmItems.length).toBeGreaterThan(0);
    const plan = await ai.createPlan(suggestion.id, { shift: 'A' });
    expect(plan.isSimulation).toBe(true);
  });

  it('SP-04 device control: retry, latest-attempt aggregation, idempotency', async () => {
    const control = new ControlService(new FakeSqlDb() as never);
    const request = await control.createRequest({
      deviceId: 'exo-1',
      commandKeys: ['start'],
      idempotencyKey: 'idem-1',
    });
    const duplicate = await control.createRequest({
      deviceId: 'exo-1',
      commandKeys: ['start'],
      idempotencyKey: 'idem-1',
    });
    expect(duplicate.id).toBe(request.id);
    await control.sendCommand(request.id, 'start');
    await control.receiveReceipt(request.id, 'start', 'failed');
    await control.sendCommand(request.id, 'start');
    await control.receiveReceipt(request.id, 'start', 'executed');
    expect((await control.getStatus(request.id)).status).toBe('executed');
  });

  it('SP-05 digital world: snapshot, delta, cursor expiry', async () => {
    const world = new WorldCursorService(new FakeSqlDb() as never);
    await world.applyUpsert({ id: 'e1', type: 'person' });
    const snapshot = await world.getSnapshot();
    await world.applyUpsert({ id: 'e2', type: 'device' });
    const delta = await world.getDelta(snapshot.cursor);
    expect(delta.upserts[0].id).toBe('e2');
    await world.getSnapshot();
    await expect(world.getDelta(snapshot.cursor)).rejects.toThrow(CursorExpiredError);
  });

  it('SP-06 multi-org isolation: audit chains stay per-org', () => {
    const audit = new AuditChainService();
    audit.append({ orgId: 'org-a', actorId: 'u1', action: 'create', entityType: 'device', entityId: 'd1', ts: 't1' });
    audit.append({ orgId: 'org-b', actorId: 'u2', action: 'create', entityType: 'device', entityId: 'd2', ts: 't2' });
    expect(audit.verifyChain('org-a').entries).toBe(1);
    expect(audit.verifyChain('org-b').entries).toBe(1);
  });

  it('SP-07 audit: hash chain continuity detects tampering', () => {
    const audit = new AuditChainService();
    audit.append({ orgId: 'org-x', actorId: 'u1', action: 'update', entityType: 'task', entityId: 't1', ts: 't1' });
    expect(audit.verifyChain('org-x').valid).toBe(true);
    const chain = (audit as unknown as { chains: Map<string, Array<{ hash: string }>> }).chains.get('org-x')!;
    chain[0].hash = 'x'.repeat(64);
    expect(audit.verifyChain('org-x').valid).toBe(false);
  });

  it('SP-08 release/rollback: DDL runner plan mode is executable', () => {
    const migration = execFileSync('node', ['db/runner/run_migrations.js', '--plan'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(migration).toContain('EWOH DDL plan');
    const seed = execFileSync('node', ['db/runner/run_migrations.js', '--plan', 'seed'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(seed).toContain('EWOH demo seed');
    const users = execFileSync('node', ['db/runner/run_migrations.js', '--plan', 'users'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(users).toContain('ewoh_user');
    const usersSeed = execFileSync('node', ['db/runner/run_migrations.js', '--plan', 'users_seed'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(usersSeed).toContain('__EWOH_ADMIN_USERNAME__');
    expect(usersSeed).not.toContain('admin123');
    const standalone = execFileSync('node', ['db/runner/run_migrations.js', '--plan', 'standalone'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(standalone).toContain('public.');
    expect(standalone).not.toContain('user_profile');
    expect(standalone).not.toContain('user_authenticated');
    expect(standalone).toContain('CREATE ROLE service_role NOLOGIN');
    expect(standalone).toContain('sha256');
    expect(standalone).toContain('public.ewoh_audit_log');
    expect(standalone).not.toContain('public.audit_log');
    const standaloneVerify = execFileSync('node', ['db/runner/run_migrations.js', '--plan', 'standalone_verify'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(standaloneVerify).toContain('public.ewoh_audit_log');
    expect(standaloneVerify).toContain('public.ewoh_world_delta_log');
    expect(standaloneVerify).not.toContain('user_authenticated');
    const standaloneUsers = execFileSync('node', ['db/runner/run_migrations.js', '--plan', 'standalone_users'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(standaloneUsers).toContain('ewoh_user');
    expect(standaloneUsers).toContain('ewoh_find_active_user');
    expect(standaloneUsers).toContain('ENABLE ROW LEVEL SECURITY');
    const standaloneUsersRollback = execFileSync(
      'node',
      ['db/runner/run_migrations.js', '--plan', 'standalone_users_rollback'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30000 },
    );
    expect(standaloneUsersRollback).toContain('DROP TABLE IF EXISTS public.ewoh_user');
    const standaloneRollback = execFileSync(
      'node',
      ['db/runner/run_migrations.js', '--plan', 'standalone_rollback'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30000 },
    );
    expect(standaloneRollback).toContain('DESTRUCTIVE');
    expect(standaloneRollback).toContain('DROP TABLE IF EXISTS public.ewoh_audit_log CASCADE');
    expect(standaloneRollback).toContain('DROP TABLE IF EXISTS public.ewoh_ai_suggestion CASCADE');
    const standaloneRuntimeRole = execFileSync(
      'node',
      ['db/runner/run_migrations.js', '--plan', 'standalone_runtime_role'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30000 },
    );
    expect(standaloneRuntimeRole).toContain('CREATE ROLE ewoh_api LOGIN INHERIT');
    expect(standaloneRuntimeRole).toContain('NOBYPASSRLS');
    expect(standaloneRuntimeRole).toContain('__EWOH_API_DATABASE_PASSWORD__');

    const rejectedRollback = spawnSync('node', ['db/runner/run_migrations.js', '--rollback-standalone'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        EWOH_DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
        EWOH_ALLOW_DDL: '1',
        EWOH_ALLOW_DESTRUCTIVE_ROLLBACK: '',
      },
    });
    expect(rejectedRollback.status).toBe(2);
    expect(rejectedRollback.stderr).toContain('EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1');
  });
});
