/* 通用"提醒 → 处置 → 终态"链接的契约测试（NO-45a）。
 *
 * 覆盖：fail-closed（缺上下文不动数据）、LIKE 前缀转义、范围三重限定、
 * 幂等守卫（resolution IS NULL）、已读行只补痕不改状态、幂等键不覆盖第一次处置。
 * 假 executor 记录 UPDATE 的 set/where，等价性断言通过"按列名求值"完成
 * （不按值嗅探：值嗅探会让"条件没生效"看起来像通过）。
 */
/// <reference types="jest" />
import { escapeLikePattern, resolveNotificationsFor } from '../notification-resolution.link';

interface Row {
  notificationId: string;
  orgId: string;
  externalRef: string | null;
  status: string;
  resolution: string | null;
  resolvedBy?: string | null;
  resolutionRef?: string | null;
  readAt?: Date | null;
}

const COL_TO_KEY: Record<string, keyof Row> = {
  org_id: 'orgId',
  notification_id: 'notificationId',
  external_ref: 'externalRef',
  status: 'status',
  resolution: 'resolution',
};

/** 简化谓词求值：支持 eq / isNull / like（含反斜杠转义）/ and。 */
function matches(cond: unknown, row: Row): boolean {
  const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  let pendingCol: keyof Row | null = null;
  let op: 'eq' | 'like' = 'eq';
  let ok = true;
  /** PostgreSQL LIKE 语义：`\x` = 字面量 x、`%` = 任意串、`_` = 任意单字符。 */
  const likeTest = (actual: unknown, expected: string): boolean => {
    if (actual == null) return false;
    const escapeRegex = (ch: string): string => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch);
    let pattern = '';
    for (let i = 0; i < expected.length; i += 1) {
      const ch = expected[i]!;
      if (ch === '\\' && i + 1 < expected.length) {
        pattern += escapeRegex(expected[i + 1]!);
        i += 1;
      } else if (ch === '%') pattern += '.*';
      else if (ch === '_') pattern += '.';
      else pattern += escapeRegex(ch);
    }
    return new RegExp(`^${pattern}$`).test(String(actual));
  };
  const applyValue = (col: keyof Row, expected: string, useLike: boolean): void => {
    const actual = row[col];
    if (useLike) {
      if (!likeTest(actual, expected)) ok = false;
    } else if (actual == null || String(actual) !== expected) {
      ok = false;
    }
  };
  for (const raw of chunks) {
    // drizzle 会把 `like` 的字面量模式**内联成裸字符串 chunk**：不处理=条件被静默丢掉。
    if (typeof raw === 'string') {
      if (pendingCol && op === 'like') {
        applyValue(pendingCol, raw, true);
        pendingCol = null;
        op = 'eq';
      } else if (/\blike\b/i.test(raw)) {
        op = 'like';
      }
      continue;
    }
    if (Array.isArray(raw)) continue;
    const c = raw as { name?: string; value?: unknown; encoder?: unknown; queryChunks?: unknown[] };
    if (!c || typeof c !== 'object') continue;
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pendingCol = COL_TO_KEY[c.name] ?? (c.name as keyof Row);
      continue;
    }
    if (!('encoder' in c)) {
      const text = Array.isArray(c.value)
        ? (c.value as unknown[]).join('')
        : typeof c.value === 'string'
          ? c.value
          : null;
      if (text !== null) {
        if (/\blike\b/i.test(text)) op = 'like';
        else if (/is\s+null/i.test(text) && pendingCol) {
          if (row[pendingCol] != null) ok = false;
          pendingCol = null;
        }
        continue;
      }
      if (Array.isArray(c.queryChunks)) {
        if (!matches(raw, row)) ok = false;
        continue;
      }
    }
    if ('encoder' in c && 'value' in c && pendingCol) {
      const expected = String(c.value);
      applyValue(pendingCol, expected, op === 'like');
      pendingCol = null;
      op = 'eq';
    }
  }
  return ok;
}

/** 记录每次 UPDATE；`returning` 返回命中行的副本（含 patch），与真实 drizzle 语义一致。 */
function createExecutor(rows: Row[]) {
  const calls: Array<{ patch: Record<string, unknown>; hit: Row[] }> = [];
  const executor = {
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            const hit = rows.filter((r) => matches(cond, r));
            calls.push({ patch, hit: hit.map((r) => ({ ...r })) });
            for (const r of hit) Object.assign(r, patch);
            return hit.map((r) => ({ notificationId: r.notificationId }));
          },
        }),
      }),
    }),
  };
  return { executor: executor as never, calls, rows };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    notificationId: 'NTF-EXO-exo-sessionS1-overdue-app',
    orgId: 'org-a',
    externalRef: 'exo-session:S1',
    status: 'pending',
    resolution: null,
    resolvedBy: null,
    resolutionRef: null,
    ...overrides,
  };
}

const BASE = {
  orgId: 'org-a',
  externalRef: 'exo-session:S1',
  notificationIdPrefix: 'NTF-EXO-',
  resolution: 'session_ended' as const,
  resolvedBy: 'lead.chen',
  resolutionRef: 'exo-session:S1',
};

describe('escapeLikePattern', () => {
  it('转义 SQL LIKE 通配符（_ 与 %）与转义符本身，避免"关掉一批看起来像的提醒"', () => {
    expect(escapeLikePattern('NTF-EXO-')).toBe('NTF-EXO-');
    expect(escapeLikePattern('NTF-EXO-LINE_A-')).toBe('NTF-EXO-LINE\\_A-');
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });
});

describe('resolveNotificationsFor（fail-closed）', () => {
  it('缺 org / externalRef / 前缀 / 处置人 → 一条都不动，且不调用 executor', async () => {
    const { executor, calls, rows } = createExecutor([row()]);
    for (const broken of [
      { ...BASE, orgId: '' },
      { ...BASE, externalRef: '' },
      { ...BASE, notificationIdPrefix: '' },
      { ...BASE, resolvedBy: '   ' },
    ]) {
      const result = await resolveNotificationsFor(executor, broken as never);
      expect(result).toEqual({ closed: 0, annotated: 0, notificationIds: [] });
    }
    expect(calls).toHaveLength(0);
    expect(rows[0]?.status).toBe('pending');
  });
});

describe('resolveNotificationsFor（范围与幂等）', () => {
  it('三重限定：只关本租户 + 本主事实 + 本前缀的待处置提醒', async () => {
    const { executor, rows } = createExecutor([
      row(),
      // 别的会话
      row({ notificationId: 'NTF-EXO-exo-sessionS2-overdue-app', externalRef: 'exo-session:S2' }),
      // 别的租户（同会话号）
      row({ notificationId: 'NTF-EXO-exo-sessionS1-overdue-app', orgId: 'org-b' }),
      // 别的提醒种类（external_ref 巧合相同，但前缀不同）
      row({ notificationId: 'NTF-EXPR-AP-1-expiring-app', externalRef: 'exo-session:S1' }),
    ]);
    const result = await resolveNotificationsFor(executor, BASE);
    expect(result.closed).toBe(1);
    expect(result.notificationIds).toEqual(['NTF-EXO-exo-sessionS1-overdue-app']);
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'pending', 'pending', 'pending']);
    expect(rows[2]?.resolution).toBeNull();
    expect(rows[3]?.resolution).toBeNull();
  });

  it('LIKE 转义生效：前缀里的 `_` 只匹配字面量，不会误伤"看起来像"的兄弟提醒', async () => {
    const { executor, rows } = createExecutor([
      row({ notificationId: 'NTF-EXO-exo-sessionLINE_A-1-overdue-app', externalRef: 'exo-session:LINE_A-1' }),
      // 若 `_` 未转义（SQL LIKE 单字符通配），这一行会被一起关掉
      row({ notificationId: 'NTF-EXO-exo-sessionLINEXA-1-overdue-app', externalRef: 'exo-session:LINE_A-1' }),
    ]);
    const result = await resolveNotificationsFor(executor, {
      ...BASE,
      externalRef: 'exo-session:LINE_A-1',
      notificationIdPrefix: 'NTF-EXO-exo-sessionLINE_A-1',
    });
    expect(result.closed).toBe(1);
    expect(rows[0]?.status).toBe('resolved');
    expect(rows[1]?.status).toBe('pending');
    expect(rows[1]?.resolution).toBeNull();
  });

  it('幂等：已处置的行不再被覆盖（第一次了结它的那次处置才是审计答案）', async () => {
    const { executor, rows } = createExecutor([
      row({ status: 'resolved', resolution: 'session_corrected', resolvedBy: 'lead.wang', resolutionRef: 'exo-session:NEW' }),
    ]);
    const result = await resolveNotificationsFor(executor, BASE);
    expect(result.closed).toBe(0);
    expect(result.annotated).toBe(0);
    expect(rows[0]?.resolution).toBe('session_corrected');
    expect(rows[0]?.resolvedBy).toBe('lead.wang');
  });

  it('已读行：状态保持 read，只补写处置四列（"人看过"与"事已了结"都留）', async () => {
    const { executor, rows } = createExecutor([row({ status: 'read', readAt: new Date('2026-09-12T08:00:00Z') })]);
    const result = await resolveNotificationsFor(executor, BASE);
    expect(result.closed).toBe(0);
    expect(result.annotated).toBe(1);
    expect(rows[0]?.status).toBe('read');
    expect(rows[0]?.readAt).toBeInstanceOf(Date);
    expect(rows[0]?.resolution).toBe('session_ended');
    expect(rows[0]?.resolvedBy).toBe('lead.chen');
    expect(rows[0]?.resolutionRef).toBe('exo-session:S1');
  });

  it('投递状态（sent/failed）不归处置管：一律不碰（否则投递失败被悄悄吞掉）', async () => {
    const { executor, rows } = createExecutor([
      row({ status: 'failed' }),
      row({ status: 'sent', notificationId: 'NTF-EXO-exo-sessionS1-overdue-lark' }),
    ]);
    const result = await resolveNotificationsFor(executor, BASE);
    expect(result.closed).toBe(0);
    expect(result.annotated).toBe(0);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'sent']);
  });

  it('处置码与处置引用按调用方给出的写死（审批被新审批取代 → 指向新审批号）', async () => {
    const { executor, rows } = createExecutor([
      row({ notificationId: 'NTF-EXPR-AP-1-expiring-app', externalRef: 'AP-1' }),
    ]);
    const result = await resolveNotificationsFor(executor, {
      orgId: 'org-a',
      externalRef: 'AP-1',
      notificationIdPrefix: 'NTF-EXPR-AP-1-',
      resolution: 'approval_superseded',
      resolvedBy: 'admin',
      resolutionRef: 'AP-2',
    });
    expect(result.closed).toBe(1);
    expect(rows[0]?.resolution).toBe('approval_superseded');
    expect(rows[0]?.resolutionRef).toBe('AP-2');
  });
});
