import {
  SITE_READINESS_STAGES,
  clusterChecksByStage,
  classifyStage,
} from './siteReadinessFlow';

describe('siteReadinessFlow', () => {
  it('defines exactly seven F0-F6 stages', () => {
    expect(SITE_READINESS_STAGES.map((s) => s.id)).toEqual([
      'F0',
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'F6',
    ]);
  });

  it('classifies checks to stages by keyword', () => {
    expect(classifyStage({ id: 'db.ready', label: 'database ready' })).toBe('F2');
    expect(classifyStage({ id: 'helm', label: 'Helm installed' })).toBe('F1');
    expect(classifyStage({ id: 'mapping', label: 'field mapping' })).toBe('F3');
    expect(classifyStage({ id: 'training', label: 'training done' })).toBe('F5');
    expect(classifyStage({ id: 'xyz', label: 'arbitrary unclassified' })).toBeNull();
  });

  it('clusters backend checks by stage, falling back to F4', () => {
    const checks = [
      { id: 'db.ready', label: 'database ready', passed: true, status: 'passed' },
      { id: 'helm', label: 'Helm installed', passed: false, status: 'failed' },
      { id: 'odd', label: 'unclassified item', passed: true, status: 'passed' },
    ];
    const clustered = clusterChecksByStage(checks);
    expect(clustered.F2).toHaveLength(1);
    expect(clustered.F1).toHaveLength(1);
    expect(clustered.F4).toContainEqual(
      expect.objectContaining({ id: 'odd', source: 'backend' }),
    );
  });
});