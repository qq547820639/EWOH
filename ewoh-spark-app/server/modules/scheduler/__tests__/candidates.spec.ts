import { SchedulerService } from '../scheduler.service';
import { EligibilityService } from '../eligibility.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
} from './scheduler-test-helpers';

/** 构造一个仅依赖 mock 的 SchedulerService，用于测试 getTaskCandidates。
 *  资格使用真实 EligibilityService；路径成本与策略使用可覆写 mock（保持离网、确定性）。 */
function makeScheduler(overrides: {
  routeFeasible?: (personId: string) => boolean;
} = {}) {
  const state = buildSnapshot({
    persons: [
      seedPerson({ id: 'p-skill', skills: ['other'] }),
      seedPerson({ id: 'p-ok', skills: ['exo'] }),
      seedPerson({ id: 'p-route', skills: ['exo'] }),
    ],
    tasks: [seedTask({ id: 't1', taskType: 'exo', requiredSkills: ['exo'] })],
    devices: [seedDevice({ id: 'd1' })],
  });
  const { snapshotVersion: _sv, ts: _ts, ...worldState } = state;

  const worldStateSnapshotService = {
    getCurrentWorldState: jest.fn().mockResolvedValue(worldState),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routeFeasible = overrides.routeFeasible ?? (() => true);
  const routeCostProvider = {
    estimate: jest.fn().mockImplementation(async (personId: string) => ({
      routeId: null,
      distanceMeters: 7,
      etaSeconds: 9,
      riskLevel: null,
      feasible: routeFeasible(personId),
      source: 'euclidean_fallback' as const,
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
    })),
  };

  const service = new SchedulerService(
    {} as never,
    {} as never,
    {} as never,
    worldStateSnapshotService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new EligibilityService(),
    routeCostProvider as never,
    policy as never,
    { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
    { enqueue: jest.fn() } as never,
  );
  return { service, routeCostProvider };
}

describe('任务候选资源 candidates', () => {
  it('技能缺失的人员被排除并给出 missing_skill 原因', async () => {
    const { service } = makeScheduler();
    const res = await service.getTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p-skill');
    expect(c).toBeDefined();
    expect(c!.eligible).toBe(false);
    expect(c!.skillMatch).toBe(false);
    expect(c!.reasons).toContain('missing_skill');
  });

  it('路径不可行的人员被排除并给出 route_infeasible 原因', async () => {
    const { service } = makeScheduler({
      routeFeasible: (p) => p !== 'p-route',
    });
    const res = await service.getTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p-route');
    expect(c).toBeDefined();
    expect(c!.eligible).toBe(false);
    expect(c!.reasons).toContain('route_infeasible');
  });

  it('合格人员出现在候选列表并带 ETA/距离', async () => {
    const { service, routeCostProvider } = makeScheduler();
    const res = await service.getTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p-ok');
    expect(c).toBeDefined();
    expect(c!.eligible).toBe(true);
    expect(c!.skillMatch).toBe(true);
    expect(c!.etaSeconds).toBe(9);
    expect(c!.distanceMeters).toBe(7);
    expect(routeCostProvider.estimate).toHaveBeenCalled();
  });

  it('任务不存在时抛出 NotFound', async () => {
    const { service } = makeScheduler();
    await expect(service.getTaskCandidates('nope')).rejects.toThrow();
  });
});