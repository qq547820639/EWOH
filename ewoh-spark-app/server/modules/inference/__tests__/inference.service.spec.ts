/* InferenceResultService 契约行为测试（ADR-019 / NO-08a）。
 *
 * 覆盖：契约校验 fail-closed（非法 level / confidence 越界 / OOD 一致性失配 /
 * 非法 subject）、org 缺失显式失败、创建幂等（唯一键冲突回读不重发事件）、
 * InferenceResultRecorded 事件落库、租户作用域查询。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_040 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { InferenceResultService } from '../inference.service';
import { ewohInferenceResult, ewohEvent } from '@server/database/schema';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const VALID_INPUT = {
  subjectId: 'decision:sug-1',
  level: 'L1_deterministic_rules',
  modelId: 'rule-a2-suggestion',
  modelVersion: 'v1',
  inputVersion: 'snapshot-v3',
  label: '测试问题',
  confidence: 1,
  oodIndicator: { flag: false, reasons: [] as string[] },
  dataQuality: 'good',
  evidence: { tsStart: '2026-08-16T08:00:00Z', tsEnd: '2026-08-16T09:00:00Z', isRule: true },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function collectValues(
  node: unknown,
  sets: { inferenceIds: Set<string>; orgIds: Set<string>; levels: Set<string>; subjects: Set<string> },
  seen: WeakSet<object>,
): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, sets, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      if (value.startsWith('inf-')) sets.inferenceIds.add(value);
      if (value.startsWith('org-')) sets.orgIds.add(value);
      if (value.startsWith('L')) sets.levels.add(value);
      if (value.startsWith('decision:')) sets.subjects.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function collectSets(cond: unknown) {
  const sets = {
    inferenceIds: new Set<string>(),
    orgIds: new Set<string>(),
    levels: new Set<string>(),
    subjects: new Set<string>(),
  };
  collectValues(cond, sets, new WeakSet());
  return sets;
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = collectSets(cond);
  if (sets.inferenceIds.size > 0 && !sets.inferenceIds.has(String(row.inferenceId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.levels.size > 0 && !sets.levels.has(String(row.level))) return false;
  if (sets.subjects.size > 0 && !sets.subjects.has(String(row.subjectId))) return false;
  return true;
}

function rowOf(
  inferenceId: string,
  orgId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId,
    inferenceId,
    subjectId: 'decision:sug-1',
    level: 'L1_deterministic_rules',
    modelId: 'rule-a2-suggestion',
    modelVersion: 'v1',
    inputVersion: 'snapshot-v3',
    label: '测试问题',
    confidence: 1,
    oodFlag: false,
    oodReasons: [],
    dataQuality: 'good',
    evidenceTsStart: new Date('2026-08-16T08:00:00Z'),
    evidenceTsEnd: new Date('2026-08-16T09:00:00Z'),
    evidenceIsRule: true,
    resultJson: {},
    createdAt: new Date(),
    ...overrides,
  };
}

function createInferenceDb(presetRows: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = [...presetRows];
  const events: Array<Record<string, unknown>> = [];
  let nextInsertError: unknown = null;
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(rows.filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (nextInsertError) {
          const err = nextInsertError;
          nextInsertError = null;
          throw err;
        }
        if (table === ewohInferenceResult) rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    __failNextInsertWith: (err: unknown) => {
      nextInsertError = err;
    },
  };
  const service = new InferenceResultService(db as never);
  return { db, rows, events, service };
}

describe('InferenceResultService（NO-08a 云侧推理结果台账）', () => {
  it('记录 fail-closed：非法 level 拒绝且不落库', async () => {
    const { rows, service } = createInferenceDb();
    await expect(
      service.recordInferenceResult({ ...VALID_INPUT, level: 'L9_teleport' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('记录 fail-closed：confidence 越界拒绝', async () => {
    const { rows, service } = createInferenceDb();
    await expect(
      service.recordInferenceResult({ ...VALID_INPUT, confidence: 1.5 }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('记录 fail-closed：OOD 一致性失配拒绝（flag=false 带 reasons）', async () => {
    const { rows, service } = createInferenceDb();
    await expect(
      service.recordInferenceResult(
        { ...VALID_INPUT, oodIndicator: { flag: false, reasons: ['low_confidence'] } },
        ORG_A,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('记录 fail-closed：非法 subjectId（非规范身份）拒绝', async () => {
    const { rows, service } = createInferenceDb();
    await expect(
      service.recordInferenceResult({ ...VALID_INPUT, subjectId: 'not-an-id' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('org 缺失显式失败（RLS 下不静默写全局）', async () => {
    const { rows, service } = createInferenceDb();
    await expect(
      service.recordInferenceResult(VALID_INPUT, ''),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('记录成功：落库 + InferenceResultRecorded 事件', async () => {
    const { rows, events, service } = createInferenceDb();
    const result = await service.recordInferenceResult(VALID_INPUT, ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(ORG_A);
    expect(rows[0]?.level).toBe('L1_deterministic_rules');
    expect(rows[0]?.confidence).toBe(1);
    expect(result.created).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('InferenceResultRecorded');
  });

  it('创建幂等：唯一键冲突回读既有行且不重发事件', async () => {
    const existing = rowOf('inf:test-1', ORG_A);
    const { db, events, service } = createInferenceDb([existing]);
    db.__failNextInsertWith({ code: '23505' });
    const result = await service.recordInferenceResult(
      { ...VALID_INPUT, inferenceId: 'inf:test-1' },
      ORG_A,
    );
    expect(result.created).toBe(false);
    expect(result.record?.inferenceId).toBe('inf:test-1');
    expect(events).toHaveLength(0);
  });

  it('inferenceId 缺省由服务端生成（inf- 前缀）', async () => {
    const { rows, service } = createInferenceDb();
    const result = await service.recordInferenceResult(VALID_INPUT, ORG_A);
    expect(String(result.record?.inferenceId)).toMatch(/^inf-\d+-[0-9a-f]{8}$/);
    expect(rows).toHaveLength(1);
  });

  it('列表：租户作用域（他租户行不可见）+ level 过滤', async () => {
    const mine = rowOf('inf:mine-1', ORG_A, { level: 'L2_statistical_ml' });
    const other = rowOf('inf:other-1', ORG_B);
    const { service } = createInferenceDb([mine, other]);
    const all = await service.listInferenceResults(ORG_A);
    expect(all.map((r) => r.inferenceId)).toEqual(['inf:mine-1']);
    const filtered = await service.listInferenceResults(ORG_A, { level: 'L1_deterministic_rules' });
    expect(filtered).toHaveLength(0);
  });

  it('getInferenceResult：越界返回 null', async () => {
    const other = rowOf('inf:other-1', ORG_B);
    const { service } = createInferenceDb([other]);
    const entry = await service.getInferenceResult(ORG_A, 'inf:other-1');
    expect(entry).toBeNull();
    const mine = await service.getInferenceResult(ORG_B, 'inf:other-1');
    expect(mine?.inferenceId).toBe('inf:other-1');
  });
});
