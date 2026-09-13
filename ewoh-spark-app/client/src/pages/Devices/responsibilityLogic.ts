/**
 * responsibilityLogic.ts — 设备责任人展示口径（NO-50a，纯函数）。
 *
 * 三条口径必须钉死（与后端契约一致）：
 *   1. **职责固定三种**（owner/operator/maintainer），页面按固定顺序展示，
 *      不做"智能合并"——班组长要一眼看出**哪个职责还空着**；
 *   2. **缺失显式**：没有登记责任人的设备显示"未登记责任人（提醒只能发到角色）"，
 *      绝不显示空白让人以为"这事不用管"（原则 7）；
 *   3. **不猜名字**：人员 id 解析不到姓名时原样显示 id（与更正对话框同一纪律）。
 */
import type { DeviceResponsibilityKind, DeviceResponsibilityRecord } from '@client/src/api/deviceResponsibility';

export const RESPONSIBILITY_ORDER: DeviceResponsibilityKind[] = ['owner', 'operator', 'maintainer'];

const KIND_LABELS: Record<DeviceResponsibilityKind, string> = {
  owner: '设备责任人',
  operator: '操作责任人',
  maintainer: '维护责任人',
};

export function responsibilityLabel(kind: string): string {
  return KIND_LABELS[kind as DeviceResponsibilityKind] ?? String(kind ?? '未记录职责');
}

export interface ResponsibilitySlot {
  kind: DeviceResponsibilityKind;
  label: string;
  /** 适用班次（空串 = 全天）；未知班次原样透出（NO-51a）。 */
  shiftId: string;
  /** 班次展示文案："全天" 或 "班次 <id>"。 */
  shiftLabel: string;
  /** 已登记的人员（未登记 → null）。 */
  personId: string | null;
  /** 展示文案：姓名（id）或 id；未登记 → null。 */
  personLabel: string | null;
  note: string | null;
  activatedAt: string | null;
}

export interface DeviceResponsibilityView {
  deviceId: string;
  slots: ResponsibilitySlot[];
  /** 已登记职责数（0–3）。 */
  covered: number;
  /** 未登记职责数。 */
  missing: number;
  /** 表格列展示文案：已登记 → "张三（设备责任人）等 2 项"；未登记 → "未登记责任人"。 */
  summaryLabel: string;
  /** 是否需要提醒班组长（存在未登记职责）。 */
  needsAttention: boolean;
  /** 是否完全没有责任人（提醒只能走角色兜底）——比"缺一项"更严重。 */
  uncovered: boolean;
}

const barePerson = (value: string | null | undefined): string =>
  String(value ?? '').trim().replace(/^person:/, '');

/**
 * 纯函数：某台设备的责任关系 → 展示视图。
 *
 * @param activeFacts 该设备的 active 责任关系（服务端已保证"同一职责至多一位"）
 * @param nameByPersonId 人员 id（裸）→ 姓名；查不到就显示 id
 */
export function buildDeviceResponsibilityView(
  deviceId: string,
  activeFacts: readonly DeviceResponsibilityRecord[],
  nameByPersonId: ReadonlyMap<string, string> = new Map(),
): DeviceResponsibilityView {
  const byKind = new Map<DeviceResponsibilityKind, DeviceResponsibilityRecord>();
  for (const fact of activeFacts) {
    if (fact.active === false) continue;
    if (!RESPONSIBILITY_ORDER.includes(fact.responsibility)) continue;
    if (!byKind.has(fact.responsibility)) byKind.set(fact.responsibility, fact);
  }
  const slots: ResponsibilitySlot[] = RESPONSIBILITY_ORDER.map((kind) => {
    const fact = byKind.get(kind) ?? null;
    const bare = fact ? barePerson(fact.personId) : '';
    const name = bare ? String(nameByPersonId.get(bare) ?? '').trim() : '';
    return {
      kind,
      label: KIND_LABELS[kind],
      shiftId: String(fact?.shiftId ?? ''),
      shiftLabel: String(fact?.shiftId ?? '').trim() === '' ? '全天' : `班次 ${String(fact?.shiftId)}`,
      personId: fact ? String(fact.personId) : null,
      personLabel: fact ? (name ? `${name}（${bare}）` : bare) : null,
      note: fact?.note ?? null,
      activatedAt: fact?.activatedAt ?? null,
    };
  });
  const covered = slots.filter((slot) => slot.personId !== null).length;
  const missing = slots.length - covered;
  const first = slots.find((slot) => slot.personLabel !== null) ?? null;
  return {
    deviceId,
    slots,
    covered,
    missing,
    summaryLabel:
      covered === 0
        ? '未登记责任人（提醒只能发到角色）'
        : covered === 1 && first
          ? // 单条：带上班次（现场要知道这人是哪个班的；"全天"不加噪）
            `${first.personLabel}（${first.label}${first.shiftId ? `·${first.shiftLabel}` : ''}）`
          : `${first?.personLabel ?? ''}（${first?.label ?? ''}${
              first?.shiftId ? `·${first?.shiftLabel}` : ''
            }）等 ${covered} 项`,
    needsAttention: missing > 0,
    uncovered: covered === 0,
  };
}

/** 表格用的映射：deviceId → 视图（一次遍历，避免每行重算）。 */
export function buildResponsibilityViews(
  facts: readonly DeviceResponsibilityRecord[],
  nameByPersonId: ReadonlyMap<string, string> = new Map(),
): Map<string, DeviceResponsibilityView> {
  const byDevice = new Map<string, DeviceResponsibilityRecord[]>();
  for (const fact of facts) {
    const key = String(fact.deviceId ?? '');
    if (key === '') continue;
    const list = byDevice.get(key) ?? [];
    list.push(fact);
    byDevice.set(key, list);
  }
  const views = new Map<string, DeviceResponsibilityView>();
  for (const [deviceId, list] of byDevice) {
    views.set(deviceId, buildDeviceResponsibilityView(deviceId, list, nameByPersonId));
  }
  return views;
}

/** 没有责任关系的设备 → 视图（未登记），供表格统一渲染。 */
export function uncoveredView(deviceId: string): DeviceResponsibilityView {
  return buildDeviceResponsibilityView(deviceId, []);
}
