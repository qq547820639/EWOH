/* 试点模块化调整（V59）：`ewoh_scheduling_run.status` 的唯一写入口。
 *
 * 钉三件事：① 闭合必须带 org 谓词（standalone_057 之后 run_id 只在租户内唯一）；
 * ② 0 行命中必须显式报错且不抛断主流程；③ 缺租户归属时**拒绝写入**，
 * 而不是退化成一条无界 UPDATE。
 */
/// <reference types="jest" />
import { closeSchedulingRun } from '../scheduling-run.lifecycle';

type Captured = { patch: unknown; where: unknown[]; returning: boolean };

function makeDb(rows: Array<{ runId: string }>) {
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

describe('closeSchedulingRun（run 终态唯一写入口）', () => {
  it('命中时返回 true，并取回命中集合（不是"写完就走"）', async () => {
    const { db, captured } = makeDb([{ runId: 'RUN-1' }]);
    const error = jest.fn();
    const ok = await closeSchedulingRun(
      db,
      { runId: 'RUN-1', orgId: 'org1', patch: { status: 'succeeded' }, stage: 'persisted' },
      { error },
    );
    expect(ok).toBe(true);
    expect(captured.returning).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it('谓词必须同时含 runId 与 orgId（缺 org 谓词即跨租户 UPDATE）', async () => {
    const { db, captured } = makeDb([{ runId: 'RUN-1' }]);
    await closeSchedulingRun(
      db,
      { runId: 'RUN-1', orgId: 'org1', patch: { status: 'succeeded' }, stage: 'persisted' },
      { error: jest.fn() },
    );
    // drizzle 的 SQL 对象不能直接 JSON.stringify（列→表→列成环，见 mobile.service.spec
    // 里同族的 sqlText 助手）：剥掉回指键后按文本核对谓词列名。
    const rendered = JSON.stringify(captured.where, (key, value) =>
      key === 'table' || key === 'parent' ? undefined : value,
    );
    expect(rendered).toContain('run_id');
    expect(rendered).toContain('org_id');
  });

  it('0 行命中：返回 false + 显式报错（含 stage 与 org），但不抛断调用方', async () => {
    const { db } = makeDb([]);
    const error = jest.fn();
    await expect(
      closeSchedulingRun(
        db,
        { runId: 'RUN-9', orgId: 'org1', patch: { status: 'failed' }, stage: 'failed' },
        { error },
      ),
    ).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain('RUN-9');
    expect(message).toContain('stage=failed');
    expect(message).toContain('org1');
  });

  it('缺租户归属：拒绝写入（一次 UPDATE 都不发）并报错', async () => {
    const update = jest.fn();
    const db = { update } as never;
    const error = jest.fn();
    const ok = await closeSchedulingRun(
      db,
      { runId: 'RUN-9', orgId: '   ', patch: { status: 'succeeded' }, stage: 'persisted' },
      { error },
    );
    expect(ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toContain('缺少租户归属');
  });
});
