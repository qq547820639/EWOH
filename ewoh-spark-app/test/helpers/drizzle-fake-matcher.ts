/**
 * drizzle-fake-matcher.ts — 假 DB 的条件求值助手（测试用）。
 *
 * 为什么要有这个文件：项目里已经**三次**踩到"假 DB 的谓词求值悄悄漏掉条件"：
 *   1. 通知服务 spec 的"按值嗅探"匹配器把未知取值当成"没有条件"（`status='paused'` 过滤消失）；
 *   2. `inArray` 的右值是**裸数组 chunk**（元素还是 Param 包装），不处理就整条条件失效；
 *   3. `like` 的字面量会被 drizzle **内联成裸字符串 chunk**，只处理对象 chunk 会静默丢掉它。
 * 三次的表现都一样：**测试通过，但条件根本没生效**——比断言失败危险得多。
 *
 * 因此把"按列名递归求值 drizzle 条件"收敛到一处，并自带单元测试
 * （`drizzle-fake-matcher.spec.ts`）：新写的假 DB 直接用，不再各写一套。
 *
 * 支持：eq / ne / inArray（含 Param 元素）/ isNull / isNotNull / like（含 `\%` `\_` 转义与
 * 内联字面量）/ gt / gte / lt / lte / and / or。未识别的形态**抛错**而不是放行——
 * 宁可让测试因为"替身不认识这个条件"而失败，也不要让它悄悄匹配所有行。
 */

export type Row = Record<string, unknown>;

/** SQL LIKE 模式 → 正则（PostgreSQL 语义：`\x` 字面量、`%` 任意串、`_` 任意单字符）。 */
export function likePatternToRegExp(pattern: string): RegExp {
  const escapeRegex = (ch: string): string => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch);
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1]!);
      i += 1;
    } else if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += escapeRegex(ch);
  }
  return new RegExp(`^${out}$`);
}

/** 比较用的字符串化（与 SQL 的隐式转换保持一致：uuid/varchar 都按文本比较）。 */
function text(value: unknown): string {
  return value == null ? '' : String(value);
}

interface Chunk {
  name?: string;
  value?: unknown;
  encoder?: unknown;
  queryChunks?: unknown[];
}

/**
 * 生成一个 `matches(cond, row)` 谓词求值器。
 *
 * @param colToKey 列名 → 行字段名（drizzle 的列名是 SQL 名，行对象是 camelCase）。
 */
export function makeConditionMatcher(colToKey: Record<string, string>) {
  const keyOf = (col: string): string => colToKey[col] ?? col;

  const unknownShape = (detail: unknown): Error =>
    new Error(
      `drizzle-fake-matcher: 无法识别的条件形态 ${JSON.stringify(
        typeof detail === 'string' ? { text: detail.slice(0, 80) } : detail,
      )}`,
    );

  return function matches(cond: unknown, row: Row): boolean {
    const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
    if (!Array.isArray(chunks)) return true;
    // 每组是 OR 的一个分支；组内条件是 AND。
    const groups: boolean[][] = [[]];
    let pendingCol: string | null = null;
    let pendingOp: 'eq' | 'ne' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' = 'eq';

    const push = (value: boolean) => groups[groups.length - 1]!.push(value);
    const compare = (op: typeof pendingOp, actual: unknown, expected: unknown): boolean => {
      if (Array.isArray(expected)) {
        const candidates = expected.map((v) =>
          v && typeof v === 'object' && 'value' in v ? text((v as { value: unknown }).value) : text(v),
        );
        return candidates.includes(text(actual));
      }
      // 大小比较：两边都是数字（或纯数字串）时按数值比较，否则按文本比较
      // （PostgreSQL 的 varchar 比较就是字典序；时间戳按 ISO 文本比较同样单调）。
      const ordered = (
        a: unknown,
        b: unknown,
        cmp: (x: number, y: number) => boolean,
        cmpText: (x: string, y: string) => boolean,
      ): boolean => {
        if (a == null || b == null) return false;
        // Date 必须按时间戳比较：`String(date)` 是本地化文本，跨时区/跨格式比较会失真
        // （2026-09-12 实测：timestamptz 列的 gte 条件在 Date 行上恒为 false，
        //  表现为"替身把行全过滤掉"，而真实 PG 明明命中）。
        const unwrap = (v: unknown): unknown =>
          v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)
            ? (v as { value: unknown }).value
            : v;
        const av0 = unwrap(a);
        const bv0 = unwrap(b);
        const av = av0 instanceof Date ? av0.getTime() : av0;
        const bv = bv0 instanceof Date ? bv0.getTime() : bv0;
        const an = typeof av === 'number' ? av : Number(String(av));
        const bn = typeof bv === 'number' ? bv : Number(String(bv));
        if (Number.isFinite(an) && Number.isFinite(bn)) return cmp(an, bn);
        return cmpText(text(a), text(b));
      };
      switch (op) {
        case 'ne':
          return text(actual) !== text(expected);
        case 'like':
          return actual != null && likePatternToRegExp(text(expected)).test(text(actual));
        case 'gt':
          return ordered(actual, expected, (x, y) => x > y, (x, y) => x > y);
        case 'gte':
          return ordered(actual, expected, (x, y) => x >= y, (x, y) => x >= y);
        case 'lt':
          return ordered(actual, expected, (x, y) => x < y, (x, y) => x < y);
        case 'lte':
          return ordered(actual, expected, (x, y) => x <= y, (x, y) => x <= y);
        default:
          return actual != null && text(actual) === text(expected);
      }
    };

    for (const raw of chunks) {
      // drizzle 内联的字面量 / SQL 片段（例如 `like` 的模式）是裸字符串。
      if (typeof raw === 'string') {
        if (pendingCol && (pendingOp === 'like' || /\b(like|ilike)\b/i.test(raw))) {
          if (pendingOp !== 'like') pendingOp = 'like';
          else {
            push(compare('like', row[keyOf(pendingCol)], raw));
            pendingCol = null;
            pendingOp = 'eq';
          }
        } else if (/\blike\b/i.test(raw)) {
          pendingOp = 'like';
        }
        continue;
      }
      if (Array.isArray(raw)) {
        // `inArray(col, [...])` 的右值：裸数组，元素是 Param 包装。
        if (pendingCol) {
          push(compare(pendingOp === 'eq' ? 'eq' : pendingOp, row[keyOf(pendingCol)], raw));
          pendingCol = null;
          pendingOp = 'eq';
        }
        continue;
      }
      const c = raw as Chunk | undefined;
      if (!c || typeof c !== 'object') continue;
      // 列引用：有 name 且不是参数（参数带 encoder）。
      if (typeof c.name === 'string' && !('encoder' in c)) {
        pendingCol = c.name;
        pendingOp = 'eq';
        continue;
      }
      if (!('encoder' in c)) {
        const rawText = Array.isArray(c.value)
          ? (c.value as unknown[]).every((v) => typeof v === 'string')
            ? (c.value as string[]).join('')
            : null
          : typeof c.value === 'string'
            ? c.value
            : null;
        if (rawText !== null) {
          // SQL 片段归一化后**显式**匹配已知操作符；未知片段一律抛错
          // （宁可让替身失败，也不要让"条件没生效"伪装成测试通过）。
          const compact = rawText.replace(/\s+/g, ' ').trim().toLowerCase();
          if (compact === '' || compact === '(' || compact === ')' || compact === 'and') continue;
          if (compact === 'or') {
            groups.push([]);
            continue;
          }
          if (compact === 'is null' && pendingCol) {
            push(row[keyOf(pendingCol)] == null);
            pendingCol = null;
            continue;
          }
          if (compact === 'is not null' && pendingCol) {
            push(row[keyOf(pendingCol)] != null);
            pendingCol = null;
            continue;
          }
          // 中性操作符：列仍在途，语义由下一个值决定（等值 / inArray）。
          if (compact === '=' || compact === 'in') continue;
          if (compact === 'not in') {
            if (!pendingCol) throw unknownShape(rawText);
            pendingOp = 'ne';
            continue;
          }
          if (compact === 'like' || compact === 'not like') {
            if (!pendingCol) throw unknownShape(rawText);
            pendingOp = compact === 'like' ? 'like' : 'ne';
            continue;
          }
          if (compact === '>=' || compact === '<=' || compact === '>' || compact === '<') {
            if (!pendingCol) throw unknownShape(rawText);
            pendingOp = compact === '>=' ? 'gte' : compact === '<=' ? 'lte' : compact === '>' ? 'gt' : 'lt';
            continue;
          }
          if (compact === '<>' || compact === '!=') {
            if (!pendingCol) throw unknownShape(rawText);
            pendingOp = 'ne';
            continue;
          }
          throw unknownShape(rawText);
        }
        if (Array.isArray(c.queryChunks)) {
          push(matches(raw, row));
          continue;
        }
      }
      if ('encoder' in c && 'value' in c && pendingCol) {
        push(compare(pendingOp, row[keyOf(pendingCol)], c.value));
        pendingCol = null;
        pendingOp = 'eq';
        continue;
      }
      // 未识别形态：抛错而不是放行（否则"条件没生效"会伪装成测试通过）。
      throw new Error(
        `drizzle-fake-matcher: 无法识别的条件形态 ${JSON.stringify({
          ctor: (c as { constructor?: { name?: string } }).constructor?.name,
          hasEncoder: 'encoder' in c,
          keys: Object.keys(c as object).slice(0, 8),
        })}`,
      );
    }
    if (pendingCol !== null) throw unknownShape({ unconsumedColumn: pendingCol, op: pendingOp });
    if (groups.every((g) => g.length === 0)) return true;
    return groups.some((g) => g.every(Boolean));
  };
}
