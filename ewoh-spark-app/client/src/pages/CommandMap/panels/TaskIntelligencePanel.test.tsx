/* CSTR-02：Task Intelligence 面板的"约束解释"节过去整块挂在 `rejectedHard.length > 0` 上——
 * 零拒绝候选的干净方案即使带了硬约束，前端一个字都不显示。本文件钉收窄后的三档形状：
 * 只有约束没有拒绝 ⇒ 渲染；两档与拒绝都空 ⇒ 不渲染（不是渲染空壳）；有拒绝 ⇒ 沿用原标题。
 * 渲染走 `react-dom/server` 的 renderToString（与本目录既有 `.test.tsx` 同一手法），
 * decision 由真实 `decisionExplainVM` 从 DecisionTrace 映射得到，不手搓 VM 字面量。
 */
/// <reference types="jest" />
import { renderToString } from 'react-dom/server';
import { TaskIntelligencePanel } from './TaskIntelligencePanel';
import { decisionExplainVM } from '../vm/decisionExplainVM';
import type { DecisionTrace } from '@shared/api.interface';

function renderWithTrace(overrides: Partial<DecisionTrace>): string {
  const trace = {
    taskId: 'T-CSTR-02',
    selected: { personId: 'p1', deviceId: 'd1', stationId: null },
    priority: { level: 'medium', score: 1, factors: [] },
    candidates: [{ personId: 'p1', deviceId: 'd1', score: 1, reasons: [] }],
    selectedReason: ['heuristic:lowest-cost'],
    rejectedAlternatives: [],
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    snapshotVersion: 'WS-1',
    ...overrides,
  } as DecisionTrace;
  return renderToString(
    <TaskIntelligencePanel taskId="T-CSTR-02" candidates={null} decision={decisionExplainVM(trace)} />,
  );
}

describe('CSTR-02 约束解释节的渲染门槛', () => {
  it('只有两档约束、没有拒绝候选 ⇒ 仍渲染约束执行说明并列出两档', () => {
    const html = renderWithTrace({
      rejectedHard: [],
      hardConstraints: ['LOCKED_DEVICE'],
      hardConstraintsIgnored: ['RESOURCE_TIME_WINDOW'],
    });
    expect(html).toContain('约束执行说明');
    expect(html).toContain('LOCKED_DEVICE');
    expect(html).toContain('RESOURCE_TIME_WINDOW');
  });

  it('两档与拒绝候选全空 ⇒ 整节不渲染（不给空壳标题）', () => {
    const html = renderWithTrace({
      rejectedHard: [],
      hardConstraints: [],
      hardConstraintsIgnored: [],
    });
    expect(html).not.toContain('约束执行说明');
    expect(html).not.toContain('拒绝候选与约束解释');
  });

  it('有拒绝候选 ⇒ 沿用原标题，两档仍各自成行', () => {
    const html = renderWithTrace({
      rejectedHard: [
        { personId: 'p2', deviceId: null, stationId: null, rejectReasons: ['missing_skill'] },
      ],
      hardConstraints: ['MAX_WORKLOAD'],
      hardConstraintsIgnored: ['STATION_CAPACITY'],
    });
    expect(html).toContain('拒绝候选与约束解释');
    expect(html).not.toContain('约束执行说明');
    expect(html).toContain('MAX_WORKLOAD');
    expect(html).toContain('STATION_CAPACITY');
  });
});
