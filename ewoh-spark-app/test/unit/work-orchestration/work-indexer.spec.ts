import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEvidence,
  validateGraph,
} from '../../../../tools/work-indexer/index.js';

describe('work indexer invariants and evidence binding', () => {
  it('rejects orphan edges, duplicate ids, cycles, and unowned items', () => {
    const graph = {
      items: [
        { id: 'A', title: 'A', type: 'task', status: 'Done', owner: 'AG-00' },
        { id: 'A', title: 'A2', type: 'task', status: 'Done', owner: 'AG-00' },
        { id: 'B', title: 'B', type: 'task', status: 'In Progress', owner: '' },
      ],
      edges: [
        { id: 'E-1', from: 'A', to: 'MISSING', edgeType: 'depends', blocking: true },
        { id: 'E-1', from: 'A', to: 'B', edgeType: 'depends', blocking: true },
        { id: 'E-2', from: 'B', to: 'A', edgeType: 'depends', blocking: true },
      ],
      evidence: [],
    };

    const conflicts = validateGraph(graph);

    expect(conflicts).toEqual(
      expect.arrayContaining([
        'duplicate item id: A',
        'item without owner: B',
        'orphan edge E-1: A -> MISSING',
        'duplicate edge id: E-1',
        'blocking dependency cycle detected at A',
      ]),
    );
  });

  it('parses evidence front matter into bound metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ewoh-evidence-'));
    const evidenceDir = join(dir, '.codex', 'artifacts', 'work', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, 'round-bound.md'),
      [
        '---',
        'workItemId: T-999',
        'result: passed',
        'commitSha: abc123',
        'branch: codex/test',
        'buildVersion: 0.6.0-rc4',
        'dependencyVersion: 3:2.2.5',
        'testTime: 2026-08-04T00:00:00.000Z',
        'verifier: VAL-61',
        'expiresAt: 2099-01-01T00:00:00.000Z',
        '---',
        '# Bound Evidence',
        'PASSED',
      ].join('\n'),
      'utf8',
    );
    try {
      const evidence = parseEvidence(
        join(dir, '.codex', 'artifacts'),
        dir,
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        workItemId: 'T-999',
        commitSha: 'abc123',
        branch: 'codex/test',
        buildVersion: '0.6.0-rc4',
        dependencyVersion: '3:2.2.5',
        testTime: '2026-08-04T00:00:00.000Z',
        verifier: 'VAL-61',
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'valid',
      });
      expect(evidence[0].envFingerprint).toEqual(expect.any(String));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
