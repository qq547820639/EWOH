/* T03 / P1-2（G7）：Candidate Engine 结构化拒绝测试。
 *
 * 先跑红再改绿：当前无 CandidateEngineService、getTaskCandidates 无 rejectReasons、
 * eligibility 无 health/station 维度。本 spec 断言各场景 rejectReasons 正确、
 * hard 不满足不进 feasible set。
 */
/// <reference types="jest" />
import { CandidateEngineService } from '../candidate-engine.service';
import { EligibilityService } from '../eligibility.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { ResourceProjectionService } from '../resource-projection.service';
import { RouteCostProvider } from '../route-cost.provider';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { defaultConfig, defaultPolicy } from './scheduler-test-helpers';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { rejectReasonLabel } from '@shared/reject-reason';

function makeSnapshot(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
    ...overrides,
  };
}

function makeEngine() {
  const worldState = {
    getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
    buildSnapshot: jest.fn(),
  };
  const resourceProjection = {
    projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'R-1', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
      feasible: true, source: 'euclidean_fallback', riskCost: 0, congestionCost: 0,
      graphVersion: null, calculatedAt: new Date().toISOString(),
      fallbackReason: null, dataQuality: 'FRESH',
    }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const engine = new CandidateEngineService(
    worldState as unknown as WorldStateSnapshotService,
    resourceProjection as unknown as ResourceProjectionService,
    new EligibilityService(),
    routeCostProvider as unknown as RouteCostProvider,
    policy as unknown as SchedulingPolicyService,
  );
  return { engine, worldState, routeCostProvider };
}

function baseSnapshot(): WorldStateSnapshot {
  const now = Date.now();
  return makeSnapshot({
    persons: [
      { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: ['cert-a'], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
    ],
    tasks: [
      {
        id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
        assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
        planStart: null, planEnd: null, progress: 0, predecessorIds: [],
        requiredSkills: ['work'], requiredCertifications: [],
      },
    ],
    devices: [
      { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [], x: 0, y: 0 },
    ],
    stations: [
      { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
    ],
    forbiddenZones: [],
    lockedAssignments: [],
  });
}

describe('NO-17a 能力要求的反事实放宽建议（只建议，不自动放宽）', () => {
  function relaxSnapshot(devices: Array<Record<string, unknown>>, requiredCaps: string[]) {
    const snapshot = baseSnapshot();
    snapshot.tasks[0] = { ...snapshot.tasks[0], requiredDeviceCapabilities: requiredCaps };
    snapshot.devices = devices as never;
    return snapshot;
  }

  it('零候选且因能力被挡 → 给出"放宽后多出几个候选 + 那些设备具备什么能力"', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['interact.assist'], x: 0, y: 0 },
          { id: 'd2', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['interact.assist', 'observe.load'], x: 0, y: 0 },
        ],
        ['exo-lift'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.candidates.every((c) => !c.eligible)).toBe(true);
    const suggestions = res.capabilityRelaxationSuggestions ?? [];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].capability).toBe('exo-lift');
    expect(suggestions[0].addedEligibleCount).toBeGreaterThan(0);
    // 如实列出那些设备实际具备的能力（供现场判断可替代性，不是"等价"声明）
    expect(suggestions[0].sampleDeviceCapabilities).toEqual(
      expect.arrayContaining(['interact.assist']),
    );
    // 边界说明必须可见：仅建议 / 需现场确认 / 需重新生成方案
    expect(suggestions[0].note).toContain('仅建议');
    expect(suggestions[0].note).toContain('现场确认');
    expect(suggestions[0].note).toContain('重新生成方案');
    // **关键**：要求本身未被修改（平台绝不擅自放宽执行边界）
    expect(res.requiredDeviceCapabilities).toEqual(['exo-lift']);
  });

  /* NO-18b：真实常见情形——同时要求两种专用能力，而现场只有一种替代资源；
   * 只放宽任何**单项**都不够，必须提示"组合放宽"。 */
  it('单项放宽都无效 → 给出组合建议（需同时放宽两项，且说明这一点）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['interact.assist'], x: 0, y: 0 },
        ],
        ['exo-lift', 'crane'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.candidates.every((c) => !c.eligible)).toBe(true);
    const suggestions = res.capabilityRelaxationSuggestions ?? [];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kind).toBe('combination');
    expect(suggestions[0].capabilities.sort()).toEqual(['crane', 'exo-lift']);
    expect(suggestions[0].label).toBe('exo-lift + crane');
    expect(suggestions[0].addedEligibleCount).toBeGreaterThan(0);
    // 必须说清"要同时放宽两项"，否则现场会以为放宽一项就行
    expect(suggestions[0].note).toContain('同时');
    expect(suggestions[0].note).toContain('仅建议');
  });

  it('单项放宽即可 → 只给单项建议（不做多余组合评估）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['crane'], x: 0, y: 0 },
        ],
        ['exo-lift', 'crane'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    const suggestions = res.capabilityRelaxationSuggestions ?? [];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kind).toBe('single');
    expect(suggestions[0].capability).toBe('exo-lift');
  });

  /* NO-19a：放宽"吊装能力"与放宽"温度观测"不是一回事——高风险必须由安全负责人确认。
   * 建议里必须带风险等级，且高风险要有 requiresSafetyReview + 明确文案。 */
  it('高风险能力（crane）→ 建议标注 high + requiresSafetyReview + "安全负责人确认"', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['interact.assist'], x: 0, y: 0 },
        ],
        ['crane'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    const suggestion = (res.capabilityRelaxationSuggestions ?? [])[0];
    expect(suggestion.risk).toBe('high');
    expect(suggestion.requiresSafetyReview).toBe(true);
    expect(suggestion.note).toContain('高风险能力');
    expect(suggestion.note).toContain('安全负责人确认');
    expect(suggestion.note).toContain('调度员不得单独决定');
  });

  it('低风险能力（observe.temperature）→ 不要求安全复核（不制造假警报）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['interact.assist'], x: 0, y: 0 },
        ],
        ['observe.temperature'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    const suggestion = (res.capabilityRelaxationSuggestions ?? [])[0];
    expect(suggestion.risk).toBe('low');
    expect(suggestion.requiresSafetyReview).toBe(false);
    expect(suggestion.note).not.toContain('安全负责人确认');
  });

  it('未登记风险等级的能力 → risk=null 且如实提示无法判断（不假装低风险）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['interact.assist'], x: 0, y: 0 },
        ],
        ['custom.magic_lift'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    const suggestion = (res.capabilityRelaxationSuggestions ?? [])[0];
    expect(suggestion.risk).toBeNull();
    expect(suggestion.requiresSafetyReview).toBe(false);
    expect(suggestion.note).toContain('未登记风险等级');
  });

  it('已有合格候选 → 不给建议（不制造噪音）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: ['exo-lift'], x: 0, y: 0 },
        ],
        ['exo-lift'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.candidates.some((c) => c.eligible)).toBe(true);
    expect(res.capabilityRelaxationSuggestions).toBeUndefined();
  });

  it('零候选但不是能力原因（如设备离线）→ 不给放宽建议（放宽也没用）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: false, status: 'OFFLINE', capabilities: ['exo-lift'], x: 0, y: 0 },
        ],
        ['exo-lift'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.capabilityRelaxationSuggestions ?? []).toEqual([]);
  });

  it('任务没有能力要求 → 不给建议', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      relaxSnapshot(
        [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [], x: 0, y: 0 },
        ],
        [],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.capabilityRelaxationSuggestions).toBeUndefined();
  });
});

describe('NO-15b 能力缺失 vs 人为停用（候选解释）', () => {
  function capSnapshot(deviceOverrides: Record<string, unknown>, requiredCaps: string[]) {
    const snapshot = baseSnapshot();
    snapshot.tasks[0] = { ...snapshot.tasks[0], requiredDeviceCapabilities: requiredCaps };
    snapshot.devices[0] = { ...snapshot.devices[0], ...deviceOverrides };
    return snapshot;
  }

  it('所需能力被人为停用 → capability_disabled + 可读细节（哪个能力/谁/何时/为何）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      capSnapshot(
        {
          capabilities: [],
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [
            {
              name: 'exo-lift',
              operator: 'admin',
              reason: '现场核对：助力模块故障待修',
              at: '2026-09-11T02:00:00.000Z',
            },
          ],
        },
        ['exo-lift'],
      ),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates[0];
    expect(c.rejectReasons).toContain('capability_disabled');
    expect(c.rejectReasons).not.toContain('missing_device_capability');
    const notes = (c.capabilityNotes ?? []).join('；');
    expect(notes).toContain('exo-lift');
    expect(notes).toContain('admin');
    expect(notes).toContain('助力模块故障待修');
  });

  it('能力单纯缺失（未停用）→ missing_device_capability 且不编造停用细节', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      capSnapshot({ capabilities: [] }, ['vacuum']),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates[0];
    expect(c.rejectReasons).toContain('missing_device_capability');
    const notes = (c.capabilityNotes ?? []).join('；');
    expect(notes).toContain('vacuum');
    expect(notes).not.toContain('人工停用');
  });
});

describe('T03 / P1-2 CandidateEngineService（结构化拒绝原因）', () => {
  it('evaluateTaskCandidates 返回 eligible/rejectReasons/scoreBreakdown（技能匹配场景）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      baseSnapshot(),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.taskId).toBe('t1');
    expect(res.candidates.length).toBeGreaterThan(0);
    const c = res.candidates[0];
    // 旧字段兼容（eligible/reasons）+ 新字段（rejectReasons）。
    expect(c).toHaveProperty('eligible');
    expect(Array.isArray(c.rejectReasons)).toBe(true);
    expect(c.rejectReasons).toEqual([]);
  });

  it('技能不匹配 → rejectReasons 含 missing_skill；eligible=false；不进 feasible set', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredSkills = ['welding'];
    snapshot.persons[0].skills = ['work'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c).toBeDefined();
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('missing_skill');
  });

  it('证书过期 → rejectReasons 含 cert_expired', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredCertifications = ['cert-a'];
    snapshot.persons[0].certificationExpiry = [{ name: 'cert-a', expiresAtMs: Date.now() - 1000 }];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('cert_expired');
  });

  it('设备离线 → rejectReasons 含 device_offline；低电量 → battery_low', async () => {
    const { engine } = makeEngine();
    const offline = baseSnapshot();
    offline.tasks[0].requiredDeviceCapabilities = ['vacuum'];
    offline.devices[0].online = false;
    offline.devices[0].capabilities = ['vacuum'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(offline);
    const res1 = await engine.evaluateTaskCandidates('t1');
    const c1 = res1.candidates.find((x) => x.personId === 'p1')!;
    expect(c1.eligible).toBe(false);
    expect(c1.rejectReasons).toContain('device_offline');

    const lowBat = baseSnapshot();
    lowBat.tasks[0].requiredDeviceCapabilities = ['vacuum'];
    lowBat.devices[0].batteryPct = 5;
    lowBat.devices[0].capabilities = ['vacuum'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(lowBat);
    const res2 = await engine.evaluateTaskCandidates('t1');
    const c2 = res2.candidates.find((x) => x.personId === 'p1')!;
    expect(c2.eligible).toBe(false);
    expect(c2.rejectReasons).toContain('battery_low');
  });

  it.each([null, undefined, NaN, Infinity, -Infinity, -1, 101])(
    'rejects invalid battery %p with an explicit unavailable reason and score',
    async (batteryPct) => {
      const { engine, worldState } = makeEngine();
      const snapshot = baseSnapshot();
      snapshot.tasks[0].requiredDeviceCapabilities = ['vacuum'];
      Object.assign(snapshot.devices[0], { batteryPct, capabilities: ['vacuum'] });
      worldState.getCurrentWorldState.mockResolvedValue(snapshot);
      const result = await engine.evaluateTaskCandidates('t1');
      const candidate = result.candidates.find((entry) => entry.deviceId === 'd1');
      expect(candidate).toMatchObject({
        eligible: false,
        batteryPct: null,
        rejectReasons: ['battery_unknown'],
        score: Infinity,
      });
      expect(candidate?.scoreBreakdown?.energyCost).toBe(Infinity);
    },
  );

  it('工位容量不足 → rejectReasons 含 station_capacity_exceeded', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.stations[0].capacity = 0;
    snapshot.tasks[0].candidateStations = ['S1'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('station_capacity_exceeded');
  });

  it('禁入区 → rejectReasons 含 zone_forbidden；时间窗冲突 → time_conflict', async () => {
    const { engine } = makeEngine();
    const zone = baseSnapshot();
    zone.tasks[0].zoneId = 'Z-FORBIDDEN';
    zone.forbiddenZones = [{ zoneId: 'Z-FORBIDDEN', reason: 'restricted' }];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(zone);
    const res1 = await engine.evaluateTaskCandidates('t1');
    const c1 = res1.candidates.find((x) => x.personId === 'p1')!;
    expect(c1.rejectReasons).toContain('zone_forbidden');

    const conflict = baseSnapshot();
    conflict.reservations = [
      { reservationId: 'r1', resourceId: 'p1', resourceType: 'person', startMs: Date.now() - 5000, endMs: Date.now() + 3600_000 },
    ];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(conflict);
    const res2 = await engine.evaluateTaskCandidates('t1');
    const c2 = res2.candidates.find((x) => x.personId === 'p1')!;
    expect(c2.rejectReasons).toContain('time_conflict');
  });

  it('健康状态 blocked → rejectReasons 含 health_blocked', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.persons[0].healthStatus = 'blocked';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('health_blocked');
  });

  it('时间窗 end 使用配置 horizonMinutes=120 → end = now + 120min', async () => {
    const { engine } = makeEngine();
    const policy = engine['policyService'] as unknown as { getConfig: jest.Mock };
    policy.getConfig.mockResolvedValue({ ...defaultConfig(), horizonMinutes: 120 });
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(baseSnapshot());
    const before = Date.now();
    const res = await engine.evaluateTaskCandidates('t1');
    const after = Date.now();
    const tw = res.candidates[0].timeWindows[0];
    expect(tw).toBeDefined();
    expect(tw.endMs).toBeGreaterThanOrEqual(before + 120 * 60 * 1000);
    expect(tw.endMs).toBeLessThanOrEqual(after + 120 * 60 * 1000);
  });

  it('时间窗回归：未配置 horizonMinutes → 缺省 end = now + 480min', async () => {
    const { engine } = makeEngine();
    const policy = engine['policyService'] as unknown as { getConfig: jest.Mock };
    const { horizonMinutes: _hm, ...cfgWithoutHorizon } = defaultConfig();
    void _hm;
    policy.getConfig.mockResolvedValue(cfgWithoutHorizon);
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(baseSnapshot());
    const before = Date.now();
    const res = await engine.evaluateTaskCandidates('t1');
    const after = Date.now();
    const tw = res.candidates[0].timeWindows[0];
    expect(tw).toBeDefined();
    expect(tw.endMs).toBeGreaterThanOrEqual(before + 480 * 60 * 1000);
    expect(tw.endMs).toBeLessThanOrEqual(after + 480 * 60 * 1000);
  });

  it('buildCandidatePool 与端点共享语义：hard 不满足的候选 eligible=false + rejectReasons', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredSkills = ['welding'];
    const pool = await engine.buildCandidatePool(snapshot.tasks[0], snapshot, {
      nowMs: Date.now(),
    });
    expect(Array.isArray(pool)).toBe(true);
    const c = pool.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('missing_skill');
  });

  // ── NO-34a：佩戴中的外骨骼是硬约束（会话事实进世界模型）──────────────────
  describe('活跃外骨骼会话 → 拒绝普通派工', () => {
    it('设备有活跃会话 → device_in_active_session（且与会话事实一起说明）', async () => {
      const { engine } = makeEngine();
      const snapshot = baseSnapshot();
      snapshot.tasks[0] = { ...snapshot.tasks[0], requiredDeviceCapabilities: ['exo-lift'] };
      snapshot.devices[0] = {
        ...snapshot.devices[0],
        capabilities: ['exo-lift'],
        activeExoSession: {
          sessionId: 'exo-session:abc',
          personId: 'person:P-1',
          startedAt: '2026-09-12T06:00:00.000Z',
        },
      };
      engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);

      const res = await engine.evaluateTaskCandidates('t1');
      const candidate = res.candidates[0];
      expect(candidate.eligible).toBe(false);
      expect(candidate.rejectReasons).toContain('device_in_active_session');
    });

    it('无会话 → 不因该原因被拒（不制造假封锁）', async () => {
      const { engine } = makeEngine();
      const snapshot = baseSnapshot();
      snapshot.tasks[0] = { ...snapshot.tasks[0], requiredDeviceCapabilities: ['exo-lift'] };
      snapshot.devices[0] = {
        ...snapshot.devices[0],
        capabilities: ['exo-lift'],
        activeExoSession: null,
      };
      engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);

      const res = await engine.evaluateTaskCandidates('t1');
      expect(res.candidates[0].rejectReasons ?? []).not.toContain('device_in_active_session');
    });

    it('任务**锁定给佩戴者** → 佩戴中的外骨骼可用（人机同体是物理可行的）', async () => {
      const { engine } = makeEngine();
      const snapshot = baseSnapshot();
      const personId = snapshot.persons[0].id;
      // 需要有**第二个人**才能验证"别人拿不到这台设备"（否则 forOthers 为空、断言恒真）
      snapshot.persons.push({
        ...snapshot.persons[0],
        id: 'p2',
        name: 'p2',
      });
      snapshot.tasks[0] = {
        ...snapshot.tasks[0],
        requiredDeviceCapabilities: ['exo-lift'],
        // 任务已锁定给佩戴者本人（session.personId 是规范身份 `person:<uuid>`）
        assigneeId: personId,
      };
      snapshot.devices[0] = {
        ...snapshot.devices[0],
        capabilities: ['exo-lift'],
        activeExoSession: {
          sessionId: 'exo-session:abc',
          personId: `person:${personId}`,
          startedAt: '2026-09-12T06:00:00.000Z',
        },
      };
      engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);

      const res = await engine.evaluateTaskCandidates('t1');
      const forWearer = res.candidates.filter((c) => c.personId === personId);
      expect(forWearer.length).toBeGreaterThan(0);
      // 佩戴者本人的候选不因会话被拒
      expect(forWearer.every((c) => !(c.rejectReasons ?? []).includes('device_in_active_session'))).toBe(true);

      // NO-38b：合法的那一条（佩戴者本人）必须带**正向说明**——现场要知道
      // "为什么只有他能接、换人要做什么"，而不是只看到没有被拒。
      const wearerCandidate = forWearer.find((c) => c.eligible) ?? forWearer[0];
      expect(wearerCandidate?.sessionNotes?.join('')).toContain('人机同体');
      expect(wearerCandidate?.sessionNotes?.join('')).toContain('exo-session:abc');
      expect(wearerCandidate?.sessionNotes?.join('')).toContain('结束会话');
      // 非佩戴者不得出现该正向说明（说明只给合法配对，不给"人人可用"的错觉）
      const forOthers = res.candidates.filter((c) => c.personId !== personId);
      expect(forOthers.every((c) => (c.sessionNotes ?? []).length === 0)).toBe(true);

      // 注意：锁定后候选池只评估锁定人，因此"别人拿不到"必须在**资格判定层**直接验证
      // （否则断言在空集合上恒真——实测踩过）。
      const eligibility = new EligibilityService();
      const device = {
        id: 'd1',
        batteryPct: 100,
        online: true,
        status: 'AVAILABLE',
        capabilities: ['exo-lift'],
        activeExoSession: {
          sessionId: 'exo-session:abc',
          personId: `person:${personId}`,
          startedAt: '2026-09-12T06:00:00.000Z',
        },
      };
      const baseTask = {
        id: 't1',
        taskType: 'work',
        requiredSkills: [],
        requiredCertifications: [],
        stationId: 'S1',
        zoneId: 'Z1',
        predIds: [],
        requiredDeviceCapabilities: ['exo-lift'],
      };
      const person = {
        id: 'p2',
        status: 'AVAILABLE',
        skills: [],
        certifications: [],
        stationId: 'S1',
        loadLevel: 0,
        fatigueLevel: 0,
        healthStatus: 'normal',
      };
      const nowMs = Date.now();
      const ctx = {
        now: nowMs,
        bookedTimeSlots: [],
        bookedDeviceSlots: [],
        bookedStationSlots: [],
        candidateStartMs: nowMs,
        candidateEndMs: nowMs + 3_600_000,
        lockedPersonIds: [],
        forbiddenZones: [],
        minBatteryPct: 20,
        maxContinuousLoad: 1,
        safetyBlockedPersonIds: [],
        predecessorDone: () => true,
      };
      const wearer = { ...person, id: personId };
      // 别人（p2）无论锁定与否都拿不到
      expect(
        eligibility.check(person, { ...baseTask, lockedAssigneeId: `person:${personId}` }, device, ctx)
          .reasons,
      ).toContain('device_in_active_session');
      expect(
        eligibility.check(person, { ...baseTask, lockedAssigneeId: null }, device, ctx).reasons,
      ).toContain('device_in_active_session');
      // 佩戴者本人：未锁定 → 可用；锁定给自己 → 可用
      expect(
        eligibility.check(wearer, { ...baseTask, lockedAssigneeId: null }, device, ctx).reasons,
      ).not.toContain('device_in_active_session');
      expect(
        eligibility.check(wearer, { ...baseTask, lockedAssigneeId: `person:${personId}` }, device, ctx)
          .reasons,
      ).not.toContain('device_in_active_session');
    });

    it('拒绝原因词表必须给得出中文文案（不让现场看到裸键）', () => {
      expect(rejectReasonLabel('device_in_active_session')).toContain('外骨骼会话');
    });
  });
});
