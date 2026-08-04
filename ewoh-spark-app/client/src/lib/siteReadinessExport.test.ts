import {
  buildAcceptancePackage,
  buildAcceptanceMarkdown,
  buildPendingItemsMarkdown,
} from './siteReadinessExport';
import { SITE_READINESS_STAGES } from './siteReadinessFlow';
import { DEFAULT_MAPPING_RULES } from './siteReadinessMapping';
import { EMPTY_APPROVAL } from './siteReadinessTasks';

describe('siteReadinessExport', () => {
  const state = {
    generatedAt: '2026-08-04T00:00:00.000Z',
    stages: SITE_READINESS_STAGES,
    backendChecks: {
      F0: [],
      F1: [],
      F2: [],
      F3: [],
      F4: [],
      F5: [],
      F6: [],
    },
    backendReports: [],
    probe: null,
    backendReachable: null,
    mapping: { rules: DEFAULT_MAPPING_RULES, updatedAt: '' },
    importPreview: null,
    tasks: [],
    approval: EMPTY_APPROVAL,
  };

  it('builds an acceptance package with seven stages', () => {
    const pkg = buildAcceptancePackage(state);
    expect((pkg.stages as unknown[]).length).toBe(7);
    expect(pkg.schema).toBe('ewoh.site-readiness.acceptance.v1');
  });

  it('builds a markdown acceptance summary', () => {
    const md = buildAcceptanceMarkdown(state);
    expect(md).toContain('# Site Readiness 验收包');
    expect(md).toContain('| F0 |');
  });

  it('builds a pending items markdown', () => {
    const md = buildPendingItemsMarkdown([]);
    expect(md).toContain('暂无未决项');
  });
});