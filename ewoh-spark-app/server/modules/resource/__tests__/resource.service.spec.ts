/* ResourceService 租户谓词与 issue CAS 回归
 * （R2-SNZ-009 / R2-SNZ-010，2026-08-17 审计整改，闭合 NO-13ag）。
 *
 * R2-SNZ-009：resource 全链读写原先无任何租户谓词——他租户 preorderId
 * 可读、可 issue（扣他租户库存）、可 release（回冲库存）、可用量跨租户
 * 聚合。现全部谓词带 org（global_admin 放行，缺租户 fail-closed 400）。
 * R2-SNZ-010：issue 的 issuedQty 原先「锁外读快照→绝对值覆盖写」，多
 * 实例并发互相覆盖计数——现改增量 + issued_qty CAS，未命中显式拒绝。
 * DB 以链式 fake 替换（单元层不依赖真实 PG）。
 */
/// <reference types="jest" />
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ResourceService } from '../resource.service';
import { ewohResourceBinding, ewohResourcePreorder } from '@server/database/schema';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function leafValues(cond: unknown): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new WeakSet<object>();
  (function walk(node: unknown) {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const el of node) {
        // 嵌套 sql 模板的数字字面量以裸值出现在 chunks 数组（字符串裸值
        // 是 SQL 定界符如 "("，不可收集）。
        if (typeof el === 'number') out.push(el);
        else walk(el);
      }
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value' && (typeof value === 'string' || typeof value === 'number')) {
        out.push(value);
      } else {
        walk(value);
      }
    }
  })(cond);
  return out;
}

interface PreorderStateRow {
  preorderId: string;
  resourceId: string;
  orgId: string;
  quantity: number;
  reservedQty: number;
  issuedQty: number;
  status: string;
}

interface BindingStateRow {
  bindingId: string;
  bindingType: string;
  resourceId: string;
  orgId: string;
  quantity: number;
  status: string;
}

interface FakeState {
  preorders: PreorderStateRow[];
  bindings: BindingStateRow[];
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  casMiss: boolean;
}

function createResourceDb(state: FakeState) {
  const preorderRowVals = (r: PreorderStateRow) => [
    r.orgId,
    r.preorderId,
    r.resourceId,
    r.status,
  ];
  const bindingRowVals = (r: BindingStateRow) => [
    r.orgId,
    r.bindingId,
    r.resourceId,
    r.status,
    r.bindingType,
  ];

  const selectThenable = (rows: Array<Record<string, unknown>>) => ({
    then: (resolve: (v: unknown[]) => void) => resolve(rows),
    limit: jest.fn(() => Promise.resolve(rows.slice(0, 1))),
    orderBy: jest.fn(() => selectThenable(rows)),
  });

  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async () => undefined,
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => ({
            returning: async () => {
              state.inserts.push({ table, values: vals });
              if (table === ewohResourcePreorder) {
                return [
                  {
                    preorder_id: vals.preorderId,
                    resource_id: vals.resourceId,
                    quantity: Number(vals.quantity),
                    reserved_qty: Number(vals.reservedQty),
                    issued_qty: Number(vals.issuedQty ?? 0),
                    status: vals.status,
                  },
                ];
              }
              return [vals];
            },
          }),
        }),
      }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const list = Array.isArray(vals) ? vals : [vals];
        for (const v of list) state.inserts.push({ table, values: v });
        return {
          onConflictDoUpdate: () => ({
            returning: async () => list,
          }),
          then: (resolve: (v: unknown[]) => void) => resolve(list),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          const leaves = leafValues(cond);
          const strings = leaves.map((l) => String(l));
          if (table === ewohResourcePreorder) {
            const matched = state.preorders.filter((r) => {
              const vals = preorderRowVals(r);
              // inArray('pending','issued') 取交集语义：status 值出现即可。
              const statusLeaves: string[] = strings.filter(
                (s) => s === 'pending' || s === 'issued',
              );
              const rest = strings.filter((s) => !statusLeaves.includes(s));
              const restOk = rest.every((s) => vals.includes(s));
              const statusOk =
                statusLeaves.length === 0 ||
                (statusLeaves as string[]).includes(r.status);
              return restOk && statusOk;
            });
            const projected = matched.map((r) => ({
              preorder_id: r.preorderId,
              resource_id: r.resourceId,
              quantity: r.quantity,
              reserved_qty: r.reservedQty,
              issued_qty: r.issuedQty,
              status: r.status,
            }));
            return selectThenable(projected as unknown as Array<Record<string, unknown>>);
          }
          const matched = state.bindings.filter((r) =>
            strings.every((s) => bindingRowVals(r).includes(s)),
          );
          return selectThenable(matched as unknown as Array<Record<string, unknown>>);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            const leaves = leafValues(cond);
            const strings = leaves.filter((l) => typeof l === 'string');
            const numbers = leaves.filter((l) => typeof l === 'number');
            if (table === ewohResourcePreorder) {
              if (state.casMiss) return [];
              const hit = state.preorders.filter(
                (r) =>
                  strings.every((s) => preorderRowVals(r).includes(s)) &&
                  (numbers.length === 0 || numbers.includes(r.issuedQty)),
              );
              for (const r of hit) {
                if (typeof patch.status === 'string') r.status = patch.status;
                const inc = leafNumbersOf(patch.issuedQty);
                if (inc.length === 1) r.issuedQty += inc[0];
                const resInc = leafNumbersOf(patch.reservedQty);
                if (resInc.length === 1) {
                  r.reservedQty = Math.max(0, r.quantity - r.issuedQty - resInc[0]);
                }
              }
              return hit.map((r) => ({
                preorder_id: r.preorderId,
                resource_id: r.resourceId,
                quantity: r.quantity,
                reserved_qty: r.reservedQty,
                issued_qty: r.issuedQty,
                status: r.status,
              }));
            }
            const hit = state.bindings.filter((r) =>
              strings.every((s) => bindingRowVals(r).includes(s)),
            );
            for (const r of hit) {
              const deltas = leafNumbersOf(patch.quantity);
              if (deltas.length === 1) r.quantity += deltas[0];
            }
            return hit.map((r) => ({ quantity: r.quantity }));
          },
        }),
      }),
    }),
  };
  return { db };
}

function leafNumbersOf(sqlValue: unknown): number[] {
  if (sqlValue == null || typeof sqlValue !== 'object') return [];
  return leafValues(sqlValue).filter((l): l is number => typeof l === 'number');
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    primaryOrgId: ORG_A,
    roles: ['dispatcher'],
    isGlobalAdmin: false,
    ...overrides,
  };
}

function baseState(): FakeState {
  return {
    preorders: [
      {
        preorderId: 'preorder-a',
        resourceId: 'res-1',
        orgId: ORG_A,
        quantity: 10,
        reservedQty: 10,
        issuedQty: 0,
        status: 'pending',
      },
      {
        preorderId: 'preorder-b',
        resourceId: 'res-1',
        orgId: ORG_B,
        quantity: 10,
        reservedQty: 10,
        issuedQty: 0,
        status: 'pending',
      },
    ],
    bindings: [
      {
        bindingId: 'inv-a',
        bindingType: 'inventory',
        resourceId: 'res-1',
        orgId: ORG_A,
        quantity: 100,
        status: 'active',
      },
    ],
    inserts: [],
    casMiss: false,
  };
}

function createService(state: FakeState) {
  const { db } = createResourceDb(state);
  return new ResourceService(db as never, undefined);
}

describe('ResourceService 租户谓词（R2-SNZ-009）', () => {
  it('getPreorder：本租户可见；他租户 404；缺租户 400；global_admin 放行', async () => {
    const state = baseState();
    const service = createService(state);
    await expect(service.getPreorder('preorder-a', actor())).resolves.toMatchObject({
      id: 'preorder-a',
    });
    await expect(service.getPreorder('preorder-b', actor())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getPreorder('preorder-a', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.getPreorder('preorder-b', actor({ isGlobalAdmin: true })),
    ).resolves.toMatchObject({ id: 'preorder-b' });
  });

  it('issue：他租户 preorderId → 404（原先可跨租户扣减库存）', async () => {
    const state = baseState();
    const service = createService(state);
    await expect(service.issue('preorder-b', 5, actor())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('issue：缺租户 → 400 fail-closed', async () => {
    const state = baseState();
    const service = createService(state);
    await expect(service.issue('preorder-a', 5, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('issue 成功：CAS 谓词带 org；binding 写入显式 orgId', async () => {
    const state = baseState();
    const service = createService(state);
    const updated = await service.issue('preorder-a', 4, actor());
    expect(updated.issuedQty).toBe(4);
    const bindingInsert = state.inserts.find(
      (i) =>
        i.table === ewohResourceBinding &&
        i.values.bindingType === 'issue',
    );
    expect(bindingInsert).toBeDefined();
    expect(bindingInsert!.values.orgId).toBe(ORG_A);
  });

  it('issue 并发 CAS 未命中 → 显式拒绝（R2-SNZ-010，原先覆盖写丢计数）', async () => {
    const state = baseState();
    state.casMiss = true;
    const service = createService(state);
    await expect(service.issue('preorder-a', 4, actor())).rejects.toThrow(
      /Concurrent issue detected/,
    );
  });

  it('createPreorder：写入显式 orgId；可用量聚合仅计本租户（org-b 预占不挤占 org-a）', async () => {
    const state = baseState();
    const service = createService(state);
    // org-b 已有 pending 预占 10（baseState 预置）——org-a 可用量仍为 100。
    const created = await service.createPreorder('res-1', 80, actor());
    expect(created.status).toBe('pending');
    const preorderInsert = state.inserts.find(
      (i) => i.table === ewohResourcePreorder && i.values.preorderId === created.id,
    );
    expect(preorderInsert).toBeDefined();
    expect(preorderInsert!.values.orgId).toBe(ORG_A);
  });

  it('release：缺租户 → 400；他租户 → 404', async () => {
    const state = baseState();
    const service = createService(state);
    await expect(service.release('preorder-a', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.release('preorder-b', actor())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
