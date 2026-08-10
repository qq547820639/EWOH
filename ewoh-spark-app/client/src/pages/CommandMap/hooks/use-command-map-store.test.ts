/* Task 4 / P1：store 订阅隔离测试（selector 纯度）。
 *
 * 断言「订阅一个 slice 不会收到另一个 slice 的更新」：
 * subscribeWithSelector 的 selector 订阅（等价于 per-slice hooks 的底层机制）——
 * 写 schedulerRealtime 不通知 selection 订阅者，反之亦然；useShallow 的浅比较
 * 语义由 zustand/react/shallow 提供，与 subscribe 的 equalityFn 一致。
 */
import { shallow } from 'zustand/shallow';
import {
  useCommandMapStore,
  DEFAULT_SELECTION,
  DEFAULT_VIEWPORT,
  DEFAULT_REPLAY,
  DEFAULT_SCHEDULER_REALTIME,
  DEFAULT_DECISION_CONTEXT,
} from '../store/commandMapStore';

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

describe('CommandMapStore 订阅隔离（selector 纯度）', () => {
  beforeEach(resetStore);

  it('写 schedulerRealtime → selection 订阅者不被通知', () => {
    const onSelection = jest.fn();
    const unsub = useCommandMapStore.subscribe(
      (s) => s.selection,
      onSelection,
      { equalityFn: shallow },
    );
    useCommandMapStore.getState().setSchedulerRealtime({ lastEventSeq: 100, connected: true });
    expect(onSelection).not.toHaveBeenCalled();
    useCommandMapStore.getState().setSelectedTask('T1');
    expect(onSelection).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('写 selection → schedulerRealtime 订阅者不被通知', () => {
    const onRealtime = jest.fn();
    const unsub = useCommandMapStore.subscribe(
      (s) => s.schedulerRealtime,
      onRealtime,
      { equalityFn: shallow },
    );
    useCommandMapStore.getState().setSelectedTask('T1');
    useCommandMapStore.getState().setSelectedPlan('P1');
    expect(onRealtime).not.toHaveBeenCalled();
    useCommandMapStore.getState().setSchedulerRealtime({ lastEventSeq: 1 });
    expect(onRealtime).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('写 selection → mode/viewport 订阅者不被通知', () => {
    const onMode = jest.fn();
    const onViewport = jest.fn();
    const unsubMode = useCommandMapStore.subscribe((s) => s.mode, onMode, { equalityFn: shallow });
    const unsubVp = useCommandMapStore.subscribe(
      (s) => s.viewport,
      onViewport,
      { equalityFn: shallow },
    );
    useCommandMapStore.getState().setSelectedEntity('ENT-1');
    expect(onMode).not.toHaveBeenCalled();
    expect(onViewport).not.toHaveBeenCalled();
    useCommandMapStore.getState().setMode('scheduling');
    expect(onMode).toHaveBeenCalledTimes(1);
    unsubMode();
    unsubVp();
  });

  it('写 selection 只 bump version，不影响其他 slice 数据', () => {
    const v0 = useCommandMapStore.getState().version;
    useCommandMapStore.getState().setSelectedPlan('P1');
    expect(useCommandMapStore.getState().version).toBe(v0 + 1);
    expect(useCommandMapStore.getState().schedulerRealtime.lastEventSeq).toBe(0);
  });
});
