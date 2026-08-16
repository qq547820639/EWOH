/**
 * fake-world-db.ts — WorldCursorService drizzle 链式假库（ADR-079，§31 单一测试助手）。
 *
 * 语义覆盖 getSnapshot/getDelta 所需最小世界事实：
 *  - delta insert（seq 自增）→ delta 行；
 *  - snapshot insert（snapshotVersion/entityCount/checksum/payload）；
 *  - snapshot select（最新一条，按 snapshotVersion 降序 limit 1）；
 *  - delta select（seq 阈值：从条件 queryChunks 提取数值参数，> max）。
 * 供 world-cursor.service.spec 与 scenario-packages.spec（SP-05）共用。
 */
import {
  ewohWorldSnapshotCursor,
  ewohWorldDeltaLog,
} from '@server/database/schema';

interface WorldDb {
  db: unknown;
  deltaRows: Array<Record<string, unknown>>;
  snapshotRows: Array<Record<string, unknown>>;
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>;
}

function collectNums(node: unknown, out: Set<number>): void {
  if (node == null) return;
  if (typeof node === 'number') {
    out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectNums(x, out);
    return;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('value' in obj && typeof obj.value === 'number') out.add(obj.value);
    if ('queryChunks' in obj) {
      for (const c of obj.queryChunks as unknown[]) collectNums(c, out);
    }
  }
}

export function makeWorldDb(): WorldDb {
  const deltaRows: Array<Record<string, unknown>> = [];
  const snapshotRows: Array<Record<string, unknown>> = [];
  const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  let seqCounter = 0;

  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row });
        if (table === ewohWorldDeltaLog) {
          seqCounter += 1;
          // 服务读面字段形状（snake_case）——seq/entity_id/delta_type/payload。
          deltaRows.push({
            seq: seqCounter,
            snapshot_version: (row as Record<string, unknown>).snapshotVersion ?? 0,
            entity_id: (row as Record<string, unknown>).entityId,
            delta_type: (row as Record<string, unknown>).deltaType,
            payload: (row as Record<string, unknown>).payload,
          });
        }
        if (table === ewohWorldSnapshotCursor) {
          // 服务读面字段形状（snake_case）。
          snapshotRows.push({
            snapshot_version: (row as Record<string, unknown>).snapshotVersion,
            payload: (row as Record<string, unknown>).payload,
            entity_count: (row as Record<string, unknown>).entityCount,
          });
        }
        return Promise.resolve([]);
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const q: any = Promise.resolve(
          table === ewohWorldSnapshotCursor
            ? snapshotRows.slice(-1)
            : deltaRows.slice(),
        );
        q.where = (cond: unknown) => {
          if (table === ewohWorldDeltaLog) {
            const nums = new Set<number>();
            collectNums(cond, nums);
            const threshold = nums.size > 0 ? Math.max(...nums) : 0;
            const filtered = deltaRows.filter((r) => Number(r.seq ?? 0) > threshold);
            const w: any = Promise.resolve(filtered);
            w.orderBy = () => w;
            w.limit = (n: number) => Promise.resolve(filtered.slice(0, n));
            return w;
          }
          const w: any = Promise.resolve(snapshotRows.slice(-1));
          w.orderBy = () => w;
          w.limit = () => Promise.resolve(snapshotRows.slice(-1));
          return w;
        };
        q.orderBy = () => q;
        q.limit = (n: number) =>
          Promise.resolve(
            table === ewohWorldSnapshotCursor
              ? snapshotRows.slice(-1)
              : deltaRows.slice(0, n),
          );
        return q;
      }),
    })),
  };
  return { db, deltaRows, snapshotRows, inserts };
}
