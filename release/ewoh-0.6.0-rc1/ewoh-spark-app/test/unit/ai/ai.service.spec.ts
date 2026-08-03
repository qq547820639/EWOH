import { AiService } from '../../../server/modules/ai/ai.service';

describe('AI manual decision flow', () => {
  it('starts with no suggestions or plans', async () => {
    const service = new AiService();
    expect(await service.getSnapshotVersion()).toBe(0);
  });

  it('creates structured suggestion only on manual trigger', async () => {
    const service = new AiService();
    const suggestion = await service.createSuggestion({
      triggeredBy: 'user-1',
      problem: '工位积压',
      snapshot: { version: 3, from: '2026-08-03T00:00:00Z', to: '2026-08-03T01:00:00Z', records: 120 },
    });
    expect(suggestion.snapshotVersion).toBe(3);
    expect(suggestion.confirmItems.length).toBeGreaterThan(0);
    const plan = await service.createPlan(suggestion.id, { shift: 'A' });
    expect(plan.isSimulation).toBe(true);
    expect(plan.status).toBe('shadow');
  });

  it('persists suggestions and plans through the database when available', async () => {
    const dbSuggestion = {
      id: 'sug-db',
      triggeredBy: 'user-1',
      frozenAt: '2026-08-03T00:00:00Z',
      snapshotVersion: 4,
      problem: '库存积压',
      dataRange: { from: 't0', to: 't1' },
      completeness: 0.8,
      basis: ['snapshot'],
      suggestion: 'review',
      risk: [],
      uncertainty: [],
      confirmItems: ['confirm'],
      expiryConditions: ['version changes'],
    };
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ content: JSON.stringify(dbSuggestion) }])
      .mockResolvedValueOnce([{ suggestion_id: 'sug-db' }])
      .mockResolvedValueOnce([]);
    const service = new AiService({ execute } as never);

    const suggestion = await service.createSuggestion({
      triggeredBy: 'user-1',
      problem: '库存积压',
      snapshot: { version: 4, from: 't0', to: 't1', records: 80 },
    });
    expect(suggestion.id).toBe('sug-db');
    const plan = await service.createPlan(suggestion.id, { shift: 'A' });
    expect(plan.id).toBe('plan-sug-db');
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
