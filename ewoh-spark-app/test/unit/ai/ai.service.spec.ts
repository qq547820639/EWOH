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
      dataRange: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
      completeness: 0.8,
      basis: ['snapshot'],
      suggestion: 'review',
      risk: [],
      uncertainty: [],
      confirmItems: ['confirm'],
      expiryConditions: ['version changes'],
    };
    // ADR-078：drizzle 链式假库（insert 返回 content；select/update 兼容既有断言）。
    const execute = jest.fn();
    const db = {
      execute,
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          returning: jest.fn().mockResolvedValue([{ content: JSON.stringify(dbSuggestion) }]),
        })),
      })),
      select: jest.fn(() => ({
        from: jest.fn(() => {
          const q: any = Promise.resolve([{ suggestionId: 'sug-db', content: JSON.stringify(dbSuggestion) }]);
          q.where = () => q;
          q.groupBy = () => q;
          q.orderBy = () => q;
          q.limit = () => q;
          return q;
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve([])),
        })),
      })),
    };
    const service = new AiService(db as never);

    const suggestion = await service.createSuggestion({
      triggeredBy: 'user-1',
      problem: '库存积压',
      snapshot: { version: 4, from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', records: 80 },
    });
    expect(suggestion.id).toBe('sug-db');
    const plan = await service.createPlan(suggestion.id, { shift: 'A' });
    expect(plan.id).toBe('plan-sug-db');
    // ADR-078：持久化走 drizzle 链式路径，raw SQL（execute）已清零。
    expect(execute).toHaveBeenCalledTimes(0);
  });
});
