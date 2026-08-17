/* SimulatorService 写入归属回归（R2-SNZ-004，2026-08-17 审计整改）。
 *
 * ewoh_world_state / ewoh_environment 两表 orgId 无 DB default——原先
 * 模拟器批量插入不带 orgId，行落 NULL = legacy 全租户可见。现所有写入
 * 行显式携带 EWOH_SIMULATOR_ORG_ID（source_type='simulated' 保持）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG）。
 */
/// <reference types="jest" />
import { SimulatorService } from '../simulator.service';

const SIM_ORG = 'org-simulator';

function createSimulatorEnv() {
  const inserts: Array<{ table: unknown; values: unknown[] }> = [];
  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn(async (vals: unknown | unknown[]) => {
        inserts.push({ table, values: Array.isArray(vals) ? vals : [vals] });
        return Array.isArray(vals) ? vals : [vals];
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => undefined),
      })),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => {
          const thenable = {
            gte: jest.fn(() => ({ limit: jest.fn(async () => []) })),
            limit: jest.fn(async () => []),
            orderBy: jest.fn(() => ({ limit: jest.fn(async () => []) })),
            then: (resolve: (v: unknown[]) => void) => resolve([]),
          };
          return thenable;
        }),
      })),
    })),
  };
  const requestDatabaseContext = {
    runInTransaction: (_settings: unknown, operation: () => Promise<void>) =>
      operation(),
  };
  const service = new SimulatorService(
    db as never,
    {} as never,
    requestDatabaseContext as never,
  );
  return { service, inserts };
}

describe('SimulatorService 写入归属（R2-SNZ-004）', () => {
  const prevOrg = process.env.EWOH_SIMULATOR_ORG_ID;
  const prevEnabled = process.env.EWOH_SIMULATOR_ENABLED;
  let randomSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.EWOH_SIMULATOR_ORG_ID = SIM_ORG;
    process.env.EWOH_SIMULATOR_ENABLED = '0';
    // 概率分支全关（OFFLINE/RESTRICTED 均不触发）。
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterAll(() => {
    if (prevOrg === undefined) delete process.env.EWOH_SIMULATOR_ORG_ID;
    else process.env.EWOH_SIMULATOR_ORG_ID = prevOrg;
    if (prevEnabled === undefined) delete process.env.EWOH_SIMULATOR_ENABLED;
    else process.env.EWOH_SIMULATOR_ENABLED = prevEnabled;
    randomSpy.mockRestore();
  });

  it('performMainTick：world_state 行显式携带模拟器 orgId', async () => {
    const { service, inserts } = createSimulatorEnv();
    (service as unknown as { persons: unknown[] }).persons = [
      {
        entityId: 'W-001',
        deviceId: 'EXO-001',
        task: 'assemble',
        x: 10,
        y: 10,
        targetX: 500,
        targetY: 500,
        loadScore: 0.3,
        status: 'active',
      },
    ];
    await (service as unknown as { performMainTick: (n: Date) => Promise<void> }).performMainTick(
      new Date('2026-08-16T10:00:00Z'),
    );
    const worldStateInsert = inserts.find((i) =>
      String((i.table as { _?: { name?: string } } | null)?._?.name ?? '').length >= 0 &&
      JSON.stringify(
        (i.values[0] as Record<string, unknown> | undefined) ?? {},
      ).includes('stateJson'),
    );
    expect(worldStateInsert).toBeDefined();
    for (const row of worldStateInsert!.values as Array<Record<string, unknown>>) {
      expect(row.orgId).toBe(SIM_ORG);
      expect((row.stateJson as Record<string, unknown>).source_type).toBe('simulated');
    }
  });

  it('envTick：environment 行显式携带模拟器 orgId', async () => {
    const { service, inserts } = createSimulatorEnv();
    (service as unknown as { running: boolean }).running = true;
    (service as unknown as { zoneIds: string[] }).zoneIds = ['zone-1', 'zone-2'];
    await (service as unknown as { envTick: () => Promise<void> }).envTick();
    const envInserts = inserts.filter((i) =>
      (i.values as Array<Record<string, unknown>>).every((v) => 'sensorId' in v),
    );
    expect(envInserts).toHaveLength(1);
    const rows = envInserts[0]!.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.orgId).toBe(SIM_ORG);
      expect(row.sourceType).toBe('simulated');
    }
  });
});
