import { WorldService } from '../../../server/modules/world/world.service';
import {
  ewohEvent,
  ewohEventChain,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohWorldState,
} from '@server/database/schema';

describe('WorldService unified replay', () => {
  it('merges world states, events, tasks, steps, and materials into lane-aware snapshots', async () => {
    const ts = new Date('2026-08-04T10:00:00.000Z');
    const rows = new Map<unknown, unknown[]>([
      [
        ewohWorldState,
        [
          {
            id: '1',
            entityId: 'EXO-1',
            ts,
            stateJson: {
              entity_type: 'device',
              x: 1,
              y: 2,
              status: 'running',
            },
          },
        ],
      ],
      [
        ewohEvent,
        [
          {
            eventId: 'EV-1',
            eventType: 'quality',
            severity: 'L2',
            title: '质检',
            createdAt: ts,
            updatedAt: ts,
            deviceId: 'EXO-1',
            sourceType: 'real',
            status: 'open',
            eventCode: 'QUALITY',
          },
        ],
      ],
      [
        ewohScheduleTask,
        [
          {
            scheduleTaskId: 'WO-1',
            status: 'released',
            createdAt: ts,
            updatedAt: ts,
          },
        ],
      ],
      [
        ewohScheduleTaskStep,
        [
          {
            stepId: 'S1',
            status: 'pending',
            createdAt: ts,
            updatedAt: ts,
          },
        ],
      ],
      [
        ewohResourceBinding,
        [
          {
            bindingId: 'B1',
            resourceId: 'M1',
            bindingType: 'material_consumption',
            targetId: 'WO-1',
            status: 'active',
            startTime: ts,
          },
        ],
      ],
    ]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => {
          const chain = {
            where: jest.fn(() => chain),
            orderBy: jest.fn(() => chain),
            limit: jest.fn(() => chain),
            then: (resolve: (value: unknown[]) => void) =>
              resolve(rows.get(table) ?? []),
          };
          return chain;
        }),
      })),
    };
    const service = new WorldService(
      db as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const snapshots = await service.getReplay(
      '2026-08-04T09:00:00.000Z',
      '2026-08-04T11:00:00.000Z',
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].events.map((event) => event.lane)).toEqual(
      expect.arrayContaining(['quality', 'task', 'material']),
    );
    expect(snapshots[0].devices[0].entityId).toBe('EXO-1');
  });

  it('returns before/during/after context around an event', async () => {
    const ts = new Date('2026-08-04T10:00:00.000Z');
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([
            {
              eventId: 'EV-1',
              createdAt: ts,
              updatedAt: ts,
            },
          ]),
        })),
      })),
    };
    const service = new WorldService(
      db as never,
      { appendAuditLog: jest.fn() } as never,
    );
    jest.spyOn(service, 'getReplay').mockResolvedValue([
      {
        ts: '2026-08-04T09:55:00.000Z',
        persons: [],
        devices: [],
        events: [],
      },
      {
        ts: '2026-08-04T10:00:00.000Z',
        persons: [],
        devices: [],
        events: [{ eventId: 'EV-1', severity: 'L2', title: 'x', lane: 'alert' }],
      },
      {
        ts: '2026-08-04T10:05:00.000Z',
        persons: [],
        devices: [],
        events: [],
      },
    ]);

    const context = await service.getEventContext('EV-1', 10);

    expect(context.before?.ts).toBe('2026-08-04T09:55:00.000Z');
    expect(context.during?.ts).toBe('2026-08-04T10:00:00.000Z');
    expect(context.after?.ts).toBe('2026-08-04T10:05:00.000Z');
  });

  it('creates an issue from a replay event and writes the causal chain', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([
            {
              eventId: 'EV-1',
              deviceId: 'EXO-1',
              title: '原始告警',
              severity: 'L3',
              createdAt: new Date('2026-08-04T10:00:00.000Z'),
            },
          ]),
        })),
      })),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn().mockResolvedValue(
          table === ewohEventChain
            ? [{ eventId: 'RPL-1' }]
            : [{ eventId: 'RPL-1' }],
        ),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new WorldService(db as never, audit as never);

    const result = await service.createReplayItem(
      { eventId: 'EV-1', kind: 'issue', title: '跟进问题', note: '需要复核' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.eventId).toMatch(/^RPL-/);
    expect(result.kind).toBe('issue');
    expect(db.insert).toHaveBeenCalledWith(ewohEvent);
    expect(db.insert).toHaveBeenCalledWith(ewohEventChain);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'world.replay.item.create' }),
    );
  });
});
