/* Phase 3 / P3-T3：candidateExplainVM 纯函数测试。 */
import { candidateExplainVM, candidateReasonLabel } from './candidateExplainVM';
import type { TaskCandidatesResponse } from '@shared/api.interface';

function resp(over: Partial<TaskCandidatesResponse>): TaskCandidatesResponse {
  return {
    taskId: 't1',
    taskTitle: '任务1',
    taskStatus: 'pending',
    assigned: false,
    lockedAssigneeId: null,
    lockedDeviceId: null,
    solverVersion: 'heuristic-v2',
    candidates: [],
    generatedAt: '2026-08-09T00:00:00.000Z',
    ...over,
  };
}

describe('candidateExplainVM（候选解释展示）', () => {
  it('eligible 按评分升序（越小越优），rejected 展示排除原因', () => {
    const vm = candidateExplainVM(
      resp({
        candidates: [
          { personId: 'p2', personName: 'B', deviceId: null, stationId: 'S1', eligible: false, etaSeconds: 1, distanceMeters: 1, skillMatch: false, workload: 0.5, batteryPct: 100, reservationConflict: false, score: Infinity, reasons: ['missing_skill'] },
          { personId: 'p1', personName: 'A', deviceId: 'd1', stationId: 'S1', eligible: true, etaSeconds: 100, distanceMeters: 10, skillMatch: true, workload: 0.2, batteryPct: 80, reservationConflict: false, score: 12, reasons: [] },
          { personId: 'p3', personName: 'C', deviceId: null, stationId: 'S1', eligible: true, etaSeconds: 200, distanceMeters: 20, skillMatch: true, workload: 0.1, batteryPct: 100, reservationConflict: false, score: 30, reasons: [] },
        ],
      }),
    );
    expect(vm.eligibleCount).toBe(2);
    expect(vm.eligible[0].personId).toBe('p1'); // score 12 < 30
    expect(vm.eligible[0].rank).toBe(1);
    expect(vm.eligible[1].personId).toBe('p3');
    expect(vm.rejected).toHaveLength(1);
    expect(vm.rejected[0].reasons).toEqual(['missing_skill']);
    expect(vm.noCandidate).toBe(false);
  });

  it('无候选 → noCandidate=true（不虚构）', () => {
    const vm = candidateExplainVM(resp({ candidates: [] }));
    expect(vm.noCandidate).toBe(true);
    expect(vm.eligibleCount).toBe(0);
  });

  it('锁定受让人标记 isLockedAssignee', () => {
    const vm = candidateExplainVM(
      resp({
        lockedAssigneeId: 'p1',
        candidates: [
          { personId: 'p1', personName: 'A', deviceId: null, stationId: 'S1', eligible: true, etaSeconds: 1, distanceMeters: 1, skillMatch: true, workload: 0, batteryPct: 100, reservationConflict: false, score: 5, reasons: [] },
        ],
      }),
    );
    expect(vm.eligible[0].isLockedAssignee).toBe(true);
  });
});

describe('candidateReasonLabel（原因文案映射）', () => {
  it('已知原因映射中文，未知原因原样透传', () => {
    expect(candidateReasonLabel('missing_skill')).toBe('缺少技能');
    expect(candidateReasonLabel('route_infeasible')).toBe('路径不可行');
    expect(candidateReasonLabel('custom_reason')).toBe('custom_reason');
  });
});
