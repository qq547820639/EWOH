import { RuleEngineService } from '../../../server/modules/rule-engine/rule-engine.service';

function createRuleEngineDb(eventRows: unknown[]) {
  const selectLimit = jest.fn().mockResolvedValue(eventRows);
  const insert = jest.fn(() => ({
    values: jest.fn().mockResolvedValue([]),
  }));
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: selectLimit })),
      })),
    })),
    insert,
  } as never;
  return { db, selectLimit, insert };
}

describe('RuleEngineService dedup', () => {
  it('suppresses an event when a recent event exists in the database window', async () => {
    const recentEvent = {
      eventId: 'EVT-1',
      eventCode: 'LOW_BATTERY',
      deviceId: 'exo-1',
      createdAt: new Date(Date.now() - 5_000),
    };
    const { db, selectLimit, insert } = createRuleEngineDb([recentEvent]);
    const service = new RuleEngineService(db);

    const triggered = await service.evaluate({
      deviceId: 'exo-1',
      batteryPct: 10,
    });

    expect(triggered).toBe(0);
    expect(selectLimit).toHaveBeenCalledWith(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('fires when the database window has no recent event', async () => {
    const { db, selectLimit, insert } = createRuleEngineDb([]);
    const service = new RuleEngineService(db);

    const triggered = await service.evaluate({
      deviceId: 'exo-1',
      batteryPct: 10,
    });

    expect(triggered).toBe(1);
    expect(selectLimit).toHaveBeenCalledWith(1);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('uses the in-memory cache to suppress within the same window', async () => {
    const { db, selectLimit, insert } = createRuleEngineDb([]);
    const service = new RuleEngineService(db);

    const first = await service.evaluate({
      deviceId: 'exo-1',
      batteryPct: 10,
    });
    const second = await service.evaluate({
      deviceId: 'exo-1',
      batteryPct: 9,
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(selectLimit).toHaveBeenCalledTimes(1);
  });

  it('re-queries the database after the cache window expires', async () => {
    jest.useFakeTimers();
    try {
      const { db, selectLimit } = createRuleEngineDb([]);
      const service = new RuleEngineService(db);

      const first = await service.evaluate({
        deviceId: 'exo-1',
        batteryPct: 10,
      });
      jest.advanceTimersByTime(30_001);
      const second = await service.evaluate({
        deviceId: 'exo-1',
        batteryPct: 9,
      });

      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(selectLimit).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('deduplicates fireDeviceOffline against the database window', async () => {
    const recentEvent = {
      eventId: 'EVT-2',
      eventCode: 'DEVICE_OFFLINE',
      deviceId: 'exo-1',
      createdAt: new Date(Date.now() - 10_000),
    };
    const { db, insert } = createRuleEngineDb([recentEvent]);
    const service = new RuleEngineService(db);

    await service.fireDeviceOffline('exo-1');

    expect(insert).not.toHaveBeenCalled();
  });
});
