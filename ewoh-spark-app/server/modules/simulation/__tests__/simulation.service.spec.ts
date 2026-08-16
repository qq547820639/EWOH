/* SimulationService 契约行为测试（ADR-025 / NO-12a，§13 Digital Twin Simulation）。
 *
 * 覆盖：run 契约 fail-closed（未知 kind/isSimulation 缺失→拒绝）、org 缺失、
 * runId 幂等（同 org+runId 回读不重复评估）、四类评估器终态落账
 * （completed+results / 评估失败→failed+failureReason 绝不静默）、
 * SimulationRunCreated/Completed 双事件、§13 隔离（服务层唯一写路径 =
 * ewoh_simulation_run，绝不写 ewoh_world_state）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_044 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { SimulationService } from '../simulation.service';
import { ewohSimulationRun, ewohEvent, ewohWorldState } from '@server/database/schema';

const ORG_A = 'org-a';

const VALID_INPUT = {
  kind: 'capacity',
  baseRef: { snapshotVersion: 3 },
  parameters: {
    stations: [
      { stationId: 'station:s1', capacityPerHour: 10 },
      { stationId: 'station:s2', capacityPerHour: 25 },
    ],
    demandPerHour: 12,
  },
};

function collectValues(
  node: unknown,
  sets: { runIds: Set<string>; orgIds: Set<string> },
  seen: WeakSet<object>,
): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, sets, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      if (value.startsWith('sim:')) sets.runIds.add(value);
      if (value.startsWith('org-')) sets.orgIds.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { runIds: new Set<string>(), orgIds: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.runIds.size > 0 && !sets.runIds.has(String(row.runId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  return true;
}

function createSimulationDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
  const writtenTables: unknown[] = [];
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(state.rows.filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohSimulationRun) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        writtenTables.push(table);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          writtenTables.push(table);
          return { returning: jest.fn(async () => hit) };
        }),
      })),
    })),
  };
  const service = new SimulationService(db as never);
  return { db, rows: state.rows, events, service, writtenTables };
}

describe('SimulationService（NO-12a 数字孪生仿真台账）', () => {
  it('run 契约 fail-closed：未知 kind 拒绝且不落库（§33 绝不注册无引擎空类型）', async () => {
    const { rows, service } = createSimulationDb();
    await expect(
      service.run({ ...VALID_INPUT, kind: 'teleport' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('org 缺失显式失败（RLS 下不静默写全局）', async () => {
    const { rows, service } = createSimulationDb();
    await expect(service.run(VALID_INPUT, '')).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('capacity 评估成功：completed + results + 双事件', async () => {
    const { rows, events, service } = createSimulationDb();
    const result = await service.run(VALID_INPUT, ORG_A);
    expect(result.created).toBe(true);
    expect(result.run?.status).toBe('completed');
    expect(result.run?.results).toEqual({
      bottleneckStationId: 'station:s1',
      lineThroughputPerHour: 10,
      utilization: 1.2,
      overloaded: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.isSimulation).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual([
      'SimulationRunCreated',
      'SimulationRunCompleted',
    ]);
  });

  it('what-if 评估成功：结论差集落账', async () => {
    const { service } = createSimulationDb();
    const result = await service.run(
      {
        kind: 'what_if',
        baseRef: { snapshotVersion: 3 },
        parameters: {
          baseFacts: [
            { ruleId: 'rule:r1', subjectId: 'station:s1', conclusion: 'overload', confidence: 0.8 },
          ],
          deltaFacts: [
            { ruleId: 'rule:r2', subjectId: 'station:s3', conclusion: 'normal', confidence: 0.9 },
          ],
        },
      },
      ORG_A,
    );
    expect(result.run?.status).toBe('completed');
    const whatIfResults = (result.run?.results ?? {}) as Record<string, unknown[]>;
    expect(whatIfResults.added).toHaveLength(1);
    expect(whatIfResults.removed).toHaveLength(1);
  });

  it('评估失败 → failed + failureReason（§33 不静默吞异常）', async () => {
    const { rows, events, service } = createSimulationDb();
    const result = await service.run(
      {
        kind: 'layout',
        baseRef: { snapshotVersion: 3 },
        parameters: { stations: [], moves: [] },
      },
      ORG_A,
    );
    expect(result.run?.status).toBe('failed');
    expect(String(result.run?.failureReason)).toContain('stations 必须是非空列表');
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.failureReason).toBe(result.run?.failureReason);
    expect(events.map((e) => e.eventType)).toEqual([
      'SimulationRunCreated',
      'SimulationRunCompleted',
    ]);
  });

  it('runId 幂等：同 org+runId 重复提交回读既有运行且不重复评估', async () => {
    const { events, service } = createSimulationDb();
    const first = await service.run({ ...VALID_INPUT, runId: 'sim:fixed-1' }, ORG_A);
    expect(first.created).toBe(true);
    expect(events).toHaveLength(2);
    const second = await service.run({ ...VALID_INPUT, runId: 'sim:fixed-1' }, ORG_A);
    expect(second.created).toBe(false);
    expect(events).toHaveLength(2); // 不重复发事件
  });

  it('§13 隔离：服务层唯一写路径 = ewoh_simulation_run，绝不写生产 World State 表', async () => {
    const { writtenTables, service } = createSimulationDb();
    await service.run(VALID_INPUT, ORG_A);
    expect(writtenTables).toContain(ewohSimulationRun);
    expect(writtenTables).not.toContain(ewohWorldState);
  });

  it('getRun 租户作用域：他租户 run 不可见', async () => {
    const { service } = createSimulationDb([
      {
        id: '00000000-0000-4000-8000-000000000001',
        orgId: 'org-b',
        runId: 'sim:other-1',
        kind: 'capacity',
        status: 'completed',
        isSimulation: true,
        baseRefJson: { snapshotVersion: 0 },
        parametersJson: {},
        resultsJson: {},
        failureReason: null,
        engineVersion: '1.0.0',
        recordJson: {},
        createdAt: new Date(),
      },
    ]);
    await expect(service.getRun(ORG_A, 'sim:other-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
