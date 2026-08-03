import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateReport } from '../../../../tools/factory-replication/index.js';

const root = join(__dirname, '..', '..', '..', '..');

describe('factory replication acceptance', () => {
  it('passes a config/asset-driven factory report', () => {
    const report = JSON.parse(
      readFileSync(
        join(root, 'tools/factory-replication/fixtures/passing.json'),
        'utf8',
      ),
    );
    const result = evaluateReport(report);
    expect(result.passed).toBe(true);
    expect(result.configSatisfactionRate).toBe(1);
    expect(result.customRate).toBe(0);
  });

  it('fails a core-forked factory report', () => {
    const report = JSON.parse(
      readFileSync(
        join(root, 'tools/factory-replication/fixtures/failing.json'),
        'utf8',
      ),
    );
    const result = evaluateReport(report);
    expect(result.passed).toBe(false);
    expect(result.configSatisfactionRate).toBe(0);
    expect(result.checks.find((check) => check.name === 'no-core-fork')?.passed).toBe(false);
  });

  it('requires at least 80 percent config/asset satisfaction', () => {
    const report = {
      schemaVersion: 'ewoh:///factory-replication/v1',
      factoryName: 'Boundary',
      profileId: 'PRF-BOUNDARY',
      templateId: 'TPL',
      coreFork: false,
      profileReplayPassed: true,
      requirements: [
        { id: 'R-001', satisfiedBy: 'config' },
        { id: 'R-002', satisfiedBy: 'config' },
        { id: 'R-003', satisfiedBy: 'config' },
        { id: 'R-004', satisfiedBy: 'custom' },
      ],
    };
    const result = evaluateReport(report);
    expect(result.configSatisfactionRate).toBe(0.75);
    expect(result.passed).toBe(false);
  });
});
