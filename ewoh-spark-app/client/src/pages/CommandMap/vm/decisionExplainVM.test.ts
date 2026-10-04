/* CSTR-01（V357）：DecisionTrace 的硬约束两档在前端解释层的透传形状。
 *
 * 服务端把 `hardConstraints` 从"注册表全量"收窄成"本次按实例参数执行的类型"，另开一档
 * `hardConstraintsIgnored`。这里钉三件事：两档各走各的、VM 不替服务端补全、
 * 收窄前落库的历史 trace（没有新字段）读出空数组而不是 undefined——面板直接取 `.length`。
 */
/// <reference types="jest" />
import { decisionExplainVM } from './decisionExplainVM';
import type { DecisionTrace } from '@shared/api.interface';

function makeTrace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    taskId: 'T-CSTR-01',
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
}

describe('CSTR-01 决策解释层硬约束两档', () => {
  it('执行档与维度档各走各的，VM 不合并也不重排', () => {
    const vm = decisionExplainVM(
      makeTrace({
        hardConstraints: ['LOCKED_DEVICE'],
        hardConstraintsIgnored: ['RESOURCE_TIME_WINDOW', 'STATION_CAPACITY'],
      }),
    );
    expect(vm!.hardConstraints).toEqual(['LOCKED_DEVICE']);
    expect(vm!.hardConstraintsIgnored).toEqual(['RESOURCE_TIME_WINDOW', 'STATION_CAPACITY']);
  });

  it('收窄前落库的历史 trace 缺维度档 → 空数组（面板取 .length，不给 undefined）', () => {
    const vm = decisionExplainVM(makeTrace({ hardConstraints: ['REQUIRED_SKILL'] }));
    expect(vm!.hardConstraintsIgnored).toEqual([]);
  });

  it('反向对照：VM 不替服务端补全注册表全量', () => {
    const vm = decisionExplainVM(makeTrace({ hardConstraints: [], hardConstraintsIgnored: [] }));
    expect(vm!.hardConstraints).toEqual([]);
    expect(vm!.hardConstraintsIgnored).toEqual([]);
  });
});
