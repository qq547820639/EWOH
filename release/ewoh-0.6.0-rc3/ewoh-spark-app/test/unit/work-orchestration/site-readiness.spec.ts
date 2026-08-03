import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateSiteReadiness } from '../../../../tools/factory-replication/site-readiness.js';

const root = join(__dirname, '..', '..', '..', '..');

describe('factory site readiness', () => {
  it('accepts a site with all required evidence', () => {
    const report = JSON.parse(
      readFileSync(join(root, 'tools/factory-replication/fixtures/site-ready.json'), 'utf8'),
    );
    const result = evaluateSiteReadiness(report);
    expect(result.ready).toBe(true);
    expect(result.requiredPassed).toBe(5);
    expect(result.requiredFailed).toBe(0);
  });

  it('rejects a site missing required evidence', () => {
    const report = JSON.parse(
      readFileSync(join(root, 'tools/factory-replication/fixtures/site-not-ready.json'), 'utf8'),
    );
    const result = evaluateSiteReadiness(report);
    expect(result.ready).toBe(false);
    expect(result.requiredFailed).toBe(1);
  });

  it('treats optional items as non-blocking', () => {
    const result = evaluateSiteReadiness({
      schemaVersion: 'ewoh:///site-readiness/v1',
      factoryName: 'Boundary',
      siteContact: 'owner@example.com',
      items: [
        { id: 'R1', label: 'required', required: true, status: 'pass', evidence: 'ok' },
        { id: 'O1', label: 'optional', required: false, status: 'fail', evidence: 'ok' },
      ],
    });
    expect(result.ready).toBe(true);
    expect(result.requiredCount).toBe(1);
  });
});
