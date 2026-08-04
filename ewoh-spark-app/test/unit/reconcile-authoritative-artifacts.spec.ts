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

  it('truthfully reports the C1 51-table footprint conflict (computed vs claimed) without auto-fixing', () => {
    const report = reconcile(REPO_ROOT);
    const check = report.checks.find((entry) => entry.name === 'db_table_footprint_reconcile');
    expect(check).toBeDefined();
    // 已知 C1 冲突：51 表口径无单一出处，reconcile 必须如实报告 computed vs claimed。
    expect(check.ok).toBe(false);
    const conflict = report.conflicts.find((entry) => entry.name === 'db_table_footprint_reconcile');
    expect(conflict).toBeDefined();
    expect(conflict.detail).toMatch(/computed/);
    expect(conflict.detail).toMatch(/claimed/);
  });

  it('never silently rewrites authoritative sources (read-only reconcile)', () => {
    const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
    const before = fs.readFileSync(changelogPath, 'utf8');
    reconcile(REPO_ROOT);
    const after = fs.readFileSync(changelogPath, 'utf8');
    expect(after).toBe(before);
  });
});