/// <reference types="jest" />
/* R2-SOP-010 回归：workbench 列表 keyset 游标查询的 OR 谓词必须被括号约束在
 * AND 树内。drizzle 的 and() 只给整个合取包一层括号、不会给每个条件单独加
 * 括号，因此 cursorPredicate 若返回裸 `(...) OR (...)`，序列化后第二个析取支
 * 会脱离 org/状态/人员等全部基础过滤（SQL 中 AND 优先级高于 OR）：
 *   where ((org_id = $1 and status in ...) and (sort > $2) OR (sort = $2 and id > $3))
 * ⇒ 第二页起返回他人工序/已完成工单等本不该出现在该列表里的行；在应用以
 * 表 owner 连接（RLS 不生效）的部署形态下即跨租户数据泄漏。
 * 本测试用真实 drizzle QueryBuilder 捕获生成 SQL，断言 WHERE 顶层不存在
 * 逃逸基础谓词的 OR。 */
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { RoleWorkbenchService } from './role-workbench.service';

type DrizzleSelect = {
  toSQL(): { sql: string };
} & Record<string, (...args: unknown[]) => unknown>;

/** 包一层真实 drizzle select 链：await 时解析为空结果，并把 SQL 记入 captured。 */
function makeRecordingDb() {
  const captured: string[] = [];
  const qb = new QueryBuilder();
  const wrap = (select: DrizzleSelect) => {
    const api: Record<string, unknown> = {
      toSQL: () => select.toSQL(),
      // thenable：count / rows 查询统一解析为 []（本测试只关心生成 SQL），
      // 解析前先留痕当前语句。
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            captured.push(select.toSQL().sql);
            return [] as unknown[];
          })
          .then(resolve, reject),
    };
    for (const method of ['where', 'orderBy', 'limit', 'offset']) {
      api[method] = (...args: unknown[]) => {
        select = select[method](...args) as DrizzleSelect;
        return api;
      };
    }
    return api;
  };
  return {
    captured,
    select: (fields?: unknown) => ({
      from: (table: unknown) =>
        wrap(qb.select(fields as never).from(table as never) as unknown as DrizzleSelect),
    }),
  };
}

/** 若整句被一层冗余括号包裹（drizzle and() 的序列化形态）则剥掉一层。 */
function stripOuterParens(clause: string): string {
  const trimmed = clause.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return trimmed;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '(') depth += 1;
    else if (trimmed[i] === ')') {
      depth -= 1;
      // 首个 '(' 的配对括号在中途出现 ⇒ 外层括号不包裹整句，不再剥。
      if (depth === 0 && i < trimmed.length - 1) return trimmed;
    }
  }
  return trimmed.slice(1, -1);
}

/** 统计子句在括号深度 0 处的 OR 数量：>0 即有析取支逃出了 AND 约束。 */
function topLevelOrCount(clause: string): number {
  const upper = stripOuterParens(clause).toUpperCase();
  let depth = 0;
  let count = 0;
  for (let i = 0; i < upper.length; i += 1) {
    const ch = upper[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && upper.startsWith(' OR ', i)) {
      count += 1;
      i += 3;
    }
  }
  return count;
}

/** 取 SELECT 语句中 where 与 order by 之间的子句。 */
function whereClauseOf(sql: string): string {
  const whereIndex = sql.toLowerCase().indexOf(' where ');
  if (whereIndex < 0) return '';
  const rest = sql.slice(whereIndex + ' where '.length);
  const orderByIndex = rest.toLowerCase().lastIndexOf(' order by ');
  return orderByIndex >= 0 ? rest.slice(0, orderByIndex) : rest;
}

describe('R2-SOP-010: workbench 游标查询 OR 谓词不得逃逸 org 谓词', () => {
  const ACTOR = {
    userId: 'admin-1',
    primaryOrgId: '11111111-1111-4111-8111-111111111111',
    roles: ['global_admin'],
    accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
  };

  it('游标第二页的 WHERE 顶层不得出现 OR（org 谓词必须覆盖全句）', async () => {
    const db = makeRecordingDb();
    const service = new RoleWorkbenchService(db as never);
    const cursor = Buffer.from(
      JSON.stringify({
        sortValue: '2026-01-01T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000000',
      }),
    ).toString('base64url');

    await service.getWorkbenchList('manager', 'delayedOrders', { cursor }, undefined, ACTOR as never);

    // 两条被 await 的查询：count + 游标行页。行页带 limit 21（pageSize+1）。
    expect(db.captured).toHaveLength(2);
    const rowsSql = db.captured.find((sql) => / limit /.test(sql.toLowerCase()));
    expect(rowsSql).toBeDefined();
    const where = whereClauseOf(rowsSql as string);
    // org 谓词必须真实存在。
    expect(where).toContain('org_id');
    // 修复前：((org_id = $1 and ...) and ("plan_end" > $2)) OR ("plan_end" = $2 and ...)
    // ——顶层 OR 使第二个析取支脱离全部基础过滤。
    expect(topLevelOrCount(where)).toBe(0);
  });

  it('offset 模式同样不得出现顶层 OR（保护基础路径不回归）', async () => {
    const db = makeRecordingDb();
    const service = new RoleWorkbenchService(db as never);
    await service.getWorkbenchList('manager', 'delayedOrders', { page: 2, pageSize: 20 }, undefined, ACTOR as never);
    const rowsSql = db.captured.find((sql) => / offset /.test(sql.toLowerCase()));
    expect(rowsSql).toBeDefined();
    expect(topLevelOrCount(whereClauseOf(rowsSql as string))).toBe(0);
  });
});
