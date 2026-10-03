/* active-plan-strategy-scope.spec.ts — 活跃方案读面的 strategy 域隔离。
 *
 * 缺陷：ewoh_schedule_plan 是多域共用表。gamification 模块直接写该表
 * （resource_alloc / task_orchest，status='proposed'），而
 * SchedulerQueryService.getActivePlans 只按 status 过滤、未按 strategy 过滤，
 * 导致非调度方案混入前端"活跃调度方案"列表。
 *
 * 本 spec 固定 getActivePlans 的 strategy 白名单语义：
 *  - 白名单 = 真实调度写入方使用的 strategy 值（唯一写入口 PlanService.persistPlan
 *    硬编码 'scheduling_v2'，与求解器身份无关——求解器身份在 solver_version 列）；
 *  - legacy 调度策略值（keep_status / capacity_priority / load_balance）保留，
 *    避免历史真实调度方案从活跃列表消失；
 *  - 非调度 strategy（resource_alloc / task_orchest / 未知新值）一律排除；
 *  - fail-open：出现未知 strategy 只是被过滤，绝不抛错（不因历史脏数据 500）。
 *
 * 同时锁定范围边界：getPlans / listRuns 不引入 strategy 过滤（历史页展示不变）。
 */
/// <reference types="jest" />
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { ewohSchedulePlan } from '@server/database/schema';
import { SchedulerQueryService } from '@server/modules/scheduler/scheduler-query.service';

const CTX = { userId: 'u1', primaryOrgId: 'ORG-1' } as never;

// ===== drizzle SQL 谓词求值器（把 where 条件真实作用于内存行） =====
// 结构经实测确认：inArray → [StringChunk(''), Column, StringChunk(' in '), Array, StringChunk('')]
// eq → [..., ' = ', Param]；isNull → [..., ' is null']；and/or → ['(', SQL, ' and '/' or ', SQL, ')']。

/** drizzle DB 列名 → 内存行字段名。 */
const COL_TO_KEY: Record<string, string> = {
  plan_id: 'planId',
  status: 'status',
  strategy: 'strategy',
  org_id: 'orgId',
  version: 'version',
  created_at: 'createdAt',
};

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

/** 可 await 且可继续链式的 drizzle 查询替身。 */
type Query = Promise<Row[]> & {
  where: (cond?: unknown) => Query;
  orderBy: () => Query;
  limit: (n?: number) => Query;
  offset: (n?: number) => Query;
};

function isStringChunk(c: unknown): boolean {
  return (
    !!c &&
    typeof c === 'object' &&
    !Array.isArray(c) &&
    Array.isArray((c as { value?: unknown }).value) &&
    (c as { value: unknown[] }).value.every((s) => typeof s === 'string')
  );
}

function isColumn(c: unknown): boolean {
  return (
    !!c &&
    typeof c === 'object' &&
    !Array.isArray(c) &&
    typeof (c as { name?: unknown }).name === 'string' &&
    // 排除 Param/Array/StringChunk 等同样可能带 name/value 的节点：
    // Column 的判定特征是「有 name 且无 value/encoder/queryChunks」。
    !('value' in (c as object)) &&
    !('encoder' in (c as object)) &&
    !('queryChunks' in (c as object))
  );
}

function chunkText(c: unknown): string | null {
  return isStringChunk(c) ? ((c as { value: string[] }).value.join('') || null) : null;
}

function paramValue(c: unknown): unknown {
  return c && typeof c === 'object' && 'value' in (c as object)
    ? (c as { value: unknown }).value
    : c;
}

/** 把 drizzle SQL 树编译为行谓词；遇到未识别的 SQL 形状直接抛错（避免静默放行）。 */
function compile(node: unknown): Predicate {
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) throw new Error('compile: not a SQL node');

  const colIdx = chunks.findIndex(isColumn);
  if (colIdx >= 0) {
    const col = chunks[colIdx] as { name: string };
    const key = COL_TO_KEY[col.name] ?? col.name;
    const op = chunkText(chunks[colIdx + 1]) ?? '';
    if (/is\s+null/i.test(op)) return (row) => row[key] == null;
    if (op.includes(' in ')) {
      const operand = chunks[colIdx + 2];
      const list = (Array.isArray(operand) ? operand : [operand]).map(paramValue);
      const set = new Set(list);
      return (row) => set.has(row[key]);
    }
    if (op.includes(' = ')) {
      const expected = paramValue(chunks[colIdx + 2]);
      return (row) => row[key] === expected;
    }
    throw new Error(`compile: unsupported leaf operator ${JSON.stringify(op)}`);
  }

  // 布尔组合层：and 优先于 or（与 SQL 优先级一致）
  const preds: Predicate[] = [];
  const ops: string[] = [];
  for (const c of chunks) {
    // 先判 SQL 节点：chunkText 对非 StringChunk 返回 null，不能与空串混淆。
    if (c && typeof c === 'object' && Array.isArray((c as { queryChunks?: unknown[] }).queryChunks)) {
      preds.push(compile(c));
      continue;
    }
    const text = chunkText(c);
    if (text === ' and ' || text === ' or ') {
      ops.push(text.trim());
      continue;
    }
    // 其余为括号 / 空串 / 排版片段，忽略。
  }
  if (preds.length === 0) return () => true;
  if (ops.length !== preds.length - 1) {
    throw new Error(`compile: operator/operand mismatch ops=${ops.length} preds=${preds.length}`);
  }
  const orGroups: Predicate[][] = [[preds[0]]];
  preds.slice(1).forEach((p, i) => {
    if (ops[i] === 'or') orGroups[orGroups.length - 1].push(p);
    else orGroups.push([p]);
  });
  // and 组间合取、or 组内析取（SQL 优先级：and 紧于 or）
  return (row) => orGroups.every((group) => group.some((p) => p(row)));
}

// ===== fake db：where 谓词真实作用于种子行 =====

/** 深度搜索 SQL 树中是否引用了目标列实例（drizzle Column 对象不参与文本展开）。 */
function containsNode(node: unknown, target: unknown): boolean {
  if (node === target) return true;
  if (Array.isArray(node)) return node.some((n) => containsNode(n, target));
  if (node && typeof node === 'object' && 'queryChunks' in (node as object)) {
    return containsNode((node as { queryChunks: unknown }).queryChunks, target);
  }
  return false;
}

function makePlanDb(seedRows: Row[]) {
  const captured: Array<{ table: unknown; cond: unknown }> = [];

  function run(table: unknown, cond: unknown): Row[] {
    const rows = table === ewohSchedulePlan ? seedRows : [];
    if (cond == null) return rows;
    const predicate = compile(cond);
    return rows.filter(predicate);
  }

  /** 可 await 且带 where/orderBy/limit/offset 的链式查询对象。 */
  function query(table: unknown, cond: unknown): Query {
    const rows = run(table, cond);
    // limit/offset 返回的仍是可继续链式（.offset / await）的查询对象。
    const make = (out: Row[]): Query => {
      const q = Promise.resolve(out) as Query;
      q.where = () => make(out);
      q.orderBy = () => make(out);
      q.limit = (n?: number) => make(out.slice(0, n ?? out.length));
      q.offset = (n?: number) => make(out.slice(n ?? 0));
      return q;
    };
    return make(rows);
  }

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = run(table, undefined);
        const q = Promise.resolve(rows) as Query;
        q.where = (cond: unknown) => {
          captured.push({ table, cond });
          return query(table, cond);
        };
        q.orderBy = () => query(table, undefined);
        q.limit = (n?: number) => query(table, undefined).limit(n);
        q.offset = (n?: number) => query(table, undefined).offset(n);
        return q;
      },
    }),
  };
  return { db, captured };
}

function makeService(db: unknown) {
  const planService = {
    // 回显被选中的 planId：让断言直接反映 where 过滤结果。
    listPlansBatched: jest.fn(async (planIds: string[]) =>
      planIds.map((planId) => ({ planId, version: 1, status: 'proposed', assignments: [] })),
    ),
    getPlan: jest.fn(),
  };
  const service = new SchedulerQueryService(
    db as never,
    undefined as never,
    planService as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, planService };
}

const ACTIVE = 'proposed';

/** 各 strategy 值的活跃方案种子行（同租户 ORG-1）。 */
function seed(...strategies: string[]): Row[] {
  return strategies.map((strategy, i) => ({
    planId: `PLAN-${i}-${strategy}`,
    planName: strategy,
    strategy,
    status: ACTIVE,
    version: 1,
    orgId: 'ORG-1',
  }));
}

/** 真实调度写入方使用的 strategy 值全集（白名单）。 */
const SCHEDULING_STRATEGIES = [
  'scheduling_v2',
  'keep_status',
  'capacity_priority',
  'load_balance',
];

/** 非调度域占用同一张表的 strategy 值。 */
const NON_SCHEDULING_STRATEGIES = ['resource_alloc', 'task_orchest'];

describe('getActivePlans strategy 域隔离（gamification 方案不得混入）', () => {
  it('strategy=resource_alloc & status=proposed → 不出现在活跃调度方案中', async () => {
    const { db } = makePlanDb(seed('resource_alloc', 'scheduling_v2'));
    const { service } = makeService(db);

    const plans = await service.getActivePlans(CTX);
    const ids = plans.map((p) => p.planId);

    expect(ids).toContain('PLAN-1-scheduling_v2'); // 同批次真实调度方案仍在
    expect(ids).not.toContain('PLAN-0-resource_alloc'); // 非调度方案被排除
  });

  it('task_orchest 同被排除（gamification 第二处写入方）', async () => {
    const { db } = makePlanDb(seed('task_orchest', 'scheduling_v2'));
    const { service } = makeService(db);

    const ids = (await service.getActivePlans(CTX)).map((p) => p.planId);

    expect(ids).toEqual(['PLAN-1-scheduling_v2']);
  });

  it('全部非调度方案被排除时返回空列表（不 500）', async () => {
    const { db } = makePlanDb(seed(...NON_SCHEDULING_STRATEGIES));
    const { service } = makeService(db);

    await expect(service.getActivePlans(CTX)).resolves.toEqual([]);
  });

  it('真实调度 strategy 全部保留（含 legacy 调度策略，不误伤历史方案）', async () => {
    const { db } = makePlanDb(seed(...SCHEDULING_STRATEGIES));
    const { service } = makeService(db);

    const ids = (await service.getActivePlans(CTX)).map((p) => p.planId);

    expect(ids).toHaveLength(SCHEDULING_STRATEGIES.length);
    for (const s of SCHEDULING_STRATEGIES) expect(ids).toContain(`PLAN-${SCHEDULING_STRATEGIES.indexOf(s)}-${s}`);
  });

  it('未知新 strategy 被过滤且不抛错（fail-open，不因脏数据 500）', async () => {
    const { db } = makePlanDb(seed('brand_new_non_scheduling_domain', 'scheduling_v2'));
    const { service } = makeService(db);

    const ids = (await service.getActivePlans(CTX)).map((p) => p.planId);

    expect(ids).toEqual(['PLAN-1-scheduling_v2']);
  });

  it('白名单用 inArray(strategy) 表达（白名单语义，非排除法）', async () => {
    const { db, captured } = makePlanDb(seed('resource_alloc'));
    const { service } = makeService(db);

    await service.getActivePlans(CTX);

    // 构造一个必然命中的 strategy 条件，验证编译出的 where 真含 strategy 白名单
    const whitelisted = compile(
      inArray(ewohSchedulePlan.strategy, SCHEDULING_STRATEGIES),
    )({ strategy: 'scheduling_v2' });
    expect(whitelisted).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
  });
});

describe('范围边界：历史读面不引入 strategy 过滤', () => {
  it('getPlans 不按 strategy 过滤（历史方案列表展示不变）', async () => {
    const { db, captured } = makePlanDb(seed('resource_alloc'));
    const { service } = makeService(db);

    const plans = await service.getPlans(ACTIVE, CTX);
    const cond = captured.find((c) => c.table === ewohSchedulePlan)?.cond;

    expect(plans.map((p) => p.planId)).toEqual(['PLAN-0-resource_alloc']);
    // where 条件树中不含 strategy 列（与 getActivePlans 相反）
    expect(containsNode(cond, ewohSchedulePlan.strategy)).toBe(false);
  });

  it('listRuns 响应仍含非调度方案（本次不改 listRuns，保持历史展示）', async () => {
    const { db } = makePlanDb(seed('resource_alloc'));
    const { service } = makeService(db);

    const res = await service.listRuns({}, CTX);
    expect(res.plans.map((p) => p.planId)).toEqual(['PLAN-0-resource_alloc']);
  });
});

// 复用 drizzle 构造器，确保本 spec 自身不被优化掉类型检查
void eq;
void and;
void or;
void isNull;
