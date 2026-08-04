import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../../scripts/collect-repo-facts';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('collect-repo-facts', () => {
  it('collects a snapshot conforming to the repository-facts schema', () => {
    const snapshot = collect();
    expect(snapshot.schema).toBe('ewoh:///repository-facts/v1');
    expect(typeof snapshot.generatedAt).toBe('string');
    expect(snapshot.version).toBe('0.6.0-rc4');
    expect(typeof snapshot.head).toBe('string');
    expect(snapshot.head.length).toBeGreaterThan(0);
    expect(snapshot.branch).toBe('main');

    // Test-count authoritative values must match the final HEAD.
    expect(snapshot.testCounts.serverJest).toMatch(/391/);
    expect(snapshot.testCounts.clientJest).toMatch(/50/);
    expect(snapshot.testCounts.openapi).toMatch(/248\/248/);
    expect(snapshot.testCounts.e2e).toMatch(/33\/33/);
    expect(snapshot.testCounts.browser).toMatch(/5\/5/);

    // DB footprint: distinguish 51 managed from 57 physical.
    expect(snapshot.database.managedTables).toBe(51);
    expect(snapshot.database.physicalTables).toBe(57);

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