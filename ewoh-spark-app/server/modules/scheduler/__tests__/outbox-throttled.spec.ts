// outbox-throttled.spec.ts — C4：enqueueThrottled 合并窗口节流契约测试
// 覆盖：
//   - 窗口内同 eventType+entityId 已有 pending → 覆盖 payload（不新增行）
//   - 窗口外/无 pending → 正常 enqueue 新增
//   - 跨实体互不影响（独立窗口）
//   - 同形 entityId 不跨租户合并（orgId 是合并边界）
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
  entityType?: string | null;
  entityVersion?: number | null;
  orgId?: string | null;
}

/**
 * fake db：where 按注入的过滤函数模拟（真实 DB 的 eventType/entityId/status/createdAt 条件）。
 * NESP-008（2026-08-17）：update 路径同样应用 whereFilter（此前恒返回 rows[0]，
 * 无命中时 Object.assign(undefined) 崩溃且与真实 UPDATE ... WHERE 语义漂移）；
 * select/update 共用同一过滤，模拟真实 WHERE 四条件。
 */
function makeOutbox(rows: Row[], whereFilter?: (r: Row) => boolean) {
  let seq = rows.length;
  const applyFilter = () => rows.filter(whereFilter ?? (() => false));
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => applyFilter().slice(0, 1),
        }),
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            const matched = applyFilter();
            for (const row of matched) Object.assign(row, patch);
            return matched;
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          // B1：真实 DB 中 sequence 未显式传入时由 ewoh_outbox_sequence_seq DEFAULT 生成；
          // fake db 模拟该行为（v.sequence 为 undefined 时自增生成）。
          const row: Row = {
            id: `id-${++seq}`,
            ...v,
            payloadJson: v.payloadJson,
            sequence: v.sequence ?? seq,
          };
          rows.push(row);
          return [row];
        },
      }),
    }),
  };
  const svc = new OutboxService(db as never);
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
          orgId: 'org1',
        },
      ],
      (r) => r.eventType === 'resource.state_changed' && r.entityId === 'res-1' && r.status === 'pending' && r.orgId === 'org1',
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

  it('同类型同实体但不同 org 的 pending 事件 → 不跨租户合并', async () => {
    const now = new Date();
    const { svc, rows } = makeOutbox(
      [
        {
          id: 'r1',
          eventType: 'resource.state_changed',
          entityId: 'res-1',
          status: 'pending',
          createdAt: now,
          payloadJson: { state: 'busy', org: 'org1' },
          sequence: 1,
          orgId: 'org1',
        },
      ],
      (r) => r.eventType === 'resource.state_changed' && r.entityId === 'res-1' && r.status === 'pending' && r.orgId === 'org2',
    );
    const out = await svc.enqueueThrottled(
      'resource.state_changed',
      'res-1',
      { state: 'idle', org: 'org2' },
      'org2',
      5000,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].payloadJson).toEqual({ state: 'busy', org: 'org1' });
    expect(out.orgId).toBe('org2');
    expect(out.payload).toEqual({ state: 'idle', org: 'org2' });
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

describe('B1 enqueue sequence 由 DB DEFAULT 生成（原子，替代 SELECT MAX+1）', () => {
  it('不传 sequence → 省略该字段（fake db 模拟 DB DEFAULT 生成）', async () => {
    const { svc, rows } = makeOutbox([], () => false);
    const before = rows.length;
    const out = await svc.enqueue('test.type', 'e-1', { k: 1 }, 'org1');
    expect(rows.length).toBe(before + 1);
    expect(out.sequence).toBeGreaterThan(0); // DB DEFAULT 生成了真实 sequence
    expect(out.entityId).toBe('e-1');
    expect(out.eventType).toBe('test.type');
  });

  it('显式传 sequence → 兼容路径保留（不覆盖调用方指定值）', async () => {
    const { svc, rows } = makeOutbox([], () => false);
    const out = await svc.enqueue('test.type', 'e-2', { k: 2 }, 'org1', 42);
    expect(out.sequence).toBe(42);
    expect(rows).toHaveLength(1);
  });
});

describe('P3-T2: enqueue 透传 SSE envelope 字段（snapshotVersion/planId/occurredAt）', () => {
  it('opts 携带 envelope 字段 → 写入 payload（SSE 端从 payload 读取）', async () => {
    const { svc, rows } = makeOutbox([], () => false);
    const occurred = '2026-08-09T10:00:00.000Z';
    await svc.enqueue(
      'conflict.detected',
      'CFL-1',
      { conflictId: 'CFL-1', type: 'device_offline' },
      'org1',
      undefined,
      {
        entityType: 'conflict',
        snapshotVersion: 'WS-20260809-0001',
        planId: 'PLAN-A',
        occurredAt: occurred,
      },
    );
    const row = rows[0];
    expect(row.payloadJson).toEqual({
      conflictId: 'CFL-1',
      type: 'device_offline',
      snapshotVersion: 'WS-20260809-0001',
      planId: 'PLAN-A',
      occurredAt: occurred,
    });
    expect(row.entityType).toBe('conflict');
  });

  it('opts 未携带 envelope 字段 → payload 保持原样（不注入 null）', async () => {
    const { svc, rows } = makeOutbox([], () => false);
    await svc.enqueue('plan.created', 'PLAN-1', { planId: 'PLAN-1' }, 'org1');
    expect(rows[0].payloadJson).toEqual({ planId: 'PLAN-1' });
  });
});
