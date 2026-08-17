/**
 * fake-resource-db.ts — ResourceService drizzle 链式语义假库（ADR-081，§31 单一测试助手）。
 *
 * 语义覆盖 ewoh_resource_preorder / ewoh_resource_binding 两表最小事实：
 *  - insert values（snake_case 归一 + SQL 标量解包；returning 回读本行）；
 *  - onConflictDoUpdate（种子库存 upsert，键 org_id/resource_id/target_id/binding_type）；
 *  - select where（条件 AST 结构遍历提取 = / in / >= 事实，limit 截断）；
 *  - update set where（补丁求值：绝对标量 + quantity 相对 +/- SQL；gte 守卫零行——
 *    服务发放扣减“条件更新零行即拒绝”依赖此语义）。
 * drizzle AST 含循环引用（列→表→列），禁止 JSON 序列化，直接遍历 queryChunks。
 * 供 resource.service.spec 与 scenario-packages.spec（SP-02）共用。
 */
import { ewohResourcePreorder, ewohResourceBinding } from '@server/database/schema';

interface FakeResourceDb {
  db: unknown;
  preorderRows: Array<Record<string, unknown>>;
  bindingRows: Array<Record<string, unknown>>;
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown>; cond: unknown }>;
}

interface Fact {
  name: string;
  op: string;
  right: unknown;
}

const PREORDER_COLS: Record<string, string> = {
  preorderId: 'preorder_id',
  resourceType: 'resource_type',
  resourceId: 'resource_id',
  quantity: 'quantity',
  reservedQty: 'reserved_qty',
  issuedQty: 'issued_qty',
  consumedQty: 'consumed_qty',
  returnedQty: 'returned_qty',
  unit: 'unit',
  batchNo: 'batch_no',
  taskId: 'task_id',
  taskStepId: 'task_step_id',
  status: 'status',
  priority: 'priority',
  startTime: 'start_time',
  endTime: 'end_time',
  orgId: 'org_id',
  createdAt: '_created_at',
  updatedAt: '_updated_at',
};

const BINDING_COLS: Record<string, string> = {
  bindingId: 'binding_id',
  bindingType: 'binding_type',
  resourceType: 'resource_type',
  resourceId: 'resource_id',
  targetType: 'target_type',
  targetId: 'target_id',
  startTime: 'start_time',
  endTime: 'end_time',
  reason: 'reason',
  status: 'status',
  operatorId: 'operator_id',
  quantity: 'quantity',
  version: 'version',
  orgId: 'org_id',
  createdAt: '_created_at',
  updatedAt: '_updated_at',
};

function colsOf(table: unknown): Record<string, string> {
  return table === ewohResourcePreorder ? PREORDER_COLS : BINDING_COLS;
}

/** SQL 包装值 → 标量（queryChunks 中第一个非空标量；无则 undefined）。 */
function unwrapScalar(v: unknown): unknown {
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o && (typeof o.value === 'string' || typeof o.value === 'number')) {
      return o.value;
    }
    if (Array.isArray(o.queryChunks)) {
      for (const c of o.queryChunks as unknown[]) {
        const u = unwrapScalar(c);
        if (u !== undefined && !(typeof u === 'string' && u.trim() === '')) return u;
      }
    }
  }
  return undefined;
}

/** 条件 AST 遍历：COL → {value:[op]} → 右操作数（标量/参数/数组/嵌套 SQL）。 */
function collectFacts(cond: unknown): Fact[] {
  const facts: Fact[] = [];
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const o = node as Record<string, unknown>;
    if (!Array.isArray(o.queryChunks)) return;
    const chunks = o.queryChunks as unknown[];
    let col: string | null = null;
    let op: string | null = null;
    for (const c of chunks) {
      const co = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
      if (co && typeof co.name === 'string' && !('queryChunks' in co)) {
        col = co.name;
        op = null;
        continue;
      }
      if (co && Array.isArray(co.value)) {
        const text = (co.value as unknown[]).join('').trim();
        if (col !== null && ['=', '!=', '>', '>=', '<', '<=', 'in'].includes(text)) {
          op = text;
        }
        continue;
      }
      if (col !== null && op !== null) {
        if (typeof c === 'number' || typeof c === 'string' || typeof c === 'boolean') {
          facts.push({ name: col, op, right: c });
          col = op = null;
          continue;
        }
        if (Array.isArray(c)) {
          facts.push({ name: col, op, right: c.map(unwrapScalar) });
          col = op = null;
          continue;
        }
        if (co && 'value' in co && (typeof co.value === 'string' || typeof co.value === 'number')) {
          facts.push({ name: col, op, right: co.value });
          col = op = null;
          continue;
        }
        if (co && Array.isArray(co.queryChunks)) {
          facts.push({ name: col, op, right: unwrapScalar(co) });
          col = op = null;
          continue;
        }
      }
      if (co && Array.isArray(co.queryChunks)) {
        walk(c);
      }
    }
  };
  walk(cond);
  return facts;
}

function matchFact(row: Record<string, unknown>, fact: Fact): boolean {
  const actual = row[fact.name];
  const a = typeof actual === 'number' ? actual : Number(actual ?? 0);
  const r = typeof fact.right === 'number' ? fact.right : Number(fact.right);
  switch (fact.op) {
    case '=':
      return String(actual ?? '') === String(fact.right);
    case '!=':
      return String(actual ?? '') !== String(fact.right);
    case 'in':
      return Array.isArray(fact.right) && fact.right.map(String).includes(String(actual ?? ''));
    case '>':
      return a > r;
    case '>=':
      return a >= r;
    case '<':
      return a < r;
    case '<=':
      return a <= r;
    default:
      return true;
  }
}

/** set 补丁值求值：标量直通；SQL 相对 +/- 基于当前值；其余解包标量。 */
function evalSetValue(current: unknown, patch: unknown): unknown {
  if (
    patch === null ||
    typeof patch === 'undefined' ||
    typeof patch === 'number' ||
    typeof patch === 'string' ||
    typeof patch === 'boolean'
  ) {
    return patch;
  }
  if (patch && typeof patch === 'object') {
    const o = patch as Record<string, unknown>;
    if (Array.isArray(o.queryChunks)) {
      let op: string | null = null;
      let operand: number | null = null;
      for (const c of o.queryChunks as unknown[]) {
        const co = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
        if (co && Array.isArray(co.value)) {
          const t = (co.value as unknown[]).join('').trim();
          if (t === '-' || t === '+') op = t;
          continue;
        }
        if (typeof c === 'number') operand = c;
        else if (co && 'value' in co && typeof co.value === 'number') operand = co.value;
      }
      if (op !== null && operand !== null) {
        const base = Number(current ?? 0);
        return op === '-' ? base - operand : base + operand;
      }
      return unwrapScalar(patch) ?? current;
    }
  }
  return patch;
}

function toSnake(table: unknown, row: Record<string, unknown>): Record<string, unknown> {
  const cols = colsOf(table);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const snakeKey = cols[key] ?? key;
    out[snakeKey] = unwrapScalar(value);
  }
  return out;
}

function toSnakePatch(table: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const cols = colsOf(table);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    out[cols[key] ?? key] = value;
  }
  return out;
}

const SEED_KEY_COLS = ['org_id', 'resource_id', 'target_id', 'binding_type'];

export function makeResourceDb(
  seed: {
    preorders?: Array<Record<string, unknown>>;
    bindings?: Array<Record<string, unknown>>;
    failSelect?: boolean;
  } = {},
): FakeResourceDb {
  const preorderRows: Array<Record<string, unknown>> = (seed.preorders ?? []).map((r) => ({ ...r }));
  const bindingRows: Array<Record<string, unknown>> = (seed.bindings ?? []).map((r) => ({ ...r }));
  const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown>; cond: unknown }> = [];

  const rowsOf = (table: unknown): Array<Record<string, unknown>> =>
    table === ewohResourcePreorder ? preorderRows : bindingRows;

  // NEST-631：createPreorder 事务（pg_advisory_xact_lock 串行化「检查-插入」）。
  // fake 以互斥队列模拟 advisory lock 的串行效果（并发预占不再交错读到同一库存）。
  let txChain: Promise<unknown> = Promise.resolve();
  const transaction = jest.fn((op: (tx: unknown) => Promise<unknown>) => {
    const run = txChain.then(() => op(db));
    txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });

  const db = {
    // pg_advisory_xact_lock 等 raw SQL（fake no-op）。
    execute: jest.fn().mockResolvedValue([]),
    transaction,
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        const snake = toSnake(table, row);
        inserts.push({ table, row: { ...snake } });
        rowsOf(table).push(snake);
        return {
          returning: jest.fn(() => Promise.resolve([snake])),
          onConflictDoUpdate: jest.fn(
            (opts: { target?: unknown[]; set: Record<string, unknown> }) => {
              const patch = toSnakePatch(table, opts.set ?? {});
              const rows = rowsOf(table);
              const index = rows.indexOf(snake);
              const existing = rows.find(
                (r) =>
                  r !== snake &&
                  SEED_KEY_COLS.every((k) => (r[k] ?? null) === (snake[k] ?? null)),
              );
              if (existing) {
                rows.splice(index, 1);
                for (const [key, value] of Object.entries(patch)) {
                  existing[key] = evalSetValue(existing[key], value);
                }
              } else {
                for (const [key, value] of Object.entries(patch)) {
                  snake[key] = evalSetValue(snake[key], value);
                }
              }
              return Promise.resolve([]);
            },
          ),
        };
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (seed.failSelect) {
          const q: any = Promise.reject(new Error('connection refused'));
          q.where = () => q;
          q.limit = () => q;
          return q;
        }
        const rows = rowsOf(table).slice();
        const q: any = Promise.resolve(rows);
        q.where = (cond: unknown) => {
          const facts = collectFacts(cond);
          const filtered = rows.filter((r) => facts.every((f) => matchFact(r, f)));
          const w: any = Promise.resolve(filtered);
          w.limit = (n: number) => Promise.resolve(filtered.slice(0, n));
          return w;
        };
        q.limit = (n: number) => Promise.resolve(rows.slice(0, n));
        return q;
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const facts = collectFacts(cond);
          const matched = rowsOf(table).filter((r) => facts.every((f) => matchFact(r, f)));
          const snakePatch = toSnakePatch(table, patch);
          for (const row of matched) {
            for (const [key, value] of Object.entries(snakePatch)) {
              row[key] = evalSetValue(row[key], value);
            }
          }
          updates.push({ table, set: { ...snakePatch }, cond });
          const p: any = Promise.resolve(matched);
          // R2-SNZ-010：issue/release 的 CAS 更新经 returning 全列回读映射——
          // fake 返回命中行整行拷贝（原先恒只回 {quantity}，增量更新后
          // issuedQty 等字段映射为 NaN）。
          p.returning = jest.fn(() =>
            Promise.resolve(matched.map((r) => ({ ...r }))),
          );
          return p;
        }),
      })),
    })),
  };
  return { db, preorderRows, bindingRows, inserts, updates };
}
