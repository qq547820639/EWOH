/* Task 10 / 10.3：OverridePanel 执行前预览纯逻辑测试（override-preview-logic）。
 *
 * 验证「提交覆盖 → 先展示 previewOverrides dry-run 摘要 → 确认后才真正提交」的
 * 展示数据构建（affected/churn/冲突/delta 行），全部只透传后端字段。
 */
import {
  overridePreviewSummary,
  overridePreviewDeltaRows,
} from './override-preview-logic';
import type { OverridePreviewResponse } from '@shared/api.interface';

const makePreview = (overrides: Partial<OverridePreviewResponse> = {}): OverridePreviewResponse => ({
  planId: 'PLAN-1',
  readonly: true,
  affectedAssignments: ['T-1', 'T-2', 'T-3'],
  conflictsIntroduced: [{ conflictId: 'C-NEW', type: 'double_booking', message: '预占冲突' }],
  latenessDeltaMinutes: -8,
  travelDeltaMinutes: -15,
  workloadDelta: 0.03,
  stationWaitDeltaMinutes: -4,
  planChurn: 3,
  candidatePlanId: 'PREVIEW-OV-1',
  ...overrides,
});

describe('Task 10 overridePreviewSummary（覆盖执行前预览摘要）', () => {
  it('从 mock 预览响应派生受影响数/churn/引入冲突数', () => {
    const summary = overridePreviewSummary(makePreview());
    expect(summary).toMatchObject({
      planId: 'PLAN-1',
      affectedCount: 3,
      planChurn: 3,
      latenessDeltaMinutes: -8,
      travelDeltaMinutes: -15,
      workloadDelta: 0.03,
      stationWaitDeltaMinutes: -4,
    });
    expect(summary.conflictsIntroduced).toHaveLength(1);
    expect(summary.conflictsIntroduced[0]).toMatchObject({
      conflictId: 'C-NEW',
      type: 'double_booking',
    });
  });

  it('delta 行覆盖迟到/路程/负荷/工位等待（负值利好）', () => {
    const rows = overridePreviewDeltaRows(makePreview());
    expect(rows.map((r) => r.key)).toEqual(['lateness', 'travel', 'workload', 'stationWait']);
    expect(rows[0]).toMatchObject({ label: '迟到', value: -8, unit: 'min' });
    expect(rows[2]).toMatchObject({ key: 'workload', value: 0.03 });
  });

  it('无引入冲突时列表为空（不伪造）', () => {
    const summary = overridePreviewSummary(makePreview({ conflictsIntroduced: [] }));
    expect(summary.conflictsIntroduced).toEqual([]);
  });
});
