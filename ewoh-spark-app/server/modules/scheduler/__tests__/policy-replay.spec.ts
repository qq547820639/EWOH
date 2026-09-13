/* R2-WP-B 回归测试：策略回放「已评估」守卫跨租户隔离。
 *
 * 缺陷：PolicyReplayService.evaluations 曾为 Map<number>，仅以 configVersion 为键；
 * 而 configVersion 由 SchedulingPolicyService.computeNextVersion 按 org 作用域递增
 * （NEST-165：max 按本 org + NULL 全局行），ewoh_scheduling_policy 上也没有
 * config_version 唯一约束（schema.ts / standalone_017：仅 integer NOT NULL）——
 * 不同租户可各自存在 version=5 的行。于是 A 租户评估 v5 后，B 租户
 * isEvaluated(5) 命中同一键为真，B 可跳过 shadow replay 直接 activate 自己的 v5。
 *
 * 核心不变量：两个租户各自 version=5，A 评估后 B 的 isEvaluated(5) 必须仍为 false。
 */
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohPolicyReplay, ewohWorldStateSnapshot } from '@server/database/schema';
import { PolicyReplayService } from '../policy-replay.service';

/** drizzle eq() SQL 的 DB 列名 → 行字段名映射。 */
const COL_TO_KEY: Record<string, string> = {
  org_id: 'orgId',
  candidate_policy_version: 'candidatePolicyVersion',
  status: 'status',
  snapshot_version: 'snapshotVersion',
  _created_at: 'createdAt',
};

/** drizzle 的文本 chunk：value 可能是 string 或 string[]（本仓库为后者）。 */
function chunkText(c: { value?: unknown }): string | null {
  if (typeof c.value === 'string') return c.value;
  if (Array.isArray(c.value)) return c.value.join('');
  return null;
}

/**
 * 从 drizzle SQL 谓词对象递归求值（eq / isNull / and / or）。
 * 按 or 分组，组内合取，组间析取；嵌套 SQL（or/and/isNull 的 queryChunks）递归求值。
 */
function matchesEq(row: Record<string, unknown>, sqlExpr: unknown): boolean {
  const chunks = (sqlExpr as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  const groups: Array<Array<() => boolean>> = [[]];
  let pendingCol: string | null = null;
  for (const raw of chunks) {
    const c = raw as {
      name?: string;
      value?: unknown;
      encoder?: unknown;
      queryChunks?: unknown[];
    } | undefined;
    if (!c || typeof c !== 'object') continue;
    // 嵌套 SQL（or/and/isNull 等）：递归求值。
    if (Array.isArray(c.queryChunks)) {
      groups[groups.length - 1].push(() => matchesEq(row, c));
      continue;
    }
    // 列名。
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pendingCol = c.name;
      continue;
    }
    // Param（eq 值）。
    if ('encoder' in c && 'value' in c) {
      if (pendingCol) {
        const key = COL_TO_KEY[pendingCol] ?? pendingCol;
        const expected = c.value;
        groups[groups.length - 1].push(() => row[key] === expected);
        pendingCol = null;
      }
      continue;
    }
    // 操作符文本（StringChunk）。
    const txt = chunkText(c);
    if (txt !== null) {
      if (/\bor\b/i.test(txt)) groups.push([]);
      else if (/is\s+null/i.test(txt) && pendingCol) {
        const key = COL_TO_KEY[pendingCol] ?? pendingCol;
        groups[groups.length - 1].push(() => row[key] == null);
        pendingCol = null;
      }
      continue;
    }
  }
  if (groups.every((g) => g.length === 0)) return true;
  return groups.some((g) => g.every((fn) => fn()));
}

/** ewoh_world_state_snapshot / ewoh_policy_replay 的 in-memory fake db。 */
function makeFakeDb(
  opts: { snapshots?: Array<Record<string, unknown>>; replays?: Array<Record<string, unknown>> } = {},
) {
  const snapshots = opts.snapshots ?? [];
  const replays = opts.replays ?? [];
  const build = (rows: Array<Record<string, unknown>>) => {
    const q: any = {
      where: (pred: unknown) => build(rows.filter((r) => matchesEq(r, pred))),
      orderBy: () => build(rows),
      limit: (n?: number) => Promise.resolve(rows.slice(0, n ?? rows.length)),
    };
    // 允许无 .limit 的链式 await（当前服务路径均以 .limit 收尾，纯兜底）。
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return q;
  };
  return {
    select: () => ({
      from: (table: unknown) =>
        build(table === ewohPolicyReplay ? replays : snapshots),
    }),
  } as unknown as PostgresJsDatabase;
}

/** 全局（org NULL）快照：两租户皆可见，把测试焦点收敛到守卫键的 org 语义。 */
const SNAPSHOT_ROW = {
  snapshotVersion: 'snap-1',
  snapshotJson: { snapshotVersion: 'snap-1' },
  orgId: null,
  createdAt: new Date('2026-09-13T00:00:00Z'),
};

const PLAN = {
  planId: 'p',
  objective: 10,
  solverStatus: 'OPTIMAL',
  assignments: [{ id: 1 }, { id: 2 }],
  metrics: { lateMinutes: 1 },
  violations: [],
};

/** 构造真实 PolicyReplayService（仅 db / policy / solver 为测试替身）。 */
function makeService(db?: PostgresJsDatabase) {
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue({ version: 3, solverVersion: 'heuristic-v2' }),
    getPolicy: jest.fn().mockResolvedValue({ solverVersion: 'heuristic-v2' }),
  };
  const solverService = { solve: jest.fn().mockResolvedValue(PLAN) };
  const svc = new PolicyReplayService(
    db ?? makeFakeDb({ snapshots: [SNAPSHOT_ROW] }),
    {} as never,
    policyService as never,
    solverService as never,
  );
  return { svc, policyService, solverService };
}

const ctxA = { userId: 'u-a', primaryOrgId: 'org-A' };
const ctxB = { userId: 'u-b', primaryOrgId: 'org-B' };

describe('R2-WP-B：policy replay 已评估守卫的租户隔离', () => {
  it('核心不变量——A 评估 v5 后，B 的 isEvaluated(5) 仍为 false', async () => {
    const { svc } = makeService();
    const evaluation = await svc.evaluate(5, ctxA as never);
    expect(evaluation).not.toBeNull();

    // A 自身：已评估。
    await expect(svc.isEvaluated(5, 'org-A')).resolves.toBe(true);
    // B 同版本号：绝不能命中 A 的评估记录（修复前 Map<number> 会返回 true）。
    await expect(svc.isEvaluated(5, 'org-B')).resolves.toBe(false);
  });

  it('B 自己评估 v5 后才放行，且不影响 C', async () => {
    const { svc } = makeService();
    await svc.evaluate(5, ctxB as never);
    await expect(svc.isEvaluated(5, 'org-B')).resolves.toBe(true);
    await expect(svc.isEvaluated(5, 'org-A')).resolves.toBe(false);
    await expect(svc.isEvaluated(5, 'org-C')).resolves.toBe(false);
  });

  it('系统后台流（无 org）用 __global__ 键，不泄漏到任意租户', async () => {
    const { svc } = makeService();
    await svc.evaluate(5, undefined);
    await expect(svc.isEvaluated(5)).resolves.toBe(true);
    await expect(svc.isEvaluated(5, 'org-A')).resolves.toBe(false);
    await expect(svc.isEvaluated(5, 'org-B')).resolves.toBe(false);
  });

  it('内存态丢失（重启）后由 ewoh_policy_replay 持久化记录兜底，且按 org 隔离', async () => {
    const db = makeFakeDb({
      snapshots: [SNAPSHOT_ROW],
      replays: [
        { id: 'r1', orgId: 'org-B', candidatePolicyVersion: 5, status: 'COMPLETED' },
      ],
    });
    const { svc } = makeService(db);
    // 内存态为空（模拟重启）：B 的 v5 有持久化完成记录 → 已评估。
    await expect(svc.isEvaluated(5, 'org-B')).resolves.toBe(true);
    // 同版本号的他租户无记录 → 未评估（跨租户不共享持久化事实）。
    await expect(svc.isEvaluated(5, 'org-A')).resolves.toBe(false);
    // 版本号不同 → 未评估。
    await expect(svc.isEvaluated(6, 'org-B')).resolves.toBe(false);
  });

  it('持久化记录非 COMPLETED（如 RUNNING/FAILED）不算已评估', async () => {
    const db = makeFakeDb({
      snapshots: [SNAPSHOT_ROW],
      replays: [
        { id: 'r1', orgId: 'org-B', candidatePolicyVersion: 5, status: 'RUNNING' },
      ],
    });
    const { svc } = makeService(db);
    await expect(svc.isEvaluated(5, 'org-B')).resolves.toBe(false);
  });
});
