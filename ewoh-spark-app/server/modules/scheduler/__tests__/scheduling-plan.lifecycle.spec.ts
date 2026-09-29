/* 试点模块化调整（V79，第三个边界样本）：`ewoh_schedule_plan.status='dispatched'` 的唯一写入口。
 *
 * 钉四件事：① 派工状态写入只此一处（两处历史写者都调它）；② CAS 前置状态必须来自入参
 * （`approved` 正统轨与 `confirmed` legacy 轨各自守住自己的入口条件，不许写死其中一个）；
 * ③ 0 行命中返回 false 而不是抛断——让调用方保留各自对外的错误文案
 * （`PLAN_CONCURRENT_DISPATCH` / 旁路的 "concurrently dispatched or no longer confirmed"）；
 * 【V278 回退】通用入口 transitionPlanStatus 与两道既有测量互斥（详见 lifecycle 文件头与 §5.3ly），
 * 本样本退回直写形状；下列四件事的断言形状自 V79 起未变。
 *
 * ④ 本函数**不加 org 谓词**：实测两处历史写者都没有，补上会改变"全局管理员跨租户派工"的
 * 现有行为，那属于 F-06 的纵深防御项（另案裁决），不是本样本的主张。
 */
/// <reference types="jest" />
import { markPlanDispatched } from '../scheduling-plan.lifecycle';

type Captured = { patch: unknown; where: unknown[]; returning: boolean };

function makeDb(rows: Array<{ id: number }>) {
  const captured: Captured = { patch: undefined, where: [], returning: false };
  const db = {
    update: jest.fn(() => ({
      set: jest.fn((patch: unknown) => {
        captured.patch = patch;
        return {
          where: jest.fn((...args: unknown[]) => {
            captured.where = args;
            return {
              returning: jest.fn(() => {
                captured.returning = true;
                return Promise.resolve(rows);
              }),
            };
          }),
        };
      }),
    })),
  };
  return { db: db as never, captured };
}

// drizzle 的 SQL 对象不能直接 JSON.stringify（列→表→列成环）：剥掉回指键后按文本核对。
const render = (where: unknown[]) =>
  JSON.stringify(where, (key, value) => (key === 'table' || key === 'parent' ? undefined : value));

describe('markPlanDispatched（plan 派工终态唯一写入口）', () => {
  it('命中：返回 true、写入 dispatched、并真的取回命中集合（不是"写完就走"）', async () => {
    const { db, captured } = makeDb([{ id: 1 }]);
    const ok = await markPlanDispatched(db, { planId: 'PLAN-1', fromStatus: 'approved' });
    expect(ok).toBe(true);
    expect(captured.returning).toBe(true);
    expect(captured.patch).toEqual({ status: 'dispatched' });
  });

  it('谓词必须同时含 plan_id 与 status（缺 status 前置即 double-dispatch 的入口）', async () => {
    const { db, captured } = makeDb([{ id: 1 }]);
    await markPlanDispatched(db, { planId: 'PLAN-1', fromStatus: 'approved' });
    const text = render(captured.where);
    expect(text).toContain('plan_id');
    expect(text).toContain('status');
  });

  it('前置状态取入参：正统轨 approved 与旁路轨 confirmed 各自成立（写死任一即假修复）', async () => {
    const a = makeDb([{ id: 1 }]);
    await markPlanDispatched(a.db, { planId: 'PLAN-A', fromStatus: 'approved' });
    const b = makeDb([{ id: 1 }]);
    await markPlanDispatched(b.db, { planId: 'PLAN-B', fromStatus: 'confirmed' });
    // 谓词里的字面量必须跟着入参走：两条轨道分别只在自己的入口状态下才被改写
    expect(render(a.captured.where)).toContain('approved');
    expect(render(a.captured.where)).not.toContain('confirmed');
    expect(render(b.captured.where)).toContain('confirmed');
    expect(render(b.captured.where)).not.toContain('approved');
  });

  it('0 行命中：返回 false 且不抛断（对外错误文案归调用方）', async () => {
    const { db } = makeDb([]);
    await expect(
      markPlanDispatched(db, { planId: 'PLAN-9', fromStatus: 'approved' }),
    ).resolves.toBe(false);
  });
});
