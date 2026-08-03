import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGitSyncPlan,
  gitInfo,
  loadRegistry,
} from '../../../../tools/git-sync/index.js';

const items = [
  {
    id: 'T-153',
    title: 'Final 6 baseline',
    type: 'task',
    status: 'Done',
    owner: 'AG-00',
    evidence: 'round69',
  },
  {
    id: 'W6-1',
    title: 'Indexer wave',
    type: 'wave',
    status: 'Proposed',
    owner: 'ORCH-02',
  },
];

describe('git sync plan', () => {
  it('builds an offline plan and counts missing tracking records', () => {
    const plan = buildGitSyncPlan(items, [
      { workItemId: 'T-153', issueNumber: 42, prNumber: 7, state: 'pr_linked' },
    ], { branch: 'codex/final6', headSha: 'abc', remote: 'git@github.com:example/ewoh.git' });

    expect(plan.schema).toBe('ewoh:///git-sync/v1');
    expect(plan.status).toBe('offline');
    expect(plan.itemCount).toBe(2);
    expect(plan.trackedCount).toBe(1);
    expect(plan.missingCount).toBe(1);
    const task = plan.items.find((entry) => entry.workItemId === 'T-153');
    expect(task?.issueNumber).toBe(42);
    expect(task?.prNumber).toBe(7);
    expect(task?.missing).toBe(false);
    expect(plan.items.find((entry) => entry.workItemId === 'W6-1')?.missing).toBe(true);
  });

  it('returns git information or a safe fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ewoh-git-sync-'));
    const info = gitInfo(dir);
    expect(typeof info.branch).toBe('string');
    expect(typeof info.headSha).toBe('string');
  });

  it('loads an empty registry when the file is absent or malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ewoh-git-sync-reg-'));
    expect(loadRegistry(dir)).toEqual([]);
    const registryDir = join(dir, 'work');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, 'git-sync.json'), 'not-json', 'utf8');
    expect(loadRegistry(dir)).toEqual([]);
  });
});
