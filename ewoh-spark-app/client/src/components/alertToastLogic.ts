// alertToastLogic.ts — L3 告警聚合纯函数（node 可测）。
//
// L3 风暴时同一设备在短窗口内可能连续触发多条事件；逐条 toast 会刷屏。
// 本模块把近窗口内的 L3 事件按设备聚合为「设备 → 最新事件 + 计数」，
// UI 只弹一张聚合卡（标题/设备/计数），处置与查看均作用于最新事件。

import type { EventInfo } from '@shared/api.interface';

export interface AggregatedL3 {
  deviceId: string | null;
  /** 聚合键（deviceId 为空时归入「未知设备」）。 */
  deviceLabel: string;
  count: number;
  latest: EventInfo;
}

const UNKNOWN_DEVICE_LABEL = '未知设备';

export function aggregateL3(
  events: EventInfo[] | undefined,
  nowMs: number,
  windowMs: number,
): AggregatedL3[] {
  if (!events || events.length === 0) return [];
  const cutoff = nowMs - windowMs;
  const inWindow = events.filter((e) => {
    if (e.severity !== 'L3') return false;
    if (!e.createdAt) return false;
    return new Date(e.createdAt).getTime() >= cutoff;
  });

  const byDevice = new Map<string, { list: EventInfo[]; latest: EventInfo }>();
  for (const ev of inWindow) {
    const key = ev.deviceId || UNKNOWN_DEVICE_LABEL;
    const bucket = byDevice.get(key);
    if (!bucket) {
      byDevice.set(key, { list: [ev], latest: ev });
      continue;
    }
    bucket.list.push(ev);
    if (new Date(ev.createdAt as string).getTime() > new Date(bucket.latest.createdAt as string).getTime()) {
      bucket.latest = ev;
    }
  }

  const aggregated: AggregatedL3[] = [];
  for (const [key, bucket] of byDevice) {
    aggregated.push({
      deviceId: key === UNKNOWN_DEVICE_LABEL ? null : key,
      deviceLabel: key,
      count: bucket.list.length,
      latest: bucket.latest,
    });
  }
  // 最新事件时间降序（最紧迫在前）
  aggregated.sort(
    (a, b) =>
      new Date(b.latest.createdAt as string).getTime() -
      new Date(a.latest.createdAt as string).getTime(),
  );
  return aggregated;
}
