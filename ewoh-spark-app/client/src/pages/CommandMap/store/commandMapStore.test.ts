/* Task 4 / P1：CommandMapStore 状态/动作/version 测试（node 环境，无 React）。
 *
 * 关键不变量：
 * - selection 写入只改 selection slice，其他 slice 引用保持不变（订阅隔离基础）；
 * - version 计数器在任意 slice 写入时 +1；
 * - 无效 mode 被 map-mode-machine 拒绝（不写入）；
 * - clearSelection(type) 只清指定选中。
 */
import {
  useCommandMapStore,
  DEFAULT_SELECTION,
  DEFAULT_VIEWPORT,
  DEFAULT_REPLAY,
  DEFAULT_SCHEDULER_REALTIME,
  DEFAULT_DECISION_CONTEXT,
  isRealtimeConnected,
} from './commandMapStore';
import type { CommandMapStore } from './commandMapStore';

function resetStore(): void {
  useCommandMapStore.setState({
    version: 0,
    selection: { ...DEFAULT_SELECTION },
    viewport: { ...DEFAULT_VIEWPORT },
    mode: 'production',
    level: 'L1',
    replay: { ...DEFAULT_REPLAY },
    schedulerRealtime: { ...DEFAULT_SCHEDULER_REALTIME },
    decisionContext: { ...DEFAULT_DECISION_CONTEXT },
  });
}

const get = (): CommandMapStore => useCommandMapStore.getState();

describe('CommandMapStore: selection slice', () => {
  beforeEach(resetStore);

  it('setSelectedTask 写入 taskId + selectionType=task，其他 id 不变', () => {
    get().setSelectedTask('TASK-1');
    expect(get().selection.taskId).toBe('TASK-1');
    expect(get().selection.selectionType).toBe('task');
    expect(get().selection.planId).toBeNull();
    expect(get().selection.entityId).toBeNull();
  });

  it('setSelectedPlan / setSelectedEntity 同步更新 selectionType', () => {
    get().setSelectedPlan('PLAN-A');
    expect(get().selection.planId).toBe('PLAN-A');
    expect(get().selection.selectionType).toBe('plan');
    get().setSelectedEntity('ENT-1');
    expect(get().selection.entityId).toBe('ENT-1');
    expect(get().selection.selectionType).toBe('entity');
    // 切换选中种类不丢失其他 id（只有清空操作才置 null）。
    expect(get().selection.planId).toBe('PLAN-A');
  });

  it('置 null 时仅清空对应字段并把 selectionType 回落为 null', () => {
    get().setSelectedTask('TASK-1');
    get().setSelectedTask(null);
    expect(get().selection.taskId).toBeNull();
    expect(get().selection.selectionType).toBeNull();
  });

  it('clearSelection(type) 只清指定种类；clearSelection() 清全部', () => {
    get().setSelectedTask('TASK-1');
    get().setSelectedPlan('PLAN-A');
    get().setSelectedEntity('ENT-1');

    get().clearSelection('task');
    expect(get().selection.taskId).toBeNull();
    expect(get().selection.planId).toBe('PLAN-A');
    expect(get().selection.entityId).toBe('ENT-1');
    expect(get().selection.selectionType).toBe('entity');

    get().clearSelection();
    expect(get().selection).toEqual(DEFAULT_SELECTION);
  });
});

describe('CommandMapStore: version 计数器与 slice 隔离', () => {
  beforeEach(resetStore);

  it('任意 slice 写入 version+1（含 viewport/replay/schedulerRealtime/decisionContext）', () => {
    expect(get().version).toBe(0);
    get().setViewport({ scale: 2 });
    expect(get().version).toBe(1);
    get().setReplay({ active: true });
    expect(get().version).toBe(2);
    get().setSchedulerRealtime({ lastEventSeq: 9 });
    expect(get().version).toBe(3);
    get().setDecisionContext({ a: 1 }, 'candidate');
    expect(get().version).toBe(4);
    get().clearDecisionContext();
    expect(get().version).toBe(5);
  });

  it('写 schedulerRealtime 不改变 selection slice 引用（订阅隔离的基础）', () => {
    const selBefore = get().selection;
    get().setSchedulerRealtime({ lastEventSeq: 42, connected: true });
    expect(get().selection).toBe(selBefore);
  });

  it('写 selection 不改变 schedulerRealtime slice 引用', () => {
    const rtBefore = get().schedulerRealtime;
    get().setSelectedTask('T1');
    expect(get().schedulerRealtime).toBe(rtBefore);
  });

  it('写 selection 不改变 viewport/mode/replay/decisionContext 引用', () => {
    const vp = get().viewport;
    const rt = get().schedulerRealtime;
    const rp = get().replay;
    const dc = get().decisionContext;
    get().setSelectedPlan('P1');
    expect(get().viewport).toBe(vp);
    expect(get().schedulerRealtime).toBe(rt);
    expect(get().replay).toBe(rp);
    expect(get().decisionContext).toBe(dc);
  });
});

describe('CommandMapStore: mode/level（map-mode-machine 联动）', () => {
  beforeEach(resetStore);

  it('切到 scheduling → 层级联动升 L3', () => {
    const effects = get().setMode('scheduling');
    expect(get().mode).toBe('scheduling');
    expect(get().level).toBe('L3');
    expect(effects).toEqual([]);
  });

  it('离开 scheduling → 层级回 L1 并返回 clear_selected_task 副作用', () => {
    get().setMode('scheduling');
    get().setSelectedTask('T1');
    const effects = get().setMode('production');
    expect(get().mode).toBe('production');
    expect(get().level).toBe('L1');
    expect(effects).toContain('clear_selected_task');
  });

  it('非法 mode → 拒绝（状态不变，无副作用）', () => {
    const before = { mode: get().mode, level: get().level, version: get().version };
    const effects = get().setMode('not-a-mode');
    expect(effects).toEqual([]);
    expect({ mode: get().mode, level: get().level }).toEqual({
      mode: before.mode,
      level: before.level,
    });
    expect(get().version).toBe(before.version);
  });

  it('setLevel 直接写入（L3/L4 近景守卫由 CommandMap 层负责）', () => {
    get().setLevel('L2');
    expect(get().level).toBe('L2');
  });
});

describe('CommandMapStore: replay / schedulerRealtime / decisionContext slices', () => {
  beforeEach(resetStore);

  it('replay patch 合并保留其他字段', () => {
    get().setReplay({ active: true, speed: 2 });
    get().setReplay({ paused: true });
    expect(get().replay).toMatchObject({ active: true, paused: true, speed: 2, timestamp: null });
  });

  it('schedulerRealtime patch 合并保留 plans/conflicts', () => {
    get().setSchedulerRealtime({ plans: [{ planId: 'P1' } as never], conflicts: [] });
    get().setSchedulerRealtime({ lastEventSeq: 5, connected: true });
    expect(get().schedulerRealtime.lastEventSeq).toBe(5);
    expect(get().schedulerRealtime.plans).toHaveLength(1);
    expect(get().schedulerRealtime.connected).toBe(true);
  });

  it('decisionContext 写入/清空', () => {
    get().setDecisionContext({ conflictId: 'CFL-1' }, 'conflict');
    expect(get().decisionContext).toEqual({ context: { conflictId: 'CFL-1' }, source: 'conflict' });
    get().clearDecisionContext();
    expect(get().decisionContext).toEqual(DEFAULT_DECISION_CONTEXT);
  });
});

describe('CommandMapStore: isRealtimeConnected', () => {
  it('OFFLINE 视为断开，其余视为在线', () => {
    expect(isRealtimeConnected('OFFLINE')).toBe(false);
    expect(isRealtimeConnected('CONNECTED')).toBe(true);
    expect(isRealtimeConnected('DEGRADED')).toBe(true);
    expect(isRealtimeConnected('RESYNCING')).toBe(true);
  });
});
