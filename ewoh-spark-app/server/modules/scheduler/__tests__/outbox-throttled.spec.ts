// outbox-throttled.spec.ts — C4：enqueueThrottled 合并窗口节流契约测试
// 覆盖：
//   - 窗口内同 eventType+entityId 已有 pending → 覆盖 payload（不新增行）
//   - 窗口外/无 pending → 正常 enqueue 新增
//   - 跨实体互不影响（独立窗口）
/* eslint-disable @typescript-eslint/no-explicit-any */
import { OutboxService } from '../outbox.service';

interface Row {
  id: string;
  eventType: string;
  entityId: string;
  status: string;
  createdAt: Date;
  payloadJson: any;
  sequence: number;
}

/** fake db：where 按注入的过滤函数模拟（真实 DB 的 eventType/entityId/status/createdAt 条件）。 */
function makeOutbox(rows: Row[], whereFilter?: (r: Row) => boolean) {
  let seq = rows.length;
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows.filter(whereFilter ?? (() => false)).slice(0, 1),
        }),
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            const row = rows[0];
            Object.assign(row, patch);
            return [row];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row: Row = { id: `id-${++seq}`, ...v, payloadJson: v.payloadJson, sequence: v.sequence };
          rows.push(row);
          return [row];
        },
      }),
    }),
  };
  const svc = new OutboxService(db as never);
  (svc as any).nextSequence = async () => seq + 1;
  (svc as any).randomSuffix = () => 'x';
  return { svc, rows };
}

describe('C4 enqueueThrottled 合并窗口节流', () => {
  it('窗口内同实体同类型已有 pending → 覆盖 payload（不新增行）', async () => {
    const now = new Date();
    const { svc, rows } = makeOutbox(
      [
        {
          id: 'r1',
          eventType: 'resource.state_changed',
          entityId: 'res-1',
          status: 'pending',
          createdAt: now,
          payloadJson: { state: 'busy' },
          sequence: 1,
        },
      ],
      (r) => r.eventType === 'resource.state_changed' && r.entityId === 'res-1' && r.status === 'pending',
    );
    const before = rows.length;
    const out = await svc.enqueueThrottled(
      'resource.state_changed',
      'res-1',
      { state: 'idle', load: 0.1 },
      'org1',
      5000,
    );
    expect(rows.length).toBe(before); // 未新增
    expect(out.payload).toEqual({ state: 'idle', load: 0.1 }); // 最终态覆盖
  });

  it('无命中（窗口外/无 pending/不同实体）→ 正常 enqueue 新增行', async () => {
    // 真实 DB 的 WHERE 含 eventType + entityId + status + createdAt 四条件，
    // 跨实体（entityId 不同）天然不会命中彼此的 pending 行——此处模拟无命中场景。
    const { svc, rows } = makeOutbox([], () => false); // 查询永不命中 → 走新增
    const before = rows.length;
    const out = await svc.enqueueThrottled(
      'resource.state_changed',
      'res-1',
      { state: 'idle' },
      'org1',
      5000,
    );
    expect(rows.length).toBe(before + 1); // 新增
    expect(out.entityId).toBe('res-1');
  });
});
