/**
 * 行锁窗口的共用观测件：判定「确实有别的会话在这张表的某行上排队等锁」。
 *
 * 为什么要有这个文件：控制面投递（`test/e2e/control-delivery-race.e2e.spec.ts` 的 D-01）、
 * 派工×回执（`dispatch-receipt-concurrency.e2e.spec.ts` 的 E-02）与取消级联
 * （`plan-cancel-execution-projection.e2e.spec.ts` 的 PC-04）用的是同一个机制——
 * **行锁本身就是同步接缝**，不需要产品代码配合。三处各自内联一份谓词时，改一处忘两处
 * 就会让某一档"看不见排队"被读成"没构造出窗口"。此文件是往后新增窗口的家。
 *
 * 谓词形状是实测出来的（不是抄文档），两条要点：
 *  1) 行锁等待在 `pg_locks` 里记成两类行——等待方对目标行先取一枚**授予态**的投机锁
 *     （`locktype='tuple'`，`relation` 有值），再对持锁事务取一枚**未授予**的
 *     `locktype='transactionid'`（该列 `relation` 为 NULL）。
 *     因此 `NOT granted AND relation = '某表'` 这个形状**永远匹配不到**行锁等待。
 *  2) 不用 `pg_stat_activity`：应用连接是 `ewoh_api` 角色、探针连接是 owner，
 *     跨角色会话的 state/query 会被权限隐藏（实测显示 `<insufficient privilege>`）；
 *     `pg_locks` 对所有角色可见，是这个场景唯一可靠的观测面。
 * 持锁方自己只有 relation/transactionid/virtualxid 行、没有 tuple 行（tuple 投机锁只在
 * 真要等待时才取），所以「存在 tuple 行」等价于「有别人在这张表的行上排队」。
 */
import type postgres from 'postgres';

export type LockWindow = { waited: boolean; probes: number; waiters: number };

const PROBES = 200;
const INTERVAL_MS = 25;

/**
 * 采样粒度是承重的，不是风格问题（V326 实测）：同一个形状——四条 normal 键的真回执并发、
 * 请求上 7 条命令行——连跑 16 遍，`5ms×` 采样 16/16 遍观测到 tuple 等待（峰值 1~3），
 * `25ms×` 采样只有 1/16 观测到。成因不是"窗口比 25 ms 短"，而是**每次采样只是一个瞬间的快照**：
 * 回执整批在 ~30 ms 内完成，25 ms 的采样器往往只看得到一眼。
 * ⇒ 问「两个写者都在被测代码里时到底排没排队」必须用 `FAST_WINDOW`；
 *   问「holder 撑开的窗口里在飞请求排没排队」（D-01／E-02／RVAGG-05 那一族）用默认档即可，
 *   因为那边的窗口是外部持有的、秒级。
 */
export const FAST_WINDOW = { intervalMs: 5, probes: 400 };

/** 轮询到 tuple 锁排队为止；默认档最多 PROBES×INTERVAL_MS＝5 秒，等不到就如实报 waited=false。 */
export async function waitTupleLockQueued(
  client: ReturnType<typeof postgres>,
  relation: string,
  opts: { intervalMs?: number; probes?: number } = {},
): Promise<LockWindow> {
  const intervalMs = opts.intervalMs ?? INTERVAL_MS;
  const probes = opts.probes ?? PROBES;
  for (let i = 0; i < probes; i += 1) {
    const rows = (await client.unsafe(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'tuple'`
      + ` AND relation = '${relation}'::regclass AND pid <> pg_backend_pid()`,
    )) as Array<Record<string, unknown>>;
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) return { waited: true, probes: i + 1, waiters: n };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { waited: false, probes, waiters: 0 };
}

/** 一句话读数，给用例的留痕行用（登记册引用的就是这一行）。 */
export function lockWindowNote(
  tag: string,
  window: LockWindow,
  extra = '',
  intervalMs = INTERVAL_MS,
): string {
  return `[${tag}] tuple 锁排队 waited=${window.waited} probes=${window.probes}`
    + `(×${intervalMs}ms) waiters=${window.waiters}${extra ? ' ' + extra : ''}`;
}
