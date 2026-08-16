// alertToastLogic.ts — critical 告警聚合纯函数（node 可测；ADR-027 规范词表，旧词表 L3=最严重）。
//
// critical 风暴时同一设备在短窗口内可能连续触发多条事件；逐条 toast 会刷屏。
// 本模块把近窗口内的 critical 事件按设备聚合为「设备 → 最新事件 + 计数」，
// UI 只弹一张聚合卡（标题/设备/计数），处置与查看均作用于最新事件。

import type { EventInfo } from '@shared/api.interface';

export interface AggregatedCriticalEvents {
  deviceId: string | null;
  /** 聚合键（deviceId 为空时归入「未知设备」）。 */
  deviceLabel: string;
  count: number;
  latest: EventInfo;
}

const UNKNOWN_DEVICE_LABEL = '未知设备';

export function aggregateCriticalEvents(
  events: EventInfo[] | undefined,
  nowMs: number,
  windowMs: number,
): AggregatedCriticalEvents[] {
  if (!events || events.length === 0) return [];
  const cutoff = nowMs - windowMs;
  const inWindow = events.filter((e) => {
    if (e.severity !== 'critical') return false;
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

  const aggregated: AggregatedCriticalEvents[] = [];
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
