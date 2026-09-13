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
  /* 2026-09-11 策略变更：未知原因不再裸透传英文键，而是显式标注"未登记原因（key）"
   * ——对现场是"这条解释还没登记"，对排查保留了 key（原则 5/7：不伪装成已知事实）。 */
  /* NO-15b：能力拒绝的可读细节由后端生成，前端只透传（不重算、不编造）。 */
  it('候选透传后端能力说明（哪个能力/谁/何时/为何停用）', () => {
    const vm = candidateExplainVM({
      taskId: 'T-1',
      candidates: [
        {
          personId: 'P-1',
          personName: '张三',
          deviceId: 'D-1',
          stationId: 'S-1',
          eligible: false,
          etaSeconds: 0,
          distanceMeters: 0,
          skillMatch: true,
          workload: 0,
          batteryPct: null,
          reservationConflict: false,
          score: null,
          reasons: ['capability_disabled'],
          rejectReasons: ['capability_disabled'],
          capabilityNotes: [
            '任务要求的能力：exo-lift；该设备当前可用能力：（无）',
            '能力 exo-lift 已被人工停用：admin · 2026/9/11 10:00:00 · 理由：助力模块故障待修',
          ],
        },
      ],
    } as never);
    const row = (vm?.rejected ?? vm?.eligible ?? [])[0];
    expect(row?.capabilityNotes).toEqual([
      '任务要求的能力：exo-lift；该设备当前可用能力：（无）',
      '能力 exo-lift 已被人工停用：admin · 2026/9/11 10:00:00 · 理由：助力模块故障待修',
    ]);
  });

  /* NO-38b：人机同体配对的正向说明同样由后端生成、前端只透传。 */
  it('候选透传后端会话说明（人机同体：该设备正由本候选人员佩戴）', () => {
    const vm = candidateExplainVM({
      taskId: 'T-1',
      candidates: [
        {
          personId: 'P-1',
          personName: '张三',
          deviceId: 'D-1',
          stationId: 'S-1',
          eligible: true,
          etaSeconds: 0,
          distanceMeters: 0,
          skillMatch: true,
          workload: 0,
          batteryPct: 80,
          reservationConflict: false,
          score: 10,
          reasons: [],
          rejectReasons: [],
          sessionNotes: [
            '设备 EXO-1 正由该人员佩戴（外骨骼会话 exo-session:x，开始于 2026/9/12 08:00:00）：本候选是人机同体配对（同一台外骨骼不能同时给两个人用）；若要改派他人，需先结束会话或由现场改派佩戴者。',
          ],
        },
      ],
    } as never);
    const row = vm.eligible[0];
    expect(row?.sessionNotes).toHaveLength(1);
    expect(row?.sessionNotes[0]).toContain('人机同体');
    // 没有该字段时 → 空数组（前端不补造说明）
    const vm2 = candidateExplainVM({
      taskId: 'T-1',
      candidates: [
        {
          personId: 'P-2',
          personName: '李四',
          deviceId: null,
          stationId: null,
          eligible: true,
          etaSeconds: 0,
          distanceMeters: 0,
          skillMatch: true,
          workload: 0,
          batteryPct: null,
          reservationConflict: false,
          score: 5,
          reasons: [],
          rejectReasons: [],
        },
      ],
    } as never);
    expect(vm2.eligible[0]?.sessionNotes).toEqual([]);
  });

  it('已知原因映射中文（唯一词表），未知原因显式标注未登记', () => {
    expect(candidateReasonLabel('missing_skill')).toBe('缺少技能');
    expect(candidateReasonLabel('route_infeasible')).toBe('无可行路径');
    // 旧键仍可读（历史方案里的 rejectReasons 带过 device_data_unavailable）
    expect(candidateReasonLabel('device_data_unavailable')).toBe('电量未知（未上报，不派工）');
    // 本轮新增登记的原因（此前不在联合类型里，前端无文案）
    expect(candidateReasonLabel('device_maintenance_blocked')).toBe('设备维护中（需人工解除）');
    expect(candidateReasonLabel('continuous_work_exceeded')).toBe('连续负荷超限');
    expect(candidateReasonLabel('battery_unknown')).toBe('电量未知（未上报，不派工）');
    expect(candidateReasonLabel('custom_reason')).toBe('未登记原因（custom_reason）');
  });
});
