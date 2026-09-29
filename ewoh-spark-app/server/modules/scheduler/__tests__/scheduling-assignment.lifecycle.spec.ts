/* 试点模块化第二轮（V279）：`ewoh_scheduling_plan_assignment.status` 的具名写入口。
 *
 * 钉四件事：
 * ① 两种形状不许互相漂移——审批/拒绝是**投影**（按 planId+org 全量改写、WHERE 里刻意没有来源态谓词，
 *    正确性由同事务的方案级 CAS 与"入库初值恒为 proposed"提供，见模块头）；取消/派工/回执是**逐条 CAS**
 *    （WHERE 里必须有字面状态列谓词）。把前者"顺手加上守卫"或把后者"顺手退化成批量写"都会在这里红。
 * ② 状态值一律字面量写在 set 侧（派工/取消/投影三条各有自己的字面值；回执那条由调用方从闭集映射给出）。
 * ③ 0 行命中一律返回空数组/false 计数、**不抛断**——对外文案（ASSIGNMENT_CONCURRENT_UPDATE／
 *    ASSIGNMENT_STATE_CONFLICT／转入 irreversible）归调用方。
 * ④ version 语义逐点保持：派工用"读到的值 +1 并进谓词"，回执用列自增表达式。
 *
 * V280 追加：投影的 org 两个分支从三元表达式拆成两条字面 UPDATE（写点 5→7），目的是让
 * `status-write-guard-census` 把这两处从 `dynamic-where`（看不见）读成 `identity-only`。
 * 三元与拆分在**运行时同形**，所以这条只能由按 AST 读的尺子来守——见"形状不倒退"那两个用例，
 * 它们直接复用仓里那把尺子，并各带一支必须开火的反向对照。
 *
 * V281 补牙（对抗性复核 G1／G2／G5／G7／G8；G3 见末尾说明）：只数"谓词里出现了 plan_id"不够——
 * 把整条 WHERE 换成硬编码常量它照样绿。所以这一轮补的是**绑定值**与**返回值形状**这两面：
 * ① 逐条 CAS 的 `.returning()` 显式钉住（删掉它 drizzle／postgres-js 会返回空数组，调用方会把
 *    正常的"0 命中"误报成冲突）；派工那条还要钉住 RETURNING 选的是哪一列——假 db 看得见实参。
 * ② 每个入口断到"调用方传进去的那个标识符确实落在了谓词上"：新 helper `boundEqualityPairs`
 *    与上面那把计数尺同源（沿 queryChunks 找直接挂着 Param 的节点，取列名 + Param 的 value）。
 *    专用那条用例喂的是互不相撞的字面量，所以 `eq(plan_id,'P-1')`、`eq(status,'approved')`
 *    这类常量与 `eq(plan_id, input.orgId)` 这类字段串门都躲不过。
 * ③ 回执的 version 自增把 `[" + 1"]` 那段 SQL 文本钉住——假 db 读得到，不需要真方言
 *    （真方言那侧另有 `canonical-receipt-test-harness.ts:159` 拒绝任何不以 `+ 1` 收尾的更新表达式）。
 * ④ set 侧在原有逐键核对**之外**补整对象／整键集核对（原断言一条未删），多一个覆写键就红。
 * ⑤ 补 `orgId: undefined` 一条，把"分支测试是松散相等 ⇒ undefined 走 legacy 分支"写成常驻契约。
 * G3（投影分支漏写 `await`）本轮**没有**补断言：假 db 在 `update()` 调用点同步记账，
 * 看不见微任务边界，硬凑一条只会是自证。现有兜底是链级用例
 * （`test/e2e/plan-reject-authority.e2e.spec.ts:145-146` 真库数 cancelled 行数、
 *  `test/e2e/dispatch-receipt-concurrency.e2e.spec.ts:254` 真库数 dispatched 存量）。
 */
/// <reference types="jest" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  advanceAssignmentByCAS,
  cancelAssignmentByCAS,
  dispatchAssignmentByCAS,
  projectAssignmentsApproved,
  projectAssignmentsCancelled,
} from '../scheduling-assignment.lifecycle';

type Captured = {
  patch: Record<string, unknown>;
  where: unknown[];
  returning: boolean;
  /** `.returning(...)` 的实参原样留存：RETURNING 选了哪几列假 db 看得见（G1）。 */
  returningSelection: unknown[];
  updates: number;
};

function makeDb(rows: Array<Record<string, unknown>>) {
  const captured: Captured = {
    patch: {}, where: [], returning: false, returningSelection: [], updates: 0,
  };
  const tail = () => {
    const res = {
      then: (onf: (v: unknown) => unknown, rj?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(onf, rj),
      returning: (...args: unknown[]) => {
        captured.returning = true;
        captured.returningSelection = args;
        return Promise.resolve(rows);
      },
    };
    return res;
  };
  const db = {
    update: jest.fn(() => {
      captured.updates += 1;
      return {
        set: (patch: Record<string, unknown>) => {
          captured.patch = patch;
          return {
            where: (...args: unknown[]) => {
              captured.where = args;
              return tail();
            },
          };
        },
      };
    }),
  };
  return { db: db as never, captured };
}

// drizzle 的 SQL 对象不能直接 JSON.stringify（列→表→列成环）：剥掉回指键后按文本核对。
const render = (where: unknown[]) =>
  JSON.stringify(where, (key, value) => (key === 'table' || key === 'parent' ? undefined : value));

/**
 * 比较谓词计数：drizzle 把 `eq(col, v)` 渲染成 queryChunks `[", col, " = ", Param, ""]`，
 * 把 `and(a, b)` 渲染成 `[ "(", a, " and ", b, ")" ]`。
 * ⇒ "树里直接挂着 Param 子节点的 SQL 节点数" 就是等值比较谓词的条数（`isNull` 无 Param，不计）。
 * 数不出来时得到 0，与本文件其余断言同样会响亮地红，不会假绿。
 */
function countComparisonPredicates(where: unknown[]): number {
  let n = 0;
  const isParam = (node: unknown): boolean =>
    !!node && typeof node === 'object'
    && (node as { constructor?: { name?: string } }).constructor?.name === 'Param';
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    if (chunks.some(isParam)) n += 1;
    chunks.forEach(walk);
  };
  where.forEach(walk);
  return n;
}

/**
 * 等值谓词的「列 ↔ 绑定值」对（G2）：与上面那把计数尺**同源**——drizzle 把 `eq(col, v)` 渲染成
 * queryChunks `["", col, " = ", Param, ""]`，把 `and(a,b)` 渲染成 `["(", a, " and ", b, ")"]`，
 * 所以"直接挂着 Param 子节点的节点"就是等值比较；Param 往前最近的那个带 `name` 的 chunk 是列，
 * `Param.value` 就是调用方传进来的那个标识符（实测读数：`{"value":"PLAN-A-7","encoder":{…}}`）。
 * ⇒ 这一条同时钉住"谓词形状"和"绑定值"：把 `input.planId` 换成字面量、或让字段串门
 *   （`eq(planId, input.orgId)`）、或整条 `and(...)` 少一个条件，这里都红——
 *   而 `toContain('plan_id')` 那一类文本断言对此完全看不见。
 */
function boundEqualityPairs(where: unknown[]): Array<{ column: string; value: unknown }> {
  const pairs: Array<{ column: string; value: unknown }> = [];
  const isParam = (node: unknown): boolean =>
    !!node && typeof node === 'object'
    && (node as { constructor?: { name?: string } }).constructor?.name === 'Param';
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    const at = chunks.findIndex(isParam);
    if (at >= 0) {
      let column = '<未识别>';
      for (let i = at - 1; i >= 0; i -= 1) {
        const name = (chunks[i] as { name?: unknown }).name;
        if (typeof name === 'string') {
          column = name;
          break;
        }
      }
      pairs.push({ column, value: (chunks[at] as { value: unknown }).value });
    }
    chunks.forEach(walk);
  };
  where.forEach(walk);
  return pairs;
}

/** `.returning(...)` 实参的形状（G1）：只取"第 0 个实参的键集"，列身份再由 render() 的文本核对。 */
function returningSelectionKeys(selection: unknown[]): string[] {
  const first = selection[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return [];
  return Object.keys(first).sort();
}

/* ── 形状不倒退那两条用的尺子：仓里那把 AST 判据（status-write-guard-census）本尊，
      不在这里重抄一套文本判据——重抄的就是 V278 栽过的那种"看着像守卫、其实读空"的量具。 ── */
const REPO_ROOT = resolve(__dirname, '../../../../..');
const LIFECYCLE_SRC = resolve(__dirname, '../scheduling-assignment.lifecycle.ts');
const ASSIGNMENT_TABLES = new Set(['ewohSchedulingPlanAssignment']);

type CensusSite = {
  file: string;
  line: number;
  table: string;
  guard: 'state-guard' | 'identity-only' | 'dynamic-where' | 'no-where';
  writesStatus: 'yes' | 'no' | 'dynamic' | 'no-set';
  valueShape: string | null;
  partial: boolean;
};
type ClassifySource = (src: string, fileName: string, tableSet: Set<string>) => CensusSite[];

function censusClassifier(): ClassifySource {
  const mod = require(resolve(REPO_ROOT, 'scripts/chain-baseline/status-write-guard-census.cjs')) as {
    classifySource: ClassifySource;
  };
  return mod.classifySource;
}

/** 本模块里"确实写了 status/state 列"的 UPDATE 站点（与尺子给产品面出的分母同口径）。 */
function assignmentSites(classifySource: ClassifySource): CensusSite[] {
  return classifySource(
    readFileSync(LIFECYCLE_SRC, 'utf8'),
    'scheduling-assignment.lifecycle.ts',
    ASSIGNMENT_TABLES,
  ).filter((s) => s.writesStatus === 'yes' || s.writesStatus === 'dynamic');
}

describe('projectAssignmentsApproved／Cancelled（审批与拒绝的投影级联）', () => {
  it('带租户：写 approved 字面值，谓词只有 plan_id + org_id——**没有**来源态谓词（这是投影的身份证据）', async () => {
    const { db, captured } = makeDb([{ id: 1 }]);
    await projectAssignmentsApproved(db, { planId: 'PLAN-1', orgId: 'org1' });
    expect(captured.patch.status).toBe('approved');
    // G8：整对象核对——多一个覆写键（orgId: null／taskId: null）就红
    expect(captured.patch).toEqual({ status: 'approved' });
    const text = render(captured.where);
    expect(text).toContain('plan_id');
    expect(text).toContain('org_id');
    expect(text).not.toContain('status');
    // G2：传进去的两个标识符要落在各自的列上
    expect(boundEqualityPairs(captured.where)).toEqual([
      { column: 'plan_id', value: 'PLAN-1' },
      { column: 'org_id', value: 'org1' },
    ]);
  });

  it('legacy 无租户行（orgId=null）：只剩 plan_id 一条谓词，不退化成无 WHERE 的整表写', async () => {
    const { db, captured } = makeDb([]);
    await projectAssignmentsCancelled(db, { planId: 'PLAN-2', orgId: null });
    expect(captured.patch.status).toBe('cancelled');
    expect(captured.patch).toEqual({ status: 'cancelled' });
    const text = render(captured.where);
    expect(text).toContain('plan_id');
    expect(text).not.toContain('org_id');
    expect(text).not.toContain('status');
    expect(captured.where.length).toBe(1);
    expect(boundEqualityPairs(captured.where)).toEqual([
      { column: 'plan_id', value: 'PLAN-2' },
    ]);
  });

  // V280：org 两个分支从三元拆成两条字面 UPDATE ⇒ 四条分支都要各自钉住，
  // 否则"某一条分支被悄悄改掉"（补 status 守卫、丢 org 条件、变成整表写）看不见。
  it('四条分支逐条核对：每次调用只发被选中的那一条 UPDATE、必带 WHERE，谓词数带租户=2／legacy=1，且都不含 status 谓词', async () => {
    const projections = [
      ['approved', projectAssignmentsApproved] as const,
      ['cancelled', projectAssignmentsCancelled] as const,
    ];
    for (const [status, fn] of projections) {
      const withOrg = makeDb([{ id: 1 }]);
      await fn(withOrg.db, { planId: 'P-1', orgId: 'org1' });
      expect(withOrg.captured.patch.status).toBe(status);
      expect(withOrg.captured.patch).toEqual({ status });
      expect(withOrg.captured.updates).toBe(1);
      expect(withOrg.captured.where.length).toBeGreaterThan(0);
      const withOrgText = render(withOrg.captured.where);
      expect(withOrgText).toContain('plan_id');
      expect(withOrgText).toContain('org_id');
      expect(withOrgText).not.toContain('status');
      expect(countComparisonPredicates(withOrg.captured.where)).toBe(2);
      expect(boundEqualityPairs(withOrg.captured.where)).toEqual([
        { column: 'plan_id', value: 'P-1' },
        { column: 'org_id', value: 'org1' },
      ]);

      const legacy = makeDb([{ id: 1 }]);
      await fn(legacy.db, { planId: 'P-2', orgId: null });
      expect(legacy.captured.patch.status).toBe(status);
      expect(legacy.captured.patch).toEqual({ status });
      expect(legacy.captured.updates).toBe(1);
      expect(legacy.captured.where.length).toBeGreaterThan(0);
      const legacyText = render(legacy.captured.where);
      expect(legacyText).toContain('plan_id');
      expect(legacyText).not.toContain('org_id');
      expect(legacyText).not.toContain('status');
      expect(countComparisonPredicates(legacy.captured.where)).toBe(1);
      expect(boundEqualityPairs(legacy.captured.where)).toEqual([
        { column: 'plan_id', value: 'P-2' },
      ]);
    }
  });

  it('投影"没有 status 谓词"这条否定断言有牙：同一个 render() 读逐条 CAS 时读得到 status', async () => {
    // not.toContain('status') 只有在 render() 确实能把 status 谓词渲染出来时才算证据；
    // 否则它可能只是量具看不见任何东西（V278 的"读空长得像变好了"同一形状）。
    const cas = makeDb([{ id: 1 }]);
    await cancelAssignmentByCAS(cas.db, { assignmentId: 'ASG-1', fromStatus: 'proposed' });
    expect(render(cas.captured.where)).toContain('status');
    expect(countComparisonPredicates(cas.captured.where)).toBe(2);
  });

  // V281 G7：分支测试写的是 `input.orgId == null`（松散相等），⇒ `undefined` 今天走 legacy 分支。
  // 生产两个调用点（plan.service.ts:471／:815）都先 `plan.orgId ?? null` 归一，所以这条现在
  // 打不到活体路径；它钉的是**文档化的那个读法**：改成 `=== null` 之后 undefined 会落进
  // 带租户分支，绑一个 `org_id = <NULL param>` 的谓词 ⇒ 零行命中，而投影返回 void、无人查命中数，
  // 于是"批准／拒绝级联静默不写"。这条用例是防那次改动的常驻村。
  it('orgId 传 undefined：按 `== null` 的文档化读法走 legacy 分支（只一条 UPDATE、WHERE 含 plan_id 不含 org_id）', async () => {
    const projections = [
      ['approved', projectAssignmentsApproved] as const,
      ['cancelled', projectAssignmentsCancelled] as const,
    ];
    for (const [status, fn] of projections) {
      const { db, captured } = makeDb([{ id: 1 }]);
      await fn(db, { planId: `PLAN-UNDEF-${status}`, orgId: undefined as never });
      expect(captured.updates).toBe(1);
      expect(captured.patch).toEqual({ status });
      const text = render(captured.where);
      expect(text).toContain('plan_id');
      expect(text).not.toContain('org_id');
      expect(text).not.toContain('status');
      expect(countComparisonPredicates(captured.where)).toBe(1);
      expect(boundEqualityPairs(captured.where)).toEqual([
        { column: 'plan_id', value: `PLAN-UNDEF-${status}` },
      ]);
    }
  });
});

describe('三个逐条 CAS 入口', () => {
  it('取消：assignmentId + status 双谓词，命中返回行、0 命中返回空数组且不抛断', async () => {
    const hit = makeDb([{ id: 7 }]);
    await expect(
      cancelAssignmentByCAS(hit.db, { assignmentId: 'ASG-1', fromStatus: 'dispatched' }),
    ).resolves.toHaveLength(1);
    expect(hit.captured.patch).toEqual({ status: 'cancelled' });
    const text = render(hit.captured.where);
    expect(text).toContain('assignment_id');
    expect(text).toContain('status');
    expect(text).toContain('dispatched');
    // G1：这条入口靠 rows.length 判 CAS 成败，删掉 .returning() ⇒ drizzle 返回空数组 ⇒
    //      调用方把正常更新误报成 ASSIGNMENT_CONCURRENT_UPDATE。假 db 是 thenable，
    //      删了它这 10 条旧断言全绿，所以必须在这里显式钉住。
    expect(hit.captured.returning).toBe(true);
    // G2：两个绑定值分别是传进来的 assignmentId 与 fromStatus
    expect(boundEqualityPairs(hit.captured.where)).toEqual([
      { column: 'assignment_id', value: 'ASG-1' },
      { column: 'status', value: 'dispatched' },
    ]);

    const miss = makeDb([]);
    await expect(
      cancelAssignmentByCAS(miss.db, { assignmentId: 'ASG-9', fromStatus: 'dispatched' }),
    ).resolves.toHaveLength(0);
    expect(miss.captured.returning).toBe(true);
    expect(boundEqualityPairs(miss.captured.where)).toEqual([
      { column: 'assignment_id', value: 'ASG-9' },
      { column: 'status', value: 'dispatched' },
    ]);
  });

  it('派工：写 dispatched + version 自增，谓词含 assignment_id/status/version，org 条件原样透传', async () => {
    const { db, captured } = makeDb([{ id: 3 }]);
    const orgCondition = { marker: 'ORG_COND' } as never;
    const rows = await dispatchAssignmentByCAS(db, {
      assignmentId: 'ASG-1',
      orgCondition,
      fromStatus: 'approved',
      expectedVersion: 1,
    });
    expect(rows).toHaveLength(1);
    expect(captured.patch).toEqual({ status: 'dispatched', version: 2 });
    const text = render(captured.where);
    expect(text).toContain('assignment_id');
    expect(text).toContain('status');
    expect(text).toContain('version');
    expect(text).toContain('approved');
    expect(text).toContain('ORG_COND');
    expect(captured.returning).toBe(true);
    // G1：派工的 RETURNING 是**带选择**的那条（`.returning({ id: … })`），调用方按 {id} 取行；
    //      退化成裸 .returning() 会把整行读回去，换成别的列则读不到 id。假 db 收得到实参。
    expect(captured.returningSelection).toHaveLength(1);
    expect(returningSelectionKeys(captured.returningSelection)).toEqual(['id']);
    expect(render(captured.returningSelection)).toContain('"columnType":"PgUUID"');
    // G2：三个绑定值都来自入参（version 谓词用的是 expectedVersion 本身，不是 +1 后的值）
    expect(boundEqualityPairs(captured.where)).toEqual([
      { column: 'assignment_id', value: 'ASG-1' },
      { column: 'status', value: 'approved' },
      { column: 'version', value: 1 },
    ]);
  });

  it('回执：id + org_id + status 三谓词，目标态来自调用方，version 走列自增表达式（不是常量）', async () => {
    const { db, captured } = makeDb([{ id: 'row-5' }]);
    const rows = await advanceAssignmentByCAS(db, {
      id: 'row-5',
      orgId: 'org1',
      fromStatus: 'dispatched',
      toStatus: 'executing',
    });
    expect(rows).toHaveLength(1);
    expect(captured.patch.status).toBe('executing');
    expect(typeof captured.patch.version).toBe('object');
    // version 自增是**列表达式**（`col.version + 1`），必须出现在 set 侧而不是调用方传进来的常量
    expect(render([captured.patch.version])).toContain('version');
    // G5：自增的那一步本身要钉住——假 db 读得到 SQL 模板的文本块（实测 chunk 为 `[" + 1"]`），
    //      所以 `sql\`t.version\``（漏 +1）与 `+ 2` 都在这里红，不必退到真方言夹具。
    expect(render([captured.patch.version])).toContain('[" + 1"]');
    // G8：set 侧只许这两个键（多一个 orgId/taskId 覆写就红）
    expect(Object.keys(captured.patch).sort()).toEqual(['status', 'version']);
    const text = render(captured.where);
    expect(text).toContain('org_id');
    expect(text).toContain('status');
    expect(text).toContain('dispatched');
    // G1：同取消，这条也靠 rows.length 判成败
    expect(captured.returning).toBe(true);
    expect(boundEqualityPairs(captured.where)).toEqual([
      { column: 'id', value: 'row-5' },
      { column: 'org_id', value: 'org1' },
      { column: 'status', value: 'dispatched' },
    ]);
  });
});

describe('绑定值逐入口钉死（V281 G2：硬编码常量与字段串门都要红）', () => {
  // 上面每个用例的断言已经按各自的字面量核过一遍，但它们的字面量彼此**相撞**
  // （`fromStatus: 'dispatched'`、`'approved'` 正是目标态词表里的值），于是
  // `eq(status, 'dispatched')` 这种"把入参写成常量"的改动在那几条里读起来是合规的。
  // 这一条把 7 个写点各喂一套互不相撞的字面量（含 `FROMST-*` 哨兵来源态与 expectedVersion 4），
  // 常量、串门（`eq(plan_id, input.orgId)`）、少一个条件，三种退化在这里都无处藏。
  it('七个写点各喂一套不相撞的字面量：列 ↔ 绑定值逐对核对，set 侧形状与 RETURNING 一并核对', async () => {
    const appOrg = makeDb([{ id: 1 }]);
    await projectAssignmentsApproved(appOrg.db, { planId: 'PLAN-A-7', orgId: 'ORG-B-3' });
    expect(appOrg.captured.updates).toBe(1);
    expect(appOrg.captured.patch).toEqual({ status: 'approved' });
    expect(boundEqualityPairs(appOrg.captured.where)).toEqual([
      { column: 'plan_id', value: 'PLAN-A-7' },
      { column: 'org_id', value: 'ORG-B-3' },
    ]);

    const appLegacy = makeDb([{ id: 1 }]);
    await projectAssignmentsApproved(appLegacy.db, { planId: 'PLAN-A-8', orgId: null });
    expect(appLegacy.captured.updates).toBe(1);
    expect(appLegacy.captured.patch).toEqual({ status: 'approved' });
    expect(boundEqualityPairs(appLegacy.captured.where)).toEqual([
      { column: 'plan_id', value: 'PLAN-A-8' },
    ]);

    const canOrg = makeDb([{ id: 1 }]);
    await projectAssignmentsCancelled(canOrg.db, { planId: 'PLAN-A-9', orgId: 'ORG-B-10' });
    expect(canOrg.captured.updates).toBe(1);
    expect(canOrg.captured.patch).toEqual({ status: 'cancelled' });
    expect(boundEqualityPairs(canOrg.captured.where)).toEqual([
      { column: 'plan_id', value: 'PLAN-A-9' },
      { column: 'org_id', value: 'ORG-B-10' },
    ]);

    const canLegacy = makeDb([{ id: 1 }]);
    await projectAssignmentsCancelled(canLegacy.db, { planId: 'PLAN-A-11', orgId: null });
    expect(canLegacy.captured.updates).toBe(1);
    expect(canLegacy.captured.patch).toEqual({ status: 'cancelled' });
    expect(boundEqualityPairs(canLegacy.captured.where)).toEqual([
      { column: 'plan_id', value: 'PLAN-A-11' },
    ]);

    const cancel = makeDb([{ id: 1 }]);
    await cancelAssignmentByCAS(cancel.db, {
      assignmentId: 'ASG-C-12', fromStatus: 'FROMST-C-13',
    });
    expect(cancel.captured.updates).toBe(1);
    expect(cancel.captured.patch).toEqual({ status: 'cancelled' });
    expect(cancel.captured.returning).toBe(true);
    expect(boundEqualityPairs(cancel.captured.where)).toEqual([
      { column: 'assignment_id', value: 'ASG-C-12' },
      { column: 'status', value: 'FROMST-C-13' },
    ]);

    const dispatch = makeDb([{ id: 1 }]);
    await dispatchAssignmentByCAS(dispatch.db, {
      assignmentId: 'ASG-C-14',
      orgCondition: { marker: 'ORG_COND_C14' } as never,
      fromStatus: 'FROMST-C-15',
      expectedVersion: 4,
    });
    expect(dispatch.captured.updates).toBe(1);
    expect(dispatch.captured.returning).toBe(true);
    expect(dispatch.captured.returningSelection).toHaveLength(1);
    expect(returningSelectionKeys(dispatch.captured.returningSelection)).toEqual(['id']);
    expect(dispatch.captured.patch).toEqual({ status: 'dispatched', version: 5 });
    expect(boundEqualityPairs(dispatch.captured.where)).toEqual([
      { column: 'assignment_id', value: 'ASG-C-14' },
      { column: 'status', value: 'FROMST-C-15' },
      { column: 'version', value: 4 },
    ]);
    expect(render(dispatch.captured.where)).toContain('ORG_COND_C14');

    const advance = makeDb([{ id: 1 }]);
    await advanceAssignmentByCAS(advance.db, {
      id: 'ROW-D-16', orgId: 'ORG-B-17', fromStatus: 'FROMST-D-18', toStatus: 'executing',
    });
    expect(advance.captured.updates).toBe(1);
    expect(advance.captured.returning).toBe(true);
    expect(Object.keys(advance.captured.patch).sort()).toEqual(['status', 'version']);
    expect(advance.captured.patch.status).toBe('executing');
    expect(render([advance.captured.patch.version])).toContain('[" + 1"]');
    expect(boundEqualityPairs(advance.captured.where)).toEqual([
      { column: 'id', value: 'ROW-D-16' },
      { column: 'org_id', value: 'ORG-B-17' },
      { column: 'status', value: 'FROMST-D-18' },
    ]);
  });
});

describe('回执目标态封闭（V286）', () => {
  // 目标态从参数化收成封闭字面分支后，"词表里不是回执目标的 4 个值"必须被拒在写库之前。
  // 这一支是本轮唯一语义收紧的常驻位点（可达性上是空集：调用方那张映射只产出 5 个值）。
  it('非回执状态抛错且一条 UPDATE 都不发', async () => {
    const { db, captured } = makeDb([]);
    await expect(
      advanceAssignmentByCAS(db, {
        id: 'ROW-E-19', orgId: 'ORG-E-20', fromStatus: 'dispatched', toStatus: 'acknowledged',
      }),
    ).rejects.toThrow('ASSIGNMENT_RECEIPT_TARGET_NOT_ALLOWED');
    expect(captured.updates).toBe(0);
  });
});

describe('形状不倒退（V278 教训的常驻面）', () => {
  it('五个入口各自只发一条 UPDATE，且状态值始终出现在 set 侧字面位置', async () => {
    const a = makeDb([{ id: 1 }]);
    await projectAssignmentsApproved(a.db, { planId: 'P', orgId: 'o' });
    const b = makeDb([{ id: 1 }]);
    await dispatchAssignmentByCAS(b.db, {
      assignmentId: 'A', orgCondition: undefined, fromStatus: 'approved', expectedVersion: 1,
    });
    expect(a.captured.updates).toBe(1);
    expect(b.captured.updates).toBe(1);
    // 状态值必须在 set(...) 的字面字段上（被参数化成变量会让两道按字面量认守卫的测量读空）
    expect(typeof b.captured.patch.status).toBe('string');
    expect(b.captured.patch.status).toBe('dispatched');
  });

  it('四个投影分支不许收回成一个三元：仓里的 AST 尺子重读本模块，dynamic-where 必须为 0', () => {
    // 三元写法在运行时与拆分后同形（都只发一条 UPDATE、同一批谓词），所以**运行时断言看不见这次回退**——
    // 只有按 AST 读的那把尺子看得见。这里直接复用它，而不是在本文件重抄一套文本判据。
    const classifySource = censusClassifier();
    const sites = assignmentSites(classifySource);
    expect(sites.map((s) => s.guard)).not.toContain('dynamic-where');
    // 拆分的代价与收益都钉在数上：V280 那版是写点 5→7（投影 4 处从"看不见"变成 identity-only、逐条 CAS 3 处不动）；
    // V286 把回执腿的参数化目标态收成 5 条字面分支 ⇒ 写点 7→11，state-guard 3→7（新增的 4 条都是同一 CAS 的形状），
    // identity-only 4 不动，dynamic-where 仍为 0。**这两组数是现状基线不是应然**：若日后把 5 条分支合回参数化写法，
    // 长度与 state-guard 两条会同时掉，而"dynamic-where 为 0"这条形状不变量仍绿——所以两条数都要留着。
    expect(sites).toHaveLength(11);
    expect(sites.filter((s) => s.guard === 'identity-only')).toHaveLength(4);
    expect(sites.filter((s) => s.guard === 'state-guard')).toHaveLength(7);
    // 一条都不许是无 WHERE 的整表写
    expect(sites.filter((s) => s.guard === 'no-where')).toHaveLength(0);
  });

  it('反向对照：上面那把尺子在本模块上确实开火（三元必须读成 dynamic-where、字面双分支必须读成 identity-only）', () => {
    // 少了这条，上一条可能只是"尺子读不到任何站点"而恒绿——读空在棘轮上长得像变好了（V278 实测）。
    const classifySource = censusClassifier();
    const ternary = "db.update(ewohSchedulingPlanAssignment).set({ status: 'approved' })"
      + '.where(input.orgId == null'
      + ' ? eq(ewohSchedulingPlanAssignment.planId, input.planId)'
      + ' : and(eq(ewohSchedulingPlanAssignment.planId, input.planId),'
      + ' eq(ewohSchedulingPlanAssignment.orgId, input.orgId)));';
    const collapsed = classifySource(ternary, 'fixture-ternary.ts', ASSIGNMENT_TABLES)
      .filter((s) => s.writesStatus === 'yes');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].guard).toBe('dynamic-where');

    const split = "db.update(ewohSchedulingPlanAssignment).set({ status: 'approved' })"
      + '.where(eq(ewohSchedulingPlanAssignment.planId, input.planId));'
      + "\ndb.update(ewohSchedulingPlanAssignment).set({ status: 'approved' })"
      + '.where(and(eq(ewohSchedulingPlanAssignment.planId, input.planId),'
      + ' eq(ewohSchedulingPlanAssignment.orgId, input.orgId)));';
    const written = classifySource(split, 'fixture-split.ts', ASSIGNMENT_TABLES)
      .filter((s) => s.writesStatus === 'yes');
    expect(written).toHaveLength(2);
    expect(written.map((s) => s.guard)).toEqual(['identity-only', 'identity-only']);
  });
});
