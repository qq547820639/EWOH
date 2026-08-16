import { TracingService } from '../../../server/modules/tracing/tracing.service';
import { ewohTraceSpan, ewohEvent, ewohAuditLog } from '@server/database/schema';

describe('TracingService', () => {
  it('records entries and returns newest first', () => {
    const service = new TracingService(5);
    for (let index = 1; index <= 6; index += 1) {
      service.record({
        traceId: `trace-${index}`,
        spanId: `span-${index}`,
        method: 'GET',
        path: '/api/test',
        status: 200,
        durationMs: 1,
        startedAt: '2026-08-03T00:00:00Z',
        finishedAt: '2026-08-03T00:00:01Z',
      });
    }
    const traces = service.list();
    expect(traces).toHaveLength(5);
    expect(traces[0].traceId).toBe('trace-6');
    expect(traces[4].traceId).toBe('trace-2');
  });

  it('limits list output', () => {
    const service = new TracingService();
    for (let index = 0; index < 10; index += 1) {
      service.record({
        traceId: `t${index}`,
        spanId: `s${index}`,
        method: 'GET',
        path: '/',
        status: 200,
        durationMs: 1,
        startedAt: '',
        finishedAt: '',
      });
    }
    expect(service.list(3)).toHaveLength(3);
  });

  // ── NO-10a（ADR-022）：span 持久化 + 三面缝合 ─────────────────────────────

  function makeDb(spanRows: Array<Record<string, unknown>> = []) {
    const spans = [...spanRows];
    function sqlText(query: unknown): string {
      const q = query as { queryChunks?: unknown[] };
      if (Array.isArray(q?.queryChunks)) {
        return q.queryChunks
          .map((c) => {
            if (typeof c === 'string') return c;
            const chunk = c as { value?: unknown };
            if (Array.isArray(chunk?.value)) return chunk.value.filter((x) => typeof x === 'string').join('');
            return '';
          })
          .join('');
      }
      return '';
    }
    function collectTraceIds(node: unknown, set: Set<string>, seen: WeakSet<object>): void {
      if (node == null || typeof node !== 'object') return;
      if (seen.has(node as object)) return;
      seen.add(node as object);
      if (Array.isArray(node)) {
        for (const x of node) collectTraceIds(x, set, seen);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'value' && typeof value === 'string' && value.startsWith('trace-')) set.add(value);
        else collectTraceIds(value, set, seen);
      }
    }
    function matches(cond: unknown, row: Record<string, unknown>): boolean {
      const set = new Set<string>();
      collectTraceIds(cond, set, new WeakSet());
      if (set.size === 0) return true;
      return set.has(String(row.traceId));
    }
    function thenable(data: unknown[]): unknown {
      return {
        then: (resolve: (v: unknown[]) => void) => resolve(data),
        orderBy: jest.fn(() => thenable(data)),
        limit: jest.fn(() => thenable(data.slice(0, 100))),
      };
    }
    const db = {
      execute: jest.fn(async () => []),
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => {
          // ADR-078：drizzle 链式假库（span/event/audit 三面 + count 直接 await）。
          const data: unknown[] =
            table === ewohTraceSpan
              ? spans
              : table === ewohEvent
                ? [{ event_id: 'EVT-1', event_type: 'WorkOrderCreated', correlation_id: 'trace-1' }]
                : table === ewohAuditLog
                  ? [{ action: 'agent.command.executed', request_id: 'trace-1' }]
                  : [];
          const q: any = Promise.resolve(data);
          q.where = (cond: unknown) => {
            if (table === ewohTraceSpan) {
              return thenable(spans.filter((r) => matches(cond, r)));
            }
            return thenable(data);
          };
          return q;
        }),
      })),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          if (table === ewohTraceSpan) spans.push(row);
          return { returning: jest.fn(async () => [row]) };
        }),
      })),
      delete: jest.fn(() => ({
        where: jest.fn(async () => []),
      })),
    };
    return { db, spans };
  }

  it('NO-10a：persistSpan 落库（含 lineage）；无 db 时 no-op 不抛', async () => {
    const { db, spans } = makeDb();
    const service = new TracingService(undefined, db as never);
    await service.persistSpan({
      traceId: 'trace-1',
      spanId: 'span-1',
      method: 'GET',
      path: '/api/workorders',
      status: 201,
      durationMs: 12,
      startedAt: '2026-08-16T08:00:00Z',
      finishedAt: '2026-08-16T08:00:01Z',
      orgId: 'org-a',
      requestUser: 'u1',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.traceId).toBe('trace-1');
    expect(spans[0]?.orgId).toBe('org-a');
    expect(spans[0]?.requestUser).toBe('u1');

    const noDb = new TracingService();
    await expect(
      noDb.persistSpan({ traceId: 't', spanId: 's', method: 'GET', path: '/', status: 200, durationMs: 1, startedAt: '', finishedAt: '' }),
    ).resolves.toBeUndefined();
  });

  it('NO-10a：persistSpan 失败留痕不抛出（best-effort 追踪索引）', async () => {
    const db = {
      insert: jest.fn(() => {
        throw new Error('db down');
      }),
      delete: jest.fn(),
      execute: jest.fn(),
      select: jest.fn(),
    };
    const service = new TracingService(undefined, db as never);
    await expect(
      service.persistSpan({ traceId: 't', spanId: 's', method: 'GET', path: '/', status: 200, durationMs: 1, startedAt: '', finishedAt: '' }),
    ).resolves.toBeUndefined();
  });

  it('NO-10a：getTrace 三面缝合（spans + events（correlationId）+ audit（request_id））', async () => {
    const { db } = makeDb([
      { traceId: 'trace-1', spanId: 'span-1', path: '/api/workorders', startedAt: new Date() },
    ]);
    const service = new TracingService(undefined, db as never);
    const stitched = await service.getTrace('trace-1');
    expect(stitched.traceId).toBe('trace-1');
    expect(stitched.spans).toHaveLength(1);
    expect(stitched.events).toHaveLength(1);
    expect((stitched.events[0] as Record<string, unknown>).event_type).toBe('WorkOrderCreated');
    expect(stitched.audit).toHaveLength(1);
    expect((stitched.audit[0] as Record<string, unknown>).action).toBe('agent.command.executed');
  });

  it('NO-10a：getTrace 无 db → 内存 span 过滤（兼容退化）', async () => {
    const service = new TracingService();
    service.record({ traceId: 'trace-a', spanId: 's1', method: 'GET', path: '/', status: 200, durationMs: 1, startedAt: '', finishedAt: '' });
    service.record({ traceId: 'trace-b', spanId: 's2', method: 'GET', path: '/', status: 200, durationMs: 1, startedAt: '', finishedAt: '' });
    const stitched = await service.getTrace('trace-a');
    expect(stitched.spans).toHaveLength(1);
    expect((stitched.spans[0] as Record<string, unknown>).traceId).toBe('trace-a');
    expect(stitched.events).toEqual([]);
    expect(stitched.audit).toEqual([]);
  });

  it('NO-10a：enforceBounds 执行 TTL 清理 + 行上限检查（失败留痕不抛）', async () => {
    const { db } = makeDb();
    const service = new TracingService(undefined, db as never);
    await expect(service.enforceBounds()).resolves.toBeUndefined();
    expect(db.delete).toHaveBeenCalled();
    // ADR-078：行上限检查走 drizzle count（execute 不再参与）。
    expect(db.select).toHaveBeenCalled();
  });
});
