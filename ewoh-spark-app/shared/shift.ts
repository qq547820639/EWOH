/* 前后端共享契约 - 班次域（standalone_074，DR-2 班次工作台）。
 *
 * 权威契约：db/migrations/standalone_074_shift_domain.sql + 本文件。
 * 班次是现场的第一组织事实：异常/任务/审批/交接都发生在"某个班"内。
 * resolveShiftAt 为纯函数（前后端同构判定，杜绝"服务端算早班、前端显示晚班"）。
 */

export interface ShiftDefinition {
  shiftId: string;
  name: string;
  code?: string | null;
  /** 本地时区窗口起点，HH:mm。 */
  startTime: string;
  /** 本地时区窗口终点，HH:mm。 */
  endTime: string;
  /** 跨零点窗口（22:00-06:00）；判定 t>=start OR t<end。 */
  crossesMidnight: boolean;
  active: boolean;
  leadUserId?: string | null;
  description?: string | null;
}

/** 交接班遗留事项（结构化，不允许"口头交接、系统无痕"）。 */
export interface ShiftHandoverOpenItem {
  title: string;
  severity?: 'info' | 'warning' | 'critical';
  relatedObjectType?: string;
  relatedObjectId?: string;
  note?: string;
}

export interface ShiftHandover {
  handoverId: string;
  shiftId: string;
  /** 班次日期（YYYY-MM-DD，交接发生的自然日口径）。 */
  shiftDate: string;
  fromUserId?: string | null;
  toUserId: string;
  openItems: ShiftHandoverOpenItem[];
  notes?: string | null;
  /**
   * NO-52a：交接时刻的"设备责任人核对快照"（存的是当时状态，不随后续变更重算）。
   * 缺失 = 交接时未做核对（或核对失败），页面必须如实说明而不是当作"没有缺口"。
   */
  responsibilitySnapshot?: {
    shiftId: string | null;
    shiftUnknown: boolean;
    total: number;
    covered: number;
    gaps: number;
    uncovered: number;
    gapDeviceIds: string[];
    generatedAt: string;
  } | null;
  status: 'pending' | 'confirmed';
  confirmedAt?: string | null;
}

/** 当前班次解析结果：无匹配班次时 current 为 null（显式未知，不猜测默认班）。 */
export interface ResolvedShift {
  current: ShiftDefinition | null;
  /** 下一班（按当日窗口顺延计算；跨零点班次算次日起始）。 */
  next: ShiftDefinition | null;
}

function parseHm(hm: string): number {
  // PG time 列驱动返回 "16:00:00"（含秒）；契约入参 "16:00"。两种都接受。
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(hm.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 判定某时刻（本地时区 HH:mm）是否落在班次窗口内。纯函数。 */
export function isWithinShiftWindow(shift: Pick<ShiftDefinition, 'startTime' | 'endTime' | 'crossesMidnight'>, hhmm: string): boolean {
  const t = parseHm(hhmm);
  const start = parseHm(shift.startTime);
  const end = parseHm(shift.endTime);
  if ([t, start, end].some((v) => Number.isNaN(v)) || start === end) {
    return false;
  }
  return shift.crossesMidnight ? t >= start || t < end : t >= start && t < end;
}

function shiftStartMinutes(shift: ShiftDefinition): number {
  return parseHm(shift.startTime);
}

/**
 * 解析当前时刻所属班次与下一班。
 *
 * 无匹配时 current=null（如班次定义未覆盖的午休间隙），调用方必须显式处理
 * "不在任何班次内"的展示，不得静默落到默认班（原则 7）。
 */
export function resolveShiftAt(shifts: ShiftDefinition[], at: Date): ResolvedShift {
  const active = shifts.filter((s) => s.active);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const now = `${hh}:${mm}`;
  const current = active.find((s) => isWithinShiftWindow(s, now)) ?? null;

  // 下一班 = 起始时刻严格晚于当前时刻的最小者；若都已过（含跨零点班已开始前段），
  // 取最早起始的班次（明天）。仅有一个班次时 next=它自己（轮转班）。
  if (active.length === 0) return { current: null, next: null };
  const t = parseHm(now);
  const later = active
    .filter((s) => shiftStartMinutes(s) > t)
    .sort((a, b) => shiftStartMinutes(a) - shiftStartMinutes(b));
  const next = later[0]
    ?? [...active].sort((a, b) => shiftStartMinutes(a) - shiftStartMinutes(b))[0];
  return { current, next };
}
