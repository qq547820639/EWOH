/* IntelligenceLayers 方案问题层渲染：未派工原因必须说人话（NO-14h）。
 *
 * 背景（2026-09-11）：求解器 violations 里带 `rejectReasons`（为什么没有合格候选），
 * 组件此前直接拼英文码（`违反约束 · UNASSIGNED_RULE_BASED：no_eligible_candidate`）
 * 且**完全忽略** rejectReasons —— 现场看不到"为什么没派出去"。
 *
 * 技术选择：冲突层在 UI 里默认折叠，`renderToStaticMarkup` 看不到折叠内容，
 * 因此直接渲染导出的 `PlanIssueList`（列表渲染与折叠容器分离）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanIssueList } from './IntelligenceLayers';
import { buildPlanIssueItems } from './intelligence-layers-logic';
import type { SchedulingPlanV2 } from '@shared/scheduler';

const NOW = new Date('2026-09-11T08:00:00.000Z').toISOString();

function makePlan(violations: Array<Record<string, unknown>>): SchedulingPlanV2 {
  return {
    planId: 'PLAN-1',
    planName: '测试方案',
    version: 1,
    status: 'approved',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-1',
    policyVersion: 1,
    solverVersion: 'rule-based-v1',
    solverStatus: 'RULE_BASED',
    objective: 0,
    scoreBreakdown: {},
    solveDurationMs: 5,
    horizonMinutes: 480,
    assignments: [],
    metrics: {},
    baselineDelta: {},
    violations,
    createdAt: NOW,
  } as unknown as SchedulingPlanV2;
}

function renderIssues(violations: Array<Record<string, unknown>>): string {
  return renderToStaticMarkup(<PlanIssueList items={buildPlanIssueItems(makePlan(violations))} />);
}

describe('IntelligenceLayers · 方案问题层文案', () => {
  it('未派工任务的候选拒绝原因被翻译并聚合，不露出英文码', () => {
    const html = renderIssues([
      {
        type: 'UNASSIGNED_RULE_BASED',
        taskId: 'T-2',
        reason: 'no_eligible_candidate',
        rejectReasons: [
          'battery_unknown',
          'battery_unknown',
          'missing_device_capability',
          'device_maintenance_blocked',
        ],
      },
    ]);
    expect(html).toContain('无法派工（规则求解器）');
    expect(html).toContain('没有合格候选资源');
    expect(html).toContain('电量未知（未上报，不派工）×2');
    expect(html).toContain('缺少设备能力');
    expect(html).toContain('设备维护中（需人工解除）');
    expect(html).toContain('任务 T-2');
    // 不把后端码丢给现场
    expect(html).not.toContain('UNASSIGNED_RULE_BASED');
    expect(html).not.toContain('no_eligible_candidate');
  });

  it('未登记码显式提示"待登记"（不静默），且保留原始码', () => {
    const html = renderIssues([{ type: 'FUTURE_VIOLATION', reason: 'brand_new_reason' }]);
    expect(html).toContain('未登记原因（FUTURE_VIOLATION）');
    expect(html).toContain('存在未登记原因');
  });

  it('无问题时列表为空且不含未登记提示（组件据空列表显示"后端未上报冲突"）', () => {
    const html = renderIssues([]);
    expect(html).not.toContain('未登记原因');
    expect(html).not.toContain('存在未登记原因');
    expect(html).not.toContain('<span>');
  });
});
