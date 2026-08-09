/* Phase 4 / P4-PREVIEW：conflict-preview-logic 纯函数测试。
 *
 * 覆盖：无 diff 摘要、churn/changeCount 透传、changeType 计数、entries 组装
 * （before/after 摘要行）、resolvePreviewAction 优先后端 resolution。
 */
import { previewSummary, resolvePreviewAction } from './conflict-preview-logic';
import type { SchedulingConflict, ConflictPreviewResult } from '@shared/api.interface';

const preview: ConflictPreviewResult = {
  conflictId: 'CFL-1',
  baselinePlanId: 'PLAN-A',
  candidatePlanId: 'PLAN-B',
  diff: {
    baselinePlanId: 'PLAN-A',
    candidatePlanId: 'PLAN-B',
    added: ['T-2'],
    removed: [],
    diffByTask: [
      {
        taskId: 'T-1',
        changeTypes: ['DEVICE_CHANGED', 'ETA_CHANGED'],
        reasons: ['DEV-7 offline', 'fallback to DEV-9'],
        before: { taskId: 'T-1', personId: 'P1', deviceId: 'DEV-7', stationId: 'ST-1', plannedStart: '2026-08-09T10:00:00Z', plannedEnd: null, etaSeconds: 120 },
        after: { taskId: 'T-1', personId: 'P1', deviceId: 'DEV-9', stationId: 'ST-1', plannedStart: '2026-08-09T10:00:00Z', plannedEnd: null, etaSeconds: 180 },
      },
    ],
    changeTypeCounts: { DEVICE_CHANGED: 1, ETA_CHANGED: 1 } as Record<string, number>,
    churn: 2,
    aggregate: {},
  },
  affectedTasks: ['T-1'],
  affectedResources: ['DEV-7'],
  remainingConflicts: [],
  expectedKpiImpact: { churn: 2 },
  readonly: true,
};

const conflict: SchedulingConflict = {
  conflictId: 'CFL-1',
  type: 'device_offline',
  severity: 'high',
  scope: 'resource',
  resourceId: 'DEV-7',
  resourceType: 'device',
  taskIds: ['T-1'],
  message: 'DEV-7 offline',
  resolution: 'REPLACE_DEVICE',
  createdAt: '2026-08-09T10:00:00Z',
  snapshotVersion: 'WS-1',
  status: 'OPEN',
};

describe('previewSummary', () => {
  it('null preview → hasDiff=false 空摘要', () => {
    const s = previewSummary(null);
    expect(s.hasDiff).toBe(false);
    expect(s.churn).toBe(0);
    expect(s.entries).toHaveLength(0);
  });

  it('透传后端 churn/changeCount/added/removed（不重算）', () => {
    const s = previewSummary(preview);
    expect(s.hasDiff).toBe(true);
    expect(s.baselineLabel).toBe('PLAN-A');
    expect(s.candidateLabel).toBe('PLAN-B');
    expect(s.churn).toBe(2);
    expect(s.changeCount).toBe(1);
    expect(s.added).toBe(1);
    expect(s.removed).toBe(0);
  });

  it('changeTypeCounts 按后端类型计数', () => {
    const s = previewSummary(preview);
    expect(s.changeTypeCounts).toEqual([
      { type: 'DEVICE_CHANGED', count: 1 },
      { type: 'ETA_CHANGED', count: 1 },
    ]);
  });

  it('entries 组装 before/after 摘要行 + reasons（后端事实）', () => {
    const s = previewSummary(preview);
    expect(s.entries).toHaveLength(1);
    const e = s.entries[0];
    expect(e.taskId).toBe('T-1');
    expect(e.changeTypes).toEqual(['DEVICE_CHANGED', 'ETA_CHANGED']);
    expect(e.reasons).toEqual(['DEV-7 offline', 'fallback to DEV-9']);
    expect(e.beforeLine).toBe('P1 → ST-1 · 120s');
    expect(e.afterLine).toBe('P1 → ST-1 · 180s');
  });

  it('diff 缺失时不抛错', () => {
    const s = previewSummary({ ...preview, diff: null });
    expect(s.hasDiff).toBe(false);
  });
});

describe('resolvePreviewAction', () => {
  it('优先后端 resolution 作为 preview 动作', () => {
    expect(resolvePreviewAction(conflict)).toBe('REPLACE_DEVICE');
  });

  it('无 resolution 时返回 undefined（后端自判）', () => {
    expect(resolvePreviewAction({ ...conflict, resolution: null })).toBeUndefined();
  });
});
