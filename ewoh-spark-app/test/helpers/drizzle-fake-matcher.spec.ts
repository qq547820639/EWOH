/* 假 DB 谓词求值助手自身的测试（NO-47a）。
 *
 * 为什么替身也要测：它已经三次"悄悄漏条件"（未知值嗅探、inArray 裸数组、like 内联字面量），
 * 每次的表现都是**业务测试通过但条件没生效**。所以助手必须有自证：
 * 每个操作符、每种 chunk 形态都要有正反例，未识别形态必须抛错。
 */
/// <reference types="jest" />
import { and, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { likePatternToRegExp, makeConditionMatcher } from './drizzle-fake-matcher';

const t = pgTable('demo', {
  orgId: uuid('org_id'),
  ref: varchar('external_ref', { length: 255 }),
  id: varchar('notification_id', { length: 255 }),
  status: varchar('status', { length: 50 }),
  resolution: varchar('resolution', { length: 50 }),
  createdAt: timestamp('_created_at'),
});

const matches = makeConditionMatcher({
  org_id: 'orgId',
  external_ref: 'ref',
  notification_id: 'id',
  status: 'status',
  resolution: 'resolution',
  _created_at: 'createdAt',
});

const row = {
  orgId: 'org-a',
  ref: 'exo-session:S1',
  id: 'NTF-EXO-exo-sessionS1-overdue-app',
  status: 'pending',
  resolution: null as string | null,
  createdAt: new Date('2026-09-12T00:00:00Z'),
};

describe('likePatternToRegExp（PostgreSQL LIKE 语义）', () => {
  it('`%` 任意串、`_` 任意单字符、`\\x` 字面量', () => {
    expect(likePatternToRegExp('NTF-EXO-%').test('NTF-EXO-anything')).toBe(true);
    expect(likePatternToRegExp('A_C').test('ABC')).toBe(true);
    expect(likePatternToRegExp('A\\_C').test('ABC')).toBe(false);
    expect(likePatternToRegExp('A\\_C').test('A_C')).toBe(true);
    expect(likePatternToRegExp('100\\%').test('100%')).toBe(true);
    expect(likePatternToRegExp('100\\%').test('1005')).toBe(false);
  });
});

describe('makeConditionMatcher', () => {
  it('eq / ne 按列比较（不按值嗅探）', () => {
    expect(matches(eq(t.status, 'pending'), row)).toBe(true);
    expect(matches(eq(t.status, 'read'), row)).toBe(false);
    expect(matches(ne(t.status, 'read'), row)).toBe(true);
    // 值相同但列不同 → 必须按列判定
    expect(matches(eq(t.ref, 'pending'), row)).toBe(false);
  });

  it('isNull / isNotNull', () => {
    expect(matches(isNull(t.resolution), row)).toBe(true);
    expect(matches(isNotNull(t.resolution), row)).toBe(false);
    expect(matches(isNull(t.ref), row)).toBe(false);
  });

  it('inArray（裸数组 chunk + Param 元素）', () => {
    expect(matches(inArray(t.status, ['pending', 'read']), row)).toBe(true);
    expect(matches(inArray(t.status, ['read', 'resolved']), row)).toBe(false);
    expect(matches(inArray(t.ref, ['exo-session:S1']), row)).toBe(true);
  });

  it('like（内联字面量形态，含转义通配符）', () => {
    expect(matches(like(t.id, 'NTF-EXO-%'), row)).toBe(true);
    expect(matches(like(t.id, 'NTF-EXPR-%'), row)).toBe(false);
    // 转义后的 `_` 只匹配字面量
    const sibling = { ...row, id: 'NTF-EXO-exo-sessionLINEXA-1-overdue-app' };
    expect(matches(like(t.id, 'NTF-EXO-exo-sessionLINE\\_A-1%'), sibling)).toBe(false);
    expect(matches(like(t.id, 'NTF-EXO-exo-sessionLINE\\_A-1%'), { ...row, id: 'NTF-EXO-exo-sessionLINE_A-1-overdue-app' })).toBe(true);
  });

  it('数值比较（gt/gte/lt/lte）', () => {
    expect(matches(gt(t.status, 'a'), row)).toBe(true);
    expect(matches(lt(t.status, 'z'), row)).toBe(true);
    expect(matches(gte(t.status, 'pending'), row)).toBe(true);
    expect(matches(lte(t.status, 'pending'), row)).toBe(true);
    expect(matches(gt(t.status, 'z'), row)).toBe(false);
  });

  it('and / or 组合（or 分组、and 逐条）', () => {
    expect(matches(and(eq(t.status, 'pending'), isNull(t.resolution)), row)).toBe(true);
    expect(matches(and(eq(t.status, 'pending'), eq(t.status, 'read')), row)).toBe(false);
    // 顶层 or：任一分支成立即可
    expect(matches(or(eq(t.status, 'read'), eq(t.status, 'pending')), row)).toBe(true);
    expect(matches(or(eq(t.status, 'read'), eq(t.status, 'resolved')), row)).toBe(false);
    // and 内嵌 or：or 作为子条件参与 AND
    expect(matches(and(eq(t.orgId, 'org-a'), or(eq(t.status, 'read'), eq(t.status, 'pending'))), row)).toBe(true);
    expect(matches(and(eq(t.orgId, 'org-b'), or(eq(t.status, 'read'), eq(t.status, 'pending'))), row)).toBe(false);
  });

  it('未识别的条件形态 → 抛错（绝不静默放行）', () => {
    // 一个既不是 Column/Param 也没有已知操作符文本的构造
    expect(() => matches({ queryChunks: [{ brand: 'mystery' }] }, row)).toThrow(/无法识别/);
    // sql`...` 里带未知函数调用（没有列/参数）
    expect(() => matches(sql`random() > 0.5`, row)).toThrow(/无法识别/);
  });

  it('未提供条件（undefined）→ 视为无过滤（调用方显式传入）', () => {
    expect(matches(undefined, row)).toBe(true);
  });
});
