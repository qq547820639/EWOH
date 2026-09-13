/* ExoSessionService 契约行为测试（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 * 覆盖：start 契约 fail-closed（非规范身份拒绝）、活跃冲突显式
 * （23505 → conflict_exo_session_active，§7 绝不静默双绑定）、
 * end/abort 状态机（endedBy 必填/终态不可复开/actualEndAt 落账）、
 * 租户作用域、ExoSessionStarted/Ended 双事件。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_046 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ExoSessionService, extractPgErrorCode } from '../exo-session.service';
import {
  ewohExoSession,
  ewohEvent,
  ewohDevice,
  ewohProductionTask,
  ewohNotification,
} from '@server/database/schema';

const ORG_A = 'org-a';
const EXO_ID = 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';
const PERSON_ID = 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

/**
 * 谓词求值（与派工 harness 同源）：按 drizzle SQL 的 `queryChunks` 递归求值，
 * 支持 eq / isNull / and / or / inArray——**按列名**映射到行字段。
 *
 * 为什么不能用"按值嗅探"：uuid 既可能是会话主键、也可能是设备/任务外键，
 * 只看值的形状无法判断该和行的哪个字段比较（实测踩过：更正会话时把同事务新插入的
 * 会话也当成"按 id 更新"的目标，一并改成了 ended）。
 */
const COL_TO_KEY: Record<string, string> = {
  id: 'id',
  org_id: 'orgId',
  session_id: 'sessionId',
  exo_id: 'exoId',
  person_id: 'personId',
  status: 'status',
  task_id: 'taskId',
  device_id: 'deviceId',
  entity_id: 'entityId',
  notification_id: 'notificationId',
  external_ref: 'externalRef',
  recipient_type: 'recipientType',
  channel: 'channel',
  title: 'title',
  resolution: 'resolution',
  resolution_ref: 'resolutionRef',
};

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  const groups: Array<Array<() => boolean>> = [[]];
  let pendingCol: string | null = null;
  // NO-44a：`like` 支持（通知处置只按 `NTF-EXO-%` 前缀限定范围）。
  // 实测教训：drizzle 会把 `like` 的**字面量模式内联成裸字符串 chunk**，
  // 早期实现只处理对象 chunk → 这个条件被静默丢掉（"别人的通知"也被当成命中），
  // 是替身保真度问题，不是业务代码问题。这里同时支持裸字符串（内联值）形态。
  let pendingOp: 'eq' | 'like' = 'eq';
  /** SQL LIKE 只实现 `%`（足够表达前缀/包含），不假装支持 `_`/转义语义。 */
  const likeMatches = (actual: unknown, expected: string): boolean => {
    if (actual == null) return false;
    const pattern = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
    return new RegExp(`^${pattern}$`).test(String(actual));
  };
  const chunkText = (o: { value?: unknown }): string | null => {
    if (Array.isArray(o.value) && o.value.every((v) => typeof v === 'string')) return o.value.join('');
    if (typeof o.value === 'string') return o.value;
    return null;
  };
  for (const raw of chunks) {
    // 裸字符串 = drizzle 内联的字面量或 SQL 片段（如 `like` 的模式）。
    if (typeof raw === 'string') {
      if (pendingCol && pendingOp === 'like') {
        const key = COL_TO_KEY[pendingCol] ?? pendingCol;
        groups[groups.length - 1].push(() => likeMatches(row[key], raw));
        pendingCol = null;
        pendingOp = 'eq';
      } else if (/\blike\b/i.test(raw)) {
        pendingOp = 'like';
      }
      continue;
    }
    // `inArray` 的右值是裸数组 chunk（无 encoder/queryChunks）；不处理=集合条件被静默丢掉。
    if (Array.isArray(raw)) {
      if (pendingCol) {
        const key = COL_TO_KEY[pendingCol] ?? pendingCol;
        // `inArray` 右值是 [Param, …]（元素带 value 包装），必须解包后再比较。
        const candidates = raw.map((v) =>
          v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : String(v),
        );
        groups[groups.length - 1].push(() => candidates.includes(String(row[key])));
        pendingCol = null;
        pendingOp = 'eq';
      }
      continue;
    }
    const c = raw as { name?: string; value?: unknown; encoder?: unknown; queryChunks?: unknown[] } | undefined;
    if (!c || typeof c !== 'object') continue;
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pendingCol = c.name;
      continue;
    }
    if (!('encoder' in c)) {
      const text = chunkText(c);
      if (text !== null) {
        if (/\bor\b/.test(text)) groups.push([]);
        else if (/\blike\b/i.test(text) && pendingCol) pendingOp = 'like';
        else if (/is\s+null/i.test(text) && pendingCol) {
          const key = COL_TO_KEY[pendingCol] ?? pendingCol;
          groups[groups.length - 1].push(() => row[key] == null);
          pendingCol = null;
          pendingOp = 'eq';
        }
        continue;
      }
      if (Array.isArray(c.queryChunks)) {
        const nested = raw;
        groups[groups.length - 1].push(() => matches(nested, row));
        continue;
      }
    }
    if ('encoder' in c && 'value' in c && pendingCol) {
      const key = COL_TO_KEY[pendingCol] ?? pendingCol;
      const expected = String((c as { value: unknown }).value);
      const op = pendingOp;
      groups[groups.length - 1].push(() => {
        const actual = row[key];
        if (actual == null) return false;
        if (op === 'like') return likeMatches(actual, expected);
        return String(actual) === expected;
      });
      pendingCol = null;
      pendingOp = 'eq';
      continue;
    }
  }
  if (groups.every((g) => g.length === 0)) return true;
  return groups.some((g) => g.every((fn) => fn()));
}

/**
 * 由会话号派生一个稳定的 uuid 形状主键。
 *
 * 为什么不能所有行共用一个固定 id：真实表里主键唯一，而按主键更新（更正会话的 CAS）
 * 必须只命中目标行——共用一个 id 会让"更新旧会话"顺带改掉同租户的其它会话（实测踩过）。
 */
function rowIdFor(sessionId: string): string {
  let hash = 0;
  for (const ch of sessionId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `00000000-0000-4000-8000-${hex}${hex}`.slice(0, 36);
}

function rowOf(sessionId: string, orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: rowIdFor(sessionId),
    orgId,
    sessionId,
    exoId: EXO_ID,
    personId: PERSON_ID,
    status: 'active',
    startedAt: new Date('2026-08-16T08:00:00Z'),
    expectedEndAt: null,
    actualEndAt: null,
    endedBy: null,
    reason: null,
    operatorId: null,
    recordJson: { sessionId, exoId: EXO_ID, personId: PERSON_ID, status: 'active', startedAt: '2026-08-16T08:00:00Z', auditTrail: true },
    createdAt: new Date(),
    ...overrides,
  };
}

function createExoDb(
  rows: Array<Record<string, unknown>> = [],
  extras: {
    devices?: Array<Record<string, unknown>>;
    tasks?: Array<Record<string, unknown>>;
    /** NO-44a：通知行（会话处置会按 external_ref 关闭对应提醒）。 */
    notifications?: Array<Record<string, unknown>>;
  } = {},
) {
  const state = {
    rows: [...rows],
    // NO-39a：开始会话要查台账设备（锁行）与在飞任务（反方向边界）——按表返回行，
    // 不能与 ewoh_exo_session 行混在一起（否则设备查询会把会话行当设备读）。
    devices: [...(extras.devices ?? [])],
    tasks: [...(extras.tasks ?? [])],
    notifications: [...(extras.notifications ?? [])],
  };
  const events: Array<Record<string, unknown>> = [];
  let nextInsertError: unknown = null;
  let nextEventInsertError: unknown = null;
  // R2-SAM-005：模拟并发事务在 CAS UPDATE 前先行提交（后提交者应命中 0 行）。
  let concurrentPatch: Record<string, unknown> | null = null;
  function applyConcurrentPatchIfAny() {
    if (concurrentPatch) {
      for (const r of state.rows) Object.assign(r, concurrentPatch);
      concurrentPatch = null;
    }
  }
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
      // `FOR UPDATE` 在假 DB 里是无副作用的方法链（真实锁语义由 PG 承担）。
      for: jest.fn(() => thenable(data)),
    };
  }
  const rowsForTable = (table: unknown): Array<Record<string, unknown>> =>
    table === ewohDevice
      ? state.devices
      : table === ewohProductionTask
        ? state.tasks
        : table === ewohNotification
          ? state.notifications
          : state.rows;
  const insertInto = (table: unknown) => ({
    values: jest.fn((row: Record<string, unknown>) => {
      if (table === ewohEvent && nextEventInsertError) {
        const err = nextEventInsertError;
        nextEventInsertError = null;
        throw err;
      }
      if (nextInsertError) {
        const err = nextInsertError;
        nextInsertError = null;
        throw err;
      }
      if (table === ewohExoSession) state.rows.push(row);
      if (table === ewohEvent) events.push(row);
      return { returning: jest.fn(async () => [row]) };
    }),
  });
  const updateIn = (table: unknown) => ({
    set: jest.fn((patch: Record<string, unknown>) => ({
      where: jest.fn((cond: unknown) => {
        applyConcurrentPatchIfAny();
        // NO-44a：UPDATE 必须按**表**选行——否则"关闭通知"会去改会话行
        // （假 DB 里表混在一起时，这类错误只会在断言计数时暴露成"改了 0 行"）。
        const hit = rowsForTable(table).filter((r) => matches(cond, r));
        for (const r of hit) Object.assign(r, patch);
        return { returning: jest.fn(async () => hit) };
      }),
    })),
  });
  /** NO-41a：`listTelemetryConsistency` 用原始 SQL 取"每设备最近一帧"——替身按表返回。 */
  const telemetryRows: Array<Record<string, unknown>> = [];
  const db = {
    execute: jest.fn(async () => telemetryRows),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        // 返回行副本（对齐真实 drizzle 语义）：调用方持有的 current 不被
        // 后续 UPDATE/并发 patch 就地污染（R2-SAM-005 CAS 断言依赖此语义）。
        where: jest.fn((cond: unknown) =>
          thenable(rowsForTable(table).filter((r) => matches(cond, r)).map((r) => ({ ...r }))),
        ),
      })),
    })),
    insert: jest.fn(insertInto),
    update: jest.fn(updateIn),
    // R2-SAM-006：事务暂存语义——事务内写入/更新先暂存，回调成功才提交，
    // 抛错整体回滚（模拟真实 DB 事务，供“事件失败回滚主事实”断言）。
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const pendingInserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
      const pendingUpdates: Array<{ table: unknown; cond: unknown; patch: Record<string, unknown> }> = [];
      const tx = {
        select: jest.fn(() => ({
          from: jest.fn((table: unknown) => ({
            where: jest.fn((cond: unknown) =>
              thenable(rowsForTable(table).filter((r) => matches(cond, r)).map((r) => ({ ...r }))),
            ),
          })),
        })),
        insert: (table: unknown) => ({
          values: jest.fn((row: Record<string, unknown>) => {
            if (nextInsertError) {
              const err = nextInsertError;
              nextInsertError = null;
              throw err;
            }
            if (table === ewohEvent && nextEventInsertError) {
              const err = nextEventInsertError;
              nextEventInsertError = null;
              throw err;
            }
            pendingInserts.push({ table, row });
            return { returning: jest.fn(async () => [row]) };
          }),
        }),
        update: (table: unknown) => ({
          set: jest.fn((patch: Record<string, unknown>) => ({
            where: jest.fn((cond: unknown) => {
              applyConcurrentPatchIfAny();
              const hit = rowsForTable(table).filter((r) => matches(cond, r));
              pendingUpdates.push({ table, cond, patch });
              // returning 返回应用 patch 后的行副本（对齐真实 drizzle 语义）。
              return { returning: jest.fn(async () => hit.map((r) => ({ ...r, ...patch }))) };
            }),
          })),
        }),
      };
      const out = await cb(tx);
      for (const { table, row } of pendingInserts) {
        if (table === ewohExoSession) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
      }
      for (const { table, cond, patch } of pendingUpdates) {
        for (const r of rowsForTable(table).filter((r) => matches(cond, r))) Object.assign(r, patch);
      }
      return out;
    }),
    __telemetryRows: telemetryRows,
    __failNextInsertWith: (err: unknown) => {
      nextInsertError = err;
    },
    __failNextEventInsertWith: (err: unknown) => {
      nextEventInsertError = err;
    },
    __simulateConcurrentUpdateBeforeNextWhere: (patch: Record<string, unknown>) => {
      concurrentPatch = patch;
    },
  };
  const service = new ExoSessionService(db as never);
  return { db, rows: state.rows, events, service, telemetryRows, notifications: state.notifications };
}

/* ── NO-39a：反方向执行边界（设备已被在飞任务指派给别人 → 拒绝开始会话）── */
describe('ExoSessionService · 会话开始的在飞任务边界（NO-39a）', () => {
  const DEVICE_UUID = '44444444-4444-4444-8444-444444444444';
  const WEARER = 'person:33333333-3333-4333-8333-333333333333';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const deviceRow = { id: DEVICE_UUID, deviceId: 'EXO-9F1C', orgId: ORG_A };
  const taskRow = (overrides: Record<string, unknown> = {}) => ({
    id: '66666666-6666-4666-8666-666666666666',
    orgId: ORG_A,
    title: '搬运任务',
    status: 'dispatched',
    assigneeId: OTHER,
    deviceId: DEVICE_UUID,
    ...overrides,
  });

  it('设备已被在飞任务指派给别人 → 409 EXO_SESSION_TASK_CONFLICT，且不落库、不发事件', async () => {
    const { service, rows, events } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow()],
    });
    const error = await service
      .start({ exoId: 'device:EXO-9F1C', personId: WEARER }, ORG_A)
      .catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(409);
    expect(String(error.message)).toContain('EXO_SESSION_TASK_CONFLICT');
    expect(String(error.message)).toContain('搬运任务');
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('在飞任务的受派人就是佩戴者 → 允许（同一个人，人机同体）', async () => {
    const { service, rows } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow({ assigneeId: WEARER })],
    });
    const result = await service.start({ exoId: 'device:EXO-9F1C', personId: WEARER }, ORG_A);
    expect(result.status).toBe('active');
    expect(rows).toHaveLength(1);
  });

  it('在飞任务没有受派人 → 同样拒绝（不能猜谁去用）', async () => {
    const { service, rows } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow({ assigneeId: null })],
    });
    const error = await service
      .start({ exoId: 'device:EXO-9F1C', personId: WEARER }, ORG_A)
      .catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(409);
    expect(String(error.message)).toContain('没有指定执行人');
    expect(rows).toHaveLength(0);
  });

  it('设备不在台账（临时设备号）→ 不做在飞任务判定，会话照常开始', async () => {
    const { service, rows } = createExoDb([], { devices: [], tasks: [taskRow()] });
    const result = await service.start({ exoId: 'device:EXO-NOT-IN-LEDGER', personId: WEARER }, ORG_A);
    expect(result.status).toBe('active');
    expect(rows).toHaveLength(1);
  });
});

/* ── NO-40a：会话 ↔ 任务绑定（继承计划结束时间；设备不一致显式拒绝）──────── */
describe('ExoSessionService · 任务绑定（NO-40a）', () => {
  const DEVICE_UUID = '77777777-7777-4777-8777-777777777777';
  const TASK_UUID = '88888888-8888-4888-8888-888888888888';
  const deviceRow = { id: DEVICE_UUID, deviceId: 'EXO-TASK', orgId: ORG_A };
  const taskRow = (overrides: Record<string, unknown> = {}) => ({
    id: TASK_UUID,
    orgId: ORG_A,
    title: '任务绑定用例',
    status: 'dispatched',
    assigneeId: PERSON_ID,
    deviceId: DEVICE_UUID,
    planEnd: new Date(Date.now() + 3_600_000),
    ...overrides,
  });

  it('绑定任务且未填预计结束 → 继承任务计划结束时间，来源记为 task_plan_end', async () => {
    const planEnd = new Date(Date.now() + 2 * 3_600_000);
    const { service, rows } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow({ planEnd })],
    });
    const result = await service.start(
      { exoId: 'device:EXO-TASK', personId: PERSON_ID, taskId: TASK_UUID },
      ORG_A,
    );
    expect(result.taskId).toBe(TASK_UUID);
    expect(result.expectedEndSource).toBe('task_plan_end');
    expect(String(result.expectedEndAt)).toBe(planEnd.toISOString());
    expect(rows[0]?.taskId).toBe(TASK_UUID);
    const recordJson = rows[0]?.recordJson as Record<string, unknown>;
    expect(recordJson.expectedEndSource).toBe('task_plan_end');
  });

  it('现场手填预计结束优先于任务计划（来源记为 operator）', async () => {
    const manual = new Date(Date.now() + 30 * 60_000).toISOString();
    const { service } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow({ planEnd: new Date(Date.now() + 5 * 3_600_000) })],
    });
    const result = await service.start(
      { exoId: 'device:EXO-TASK', personId: PERSON_ID, taskId: TASK_UUID, expectedEndAt: manual },
      ORG_A,
    );
    expect(String(result.expectedEndAt)).toBe(manual);
    expect(result.expectedEndSource).toBe('operator');
  });

  it('任务计划结束时间已过期 → 不继承（预计结束仍为未记录，不拿过去的时间充数）', async () => {
    const { service } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow({ planEnd: new Date(Date.now() - 60_000) })],
    });
    const result = await service.start(
      { exoId: 'device:EXO-TASK', personId: PERSON_ID, taskId: TASK_UUID },
      ORG_A,
    );
    expect(result.taskId).toBe(TASK_UUID);
    expect(result.expectedEndAt).toBeUndefined();
    expect(result.expectedEndSource).toBeUndefined();
  });

  it('任务不存在（或非本租户）→ 400 task_not_found，不静默忽略绑定声明', async () => {
    const { service, rows } = createExoDb([], { devices: [deviceRow], tasks: [] });
    const error = await service
      .start({ exoId: 'device:EXO-TASK', personId: PERSON_ID, taskId: TASK_UUID }, ORG_A)
      .catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(400);
    expect(String(error.message)).toContain('task_not_found');
    expect(rows).toHaveLength(0);
  });

  it('任务关联的是另一台设备 → 409 EXO_SESSION_TASK_DEVICE_MISMATCH（错的关联不落库）', async () => {
    const { service, rows } = createExoDb([], {
      devices: [deviceRow],
      tasks: [taskRow({ deviceId: '99999999-9999-4999-8999-999999999999' })],
    });
    const error = await service
      .start({ exoId: 'device:EXO-TASK', personId: PERSON_ID, taskId: TASK_UUID }, ORG_A)
      .catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(409);
    expect(String(error.message)).toContain('EXO_SESSION_TASK_DEVICE_MISMATCH');
    expect(rows).toHaveLength(0);
  });

  it('不传 taskId → 不关联任务（临时/演示会话合法）', async () => {
    const { service, rows } = createExoDb([], { devices: [deviceRow], tasks: [taskRow()] });
    const result = await service.start({ exoId: 'device:EXO-TASK', personId: PERSON_ID }, ORG_A);
    expect(result.taskId).toBeUndefined();
    expect(rows[0]?.taskId).toBeNull();
  });
});

/* ── NO-41a：佩戴事实双源一致性（会话声明 × 遥测）──────────────────────── */
describe('ExoSessionService · 遥测一致性（NO-41a）', () => {
  const EXO = 'device:EXO-CONSIST';

  it('会话佩戴者与遥测一致 → consistent；另一条会话无遥测 → no_telemetry（缺证据不升级为结论）', async () => {
    const now = Date.now();
    const { service, rows, telemetryRows } = createExoDb([
      rowOf('exo-session:ok', ORG_A, {
        exoId: EXO,
        personId: 'person:P-1',
        startedAt: new Date(now - 3_600_000),
      }),
      rowOf('exo-session:no-tel', ORG_A, {
        exoId: 'device:EXO-NO-TEL',
        personId: 'person:P-2',
        startedAt: new Date(now - 3_600_000),
      }),
    ]);
    telemetryRows.push({
      device_id: 'EXO-CONSIST',
      ts: new Date(now - 10_000),
      worker_id: 'P-1',
      load_score: 0.4,
      assist_level: null,
      angular_velocity_dps: 2,
      source_type: 'real',
      data_quality: 'good',
    });
    const result = (await service.listTelemetryConsistency(ORG_A)) as {
      scanned: number;
      summary: Record<string, number>;
      sessions: Array<{ sessionId: string; verdict: string; reason: string }>;
    };
    expect(rows).toHaveLength(2);
    expect(result.scanned).toBe(2);
    expect(result.summary.consistent).toBe(1);
    expect(result.summary.no_telemetry).toBe(1);
    const ok = result.sessions.find((s) => s.sessionId === 'exo-session:ok');
    expect(ok?.verdict).toBe('consistent');
    const noTel = result.sessions.find((s) => s.sessionId === 'exo-session:no-tel');
    expect(noTel?.reason).toContain('不等于"没有佩戴"');
  });

  it('遥测佩戴人是另一个人 → wearer_mismatch 且标记需人核实', async () => {
    const now = Date.now();
    const { service, telemetryRows } = createExoDb([
      rowOf('exo-session:mismatch', ORG_A, {
        exoId: EXO,
        personId: 'person:P-1',
        startedAt: new Date(now - 600_000),
      }),
    ]);
    telemetryRows.push({
      device_id: 'EXO-CONSIST',
      ts: new Date(now - 5_000),
      worker_id: 'P-OTHER',
      load_score: 0.2,
      assist_level: null,
      angular_velocity_dps: 1,
      source_type: 'real',
      data_quality: 'good',
    });
    const result = (await service.listTelemetryConsistency(ORG_A)) as {
      sessions: Array<{ verdict: string; needsHumanCheck: boolean; telemetryWorkerRef: string | null }>;
    };
    expect(result.sessions[0]?.verdict).toBe('wearer_mismatch');
    expect(result.sessions[0]?.needsHumanCheck).toBe(true);
    expect(result.sessions[0]?.telemetryWorkerRef).toBe('P-OTHER');
  });

  it('缺 org 上下文 → 400（不跨租户校验）', async () => {
    const { service } = createExoDb([]);
    await expect(service.listTelemetryConsistency('')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ── NO-43a：按实际佩戴人更正会话（遥测冲突的一步处置）──────────────────── */
describe('ExoSessionService · 按实际佩戴人更正（NO-43a）', () => {
  const DEVICE_UUID = '12121212-1212-4121-8121-121212121212';
  const TASK_UUID = '13131313-1313-4131-8131-131313131313';
  const deviceRow = { id: DEVICE_UUID, deviceId: 'EXO-CORRECT', orgId: ORG_A };
  const wearer = (suffix: string) => `person:00000000-0000-4000-8000-0000000000${suffix}`;

  it('一步更正：旧会话结束（含理由与去向）+ 新会话以新佩戴人开始 + 两条事件，全在同一事务', async () => {
    const { service, rows, events } = createExoDb(
      [
        rowOf('exo-session:OLD', ORG_A, {
          exoId: 'device:EXO-CORRECT',
          personId: wearer('01'),
          startedAt: new Date(Date.now() - 600_000),
          taskId: TASK_UUID,
        }),
      ],
      {
        devices: [deviceRow],
        tasks: [
          {
            id: TASK_UUID,
            orgId: ORG_A,
            title: '更正用例任务',
            status: 'dispatched',
            assigneeId: wearer('02'),
            deviceId: DEVICE_UUID,
            planEnd: new Date(Date.now() + 3_600_000),
          },
        ],
      },
    );
    const result = (await service.correctWearer(
      ORG_A,
      'exo-session:OLD',
      { personId: wearer('02'), endedBy: 'lead.chen', reason: '遥测显示实际佩戴人是 02' },
      { userId: 'lead.chen', primaryOrgId: ORG_A } as never,
    )) as {
      corrected: boolean;
      fromPersonId: string;
      toPersonId: string;
      ended: Record<string, unknown>;
      started: Record<string, unknown>;
    };

    expect(result.corrected).toBe(true);
    expect(result.fromPersonId).toBe(wearer('01'));
    expect(result.toPersonId).toBe(wearer('02'));
    expect(result.ended.status).toBe('ended');
    expect(result.ended.endedBy).toBe('lead.chen');
    expect(String(result.ended.reason)).toContain('遥测显示实际佩戴人是 02');
    expect(result.started.status).toBe('active');
    expect(result.started.personId).toBe(wearer('02'));
    // 继承关联任务与计划结束时间（来源仍是 task_plan_end）
    expect(result.started.taskId).toBe(TASK_UUID);
    expect(result.started.expectedEndSource).toBe('task_plan_end');
    // NO-43a：更正链路必须**双向可见**（否则审计只看到两条互不相关的会话）
    expect(result.ended.correctedTo).toBe(result.started.sessionId);
    expect(result.started.correctedFrom).toBe('exo-session:OLD');
    // 未经过更正的会话不出现这两个字段（缺失 = 没发生，不是空字符串）
    const plain = createExoDb([rowOf('exo-session:PLAIN', ORG_A, { exoId: 'device:EXO-CORRECT', personId: wearer('01') })]);
    const plainSession = (await plain.service.getSession(ORG_A, 'exo-session:PLAIN')) as Record<string, unknown>;
    expect('correctedTo' in plainSession).toBe(false);
    expect('correctedFrom' in plainSession).toBe(false);
    // 只有一条活跃会话（旧会话已终结，不残留双活跃）
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    // 两条目录事件同事务写入
    expect(events.map((e) => e.eventType).sort()).toEqual(['ExoSessionEnded', 'ExoSessionStarted']);
  });

  it('裸人员 id 会被规范化成 person: 身份；相同佩戴人 → 400（没有要更正的事实）', async () => {
    const { service } = createExoDb([
      rowOf('exo-session:OLD', ORG_A, { exoId: 'device:EXO-CORRECT', personId: wearer('01') }),
      // 独立的一条活跃会话：用于"相同佩戴人"断言（上一条在更正后已成终态）
      rowOf('exo-session:OTHER', ORG_A, { exoId: 'device:EXO-CORRECT-2', personId: wearer('05') }),
    ]);
    const result = (await service.correctWearer(
      ORG_A,
      'exo-session:OLD',
      { personId: '00000000-0000-4000-8000-000000000002', endedBy: 'lead.chen' },
      undefined,
    )) as { toPersonId: string };
    expect(result.toPersonId).toBe(wearer('02'));

    const unchanged = await service
      .correctWearer(ORG_A, 'exo-session:OTHER', { personId: wearer('05'), endedBy: 'lead.chen' })
      .catch((caught) => caught);
    expect(unchanged?.getStatus?.()).toBe(400);
    expect(String(unchanged.message)).toContain('EXO_SESSION_WEARER_UNCHANGED');
  });

  it('终态会话 → 409 EXO_SESSION_NOT_ACTIVE；缺 personId/endedBy → 400（都不可静默）', async () => {
    const { service } = createExoDb([
      rowOf('exo-session:DONE', ORG_A, {
        exoId: 'device:EXO-CORRECT',
        personId: wearer('01'),
        status: 'ended',
        actualEndAt: new Date(),
        endedBy: 'lead.chen',
      }),
      rowOf('exo-session:LIVE', ORG_A, { exoId: 'device:EXO-CORRECT', personId: wearer('01') }),
    ]);
    const notActive = await service
      .correctWearer(ORG_A, 'exo-session:DONE', { personId: wearer('02'), endedBy: 'lead.chen' })
      .catch((caught) => caught);
    expect(notActive?.getStatus?.()).toBe(409);
    expect(String(notActive.message)).toContain('EXO_SESSION_NOT_ACTIVE');

    await expect(
      service.correctWearer(ORG_A, 'exo-session:LIVE', { personId: '   ', endedBy: 'lead.chen' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.correctWearer(ORG_A, 'exo-session:LIVE', { personId: wearer('02') }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('新佩戴人仍受执行边界约束：设备被在飞任务指派给第三人 → 409 且旧会话不被结束（整体回滚）', async () => {
    const { service, rows } = createExoDb(
      [rowOf('exo-session:OLD', ORG_A, { exoId: 'device:EXO-CORRECT', personId: wearer('01') })],
      {
        devices: [deviceRow],
        tasks: [
          {
            id: TASK_UUID,
            orgId: ORG_A,
            title: '别人的在飞任务',
            status: 'executing',
            assigneeId: wearer('03'),
            deviceId: DEVICE_UUID,
            planEnd: null,
          },
        ],
      },
    );
    const error = await service
      .correctWearer(ORG_A, 'exo-session:OLD', { personId: wearer('02'), endedBy: 'lead.chen' })
      .catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(409);
    expect(String(error.message)).toContain('EXO_SESSION_TASK_CONFLICT');
    // 事务回滚：旧会话仍是 active（不允许"结束了却开不起来"的半成品）
    expect(rows.find((r) => r.sessionId === 'exo-session:OLD')?.status).toBe('active');
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });
});

describe('ExoSessionService（ADR-032 / §7）', () => {
  it('start 契约 fail-closed：非规范身份拒绝且不落库', async () => {
    const { rows, service } = createExoDb();
    await expect(
      service.start({ exoId: 'EXO-1', personId: PERSON_ID }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('start 成功：active 落账 + ExoSessionStarted 事件', async () => {
    const { events, service } = createExoDb();
    const result = await service.start({ exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    expect(result.status).toBe('active');
    expect(events.map((e) => e.eventType)).toEqual(['ExoSessionStarted']);
  });

  it('活跃冲突显式：同外骨骼第二个 active 会话 → conflict_exo_session_active（§7 绝不静默双绑定）', async () => {
    const { db, service } = createExoDb();
    await service.start({ exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    db.__failNextInsertWith({ code: '23505' });
    await expect(
      service.start({ exoId: EXO_ID, personId: 'person:other-1' }, ORG_A),
    ).rejects.toThrow('conflict_exo_session_active');
  });

  it('驱动错误被包装（drizzle 事务加了一层 cause）时仍识别 23505 → 显式冲突而非 500', async () => {
    // 回归（2026-09-12 e2e 实测）：只查顶层 `err.code` 会漏判，冲突被当成 500 抛出。
    const { db, service } = createExoDb();
    await service.start({ exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    db.__failNextInsertWith({
      message: 'Failed query',
      cause: { code: '23505', detail: 'duplicate key value violates unique constraint' },
    });
    const error = await service
      .start({ exoId: EXO_ID, personId: 'person:other-1' }, ORG_A)
      .catch((e) => e);
    expect(String(error?.message ?? error)).toContain('conflict_exo_session_active');
  });

  it('extractPgErrorCode：沿 cause 链取码，深度有界（不无限递归）', () => {
    expect(extractPgErrorCode({ code: '23505' })).toBe('23505');
    expect(extractPgErrorCode({ cause: { cause: { code: '40001' } } })).toBe('40001');
    expect(extractPgErrorCode({ message: 'no code' })).toBeUndefined();
    expect(extractPgErrorCode(null)).toBeUndefined();
    // 超过深度上限 → undefined（不做无界遍历）
    let deep: Record<string, unknown> = { code: '23505' };
    for (let i = 0; i < 10; i += 1) deep = { cause: deep };
    expect(extractPgErrorCode(deep)).toBeUndefined();
  });

  it('end：状态机 + endedBy 必填 + actualEndAt 落账 + ExoSessionEnded；终态不可复开', async () => {
    const { rows, events, service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    await expect(service.endSession(ORG_A, 'exo-session:s1', '')).rejects.toThrow('endedBy 必填');
    const result = await service.endSession(ORG_A, 'exo-session:s1', 'person:op1', '班次结束');
    expect(result.status).toBe('ended');
    expect(result.actualEndAt).toBeDefined();
    expect(rows[0]?.status).toBe('ended');
    expect(rows[0]?.actualEndAt).toBeInstanceOf(Date);
    expect(events.map((e) => e.eventType)).toEqual(['ExoSessionEnded']);
    // 终态不可复开（新绑定 = 新会话，§7）
    await expect(service.abortSession(ORG_A, 'exo-session:s1', 'person:op1')).rejects.toThrow('非法会话转移');
  });

  it('abort：状态机 + 理由留痕', async () => {
    const { service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    const result = await service.abortSession(ORG_A, 'exo-session:s1', 'person:op1', '设备故障');
    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('设备故障');
  });


  it('ADR-033 幂等：同 sessionId 重复 start 回读（应用层幂等，at-least-once 安全）', async () => {
    const { service } = createExoDb();
    const first = await service.start({ sessionId: 'exo-session:fixed-1', exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    const second = await service.start({ sessionId: 'exo-session:fixed-1', exoId: EXO_ID, personId: PERSON_ID }, ORG_A);
    expect((second as Record<string, unknown>).sessionId).toBe(first.sessionId);
    expect((second as Record<string, unknown>).status).toBe('active');
  });

  it('ADR-033 幂等：重复 ended 原样返回（不报错）', async () => {
    const { service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    await service.endSession(ORG_A, 'exo-session:s1', 'person:op1');
    const again = await service.endSession(ORG_A, 'exo-session:s1', 'person:op2');
    expect((again as Record<string, unknown>).status).toBe('ended');
  });

  // ── R2-SAM-005：terminate status CAS（并发 end+abort 不覆盖终态） ──

  it('R2-SAM-005：并发终结先提交后，后提交者 CAS 命中 0 行 → 显式冲突且不覆盖终态、不发事件', async () => {
    const { db, rows, events, service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    // 模拟并发：mustGet 读到 active 后、CAS UPDATE 提交前，另一终止事务先落地 ended。
    db.__simulateConcurrentUpdateBeforeNextWhere({
      status: 'ended',
      endedBy: 'person:op-concurrent',
    });
    await expect(
      service.abortSession(ORG_A, 'exo-session:s1', 'person:op1'),
    ).rejects.toThrow('exo_session_state_changed_concurrently:active');
    // 先提交者的终态（ended）不被后提交者（abort）覆盖（ADR-032 终态不可复开）。
    expect(rows[0]?.status).toBe('ended');
    expect(rows[0]?.endedBy).toBe('person:op-concurrent');
    // 冲突路径不产生事件（无“已冲突仍留痕 Ended”的假事实）。
    expect(events).toHaveLength(0);
  });

  // ── R2-SAM-006：主事实与事件同事务（事件失败整体回滚） ──

  it('R2-SAM-006：start 事件写失败 → 事务回滚（会话不落库，无“绑定无留痕”半态）', async () => {
    const { db, rows, events, service } = createExoDb();
    db.__failNextEventInsertWith(new Error('event insert down'));
    await expect(
      service.start({ exoId: EXO_ID, personId: PERSON_ID }, ORG_A),
    ).rejects.toThrow('event insert down');
    expect(rows).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('R2-SAM-006：terminate 事件写失败 → 事务回滚（会话保持 active，事件不残留）', async () => {
    const { db, rows, events, service } = createExoDb([rowOf('exo-session:s1', ORG_A)]);
    db.__failNextEventInsertWith(new Error('event insert down'));
    await expect(
      service.endSession(ORG_A, 'exo-session:s1', 'person:op1'),
    ).rejects.toThrow('event insert down');
    expect(rows[0]?.status).toBe('active');
    expect(events).toHaveLength(0);
  });

  it('租户作用域：他租户会话不可见', async () => {
    const { service } = createExoDb([
      rowOf('exo-session:s1', ORG_A),
      rowOf('exo-session:s2', 'org-b'),
    ]);
    const list = await service.listSessions(ORG_A);
    expect(list).toHaveLength(1);
    expect((list[0] as Record<string, unknown>).sessionId).toBe('exo-session:s1');
    await expect(service.getSession(ORG_A, 'exo-session:s2')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ── NO-44a：会话处置 → 相关提醒的终态（不让提醒永远挂在待办里）────────────── */

describe('ExoSessionService · 处置即闭环（NO-44a）', () => {
  const ORG = 'org-a';

  /** 一条会话提醒（通知号由 NO-37a 的确定性规则生成）。 */
  const notif = (overrides: Record<string, unknown> = {}) => ({
    id: `n-${Math.random().toString(36).slice(2, 10)}`,
    orgId: ORG,
    notificationId: 'NTF-EXO-exo-sessionS1-overdue-app',
    recipientType: 'role',
    recipientId: 'workshop_lead',
    channel: 'app',
    title: '会话超时',
    body: null,
    severity: 'high',
    status: 'pending',
    externalRef: 'exo-session:s1',
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionRef: null,
    ...overrides,
  });

  it('收工：同一事务把该会话的待处置提醒置为 resolved，并把处置人/依据写进去', async () => {
    const { service, notifications } = createExoDb([rowOf('exo-session:s1', ORG)], {
      notifications: [
        notif(),
        notif({ id: 'n2', notificationId: 'NTF-EXO-exo-sessionS1-overdue-user-u1-app', recipientType: 'user', recipientId: 'u1' }),
      ],
    });
    const ended = (await service.endSession(ORG, 'exo-session:s1', 'lead.chen', '作业完成')) as Record<string, unknown>;

    // 响应必须说清"这次处置顺带关闭了几条提醒"（缺失 ≠ 0，所以这里要求 2）
    expect(ended.resolvedNotificationCount).toBe(2);
    expect(ended.annotatedNotificationCount).toBe(0);
    expect(ended.status).toBe('ended');
    for (const row of notifications) {
      expect(row.status).toBe('resolved');
      expect(row.resolution).toBe('session_ended');
      expect(row.resolvedBy).toBe('lead.chen');
      expect(row.resolutionRef).toBe('exo-session:s1');
      expect(row.resolvedAt).toBeInstanceOf(Date);
    }
  });

  it('幂等：重复收工（已终态）不再关闭任何提醒，也不覆盖第一次的处置依据', async () => {
    const { service, notifications } = createExoDb([rowOf('exo-session:s1', ORG)], {
      notifications: [notif()],
    });
    await service.endSession(ORG, 'exo-session:s1', 'lead.chen');
    const again = (await service.endSession(ORG, 'exo-session:s1', 'lead.wang')) as Record<string, unknown>;
    expect(again.status).toBe('ended');
    // 幂等路径没有发生处置 → 不返回计数（不把"没发生"写成"关闭了 0 条"）
    expect('resolvedNotificationCount' in again).toBe(false);
    expect(notifications[0]?.resolvedBy).toBe('lead.chen');
  });

  it('中止：处置类型是 session_aborted（与正常收工可区分）', async () => {
    const { service, notifications } = createExoDb([rowOf('exo-session:s1', ORG)], {
      notifications: [notif()],
    });
    const aborted = (await service.abortSession(ORG, 'exo-session:s1', 'lead.chen', '人员离岗')) as Record<string, unknown>;
    expect(aborted.status).toBe('aborted');
    expect(aborted.resolvedNotificationCount).toBe(1);
    expect(notifications[0]?.resolution).toBe('session_aborted');
  });

  it('只动本会话、本租户、本类提醒：别人的会话/别的通知/投递失败一律不碰', async () => {
    const { service, notifications } = createExoDb([rowOf('exo-session:s1', ORG)], {
      notifications: [
        notif(),
        // 别的会话
        notif({ id: 'n-other', notificationId: 'NTF-EXO-exo-sessionS2-overdue-app', externalRef: 'exo-session:s2' }),
        // 别的租户（同会话号，不同 org）
        notif({ id: 'n-org', notificationId: 'NTF-EXO-exo-sessionS1-overdue-app-orgb', orgId: 'org-b' }),
        // 别的通知种类（external_ref 巧合相同，但不是 NTF-EXO-）
        notif({ id: 'n-andon', notificationId: 'NTF-ANDON-1-app', externalRef: 'exo-session:s1' }),
        // 推送投递失败：是运维事件，不归业务处置管（否则失败被悄悄吞掉）
        notif({ id: 'n-failed', notificationId: 'NTF-EXO-exo-sessionS1-overdue-lark', channel: 'lark', status: 'failed' }),
      ],
    });
    const ended = (await service.endSession(ORG, 'exo-session:s1', 'lead.chen')) as Record<string, unknown>;
    expect(ended.resolvedNotificationCount).toBe(1);

    const byId = (id: string) => notifications.find((n) => n.id === id) as Record<string, unknown>;
    expect(byId('n-other').status).toBe('pending');
    expect(byId('n-org').status).toBe('pending');
    expect(byId('n-andon').status).toBe('pending');
    expect(byId('n-failed').status).toBe('failed');
  });

  it('已读行：状态保持 read，但补写处置痕迹（"人看过"与"事已了结"两条信息都留）', async () => {
    const { service, notifications } = createExoDb([rowOf('exo-session:s1', ORG)], {
      notifications: [notif({ status: 'read', readAt: new Date() })],
    });
    const ended = (await service.endSession(ORG, 'exo-session:s1', 'lead.chen')) as Record<string, unknown>;
    expect(ended.resolvedNotificationCount).toBe(0);
    expect(ended.annotatedNotificationCount).toBe(1);
    expect(notifications[0]?.status).toBe('read');
    expect(notifications[0]?.resolution).toBe('session_ended');
    expect(notifications[0]?.resolvedBy).toBe('lead.chen');
  });

  it('更正：旧会话的提醒随更正关闭，并把 resolution_ref 指向新会话（可反查这次交接）', async () => {
    const { service, notifications } = createExoDb(
      [rowOf('exo-session:OLD', ORG, { personId: 'person:00000000-0000-4000-8000-0000000000a1' })],
      { notifications: [notif({ externalRef: 'exo-session:OLD', notificationId: 'NTF-EXO-exo-sessionOLD-telemetry_wearer_mismatch-app' })] },
    );
    const result = (await service.correctWearer(
      ORG,
      'exo-session:OLD',
      { personId: 'person:00000000-0000-4000-8000-0000000000a2', endedBy: 'lead.chen', reason: '现场核实' },
      { userId: 'lead.chen', primaryOrgId: ORG } as never,
    )) as Record<string, unknown>;

    expect(result.resolvedNotificationCount).toBe(1);
    const successor = (result.started as Record<string, unknown>).sessionId;
    expect(notifications[0]?.status).toBe('resolved');
    expect(notifications[0]?.resolution).toBe('session_corrected');
    expect(notifications[0]?.resolutionRef).toBe(successor);
    expect(notifications[0]?.resolutionRef).not.toBe('exo-session:OLD');
  });

  it('事件证据带上关闭条数与处置类型（审计不依赖通知表也能读）', async () => {
    const { service, events } = createExoDb([rowOf('exo-session:s1', ORG)], {
      notifications: [notif()],
    });
    await service.endSession(ORG, 'exo-session:s1', 'lead.chen');
    const endedEvent = events.find((e) => e.eventType === 'ExoSessionEnded');
    const evidence = endedEvent?.evidenceJson as Record<string, unknown>;
    expect(evidence?.resolvedNotificationCount).toBe(1);
    expect(evidence?.notificationResolution).toBe('session_ended');
  });
});
