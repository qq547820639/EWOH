/* 指挥地图"冲突层"聚合逻辑（intelligence-layers-logic）。
 *
 * 背景（2026-09-11）：组件里原先直接拼后端码，现场看到的是
 * `违反约束 · UNASSIGNED_RULE_BASED：no_eligible_candidate`，而且**丢掉**了求解器
 * 上报的 `rejectReasons`——即"为什么没有可用资源"这条最关键的信息。
 * 本测试锁定三件事：码 → 中文、候选拒绝原因按次数聚合、未知码显式标注不静默。
 */
/// <reference types="jest" />
import {
  aggregateRejectReasons,
  buildPlanIssueItems,
  formatRejectReasonCounts,
  hasUnregisteredCode,
} from './intelligence-layers-logic';
import type { SchedulingPlanV2 } from '@shared/scheduler';

function makePlan(overrides: Partial<SchedulingPlanV2> = {}): SchedulingPlanV2 {
  return {
    planId: 'PLAN-1',
    planName: '测试方案',
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL' },
    snapshotVersion: 'snap-1',
    policyVersion: 'v1',
    solverVersion: 'test',
    solverStatus: 'RULE_BASED',
    objective: 0,
    scoreBreakdown: {},
    solveDurationMs: 1,
    horizonMinutes: 60,
    assignments: [],
    metrics: {},
    baselineDelta: null,
    violations: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as SchedulingPlanV2;
}

describe('aggregateRejectReasons / formatRejectReasonCounts', () => {
  it('按原因聚合并按次数降序（同次数按原因码稳定排序）', () => {
    const aggregated = aggregateRejectReasons([
      'battery_unknown',
      'missing_device_capability',
      'battery_unknown',
      'battery_unknown',
      'device_offline',
    ]);
    expect(aggregated[0]).toMatchObject({ reason: 'battery_unknown', count: 3 });
    expect(aggregated[0].label).toBe('电量未知（未上报，不派工）');
    expect(aggregated.map((a) => a.reason)).toEqual([
      'battery_unknown',
      'device_offline',
      'missing_device_capability',
    ]);
  });

  it('单行文案对重复原因标次数，单次不标', () => {
    expect(formatRejectReasonCounts(['device_offline', 'device_offline', 'battery_low'])).toBe(
      '设备离线×2、电量低于下限',
    );
  });

  it('忽略空白项；全空返回空串（不产出"×0"这类噪音）', () => {
    expect(formatRejectReasonCounts(['', '   '])).toBe('');
  });
});

describe('buildPlanIssueItems：未派工原因必须可读且带聚合计数', () => {
  it('violations 的类型/原因/任务/候选拒绝原因都被翻译成中文', () => {
    const items = buildPlanIssueItems(
      makePlan({
        violations: [
          {
            type: 'UNASSIGNED_RULE_BASED',
            taskId: 'TASK-abcdefghijklmnop',
            reason: 'no_eligible_candidate',
            rejectReasons: [
              'battery_unknown',
              'battery_unknown',
              'missing_device_capability',
              'device_maintenance_blocked',
            ],
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('error');
    // 类型与原因都中文化，且给出候选拒绝原因的次数聚合（这是"为什么没派出去"的答案）
    expect(items[0].text).toContain('无法派工（规则求解器）');
    expect(items[0].text).toContain('没有合格候选资源');
    expect(items[0].text).toContain('电量未知（未上报，不派工）×2');
    expect(items[0].text).toContain('缺少设备能力');
    expect(items[0].text).toContain('设备维护中（需人工解除）');
    // 不再出现英文码
    expect(items[0].text).not.toContain('UNASSIGNED_RULE_BASED');
    expect(items[0].text).not.toContain('no_eligible_candidate');
  });

  /* NO-15c：方案层必须带上能力细节——只报"capability_disabled ×2"，
   * 班组长仍不知道是哪个能力、谁停的、为什么。 */
  it('未派工原因里的能力细节（哪个能力/谁/何时/为何停用）进入方案条目', () => {
    const items = buildPlanIssueItems(
      makePlan({
        violations: [
          {
            type: 'UNASSIGNED_RULE_BASED',
            taskId: 'T-9',
            reason: 'no_eligible_candidate',
            rejectReasons: ['capability_disabled', 'capability_disabled'],
            capabilityNotes: [
              '任务要求的能力：exo-lift；该设备当前可用能力：（无）',
              '能力 exo-lift 已被人工停用：admin · 2026/9/11 10:00:00 · 理由：助力模块故障待修',
            ],
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    const text = items[0].text;
    // 聚合计数 + 可读细节都在
    expect(text).toContain('所需能力已被人工停用');
    expect(text).toContain('×2');
    expect(text).toContain('exo-lift');
    expect(text).toContain('admin');
    expect(text).toContain('助力模块故障待修');
    // 未登记提示不应被细节误触发
    expect(hasUnregisteredCode(items)).toBe(false);
  });

  /* 历史方案（早期启发式求解器）只写嵌套 alternatives[].reasons：
   * 升级后旧数据仍必须能讲清原因，不能因为字段搬迁就失读。 */
  it('历史方案的嵌套 alternatives[].reasons 回退展开（旧数据不失读）', () => {
    const items = buildPlanIssueItems(
      makePlan({
        violations: [
          {
            type: 'infeasible',
            taskId: 'T-3',
            reason: 'no_eligible_resource',
            alternatives: [
              { reasons: ['battery_unknown', 'battery_unknown'] },
              { reasons: ['device_offline'] },
            ],
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('电量未知（未上报，不派工）×2');
    expect(items[0].text).toContain('设备离线');
  });

  it('未登记的码显式标注（并置 hasUnregisteredCode=true），不静默吞掉', () => {
    const items = buildPlanIssueItems(
      makePlan({
        violations: [{ type: 'FUTURE_SOLVER_VIOLATION', reason: 'brand_new_reason' }],
      }),
    );
    expect(items[0].text).toContain('未登记原因（FUTURE_SOLVER_VIOLATION）');
    expect(items[0].text).toContain('未登记原因（brand_new_reason）');
    expect(hasUnregisteredCode(items)).toBe(true);
  });

  it('前置成环等已知违反项也可读', () => {
    const items = buildPlanIssueItems(
      makePlan({ violations: [{ type: 'PREDECESSOR_CYCLE', reason: 'predecessor_cycle' }] }),
    );
    expect(items[0].text).toContain('前置依赖成环');
    expect(hasUnregisteredCode(items)).toBe(false);
  });

  it('blocked/failed 分配如实上报（原因同样中文化）', () => {
    const items = buildPlanIssueItems(
      makePlan({
        assignments: [
          { taskId: 'T-1', status: 'blocked', reasons: ['safety_blocked'] },
          { taskId: 'T-2', status: 'failed', reasons: [] },
          { taskId: 'T-3', status: 'dispatched', reasons: [] },
        ],
      } as unknown as Partial<SchedulingPlanV2>),
    );
    expect(items).toHaveLength(2);
    expect(items[0].text).toContain('任务 T-1 分配被阻断');
    expect(items[0].text).toContain('安全规则封锁');
    expect(items[1].text).toContain('任务 T-2 分配失败');
  });

  it('决策轨迹里被排除的候选给出原因（info 级，不推导因果）', () => {
    const items = buildPlanIssueItems(
      makePlan({
        assignments: [
          {
            taskId: 'T-1',
            status: 'dispatched',
            reasons: [],
            decisionTrace: {
              rejectedAlternatives: [
                { personId: 'P-9', deviceId: null, stationId: null, reason: ['missing_certification'] },
                { personId: null, deviceId: 'EXO-3', stationId: null, reason: [] },
              ],
            },
          },
        ],
      } as unknown as Partial<SchedulingPlanV2>),
    );
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('info');
    expect(items[0].text).toBe('候选 P-9 被排除：缺少证书');
  });

  it('无问题时返回空数组（组件据此显示"后端未上报冲突"）', () => {
    expect(buildPlanIssueItems(makePlan())).toEqual([]);
    expect(hasUnregisteredCode([])).toBe(false);
  });
});
