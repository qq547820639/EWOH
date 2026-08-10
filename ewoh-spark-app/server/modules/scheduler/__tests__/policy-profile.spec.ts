/* Phase 1 / P1-C（§六）：版本化 Policy Profile 单测。
 *
 * 覆盖：
 * - 每个 profile 产出不同 objectiveWeights（soft objective 缩放；缺省配置回退内置预设）
 * - profile 不影响 hard constraints（同 snapshot 下 hard 违规数=0，solver-invariants 断言风格）
 * - 缺省 BALANCED 回归（不缩放）
 * - plan 记录 profileId/profileVersion（可审计/确定性重放）
 * - 配置自定义 profiles → solveVariants 消费配置 scale（版本化）
 * - resolveProfiles 归一化（缺省 6 预设 / 配置覆盖合并 / BALANCED 兜底）
 */
/// <reference types="jest" />
import { SchedulingPolicyService } from '../scheduling-policy.service';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';
import type { SchedulingPolicyConfig } from '@shared/api.interface';

describe('P1-C: 版本化 Policy Profile（solveVariants 从配置读取）', () => {
  it('每个 profile 产出不同 objectiveWeights（缺省配置回退内置预设）', async () => {
    const { solver } = makeSolver();
    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['work'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work', status: 'pending' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      baseSolveOpts,
    );

    expect(plans).toHaveLength(3);
    // A=ON_TIME：lateness×3、change×0.5（base=defaultPolicy 全 1）。
    expect(plans[0].weights).toEqual({
      lateness: 3,
      travel: 1,
      wait: 1,
      workload: 1,
      station: 1,
      change: 0.5,
      risk: 1,
      energy: 1,
    });
    // B=WORKLOAD_BALANCE：workload×3、travel×1.5、lateness×0.5。
    expect(plans[1].weights).toEqual({
      lateness: 0.5,
      travel: 1.5,
      wait: 1,
      workload: 3,
      station: 1,
      change: 1,
      risk: 1,
      energy: 1,
    });
    // 变体间确实不同（可解释差异）。
    expect(plans[0].weights.lateness).toBeGreaterThan(plans[1].weights.lateness);
    expect(plans[1].weights.workload).toBeGreaterThan(plans[0].weights.workload);
    expect(plans[0].weights.lateness).not.toBe(plans[2].weights.lateness);
    // 旧字段兼容别名与权威权重同步缩放。
    expect(plans[0].weights?.lateness).toBe(3);
    expect(plans[1].weights?.workload).toBe(3);
  });

  it('缺省 BALANCED 回归：C 变体不缩放（权重 = base 策略）', async () => {
    const { solver } = makeSolver();
    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['work'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work', status: 'pending' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      baseSolveOpts,
    );
    expect(plans[2].weights).toEqual(defaultPolicy().weights);
    expect(plans[2].planName).toBe('综合平衡');
  });

  it('plan 记录 profileId/profileVersion（可审计）', async () => {
    const { solver } = makeSolver();
    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['work'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work', status: 'pending' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      baseSolveOpts,
    );
    expect(plans[0].profileId).toBe('ON_TIME');
    expect(plans[1].profileId).toBe('WORKLOAD_BALANCE');
    expect(plans[2].profileId).toBe('BALANCED');
    // profileVersion = 策略版本（configVersion 的等价物，随 weights 一起确定性重放）。
    expect(plans[0].profileVersion).toBe(defaultPolicy().version);
    expect(plans[1].profileVersion).toBe(defaultPolicy().version);
    expect(plans[2].profileVersion).toBe(defaultPolicy().version);
    // baselineDelta.variant 同步持久化 profileId/profileVersion（DB 无独立列，随方案落库可审计）。
    expect((plans[0].baselineDelta.variant as { profileId?: string; profileVersion?: number }))
      .toMatchObject({ profileId: 'ON_TIME', profileVersion: defaultPolicy().version });
    // planId 后缀保持 A/B/C（createRun objectiveProfile 筛选兼容）。
    expect(plans.map((p) => p.planId)).toEqual(['PA', 'PB', 'PC']);
  });

  it('profile 不影响 hard constraints：同 snapshot 下 hard 违规数=0', async () => {
    const { solver } = makeSolver();
    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [
          seedPerson({ id: 'p1', skills: ['work'] }),
          seedPerson({ id: 'p2', skills: ['work'] }),
        ],
        tasks: [
          seedTask({ id: 't1', taskType: 'work', status: 'pending' }),
          seedTask({ id: 't2', taskType: 'work', status: 'pending' }),
        ],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      baseSolveOpts,
    );
    for (const plan of plans) {
      // 全可行场景：无任何违规（含 hard）。
      expect(plan.violations).toHaveLength(0);
      // 全部任务被分配（hard 可行性不因 profile 改变）。
      expect(plan.assignments).toHaveLength(2);
    }
  });

  it('profile 不影响 hard constraints：forbidden zone 下三变体行为一致（均不分配）', async () => {
    const { solver } = makeSolver();
    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['work'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work', status: 'pending', zoneId: 'Z-FORBIDDEN' })],
        devices: [seedDevice({ id: 'd1' })],
        forbiddenZones: [{ zoneId: 'Z-FORBIDDEN', reason: 'restricted_zone' }],
      }),
      [],
      baseSolveOpts,
    );
    for (const plan of plans) {
      expect(plan.assignments).toHaveLength(0);
      // 仅记录 infeasible（未分配说明），无 hard 违规类型（如 unsupported_constraint）。
      for (const v of plan.violations) {
        expect((v as { type?: string }).type).toBe('infeasible');
      }
    }
  });

  it('配置自定义 profiles → solveVariants 消费配置 scale（版本化，覆盖同名预设）', async () => {
    const { solver, policy } = makeSolver();
    const customConfig: SchedulingPolicyConfig = {
      ...defaultConfig(),
      profiles: {
        ON_TIME: { label: '准时优先-定制', scale: { lateness: 5, change: 0.25 } },
        // 未配置的 profile（如 WORKLOAD_BALANCE/BALANCED）回退内置预设。
      },
    };
    (policy as { getConfig: jest.Mock }).getConfig.mockResolvedValue(customConfig);

    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['work'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work', status: 'pending' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      baseSolveOpts,
    );

    // ON_TIME 用配置 scale。
    expect(plans[0].weights?.lateness).toBe(5);
    expect(plans[0].weights?.change).toBe(0.25);
    expect(plans[0].planName).toBe('准时优先-定制');
    // 未配置 profile 保持内置预设（B=WORKLOAD_BALANCE、C=BALANCED）。
    expect(plans[1].weights?.workload).toBe(3);
    expect(plans[2].weights).toEqual(defaultPolicy().weights);
  });

  it('配置新增自定义 profile 且 solveVariants 缺省投放不变（A/B/C 语义兼容）', async () => {
    const { solver, policy } = makeSolver();
    const customConfig: SchedulingPolicyConfig = {
      ...defaultConfig(),
      profiles: {
        MIN_CHURN: { label: '最小扰动', scale: { change: 3 } },
      },
    };
    (policy as { getConfig: jest.Mock }).getConfig.mockResolvedValue(customConfig);

    const plans = await solver.solveVariants(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['work'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work', status: 'pending' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      baseSolveOpts,
    );

    // 公共行为不变：仍 A/B/C 三变体（planId 后缀兼容 createRun 筛选）。
    expect(plans.map((p) => p.planId)).toEqual(['PA', 'PB', 'PC']);
    expect(plans[0].profileId).toBe('ON_TIME');
    expect(plans[1].profileId).toBe('WORKLOAD_BALANCE');
    expect(plans[2].profileId).toBe('BALANCED');
  });
});

describe('P1-C: resolveProfiles 归一化（scheduling-policy.service）', () => {
  // resolveProfiles 为纯函数（无 DB 依赖），直接以真实服务原型执行。
  const policySvc = new SchedulingPolicyService({} as never);

  it('配置缺省 → 内置 6 预设且 BALANCED=不缩放', () => {
    const resolved = policySvc.resolveProfiles(undefined);
    expect(Object.keys(resolved).sort()).toEqual([
      'BALANCED',
      'MIN_CHURN',
      'ON_TIME',
      'PRODUCTION_IMPACT',
      'TRAVEL_MIN',
      'WORKLOAD_BALANCE',
    ]);
    expect(resolved.BALANCED.scale).toEqual({});
    // 语义兼容既有 A/B/C：ON_TIME=lateness×3、change×0.5；WORKLOAD_BALANCE=workload×3、travel×1.5。
    expect(resolved.ON_TIME.scale).toEqual({ lateness: 3, change: 0.5 });
    expect(resolved.WORKLOAD_BALANCE.scale).toEqual({
      workload: 3,
      travel: 1.5,
      lateness: 0.5,
    });
  });

  it('配置部分覆盖 → 与内置预设合并（未覆盖项保留），BALANCED 兜底', () => {
    const resolved = policySvc.resolveProfiles({
      ...defaultConfig(),
      profiles: {
        ON_TIME: { label: '定制准时', scale: { lateness: 9 } },
      },
    });
    expect(resolved.ON_TIME.label).toBe('定制准时');
    expect(resolved.ON_TIME.scale.lateness).toBe(9);
    // 未覆盖项保留内置预设。
    expect(resolved.ON_TIME.scale.change).toBe(0.5);
    expect(resolved.WORKLOAD_BALANCE.scale.workload).toBe(3);
    expect(resolved.BALANCED).toBeDefined();
    expect(resolved.BALANCED.scale).toEqual({});
  });

  it('配置含未知 profile → 保留（可扩展），且不破坏内置预设', () => {
    const resolved = policySvc.resolveProfiles({
      ...defaultConfig(),
      profiles: {
        CUSTOM: { label: '自定义', scale: { travel: 2 } },
      },
    });
    expect(resolved.CUSTOM).toEqual({ label: '自定义', scale: { travel: 2 } });
    expect(resolved.ON_TIME.scale.lateness).toBe(3);
    expect(resolved.BALANCED.scale).toEqual({});
  });
});
