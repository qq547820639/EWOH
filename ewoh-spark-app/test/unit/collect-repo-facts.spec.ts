import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../../scripts/collect-repo-facts';
import {
  gitBranch,
  gitHead,
  readVersion,
} from '../../../scripts/truth-source';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('collect-repo-facts', () => {
  it('collects a snapshot conforming to the repository-facts schema', () => {
    const snapshot = collect();
    expect(snapshot.schema).toBe('ewoh:///repository-facts/v1');
    expect(typeof snapshot.generatedAt).toBe('string');

    // Version comes from the single source of truth (version.json), never a
    // hard-coded literal in the snapshot.
    expect(snapshot.version).toBe(readVersion());
    expect(snapshot.version).toBeTruthy();

    // head/branch come from live git, not a stale copied SHA.
    expect(typeof snapshot.head).toBe('string');
    expect(snapshot.head.length).toBeGreaterThan(0);
    expect(snapshot.head).toBe(gitHead());
    expect(snapshot.branch).toBe(gitBranch());

    // Test counts are structurally present. Locally the CI JSON reports are
    // absent, so serverJest/clientJest/e2e/browser are null ("待生成"); when a
    // report exists they must be strings. openapi is always derived live.
    const { serverJest, clientJest, openapi, e2e, browser } = snapshot.testCounts;
    expect(openapi).toMatch(/^\d+\/\d+$/);
    for (const value of [serverJest, clientJest, e2e, browser]) {
      expect(value === null || typeof value === 'string').toBe(true);
    }

    // DB footprint is structurally present (numbers are derived, not asserted).
    expect(typeof snapshot.database.managedTables).toBe('number');
    expect(typeof snapshot.database.physicalTables).toBe('number');

    // Evidence summary must be present and internally consistent.
    expect(snapshot.evidence.total).toBeGreaterThan(0);
  });

  it('writes a machine-readable snapshot to --out when requested', () => {
    const outPath = path.join(REPO_ROOT, 'output', '_test-repository-facts.json');
    const args = process.argv;
    process.argv = ['node', 'collect-repo-facts.js', '--out', outPath, '--generatedAt', '2026-08-04T00:00:00.000Z'];
    try {
      collect();
      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(written.generatedAt).toBe('2026-08-04T00:00:00.000Z');
      expect(written.schema).toBe('ewoh:///repository-facts/v1');
    } finally {
      process.argv = args;
      if (fs.existsSync(outPath)) {
        fs.unlinkSync(outPath);
      }
    }
  });
});