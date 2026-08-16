/* DecisionHistoryTable.render.test.tsx — 决策历史纯展示表渲染 smoke（NO-13q / ADR-066）。
 *
 * 数据型页面渲染补强（renderToStaticMarkup 同栈）：数据行透出契约字段
 * （决策 ID/类型标签/状态/风险档/依据/审批人）+ skippedInvalid 显式横幅
 * （§33）+ 空态。纯展示组件零网络，行模型直接注入。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionHistoryTable } from './DecisionHistoryTable';
import { buildDecisionRows, buildSourcesSummary } from './decisionHistoryLogic';
import type { DecisionRecord } from '@shared/decision';

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: 'decision:d1',
    kind: 'task_assignment',
    status: 'proposed',
    decisionAuthority: 'optimization',
    subject: 'task:t1',
    tenantId: 'ORG-1',
    riskLevel: 'low',
    requiresApproval: true,
    decidedAt: '2026-08-16T10:00:00.000Z',
    selected: { optionId: 'opt:a', reason: ['highest-score'] },
    auditTrail: [{ actor: 'solver:heuristic-v2', action: 'decided', at: '2026-08-16T10:00:00.000Z' }],
    ...overrides,
  };
}

describe('DecisionHistoryTable 渲染 smoke（NO-13q / ADR-066）', () => {
  it('数据行：契约字段透出（决策 ID/类型标签/状态/风险档/依据/审批人）', () => {
    const rows = buildDecisionRows([
      record({
        decisionId: 'decision:PLAN-1:approval:v2',
        kind: 'plan_approval',
        status: 'approved',
        decisionAuthority: 'human',
        riskLevel: 'high',
        selected: { optionId: 'opt:approve', reason: ['人工审批激活'] },
        approver: { actor: 'user:op1', at: '2026-08-16T10:00:00.000Z' },
      }),
    ]);
    const markup = renderToStaticMarkup(
      <DecisionHistoryTable
        rows={rows}
        total={1}
        skippedInvalid={0}
        sourcesSummary="方案 1 / Agent 审批 0 / 学习提案 0 / 策略 0"
      />,
    );
    expect(markup).toContain('decision:PLAN-1:approval:v2');
    expect(markup).toContain('方案审批');
    expect(markup).toContain('批准');
    expect(markup).toContain('人工');
    expect(markup).toContain('high');
    expect(markup).toContain('人工审批激活');
    expect(markup).toContain('user:op1');
    expect(markup).toContain('共 1 条');
  });

  it('skippedInvalid > 0 → 显式横幅（§33 不静默丢弃）+ 空态显式', () => {
    const withInvalid = renderToStaticMarkup(
      <DecisionHistoryTable
        rows={[]}
        total={0}
        skippedInvalid={3}
        sourcesSummary="方案 3 / Agent 审批 0 / 学习提案 0 / 策略 0"
      />,
    );
    expect(withInvalid).toContain('非法记录 3 条已显式跳过');
    expect(withInvalid).toContain('暂无决策记录');
  });
});
