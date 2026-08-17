import { queryKeys } from './queryKeys';

describe('queryKeys', () => {
  it('builds stable page-level keys', () => {
    expect(queryKeys.commandCenter).toEqual(['command-center']);
    expect(queryKeys.digitalWorld).toEqual(['digital-world']);
    expect(queryKeys.alerts).toEqual(['alerts']);
    expect(queryKeys.organizationTree).toEqual(['organization-tree']);
    expect(queryKeys.models).toEqual(['models']);
    expect(queryKeys.dataAssets).toEqual(['data-assets']);
    expect(queryKeys.systemConfigs).toEqual(['system-configs']);
    expect(queryKeys.aiSuggestions).toEqual(['ai-suggestions']);
    expect(queryKeys.aiPlans).toEqual(['ai-plans']);
    expect(queryKeys.operationsSummary).toEqual(['operations-summary']);
    expect(queryKeys.operationsAssets).toEqual(['operations-assets']);
    expect(queryKeys.operationsWorkCenters).toEqual(['operations-work-centers']);
  });

  it('embeds filters into personnel keys', () => {
    expect(queryKeys.personnel()).toEqual(['personnel', {}]);
    expect(queryKeys.personnel({ keyword: '张' })).toEqual(['personnel', { keyword: '张' }]);
  });

  it('keeps scheduler keys stable and shards world keys by org (CLI-715)', () => {
    expect(queryKeys.schedulerPlans()).toEqual(['scheduler-plans', 'all']);
    expect(queryKeys.schedulerPlans('confirmed')).toEqual(['scheduler-plans', 'confirmed']);
    // CLI-715：world/spatial 键按当前登录组织分片（未登录时 no-org 段）。
    expect(queryKeys.worldState).toEqual(['world-state', 'no-org']);
    expect(queryKeys.spatialEntities).toEqual(['spatial-entities', 'no-org']);
  });
});
