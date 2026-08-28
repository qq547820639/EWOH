/**
 * T9 求解器复杂度（审计批次 D）：资源槽位区间索引。
 *
 * 语义等价目标：与原先「每任务从全量槽位数组重建 Map + `.some(intervalsOverlap)`
 * 线性扫描」完全同果——overlap 存在性判定与遍历顺序无关，因此以
 * 「按 start 排序 + 前缀 max(end) + 二分」替换线性扫描不改变任何布尔结果：
 *
 *   overlap(s, [qs,qe)) ⇔ s.start < qe ∧ qs < s.end
 *   （intervalsOverlap 的严格半开语义，heuristic-scheduling-solver.ts）
 *
 *   命中判定：取 rightmost(i: starts[i] < qe)（所有可能相交的区间必在其左侧，
 *   因为 start ≥ qe 的区间不可能满足 s.start < qe），该前缀内存在 qs < end
 *   当且仅当 prefixMaxEnd[i] > qs。
 *
 * 复杂度收益：
 * - 查询 O(log k)（原 O(k) 每候选扫描）；
 * - 插入 O(k)（仅每次「接受一个分配」发生一次，取代原先每任务 O(S_total)
 *   的三 Map 全量重建 → O(T × S_total) 主导项被消除）。
 *
 * 调用方约定：`slots()` 返回内部有序数组（含资源 id 字段，供 eligibility
 * 按 personId/deviceId/stationId 再分组），只读使用、不得变更。
 */

export interface SlotRange {
  readonly start: number;
  readonly end: number;
}

/** 人员槽位（供 eligibility bookedTimeSlots 按 personId 再分组）。 */
export interface PersonSlot extends SlotRange {
  readonly personId: string;
}

/** 设备槽位（供 eligibility bookedDeviceSlots 按 deviceId 再分组）。 */
export interface DeviceSlot extends SlotRange {
  readonly deviceId: string;
}

/** 工位槽位（供 eligibility bookedStationSlots 按 stationId 再分组）。 */
export interface StationSlot extends SlotRange {
  readonly stationId: string;
}

export class SlotIndex<S extends SlotRange> {
  /** 按 start 升序的槽位（含调用方附加字段，如 personId）。 */
  private readonly ordered: S[] = [];
  /** prefixMaxEnd[i] = max(ordered[0..i].end)。 */
  private prefixMaxEnd: number[] = [];

  constructor(slots?: readonly S[]) {
    if (slots && slots.length > 0) {
      this.ordered.push(...slots);
      this.ordered.sort((a, b) => a.start - b.start);
      this.rebuildPrefixMax(0);
    }
  }

  /** 是否存在与 [startMs, endMs) 相交的槽位（与线性 some(intervalsOverlap) 同果）。 */
  hasOverlap(startMs: number, endMs: number): boolean {
    // rightmost i with ordered[i].start < endMs（有序 ⇒ 二分）。
    let lo = 0;
    let hi = this.ordered.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ordered[mid].start < endMs) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return false;
    return this.prefixMaxEnd[idx] > startMs;
  }

  /** 追加一个槽位并维持有序与前缀 max（每次「接受分配」调用一次）。 */
  insert(slot: S): void {
    // lower bound：第一个 start >= slot.start 的位置。
    let lo = 0;
    let hi = this.ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ordered[mid].start < slot.start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.ordered.splice(lo, 0, slot);
    this.rebuildPrefixMax(lo);
  }

  /** 有序槽位（内部数组引用；调用方只读）。 */
  slots(): S[] {
    return this.ordered;
  }

  get size(): number {
    return this.ordered.length;
  }

  /** 从 from 起重建前缀 max(end)。 */
  private rebuildPrefixMax(from: number): void {
    for (let i = from; i < this.ordered.length; i += 1) {
      const prev = i > 0 ? this.prefixMaxEnd[i - 1] : Number.NEGATIVE_INFINITY;
      // splice 插入使 from 起的元素右移一位，整段重算即可保持等长不变式。
      this.prefixMaxEnd[i] = Math.max(prev, this.ordered[i].end);
    }
  }
}
