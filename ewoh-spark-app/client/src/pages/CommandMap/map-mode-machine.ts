// map-mode-machine.ts — 指挥地图模式状态机（v0.7 Batch10.3）
//
// 将 CommandMap 的 mode/level/replayMode 三态联动规则抽取为纯函数模块：
// - 有效转换表（mode ↔ level 联动、replay 与实时模式互斥）
// - 副作用映射（进入调度模式需清理选中任务、回放模式冻结轮询）
// 纯函数可测，CommandMap 消费本模块的转换判定，消除手写 effect 中的隐性规则。
//
// 说明：CommandMap 保留 useState 作为存储（不引入 useReducer 大重构），
// 本模块承载"转换合法性 + 联动副作用"的单一事实源。

/** 地图模式 key（与 ModePanel.MODES 一致）。 */
export type MapMode = 'production' | 'person' | 'exoskeleton' | 'body_load' | 'safety_risk' | 'device' | 'environment' | 'scheduling' | 'data_quality';

/** 层级 L0-L4。 */
export type MapLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/** 回放状态。 */
export interface ReplayState {
  active: boolean;
  paused: boolean;
}

/** 地图视图状态快照。 */
export interface MapViewState {
  mode: MapMode;
  level: MapLevel;
  replay: ReplayState;
}

/** 模式切换副作用类型（供 CommandMap 在转换后执行）。 */
export type ModeSideEffect =
  | 'clear_selected_task' // 离开调度模式时清空选中任务
  | 'freeze_realtime'     // 进入回放时冻结实时轮询
  | 'resume_realtime';    // 退出回放时恢复实时轮询

/** 有效模式集合。 */
export const VALID_MODES: MapMode[] = [
  'production', 'person', 'exoskeleton', 'body_load', 'safety_risk',
  'device', 'environment', 'scheduling', 'data_quality',
];

/** 层级联动：调度模式默认 L3（方案影响可视化），其他模式默认 L1。 */
export function defaultLevelForMode(mode: MapMode): MapLevel {
  return mode === 'scheduling' ? 'L3' : 'L1';
}

/** 校验模式 key 是否合法。 */
export function isValidMode(mode: string): mode is MapMode {
  return (VALID_MODES as string[]).includes(mode);
}

/** 校验层级是否合法。 */
export function isValidLevel(level: string): level is MapLevel {
  return ['L0', 'L1', 'L2', 'L3', 'L4'].includes(level);
}

/**
 * 计算模式切换后的目标状态 + 副作用。
 * 规则：
 * - 非法模式 → 拒绝（返回 null）；
 * - 切到调度模式 → level 升到 L3（若当前低于 L3）；
 * - 切离调度模式 → level 回到 L1，并产生 clear_selected_task；
 * - 回放激活时禁止切换实时模式（replay 优先）。
 */
export function transitionMode(
  current: MapViewState,
  nextMode: string,
): { state: MapViewState; effects: ModeSideEffect[] } | null {
  if (!isValidMode(nextMode)) return null;
  if (current.replay.active) {
    // 回放中禁止切换实时模式（保持回放上下文）
    return null;
  }
  const effects: ModeSideEffect[] = [];
  let level = current.level;

  if (nextMode === 'scheduling') {
    // 进入调度模式：提升层级到 L3（若低于）
    const target = defaultLevelForMode(nextMode);
    if (levelRank(level) < levelRank(target)) level = target;
  } else {
    // 离开调度模式
    if (current.mode === 'scheduling') {
      effects.push('clear_selected_task');
      level = defaultLevelForMode(nextMode);
    }
  }

  return { state: { mode: nextMode, level, replay: current.replay }, effects };
}

/**
 * 计算回放状态转换后的目标状态 + 副作用。
 * 规则：
 * - 进入回放 → 冻结实时（freeze_realtime），模式回到 production（回放独立于实时模式）；
 * - 退出回放 → 恢复实时（resume_realtime）。
 */
export function transitionReplay(
  current: MapViewState,
  active: boolean,
): { state: MapViewState; effects: ModeSideEffect[] } {
  if (active === current.replay.active) {
    return { state: current, effects: [] };
  }
  const effects: ModeSideEffect[] = [active ? 'freeze_realtime' : 'resume_realtime'];
  return {
    state: {
      mode: active ? 'production' : current.mode,
      level: active ? 'L1' : current.level,
      replay: { active, paused: active ? false : current.replay.paused },
    },
    effects,
  };
}

/** 层级数值排名（用于比较）。 */
function levelRank(level: MapLevel): number {
  return { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 }[level];
}
