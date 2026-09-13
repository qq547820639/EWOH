/**
 * andon-sla.ts — 安灯 SLA 与"没人接手"升级的判定（NO-48a，纯函数）。
 *
 * 为什么需要它：安灯现有的 SLA 升级**只在"有人接手但接晚了"时触发**
 * （`transitionAndon` 的 acknowledge 分支：responseSec > slaSeconds → escalationLevel=1）。
 * 于是一个真实且危险的场景完全没有出口：**红灯亮了、没有人接手**——
 * 事件永远停在 `open`，既不升级、也不提醒第二个人，直到有人偶然打开看板。
 *
 * 本模块只做判定（谁超期、超到第几级、该用哪个提醒桶）；写通知/审计由服务层做，
 * 且**不改动安灯业务事实**（升级是提醒与留痕，不代替人处置，原则 4/6）。
 *
 * 口径：
 *   · 只对**未接手**的安灯升级（`open`）：已 `acknowledged`/`processing` 说明有人在处理，
 *     那是"处理中"，不是"没人管"——避免把在办的事重复升级成噪音；
 *   · 级别按"已过 SLA 的倍数"分档：>1× → L1（调度/班组长），>2× → L2（追加安全员）；
 *   · 缺失/非法 SLA 与开启时间 → **不下结论**（`breachLevel=0` 且 `reason` 说明原因），
 *     绝不用默认值把"数据缺口"伪装成"没超期"以外的任何结论。
 */

/** 默认 SLA（秒）：15 分钟，与边缘安灯投影的 `slaSeconds ?? 900` 一致。 */
export const ANDON_DEFAULT_SLA_SECONDS = 900;

/** 升级分档（SLA 倍数）。 */
export const ANDON_BREACH_LEVELS = [
  { level: 1, multiplier: 1, bucket: 'sla_breach_l1' },
  { level: 2, multiplier: 2, bucket: 'sla_breach_l2' },
] as const;

export type AndonBreachBucket = (typeof ANDON_BREACH_LEVELS)[number]['bucket'];
export type AndonBreachLevel = 0 | 1 | 2;

export interface AndonSlaInput {
  /** 安灯开启时间（epoch ms；无法解析 → null）。 */
  openedAtMs: number | null;
  /** 该安灯的 SLA（秒；缺失/非法 → 用默认值，并在 reason 里说明）。 */
  slaSeconds?: number | null;
  /** 判定时刻。 */
  nowMs: number;
}

export interface AndonSlaState {
  /** 已开启多久（秒）；无法解析 → null。 */
  ageSeconds: number | null;
  /** 实际使用的 SLA（秒）。 */
  slaSeconds: number;
  /** SLA 是否来自默认值（true = 该安灯没记录自己的 SLA）。 */
  slaIsDefault: boolean;
  /** 超期多少秒（未超期 → 0）。 */
  overdueSeconds: number;
  /** 升级级别：0=未超期/不下结论，1=超过 1×SLA，2=超过 2×SLA。 */
  breachLevel: AndonBreachLevel;
  /** 该级别对应的提醒桶（未超期 → null）。 */
  bucket: AndonBreachBucket | null;
  /** 无法判定时的原因（可判定 → null）。 */
  reason: string | null;
}

/**
 * 纯函数：安灯的 SLA 状态判定。
 *
 * `open` 之外的调用方（acknowledged/processing/closed）不应调用本函数做升级判断——
 * 状态过滤在服务层的扫描里（这里只回答"按时间算该不该升级"）。
 */
export function evaluateAndonSla(input: AndonSlaInput): AndonSlaState {
  const rawSla = Number(input.slaSeconds);
  const slaIsDefault = !Number.isFinite(rawSla) || rawSla <= 0;
  const slaSeconds = slaIsDefault ? ANDON_DEFAULT_SLA_SECONDS : Math.trunc(rawSla);
  const openedAtMs = input.openedAtMs;
  if (openedAtMs === null || !Number.isFinite(openedAtMs)) {
    return {
      ageSeconds: null,
      slaSeconds,
      slaIsDefault,
      overdueSeconds: 0,
      breachLevel: 0,
      bucket: null,
      reason: '安灯开启时间未记录或无法解析（无法判断是否超期）',
    };
  }
  const ageSeconds = Math.max(0, Math.round((input.nowMs - openedAtMs) / 1000));
  const overdueSeconds = Math.max(0, ageSeconds - slaSeconds);
  // 分档从高到低匹配：先看是否已到 L2，再看 L1。
  const hit = [...ANDON_BREACH_LEVELS].reverse().find((entry) => ageSeconds > entry.multiplier * slaSeconds);
  return {
    ageSeconds,
    slaSeconds,
    slaIsDefault,
    overdueSeconds,
    breachLevel: (hit?.level ?? 0) as AndonBreachLevel,
    bucket: hit?.bucket ?? null,
    reason: null,
  };
}

/** 升级受众（角色）按级别确定：L1 给调度/班组长；L2 追加安全员。 */
export function andonBreachRecipients(level: AndonBreachLevel): string[] {
  if (level >= 2) return ['safety_admin', 'workshop_lead', 'dispatcher'];
  if (level === 1) return ['workshop_lead', 'dispatcher'];
  return [];
}

/** 升级文案（人话，含"没人接手多久"+可照做的下一步）。 */
export function andonBreachText(params: {
  title: string;
  deviceId: string | null;
  ageSeconds: number;
  slaSeconds: number;
  level: AndonBreachLevel;
  slaIsDefault: boolean;
}): { title: string; body: string } {
  const minutes = Math.max(0, Math.round(params.ageSeconds / 60));
  const slaMinutes = Math.max(1, Math.round(params.slaSeconds / 60));
  const scoped = params.deviceId ? `设备 ${params.deviceId}` : '安灯';
  return {
    title: `安灯超时未接手（L${params.level}）：${params.title}`,
    body:
      `${scoped} 已亮 ${minutes} 分钟，超过 SLA ${slaMinutes} 分钟仍**无人接手**`
      + (params.slaIsDefault ? '（该安灯未记录自己的 SLA，按默认 15 分钟判定）' : '')
      + `｜等级 L${params.level}：请立即确认现场情况并接手（acknowledge→process→close）`,
  };
}
