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

  it('keeps scheduler and world keys stable', () => {
    expect(queryKeys.schedulerPlans()).toEqual(['scheduler-plans', 'all']);
    expect(queryKeys.schedulerPlans('confirmed')).toEqual(['scheduler-plans', 'confirmed']);
    expect(queryKeys.worldState).toEqual(['world-state']);
    expect(queryKeys.spatialEntities).toEqual(['spatial-entities']);
  });
});
