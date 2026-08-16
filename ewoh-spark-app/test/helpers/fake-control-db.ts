/**
 * fake-control-db.ts — ControlService drizzle 链式假库（ADR-077，§31 单一测试助手）。
 *
 * 供 control.service.spec 与 scenario-packages.spec（SP-04）共用：
 * insert（三表行收集 + 回读）/ select（行回读，忽略条件）/ update
 * （patch 收集 + 命令/请求行回写，receipts/revoke 终态读回依赖）。
 */
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
} from '@server/database/schema';

export interface FakeControlDb {
  db: unknown;
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown>; cond: unknown }>;
  requestRows: unknown[];
  commandRows: unknown[];
  resultRows: unknown[];
}

export function makeControlDb(seed: {
  requests?: unknown[];
  commands?: unknown[];
} = {}): FakeControlDb {
  const requestRows: unknown[] = [...(seed.requests ?? [])];
  const commandRows: unknown[] = [...(seed.commands ?? [])];
  const resultRows: unknown[] = [];
  const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown>; cond: unknown }> = [];
  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row });
        if (table === ewohControlRequest) requestRows.push(row);
        if (table === ewohControlCommand) commandRows.push(row);
        if (table === ewohControlResult) resultRows.push(row);
        return { returning: jest.fn().mockResolvedValue([row]) };
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const rows =
          table === ewohControlRequest
            ? requestRows
            : table === ewohControlCommand
              ? commandRows
              : table === ewohControlResult
                ? resultRows
                : [];
        const q: any = Promise.resolve(rows);
        q.where = () => q;
        q.orderBy = () => q;
        q.limit = () => q;
        return q;
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          updates.push({ table, set: patch, cond });
          if (table === ewohControlCommand) {
            for (const row of commandRows as Record<string, unknown>[]) {
              Object.assign(row, patch);
            }
          }
          if (table === ewohControlRequest) {
            for (const row of requestRows as Record<string, unknown>[]) {
              Object.assign(row, patch);
            }
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  };
  return { db, inserts, updates, requestRows, commandRows, resultRows };
}
