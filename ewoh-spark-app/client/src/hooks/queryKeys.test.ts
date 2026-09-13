import { queryKeys } from './queryKeys';

describe('queryKeys', () => {
  it('builds stable page-level keys', () => {
    expect(queryKeys.commandCenter).toEqual(['no-org', 'command-center']);
    expect(queryKeys.digitalWorld).toEqual(['no-org', 'digital-world']);
    expect(queryKeys.alerts).toEqual(['no-org', 'alerts']);
    expect(queryKeys.organizationTree).toEqual(['no-org', 'organization-tree']);
    expect(queryKeys.models).toEqual(['no-org', 'models']);
    expect(queryKeys.dataAssets).toEqual(['no-org', 'data-assets']);
    expect(queryKeys.systemConfigs).toEqual(['no-org', 'system-configs']);
    expect(queryKeys.aiSuggestions).toEqual(['no-org', 'ai-suggestions']);
    expect(queryKeys.aiPlans).toEqual(['no-org', 'ai-plans']);
    expect(queryKeys.operationsSummary).toEqual(['no-org', 'operations-summary']);
    expect(queryKeys.operationsAssets).toEqual(['no-org', 'operations-assets']);
    expect(queryKeys.operationsWorkCenters).toEqual(['no-org', 'operations-work-centers']);
  });

  it('embeds filters into personnel keys', () => {
    expect(queryKeys.personnel()).toEqual(['no-org', 'personnel', {}]);
    expect(queryKeys.personnel({ keyword: '张' })).toEqual(['no-org', 'personnel', { keyword: '张' }]);
  });

  it('shards scheduler and world keys by org (CLI-715)', () => {
    expect(queryKeys.schedulerPlans()).toEqual(['scheduler-plans', 'no-org', 'all']);
    expect(queryKeys.schedulerPlans('confirmed')).toEqual(['scheduler-plans', 'no-org', 'confirmed']);
    expect(queryKeys.schedulerActivePlans).toEqual(['scheduler-active-plans', 'no-org']);
    expect(queryKeys.schedulerRuns()).toEqual(['scheduler', 'no-org', 'runs']);
    expect(queryKeys.schedulerRuns({ pageSize: 20 })).toEqual(['scheduler', 'no-org', 'runs', { pageSize: 20 }]);
    expect(queryKeys.schedulerSnapshot).toEqual(['scheduler', 'no-org', 'snapshot']);
    // CLI-715：world/spatial 键按当前登录组织分片（未登录时 no-org 段）。
    expect(queryKeys.worldState).toEqual(['world-state', 'no-org']);
    expect(queryKeys.spatialEntities).toEqual(['spatial-entities', 'no-org']);
  });
});
