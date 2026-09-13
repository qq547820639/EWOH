/**
 * device-responsibility.ts — 设备责任人的契约与"提醒该叫谁"的判定（NO-49a，纯函数）。
 *
 * 为什么需要：安灯/升级提醒一直发到**固定角色**（dispatcher / workshop_lead / safety_admin）。
 * 现实里"这台设备是谁的"是车间的基本事实：设备责任人最清楚现场情况，也最该第一时间被叫到。
 * 缺这层数据时平台只能广播，噪音大、还常常叫不到人。
 *
 * 本模块只做两件事（都可单测、无 IO）：
 *   1. 职责词表（owner/operator/maintainer）与中文文案；
 *   2. 把"责任关系 + 人员→账号绑定情况"（由服务层查库得到）换算成**通知收件人**，
 *      并把"有责任关系但没有绑定账号"的人**如实报成缺口**——不假装通知到了（原则 7）。
 */

export const DEVICE_RESPONSIBILITY_KINDS = ['owner', 'operator', 'maintainer'] as const;
export type DeviceResponsibilityKind = (typeof DEVICE_RESPONSIBILITY_KINDS)[number];

const KIND_LABELS: Record<DeviceResponsibilityKind, string> = {
  owner: '设备责任人',
  operator: '操作责任人',
  maintainer: '维护责任人',
};

/** 中文文案；未登记值原样透出（不把未知翻译成已知结论）。 */
export function deviceResponsibilityLabel(kind: string | null | undefined): string {
  const key = String(kind ?? '').trim();
  if (key === '') return '未记录职责';
  return KIND_LABELS[key as DeviceResponsibilityKind] ?? key;
}

export function isDeviceResponsibilityKind(value: unknown): value is DeviceResponsibilityKind {
  return typeof value === 'string' && (DEVICE_RESPONSIBILITY_KINDS as readonly string[]).includes(value);
}

/** 比较用的裸人员 id（`person:<uuid>` 与 `<uuid>` 等价，ADR-006）。 */
export function barePersonRef(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/^person:/, '');
}

export interface DeviceResponsibilityFact {
  deviceId: string;
  /** 规范人员身份（`person:<uuid>` 或裸 uuid）。 */
  personId: string;
  responsibility: DeviceResponsibilityKind;
  /**
   * 责任关系适用的班次（`ewoh_shift.shift_id`）；**空串/缺失 = 全天**（NO-51a）。
   * 同一设备不同班次可以由不同人负责；路由时"本班优先、全天兜底"。
   */
  shiftId?: string | null;
}

/** 全天责任人的班次标识（空串，与数据库列默认值一致）。 */
export const ALL_SHIFT = '';

export interface AlertRecipientPlan {
  /**
   * 点名到人的收件人（recipientId = 登录账号 id）。
   * `matchedBy` 说明这个人是**怎么被选中的**：`current_shift`（本班责任人）/
   * `all_shift`（全天责任人）/ `shift_unknown`（当前班次未知，只能按全天兜底）。
   */
  users: Array<{
    recipientType: 'user';
    recipientId: string;
    personId: string;
    responsibility: DeviceResponsibilityKind;
    matchedBy: 'current_shift' | 'all_shift' | 'shift_unknown';
  }>;
  /** 同一账号被多位责任人共用时只发一条（去重后按账号排序，保证幂等键稳定）。 */
  dedupedUserIds: string[];
  /**
   * 有责任关系但**没有绑定登录账号**的人（缺口，如实报出）。
   * 现场视角：这些提醒发不出去，需要先补账号绑定，而不是以为"已经通知了"。
   */
  unresolved: Array<{ personId: string; responsibility: DeviceResponsibilityKind }>;
  /** 无任何有效责任关系（提醒只能走角色兜底）。 */
  uncovered: boolean;
  /** 本次判定使用的当前班次（null = 未知/未传）。 */
  shiftId: string | null;
  /** 当前班次未知（没有匹配到任何班次定义）→ 只能按"全天责任人"兜底并如实标注。 */
  shiftUnknown: boolean;
  /**
   * **只覆盖了别的班次**的责任人（本班不在岗）：不当作收件人，但必须报出来——
   * 现场看到"这台设备只有夜班登记了责任人，白班没人管"才能去补（原则 7）。
   */
  outOfShift: Array<{ personId: string; responsibility: DeviceResponsibilityKind; shiftId: string }>;
}

/**
 * 纯函数：责任关系 + 账号绑定 → 提醒收件人计划。
 *
 * @param facts 该设备的有效责任关系（服务层按 `active=true` 读出）
 * @param accountByPerson 人员 id（裸）→ 登录账号 id；查不到即视为"无绑定账号"
 */
export function planResponsibilityRecipients(
  facts: readonly DeviceResponsibilityFact[],
  accountByPerson: ReadonlyMap<string, string>,
  options: { currentShiftId?: string | null } = {},
): AlertRecipientPlan {
  const rawShift = String(options.currentShiftId ?? '').trim();
  const shiftId = rawShift === '' ? null : rawShift;
  const shiftUnknown = shiftId === null;

  const users: AlertRecipientPlan['users'] = [];
  const unresolved: AlertRecipientPlan['unresolved'] = [];
  const outOfShift: AlertRecipientPlan['outOfShift'] = [];
  const seenAccounts = new Set<string>();
  const seenPersons = new Set<string>();

  /** 责任关系与本班次的关系：本班 / 全天 / 别的班。 */
  const scopeOf = (fact: DeviceResponsibilityFact): 'current' | 'all' | 'other' => {
    const factShift = String(fact.shiftId ?? '').trim();
    if (factShift === '') return 'all';
    if (shiftId !== null && factShift === shiftId) return 'current';
    return 'other';
  };

  // 本班优先、全天兜底：同一人只发一条（先到先得，因此顺序决定 matchedBy）。
  const ordered = [...facts].sort((a, b) => {
    const rank = (fact: DeviceResponsibilityFact) =>
      scopeOf(fact) === 'current' ? 0 : scopeOf(fact) === 'all' ? 1 : 2;
    return rank(a) - rank(b);
  });

  for (const fact of ordered) {
    const scope = scopeOf(fact);
    if (scope === 'other') {
      outOfShift.push({
        personId: String(fact.personId),
        responsibility: fact.responsibility,
        shiftId: String(fact.shiftId ?? ''),
      });
      continue;
    }
    const personKey = barePersonRef(fact.personId);
    if (personKey === '' || seenPersons.has(personKey)) continue;
    seenPersons.add(personKey);
    const account = String(accountByPerson.get(personKey) ?? '').trim();
    if (account === '') {
      unresolved.push({ personId: String(fact.personId), responsibility: fact.responsibility });
      continue;
    }
    if (seenAccounts.has(account)) continue;
    seenAccounts.add(account);
    users.push({
      recipientType: 'user',
      recipientId: account,
      personId: String(fact.personId),
      responsibility: fact.responsibility,
      matchedBy: scope === 'current' ? 'current_shift' : shiftUnknown ? 'shift_unknown' : 'all_shift',
    });
  }

  users.sort((a, b) => a.recipientId.localeCompare(b.recipientId));
  unresolved.sort((a, b) => a.personId.localeCompare(b.personId));
  outOfShift.sort((a, b) => a.personId.localeCompare(b.personId));
  return {
    users,
    dedupedUserIds: users.map((u) => u.recipientId),
    unresolved,
    // 只有"别的班次"的责任人不算覆盖——那是缺口，不是责任人。
    uncovered: facts.length === 0 || (users.length === 0 && unresolved.length === 0 && outOfShift.length > 0),
    shiftId,
    shiftUnknown,
    outOfShift,
  };
}

/* ── NO-52a：交接班前的"责任人核对"（快照 + 覆盖率）────────────────────── */

export interface ResponsibilityCoverageDevice {
  deviceId: string;
  /** 该设备在本班次下的责任人（本班 + 全天；已绑定账号与否都在这里）。 */
  holders: Array<{ personId: string; responsibility: DeviceResponsibilityKind; matchedBy: 'current_shift' | 'all_shift' }>;
  /** 只覆盖别的班次的责任人（本班不在岗）。 */
  outOfShift: Array<{ personId: string; responsibility: DeviceResponsibilityKind; shiftId: string }>;
  /** 是否有本班/全天责任人。 */
  covered: boolean;
}

export interface ResponsibilityCoverageSnapshot {
  shiftId: string | null;
  /** 当前/目标班次未知（没有匹配到班次定义）→ 覆盖率判定只按全天口径，必须显式标注。 */
  shiftUnknown: boolean;
  /** 纳入核对的设备数（= 有责任关系登记的设备）。 */
  total: number;
  covered: number;
  /** 有责任关系但**本班没人**（缺本班且缺全天）。 */
  gaps: number;
  /** 一条责任关系都没登记的设备数（更宽的缺口，另行统计）。 */
  uncovered: number;
  devices: ResponsibilityCoverageDevice[];
  notes: string[];
}

/**
 * 纯函数：把"每台设备的 active 责任关系"折算成给定班次的核对快照。
 *
 * 口径（与提醒路由一致，避免"页面说有人、提醒发不到"）：
 *   · `covered` = 该设备存在"本班"或"全天"责任人（**不要求已绑定账号**——
 *     账号缺口由另一条链路口径负责，见 `planResponsibilityRecipients.unresolved`）；
 *   · 只有别的班次的责任人 → `gaps`（现场要看到"本班没人"）；
 *   · `shiftUnknown=true` 时，"班次责任人"无法判定为本班，只按全天口径计覆盖。
 */
export function summarizeResponsibilityCoverage(
  factsByDevice: ReadonlyMap<string, readonly DeviceResponsibilityFact[]>,
  options: { shiftId?: string | null; uncoveredDeviceIds?: readonly string[] } = {},
): ResponsibilityCoverageSnapshot {
  const rawShift = String(options.shiftId ?? '').trim();
  const shiftId = rawShift === '' ? null : rawShift;
  const shiftUnknown = shiftId === null;
  const devices: ResponsibilityCoverageDevice[] = [];
  let covered = 0;
  let gaps = 0;

  for (const [deviceId, facts] of factsByDevice) {
    const holders: ResponsibilityCoverageDevice['holders'] = [];
    const outOfShift: ResponsibilityCoverageDevice['outOfShift'] = [];
    for (const fact of facts) {
      const factShift = String(fact.shiftId ?? '').trim();
      if (factShift === '') {
        holders.push({ personId: fact.personId, responsibility: fact.responsibility, matchedBy: 'all_shift' });
      } else if (shiftId !== null && factShift === shiftId) {
        holders.push({ personId: fact.personId, responsibility: fact.responsibility, matchedBy: 'current_shift' });
      } else {
        outOfShift.push({ personId: fact.personId, responsibility: fact.responsibility, shiftId: factShift });
      }
    }
    const isCovered = holders.length > 0;
    if (isCovered) covered += 1;
    else gaps += 1;
    devices.push({ deviceId, holders, outOfShift, covered: isCovered });
  }

  devices.sort((a, b) => Number(a.covered) - Number(b.covered) || a.deviceId.localeCompare(b.deviceId));
  return {
    shiftId,
    shiftUnknown,
    total: devices.length,
    covered,
    gaps,
    uncovered: (options.uncoveredDeviceIds ?? []).length,
    devices,
    notes: [
      '口径：纳入核对的是**已登记责任关系**的设备；"覆盖"= 存在本班或全天责任人（不要求已绑定登录账号）。',
      shiftUnknown
        ? '当前/目标班次未知（没有匹配到班次定义）：只能按"全天责任人"口径判定，班次责任人无法认定为本班。'
        : '覆盖判定按给定班次：本班责任人优先、全天责任人兜底；只有别的班次责任人时计为缺口。',
      '无账号绑定的责任人仍会在提醒侧进缺口清单（两处口径不同：这里看"有没有人负责"，提醒侧看"发不发得出去"）。',
    ],
  };
}
