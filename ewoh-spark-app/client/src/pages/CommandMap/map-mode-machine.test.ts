/* v0.7 Batch10.3：地图模式状态机测试 */
import {
  transitionMode,
  transitionReplay,
  defaultLevelForMode,
  isValidMode,
  isValidLevel,
  type MapViewState,
} from './map-mode-machine';

const base: MapViewState = {
  mode: 'production',
  level: 'L1',
  replay: { active: false, paused: false },
};

describe('map-mode-machine: transitionMode', () => {
  it('切到调度模式 → 层级升到 L3，无清理副作用', () => {
    const r = transitionMode(base, 'scheduling');
    expect(r).not.toBeNull();
    expect(r!.state.level).toBe('L3');
    expect(r!.effects).toEqual([]);
  });

  it('从调度模式切离 → 层级回 L1 + clear_selected_task', () => {
    const r = transitionMode({ mode: 'scheduling', level: 'L3', replay: { active: false, paused: false } }, 'production');
    expect(r!.state.level).toBe('L1');
    expect(r!.effects).toContain('clear_selected_task');
  });

  it('非法模式 → 拒绝', () => {
    expect(transitionMode(base, 'bogus_mode')).toBeNull();
  });

  it('回放激活时禁止切换模式', () => {
    const r = transitionMode({ ...base, replay: { active: true, paused: false } }, 'scheduling');
    expect(r).toBeNull();
  });
});

describe('map-mode-machine: transitionReplay', () => {
  it('进入回放 → freeze_realtime + 模式回 production', () => {
    const r = transitionReplay({ ...base, mode: 'device' }, true);
    expect(r.effects).toContain('freeze_realtime');
    expect(r.state.mode).toBe('production');
    expect(r.state.replay.active).toBe(true);
  });

  it('退出回放 → resume_realtime', () => {
    const r = transitionReplay({ ...base, replay: { active: true, paused: false } }, false);
    expect(r.effects).toContain('resume_realtime');
    expect(r.state.replay.active).toBe(false);
  });

  it('状态未变 → 无副作用', () => {
    const r = transitionReplay(base, false);
    expect(r.effects).toEqual([]);
  });
});

describe('map-mode-machine: helpers', () => {
  it('defaultLevelForMode: scheduling → L3，其他 → L1', () => {
    expect(defaultLevelForMode('scheduling')).toBe('L3');
    expect(defaultLevelForMode('production')).toBe('L1');
  });

  it('isValidMode / isValidLevel', () => {
    expect(isValidMode('scheduling')).toBe(true);
    expect(isValidMode('bogus')).toBe(false);
    expect(isValidLevel('L4')).toBe(true);
    expect(isValidLevel('L9')).toBe(false);
  });
});
