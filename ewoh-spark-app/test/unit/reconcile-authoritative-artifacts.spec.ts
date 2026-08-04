import fs from 'node:fs';
import path from 'node:path';
import { reconcile } from '../../../scripts/reconcile-authoritative-artifacts';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('reconcile-authoritative-artifacts', () => {
  it('returns a valid machine-readable report with checks, conflicts and summary', () => {
    const report = reconcile(REPO_ROOT);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(Array.isArray(report.conflicts)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(report.summary).toBeDefined();
    expect(report.summary.total).toBe(report.checks.length);
    expect(report.summary.passed + report.summary.failed).toBe(report.summary.total);
    expect(typeof report.headSha).toBe('string');
    expect(report.root).toBe(REPO_ROOT);
  });

  it('reports version consistency between CHANGELOG and release-manifest', () => {
    const report = reconcile(REPO_ROOT);
    const check = report.checks.find((entry) => entry.name === 'version_changelog_vs_release_manifest');
    expect(check).toBeDefined();
    expect(check.ok).toBe(true);
  });

  it('reconciles the OpenAPI route manifest against the live scan', () => {
    const report = reconcile(REPO_ROOT);
    const check = report.checks.find((entry) => entry.name === 'route_manifest_consistent_with_live_scan');
    expect(check).toBeDefined();
    expect(check.ok).toBe(true);
  });

  it('computes the 51-table managed footprint consistently with CHANGELOG/state/release-manifest', () => {
    const report = reconcile(REPO_ROOT);
    const check = report.checks.find((entry) => entry.name === 'db_table_footprint_reconcile');
    expect(check).toBeDefined();
    // 受管表口径：managed_tables list 共 51 表，与 CHANGELOG(48→51)/state.json/release-manifest 声称一致。
    // additional_hardened_existing_tables（如 ewoh_organization/ewoh_personnel）是既有已加固表，不计入受管 51 表口径。
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/computed=51/);
    expect(check.detail).toMatch(/claimed: changelog=51/);
  });

  it('never silently rewrites authoritative sources (read-only reconcile)', () => {
    const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
    const before = fs.readFileSync(changelogPath, 'utf8');
    reconcile(REPO_ROOT);
    const after = fs.readFileSync(changelogPath, 'utf8');
    expect(after).toBe(before);
  });
});