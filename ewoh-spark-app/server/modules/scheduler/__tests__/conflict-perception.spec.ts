/* NO-58b（调度侧接入）：感知融合不可信 → 调度冲突面显式可见（提示层）。
 *
 * 钉住的语义：
 *   1. 门控不允许强建议（多源冲突/过期/置信度不足）+ 主体牵涉在飞任务 → 产出 perception_inconsistent；
 *   2. 门控允许 → 不产出（不制造噪声）；
 *   3. 主体与在飞任务无关 → 不产出（闲置信设备的感知噪声不许淹没真冲突）；
 *   4. 工位主体 `station:<id>` → resourceType=station，resourceId 去前缀；
 *   5. 未注入感知服务 / 无租户上下文 / 感知读取失败 → 不产出感知冲突，且**其余冲突照旧**（如实降级）；
 *   6. 感知冲突**不阻断**任何调度：只是新增一条可见冲突，不改变其它冲突。
 */
/// <reference types="jest" />
import { ConflictService } from '../conflict.service';
import { ewohSchedulePlan } from '@server/database/schema';
import { WorldStateSnapshotService } from '../world-state.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { AuditService } from '@server/modules/shared/audit.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import type { PerceptionFusionService } from '../../perception/perception-fusion.service';
import type { WorldStateSnapshot } from '@shared/api.interface';

const ORG = '00000000-0000-4000-8000-000000000001';
const CTX = { userId: 'lead.chen', primaryOrgId: ORG } as never;

function baseState(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'CURRENT',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
    persons: [
      {
        id: 'P-63000000',
        name: '张三',
        status: 'ACTIVE',
        healthStatus: null,
        skills: [],
        certifications: [],
        loadLevel: 0,
        fatigueLevel: 0,
        stationId: 'WS-1',
        zoneId: null,
        x: 1,
        y: 1,
        dataQuality: 'FRESH',
      },
    ],
    tasks: [
      {
        id: 'T-1',
        title: '装配',
        taskType: 'assembly',
        priority: 'normal',
        status: 'in_progress',
        assigneeId: 'P-63000000',
        deviceId: 'DEV-04',
        stationId: 'WS-1',
        zoneId: null,
        planStart: null,
        planEnd: null,
        progress: 0,
        predecessorIds: [],
        requiredSkills: [],
        requiredCertifications: [],
      },
    ],
    devices: [
      {
        id: 'DEV-04',
        name: '拧紧枪',
        status: 'ONLINE',
        batteryPct: 80,
        dataQuality: 'FRESH',
        capabilities: [],
      } as never,
      {
        id: 'DEV-99',
        name: '闲置设备',
        status: 'ONLINE',
        batteryPct: 80,
        dataQuality: 'FRESH',
        capabilities: [],
      } as never,
    ],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
    ...overrides,
  } as WorldStateSnapshot;
}

function makeService(options: {
  state?: WorldStateSnapshot;
  gates?: Map<string, Record<string, unknown>>;
  perceptionThrows?: boolean;
  withPerception?: boolean;
} = {}) {
  // 活跃方案查询：本 spec 只关心感知冲突 → 返回空活跃方案集（可链式 where/orderBy/limit）。
  const planQuery: any = Promise.resolve([]);
  planQuery.where = () => planQuery;
  planQuery.orderBy = () => planQuery;
  planQuery.limit = () => planQuery;
  const db = {
    select: () => ({ from: (table: unknown) => (table === ewohSchedulePlan ? planQuery : Promise.resolve([])) }),
  };
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
  };
  const worldState = {
    getCurrentWorldState: jest.fn().mockResolvedValue(options.state ?? baseState()),
    isPlanStale: jest.fn().mockResolvedValue(false),
  };
  const policy = { getConfig: jest.fn().mockResolvedValue({ triggerCooldownMs: 30_000, minBatteryPct: 15 }) };
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const perception = {
    latestGates: jest.fn(async () => {
      if (options.perceptionThrows) throw new Error('perception table unavailable');
      return options.gates ?? new Map();
    }),
  };
  const svc = new ConflictService(
    db as never,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    worldState as unknown as WorldStateSnapshotService,
    policy as unknown as SchedulingPolicyService,
    audit as unknown as AuditService,
    undefined,
    (options.withPerception === false ? undefined : perception) as unknown as PerceptionFusionService,
  );
  return { svc, perception, worldState };
}

const DENY_GATE = {
  strongAdviceAllowed: false,
  level: 'low',
  agreement: 'conflict',
  reason: '感知融合不许强建议：一致性 conflict / 置信度 low / 冲突 2 条',
  fusedAt: '2026-09-12T08:00:00.000Z',
  basis: 'window 08:00~08:05；规则留痕 2 条命中',
};
const ALLOW_GATE = {
  strongAdviceAllowed: true,
  level: 'high',
  agreement: 'consistent',
  reason: null,
  fusedAt: '2026-09-12T08:00:00.000Z',
  basis: 'window 08:00~08:05；规则留痕 0 条命中',
};

describe('NO-58b 感知不可信 → 调度冲突面（提示层，不阻断）', () => {
  it('门控不允许强建议且设备在飞 → 产出 perception_inconsistent（带资源/任务/依据）', async () => {
    const { svc, perception } = makeService({
      gates: new Map([['DEV-04', DENY_GATE]]),
    });
    const conflicts = await svc.derive(CTX);
    const found = conflicts.filter((c) => c.type === 'perception_inconsistent');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      scope: 'resource',
      resourceType: 'device',
      resourceId: 'DEV-04',
      severity: 'high',
      taskIds: ['T-1'],
      snapshotVersion: 'CURRENT',
    });
    expect(found[0].message).toContain('不可信');
    expect(found[0].resolution).toContain('不阻断调度');
    expect(found[0].data).toMatchObject({ factor: 'perception_fusion', agreement: 'conflict', confidenceLevel: 'low' });
    // 只查在飞任务牵涉的主体（不含闲置设备 DEV-99）
    expect(perception.latestGates).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['DEV-04', 'P-63000000', 'station:WS-1']),
    );
    const queried = (perception.latestGates as jest.Mock).mock.calls[0][1] as string[];
    expect(queried).not.toContain('DEV-99');
  });

  it('门控允许强建议 → 不产出（不制造噪声）', async () => {
    const { svc } = makeService({ gates: new Map([['DEV-04', ALLOW_GATE]]) });
    const conflicts = await svc.derive(CTX);
    expect(conflicts.filter((c) => c.type === 'perception_inconsistent')).toHaveLength(0);
  });

  it('主体与在飞任务无关 → 不产出（闲置信设备的感知噪声不淹没真冲突）', async () => {
    const { svc } = makeService({ gates: new Map([['DEV-99', DENY_GATE]]) });
    const conflicts = await svc.derive(CTX);
    expect(conflicts.filter((c) => c.type === 'perception_inconsistent')).toHaveLength(0);
  });

  it('工位主体 `station:<id>` → resourceType=station 且 resourceId 去前缀', async () => {
    const { svc } = makeService({ gates: new Map([['station:WS-1', DENY_GATE]]) });
    const conflicts = await svc.derive(CTX);
    const found = conflicts.filter((c) => c.type === 'perception_inconsistent');
    expect(found).toHaveLength(1);
    expect(found[0].resourceType).toBe('station');
    expect(found[0].resourceId).toBe('WS-1');
    expect(found[0].taskIds).toEqual(['T-1']);
    // severity：一致性 conflict → high；只有"过期/未知"才是 medium
    expect(found[0].severity).toBe('high');
  });

  it('人员主体的规范前缀 `person:` 也判为 person（不是 device；与裸 personnel id 两种写法都要认）', async () => {
    const { svc, worldState } = makeService({ gates: new Map([['person:SPATIAL-1', DENY_GATE]]) });
    const stateWithPrefixedPerson = baseState();
    (stateWithPrefixedPerson.tasks as unknown as Array<Record<string, unknown>>)[0] = {
      ...(stateWithPrefixedPerson.tasks[0] as unknown as Record<string, unknown>),
      assigneeId: 'person:SPATIAL-1',
    };
    (worldState.getCurrentWorldState as jest.Mock).mockResolvedValue(stateWithPrefixedPerson);
    const conflicts = await svc.derive(CTX);
    const found = conflicts.filter((c) => c.type === 'perception_inconsistent');
    expect(found).toHaveLength(1);
    expect(found[0].resourceType).toBe('person');
    expect(found[0].resourceId).toBe('person:SPATIAL-1');
    expect(found[0].taskIds).toEqual(['T-1']);
  });

  it('中等门控（非 conflict 且非 low）→ medium 严重度', async () => {
    const { svc } = makeService({
      gates: new Map([['P-63000000', { ...DENY_GATE, agreement: 'partial', level: 'medium' }]]),
    });
    const conflicts = await svc.derive(CTX);
    const found = conflicts.filter((c) => c.type === 'perception_inconsistent');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('medium');
    expect(found[0].resourceType).toBe('person');
  });

  it('感知融合不可信不阻断其它冲突：设备离线冲突照旧产出', async () => {
    const state = baseState();
    (state.devices as Array<Record<string, unknown>>)[0] = {
      ...(state.devices[0] as unknown as Record<string, unknown>),
      status: 'OFFLINE',
    };
    const { svc } = makeService({ state, gates: new Map([['DEV-04', DENY_GATE]]) });
    const conflicts = await svc.derive(CTX);
    expect(conflicts.some((c) => c.type === 'device_offline')).toBe(true);
    expect(conflicts.some((c) => c.type === 'perception_inconsistent')).toBe(true);
  });

  it('未注入感知服务（旧单测/未部署）→ 零感知冲突且不抛错', async () => {
    const { svc } = makeService({ withPerception: false });
    const conflicts = await svc.derive(CTX);
    expect(conflicts.filter((c) => c.type === 'perception_inconsistent')).toHaveLength(0);
  });

  it('无租户上下文 → 不查感知快照（避免跨租户混入）', async () => {
    const { svc, perception } = makeService({ gates: new Map([['DEV-04', DENY_GATE]]) });
    const conflicts = await svc.derive(undefined);
    expect(perception.latestGates).not.toHaveBeenCalled();
    expect(conflicts.filter((c) => c.type === 'perception_inconsistent')).toHaveLength(0);
  });

  it('感知读取失败 → 只记日志跳过，其余冲突照旧（如实降级，不伪造）', async () => {
    const state = baseState();
    (state.devices as Array<Record<string, unknown>>)[0] = {
      ...(state.devices[0] as unknown as Record<string, unknown>),
      status: 'OFFLINE',
    };
    const { svc } = makeService({ state, perceptionThrows: true });
    const conflicts = await svc.derive(CTX);
    expect(conflicts.filter((c) => c.type === 'perception_inconsistent')).toHaveLength(0);
    expect(conflicts.some((c) => c.type === 'device_offline')).toBe(true);
  });

  it('无在飞任务 → 不查感知（空任务集直接跳过）', async () => {
    const state = baseState({
      tasks: [
        {
          ...(baseState().tasks[0] as Record<string, unknown>),
          status: 'completed',
        } as never,
      ],
    });
    const { svc, perception } = makeService({ state, gates: new Map([['DEV-04', DENY_GATE]]) });
    const conflicts = await svc.derive(CTX);
    expect(perception.latestGates).not.toHaveBeenCalled();
    expect(conflicts.filter((c) => c.type === 'perception_inconsistent')).toHaveLength(0);
  });
});
