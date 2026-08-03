import { SimulatorService } from '../../../server/modules/simulator/simulator.service';

function createDbMocks() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue([]);
  const values = jest.fn(() => ({ onConflictDoUpdate }));
  const updateWhere = jest.fn().mockResolvedValue([]);
  const selectWhere = jest.fn().mockResolvedValue([]);
  return {
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: selectWhere,
          then: (resolve: (value: unknown) => void) => resolve([]),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
      insert: jest.fn(() => ({ values })),
    } as never,
    values,
    selectWhere,
    updateWhere,
  };
}

function createContextMock() {
  let insideTransaction = false;
  const runInTransaction = jest.fn(
    async (_settings: unknown, operation: () => Promise<unknown>) => {
      insideTransaction = true;
      try {
        return await operation();
      } finally {
        insideTransaction = false;
      }
    },
  );
  return {
    runInTransaction,
    isInsideTransaction: () => insideTransaction,
  };
}

const SIM_ORG_KEY = 'EWOH_SIMULATOR_ORG_ID';

describe('SimulatorService background org context', () => {
  const originalOrg = process.env[SIM_ORG_KEY];

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalOrg === undefined) {
      delete process.env[SIM_ORG_KEY];
    } else {
      process.env[SIM_ORG_KEY] = originalOrg;
    }
  });

  it('skips the tick and increments observable error count when org is not configured', async () => {
    delete process.env[SIM_ORG_KEY];
    const { db } = createDbMocks();
    const ruleEngine = {
      evaluate: jest.fn(),
      fireDeviceOffline: jest.fn(),
    };
    const context = { runInTransaction: jest.fn() };
    const service = new SimulatorService(
      db,
      ruleEngine as never,
      context as never,
    );
    (service as unknown as { running: boolean }).running = true;
    (service as unknown as { mainTicking: boolean }).mainTicking = false;

    await (service as unknown as { mainTick: () => Promise<void> }).mainTick();

    expect(context.runInTransaction).not.toHaveBeenCalled();
    expect(
      (service as unknown as { simulationErrorCount: number })
        .simulationErrorCount,
    ).toBe(1);
    const status = await service.getStatus();
    expect(status.simulationErrorCount).toBe(1);
  });

  it('runs main tick writes inside a transaction with the simulator org GUC', async () => {
    process.env[SIM_ORG_KEY] = 'org-sim';
    const { db, values } = createDbMocks();
    const evaluate = jest.fn().mockResolvedValue(undefined);
    const ruleEngine = {
      evaluate,
      fireDeviceOffline: jest.fn(),
    };
    const context = createContextMock();
    const service = new SimulatorService(
      db,
      ruleEngine as never,
      context as never,
    );
    (service as unknown as { running: boolean }).running = true;
    (service as unknown as { mainTicking: boolean }).mainTicking = false;
    (service as unknown as { devices: unknown[] }).devices = [
      {
        entityId: 'EXO-001',
        deviceId: 'EXO-001',
        workerId: 'W-1',
        battery: 100,
        online: true,
        pitchDeg: 0,
        loadScore: 0.3,
        fatigueTrend: 0,
        qualityStatus: 'ok',
      },
    ];
    (service as unknown as { persons: unknown[] }).persons = [];
    (
      service as unknown as { tempOfflineDevices: Set<string> }
    ).tempOfflineDevices = new Set();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    let valuesSawTransaction: boolean | null = null;
    values.mockImplementation(() => {
      valuesSawTransaction = context.isInsideTransaction();
      return { onConflictDoUpdate: jest.fn().mockResolvedValue([]) };
    });
    let evaluateSawTransaction: boolean | null = null;
    evaluate.mockImplementation(async () => {
      evaluateSawTransaction = context.isInsideTransaction();
    });

    await (service as unknown as { mainTick: () => Promise<void> }).mainTick();

    expect(context.runInTransaction).toHaveBeenCalledTimes(1);
    expect(context.runInTransaction).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'app.user_id', value: 'simulator' },
        { name: 'app.current_org_id', value: 'org-sim' },
        { name: 'app.current_org_ids', value: 'org-sim' },
      ]),
      expect.any(Function),
    );
    expect(valuesSawTransaction).toBe(true);
    expect(evaluateSawTransaction).toBe(true);
    expect(
      (service as unknown as { simulationErrorCount: number })
        .simulationErrorCount,
    ).toBe(0);
  });

  it('runs environment tick writes inside a transaction with the simulator org GUC', async () => {
    process.env[SIM_ORG_KEY] = 'org-sim';
    const { db, values } = createDbMocks();
    const ruleEngine = {
      evaluate: jest.fn(),
      fireDeviceOffline: jest.fn(),
    };
    const context = createContextMock();
    const service = new SimulatorService(
      db,
      ruleEngine as never,
      context as never,
    );
    (service as unknown as { running: boolean }).running = true;
    (service as unknown as { envTicking: boolean }).envTicking = false;
    (service as unknown as { zoneIds: string[] }).zoneIds = ['Z-1'];

    let valuesSawTransaction: boolean | null = null;
    values.mockImplementation(() => {
      valuesSawTransaction = context.isInsideTransaction();
      return { onConflictDoUpdate: jest.fn().mockResolvedValue([]) };
    });

    await (service as unknown as { envTick: () => Promise<void> }).envTick();

    expect(context.runInTransaction).toHaveBeenCalledTimes(1);
    expect(context.runInTransaction).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'app.current_org_id', value: 'org-sim' },
      ]),
      expect.any(Function),
    );
    expect(valuesSawTransaction).toBe(true);
  });

  it('loads initial state inside a transaction with the simulator org GUC', async () => {
    process.env[SIM_ORG_KEY] = 'org-sim';
    const { db } = createDbMocks();
    const ruleEngine = {
      evaluate: jest.fn(),
      fireDeviceOffline: jest.fn(),
    };
    const context = createContextMock();
    const service = new SimulatorService(
      db,
      ruleEngine as never,
      context as never,
    );

    await (
      service as unknown as { loadInitialState: () => Promise<void> }
    ).loadInitialState();

    expect(context.runInTransaction).toHaveBeenCalledTimes(1);
    expect(context.runInTransaction).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'app.current_org_id', value: 'org-sim' },
      ]),
      expect.any(Function),
    );
  });
});
