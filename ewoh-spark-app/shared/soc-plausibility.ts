/* 执行机构（AGV）电量合理性闸门（NO-92a）——平台侧领域规则。
 *
 * 背景（2026-09-15 仿真对抗 A6 观察项）：AGV SOC 序列 90→55→20→8→**95** 中的
 * 单帧回跳被如实接受进台账——坏传感、 spoofing 或瞬时毛刺的读数没有任何
 * 变化率/合理性拦截（已知缺口，修复需先定"合理变化率"的领域口径）。
 *
 * 领域口径（本文件是唯一事实源）：
 * - 电量是**物理量**：短时间内的变化率有物理上限。放电由电机功率决定
 *   （典型 AGV 满放电 8–12h ≈ 0.1–0.2%/min）；充电由充电功率决定
 *   （机会快充约 1–1.5%/min）。默认包络取**对称 1.5%/min**（覆盖快充 + 余量），
 *   现场可通过环境变量按机型放宽。
 * - 量化噪声下限：电池百分比是离散读数（ADC/量化），相邻帧 ±1–2 点跳变正常；
 *   包络取 `max(floor, rate × dt)`，floor 默认 4 点。
 * - 锚点时效：上次可信遥测距今超过 dtCap（默认 30 分钟）后不再可比
 *   （设备可能离线充电数小时）→ **unjudgeable，如实接受**（缺锚 ≠ 造假，
 *   不拿过期锚点拒绝真实状态）。
 * - 再锚定：单帧跳变被拒绝后，若设备**连续** N 帧（默认 3）都报告同一新水平，
 *   判定为真实变化（毛刺只有一帧，真实充电是持续过程）→ 接受并标记
 *   `soc_reanchored`。拒绝与再锚定全程显式回显，不静默。
 * - 越界：battery_pct 非 [0,100] 或非有限数 → 无条件拒绝（无需锚点）。
 *
 * 设计取舍（为何不用现成库）：这是**领域校验规则**而非通用算法——检索主流
 * 开源生态（时序异常检测：prophet/ADTK/pyod 等）面向统计离群，需要历史训练
 * 窗口且不可解释到"单帧为什么被拒"；工业网关实践（Sparkplug B 死带、 UNS
 * 合理性检查）均为参数化包络判据。故按仓库既有闸门模式（CLOCK_DRIFT_FUTURE_TS
 * 同款 fail-closed + 显式 error 词）自实现，参数显式可配置：
 * - 平台侧（本文件）而非边缘侧：平台闸门保护**所有**上行路径（边缘桥、直连
 *   API、仿真器），边缘只覆盖单通道；且台账投影（ewoh_device.battery_pct）
 *   是调度资格的唯一读点，闸门守在投影前。
 * - 拒绝而非标记接受：世界状态与台账是调度/指挥地图的事实源，坏电量一旦
 *   投影进去，`battery_low` 资格门槛就被伪造读数绕过（原则 7：不可信数据
 *   不得被静默伪造成确定事实）。原始观测仍可从边缘死信与响应回显取证。
 *
 * 跨运行时：边缘（Python）暂不实现同判据——平台闸门已覆盖全部入口；边缘
 * 侧本地降级决策若未来需要电量合理性，应读本文件的口径注释对齐参数。
 */

/** 默认配置（现场可按机型/充电策略经环境变量覆盖，见 SensorIngestService）。 */
export const SOC_PLAUSIBILITY_DEFAULTS = {
  /** 包络速率：每分钟最大变化百分点（对称，覆盖快充）。 */
  maxRatePerMin: 1.5,
  /** 量化噪声下限：无论 dt 多短，|Δ| ≤ 此值视为正常读数抖动。 */
  jumpFloorPts: 4,
  /** 锚点时效上限（分钟）：超过后不可判（如实接受，不拿过期锚点拒绝真实状态）。 */
  dtCapMin: 30,
  /** 再锚定连击数：连续 N 帧同一新水平 → 判定真实变化，接受并标记。 */
  reanchorStreak: 3,
} as const;

export interface SocPlausibilityConfig {
  maxRatePerMin: number;
  jumpFloorPts: number;
  dtCapMin: number;
  reanchorStreak: number;
}

export const SOC_RANGE = { min: 0, max: 100 } as const;

/** 响应/错误词中的稳定 token（grep 即审，与 CLOCK_DRIFT_FUTURE_TS 同纪律）。 */
export const SOC_JUMP_IMPLAUSIBLE = 'SOC_JUMP_IMPLAUSIBLE';
export const SOC_OUT_OF_RANGE = 'SOC_OUT_OF_RANGE';

export type SocVerdict =
  | { verdict: 'plausible'; delta: number; maxDelta: number }
  | { verdict: 'unjudgeable'; reason: 'no_anchor' | 'stale_anchor' }
  | { verdict: 'out_of_range' }
  | { verdict: 'implausible'; delta: number; maxDelta: number; dtMin: number };

/**
 * 判定一帧电量读数相对上次可信锚点是否物理合理。纯函数，无 I/O。
 *
 * @param prevPct   上次可信电量（台账现值）；null = 无锚点。
 * @param prevAt    上次可信遥测时刻；null = 无锚点。
 * @param candidate 本次读数（调用前已确保为 number）。
 */
export function evaluateSocPlausibility(params: {
  prevPct: number | null;
  prevAt: Date | null;
  candidate: number;
  candidateAt: Date;
  cfg: SocPlausibilityConfig;
}): SocVerdict {
  const { prevPct, prevAt, candidate, candidateAt, cfg } = params;

  if (!Number.isFinite(candidate) || candidate < SOC_RANGE.min || candidate > SOC_RANGE.max) {
    return { verdict: 'out_of_range' };
  }
  if (prevPct === null || prevPct === undefined || !prevAt) {
    return { verdict: 'unjudgeable', reason: 'no_anchor' };
  }
  const dtMin = (candidateAt.getTime() - prevAt.getTime()) / 60000;
  // 负 dt（乱序迟到帧）：钳到 0——只按噪声下限判（迟到帧不得用"未来的锚"放大包络）。
  const dtClamped = Math.max(0, dtMin);
  if (dtClamped > cfg.dtCapMin) {
    return { verdict: 'unjudgeable', reason: 'stale_anchor' };
  }
  const maxDelta = Math.max(cfg.jumpFloorPts, cfg.maxRatePerMin * dtClamped);
  const delta = Math.abs(candidate - prevPct);
  if (delta <= maxDelta) {
    return { verdict: 'plausible', delta, maxDelta };
  }
  return { verdict: 'implausible', delta, maxDelta, dtMin: dtClamped };
}

/**
 * 从环境变量解析配置；非法值回退默认（摄入主路径不因配置错误拒服）。
 * 返回逐项来源说明，供启动日志/排障显式回显（不静默）。
 */
export function resolveSocPlausibilityConfig(env: NodeJS.ProcessEnv = process.env): {
  cfg: SocPlausibilityConfig;
  sources: Record<keyof SocPlausibilityConfig, 'env' | 'default'>;
} {
  const num = (raw: string | undefined): number | null => {
    if (raw === undefined || String(raw).trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  const maxRatePerMin = num(env.EWOH_SOC_MAX_RATE_PER_MIN) ?? SOC_PLAUSIBILITY_DEFAULTS.maxRatePerMin;
  const jumpFloorPts = num(env.EWOH_SOC_JUMP_FLOOR_PTS) ?? SOC_PLAUSIBILITY_DEFAULTS.jumpFloorPts;
  const dtCapMin = num(env.EWOH_SOC_DT_CAP_MIN) ?? SOC_PLAUSIBILITY_DEFAULTS.dtCapMin;
  const reanchorStreakRaw = num(env.EWOH_SOC_REANCHOR_STREAK);
  // 连击数必须是 ≥1 的整数（0 或小数无意义）。
  const reanchorStreak =
    reanchorStreakRaw !== null && Number.isInteger(reanchorStreakRaw) && reanchorStreakRaw >= 1
      ? reanchorStreakRaw
      : SOC_PLAUSIBILITY_DEFAULTS.reanchorStreak;
  return {
    cfg: { maxRatePerMin, jumpFloorPts, dtCapMin, reanchorStreak },
    sources: {
      maxRatePerMin: num(env.EWOH_SOC_MAX_RATE_PER_MIN) !== null ? 'env' : 'default',
      jumpFloorPts: num(env.EWOH_SOC_JUMP_FLOOR_PTS) !== null ? 'env' : 'default',
      dtCapMin: num(env.EWOH_SOC_DT_CAP_MIN) !== null ? 'env' : 'default',
      reanchorStreak:
        reanchorStreakRaw !== null && Number.isInteger(reanchorStreakRaw) && reanchorStreakRaw >= 1
          ? 'env'
          : 'default',
    },
  };
}

/**
 * 再锚定连击追踪（进程内有界 Map；多实例部署各计各的——再锚定是安全网而非
 * 正确性关键路径，各实例独立达阈值最终都会再锚定）。
 * 有界化：超容淘汰最老一半（对齐 dashboard overview 缓存同款纪律）。
 */
export class SocReanchorTracker {
  private readonly entries = new Map<string, { level: number; streak: number; updatedAt: number }>();

  constructor(
    private readonly capacity = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 记录一次被拒读数：同水平连击 +1，换水平重置为 1。返回当前连击数。
   */
  record(key: string, level: number): number {
    const prev = this.entries.get(key);
    const streak = prev && prev.level === level ? prev.streak + 1 : 1;
    if (this.entries.size >= this.capacity && !prev) {
      this.evictOldestHalf();
    }
    this.entries.set(key, { level, streak, updatedAt: this.now() });
    return streak;
  }

  /** 可信帧到达：清除连击（新锚点成立，旧争议作废）。 */
  clear(key: string): void {
    this.entries.delete(key);
  }

  currentStreak(key: string): number {
    return this.entries.get(key)?.streak ?? 0;
  }

  private evictOldestHalf(): void {
    const ordered = [...this.entries.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    for (let i = 0; i < Math.ceil(ordered.length / 2); i++) {
      this.entries.delete(ordered[i][0]);
    }
  }
}

/** 组装拒绝响应的 error 文案（稳定 token + 判据数值，现场可解释）。 */
export function socRejectionMessage(verdict: SocVerdict & { verdict: 'implausible' | 'out_of_range' }, candidate: number, prevPct: number | null): string {
  if (verdict.verdict === 'out_of_range') {
    return `${SOC_OUT_OF_RANGE}：battery_pct=${candidate} 越界（合法范围 ${SOC_RANGE.min}–${SOC_RANGE.max}），拒绝写入`;
  }
  return (
    `${SOC_JUMP_IMPLAUSIBLE}：battery_pct ${prevPct}→${candidate} 单帧变化 ${verdict.delta.toFixed(1)}` +
    ` 超出合理包络 ≤${verdict.maxDelta.toFixed(1)} 点（速率包络 × dt ${verdict.dtMin.toFixed(2)}min，` +
    `下限为量化噪声）；连续多帧同一新水平将触发再锚定（SOC_REANCHOR），本帧不写台账与世界状态`
  );
}
