/* ExoConfigService 契约行为测试（ADR-051/ADR-052 / §7：外骨骼配置事实台账）。
 *
 * 覆盖：record 契约门 fail-closed（未知 kind/supportMode/判定事实拒绝且不落库）、
 * 幂等（同 org+configId 返回既有行）、台账往返、activateProfile（旧 active
 * CAS→superseded + 新 active + 幂等）、租户作用域（他租户不可见）、
 * ExoConfigRecorded 事件。DB 以链式 fake 替换（单元层不依赖真实 PG；
 * DB 级验证由 standalone_051 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ExoConfigService } from '../exo-config.service';
import { ewohExoConfig, ewohEvent } from '@server/database/schema';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const EXO_ID = 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

function collectValues(node: unknown, out: Record<string, Set<string>>, seen: WeakSet<object>): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, out, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      for (const field of Object.keys(out)) {
        const row = { configId: '', orgId: '', kind: '', status: '', exoId: '', supportMode: '' };
        // 仅收集已知字段值（值比较在 matches 中按字段进行）
        void row;
      }
      if (value.startsWith('exo-config:')) out.configId.add(value);
      if (value.startsWith('org-')) out.orgId.add(value);
      if (['assist_profile', 'fit', 'calibration'].includes(value)) out.kind.add(value);
      if (['active', 'superseded', 'retired', 'fitted', 'passed', 'pending', 'invalidated', 'adjusted', 'failed'].includes(value)) out.status.add(value);
      if (value.startsWith('device:')) out.exoId.add(value);
      if (['lift_assist', 'passive', 'vendor_specific'].includes(value)) out.supportMode.add(value);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) out.id.add(value);
    } else {
      collectValues(value, out, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const out = {
    configId: new Set<string>(), orgId: new Set<string>(), kind: new Set<string>(),
    status: new Set<string>(), exoId: new Set<string>(), supportMode: new Set<string>(),
    id: new Set<string>(),
  };
  collectValues(cond, out, new WeakSet());
  if (out.configId.size > 0 && !out.configId.has(String(row.configId))) return false;
  if (out.orgId.size > 0 && !out.orgId.has(String(row.orgId))) return false;
  if (out.kind.size > 0 && !out.kind.has(String(row.kind))) return false;
  if (out.status.size > 0 && !out.status.has(String(row.status))) return false;
  if (out.exoId.size > 0 && !out.exoId.has(String(row.exoId))) return false;
  if (out.supportMode.size > 0 && !out.supportMode.has(String(row.supportMode))) return false;
  if (out.id.size > 0 && !out.id.has(String(row.id))) return false;
  return true;
}

function configRow(configId: string, orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId,
    configId,
    kind: 'assist_profile',
    exoId: EXO_ID,
    status: 'active',
    supportMode: 'lift_assist',
    vendorModeName: null,
    parametersJson: { assistLevel: 0.6 },
    effectiveFrom: new Date('2026-08-16T08:00:00Z'),
    effectiveTo: null,
    supersededBy: null,
    setBy: 'person:op-1',
    personId: null,
    fittedAt: null,
    fitter: null,
    measuredValuesJson: null,
    calibrationKind: null,
    result: null,
    calibratedAt: null,
    calibratedBy: null,
    nextDueAt: null,
    recordJson: { configId, kind: 'assist_profile', exoId: EXO_ID, tenantId: orgId, status: 'active', supportMode: 'lift_assist', effectiveFrom: '2026-08-16T08:00:00Z', auditTrail: [{ actor: 'person:op-1', action: 'recorded', at: '2026-08-16T08:00:00Z' }] },
    createdAt: new Date(),
    ...overrides,
  };
}

function createConfigDb(
  rows: Array<Record<string, unknown>> = [],
  /** 对抗审查（2026-09-13）：模拟 READ COMMITTED 下的并发激活提交——
   * 首个事务内 select 求值**之后**触发一次（快照已取、并发事务随后提交）。 */
  options: { onFirstTxSelect?: () => void } = {},
) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
  let nextEventInsertError: unknown = null;
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
      // `FOR UPDATE` 在假 DB 里无锁语义；真实锁等待返回即见最新已提交版本，
      // 由 PG 承担（替身只保证方法链不炸、返回行集合）。
      for: jest.fn(() => thenable(data)),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(state.rows.filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohExoConfig) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          return { returning: jest.fn(async () => hit) };
        }),
      })),
    })),
  } as unknown as Record<string, jest.Mock>;
  // NEST-431 / R2-SAM-007：事务暂存语义——事务内 select 读当前态、写入/更新
  // 先暂存，回调成功才提交；抛错整体回滚（供“supersede 后激活失败不留
  // 零 active 半态”断言）。
  db.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const pendingInserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
    const pendingUpdates: Array<{ cond: unknown; patch: Record<string, unknown> }> = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            // 先按当前状态求值（快照），再让"并发事务"提交——对齐 READ COMMITTED
            // 的语句级快照语义：本语句看不到快照之后提交的变更，后续语句才看得到。
            const data = state.rows.filter((r) => matches(cond, r));
            if (options.onFirstTxSelect) {
              const fn = options.onFirstTxSelect;
              (options as { onFirstTxSelect?: () => void }).onFirstTxSelect = undefined;
              fn();
            }
            return thenable(data);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          if (table === ewohEvent && nextEventInsertError) {
            const err = nextEventInsertError;
            nextEventInsertError = null;
            throw err;
          }
          pendingInserts.push({ table, row });
          return { returning: jest.fn(async () => [row]) };
        }),
      }),
      update: () => ({
        set: jest.fn((patch: Record<string, unknown>) => ({
          where: jest.fn((cond: unknown) => {
            const hit = state.rows.filter((r) => matches(cond, r));
            pendingUpdates.push({ cond, patch });
            // returning 返回应用 patch 后的行副本（对齐真实 drizzle 语义）。
            return { returning: jest.fn(async () => hit.map((r) => ({ ...r, ...patch }))) };
          }),
        })),
      }),
    };
    const out = await cb(tx);
    for (const { table, row } of pendingInserts) {
      if (table === ewohExoConfig) state.rows.push(row);
      if (table === ewohEvent) events.push(row);
    }
    for (const { cond, patch } of pendingUpdates) {
      for (const r of state.rows.filter((r) => matches(cond, r))) Object.assign(r, patch);
    }
    return out;
  });
  const service = new ExoConfigService(db as never);
  return {
    rows: state.rows,
    events,
    service,
    db,
    __failNextEventInsertWith: (err: unknown) => {
      nextEventInsertError = err;
    },
  };
}

const validProfile = {
  kind: 'assist_profile',
  exoId: EXO_ID,
  status: 'active',
  supportMode: 'lift_assist',
  parameters: { assistLevel: 0.6, torqueLimitNm: 25.0 },
  effectiveFrom: '2026-08-16T08:00:00Z',
  setBy: 'person:op-1',
};

describe('ExoConfigService（ADR-051/ADR-052 / §7）', () => {
  it('record 契约门 fail-closed：未知 supportMode / vendor_specific 无名 / 非法 assistLevel 拒绝且不落库', async () => {
    const { rows, service } = createConfigDb();
    await expect(service.record({ ...validProfile, supportMode: 'turbo' }, ORG_A))
      .rejects.toThrow(BadRequestException);
    await expect(service.record({ ...validProfile, supportMode: 'vendor_specific' }, ORG_A))
      .rejects.toThrow(BadRequestException);
    await expect(service.record({ ...validProfile, parameters: { assistLevel: 1.7 } }, ORG_A))
      .rejects.toThrow(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('record 台账往返 + 幂等（同 org+configId 返回既有行，不重复插入）+ 事件', async () => {
    const { rows, events, service } = createConfigDb();
    const first = await service.record({ ...validProfile, configId: 'exo-config:ap-1' }, ORG_A);
    expect(first.status).toBe('active');
    expect(rows).toHaveLength(1);
    expect(rows[0].recordJson).toMatchObject({ configId: 'exo-config:ap-1' });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('ExoConfigRecorded');

    const second = await service.record({ ...validProfile, configId: 'exo-config:ap-1' }, ORG_A);
    expect(second).toMatchObject({ configId: 'exo-config:ap-1' });
    expect(rows).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('activateProfile：旧 active CAS→superseded（supersededBy 判定事实）+ 目标激活 + 幂等', async () => {
    const { rows, service } = createConfigDb([
      configRow('exo-config:ap-old', ORG_A),
      configRow('exo-config:ap-new', ORG_A, {
        id: '00000000-0000-4000-8000-000000000002',
        status: 'retired',
        recordJson: { configId: 'exo-config:ap-new', kind: 'assist_profile', exoId: EXO_ID, tenantId: ORG_A, status: 'retired', supportMode: 'lift_assist', effectiveFrom: '2026-08-16T09:00:00Z', auditTrail: [{ actor: 'person:op-1', action: 'recorded', at: '2026-08-16T09:00:00Z' }] },
      }),
    ]);
    const result = await service.activateProfile(ORG_A, 'exo-config:ap-new', 'person:op-2');
    expect(result.status).toBe('active');
    const old = rows.find((r) => r.configId === 'exo-config:ap-old');
    expect(old?.status).toBe('superseded');
    expect(old?.supersededBy).toBe('exo-config:ap-new');
    // 幂等：再次激活返回自身，不重复 supersede
    const again = await service.activateProfile(ORG_A, 'exo-config:ap-new', 'person:op-2');
    expect(again.status).toBe('active');
  });

  it('R2-SAM-007：激活事务失败 → supersede 一并回滚（不留“旧已废、新未活”的零 active 半态）', async () => {
    const harness = createConfigDb([
      configRow('exo-config:ap-old', ORG_A),
      configRow('exo-config:ap-new', ORG_A, {
        id: '00000000-0000-4000-8000-000000000002',
        status: 'retired',
        recordJson: { configId: 'exo-config:ap-new', kind: 'assist_profile', exoId: EXO_ID, tenantId: ORG_A, status: 'retired', supportMode: 'lift_assist', effectiveFrom: '2026-08-16T09:00:00Z', auditTrail: [{ actor: 'person:op-1', action: 'recorded', at: '2026-08-16T09:00:00Z' }] },
      }),
    ]);
    // 激活主事实写入后、目录事件写入失败 → 整个事务（含 supersede）回滚。
    harness.__failNextEventInsertWith(new Error('event insert down'));
    await expect(
      harness.service.activateProfile(ORG_A, 'exo-config:ap-new', 'person:op-2'),
    ).rejects.toThrow('event insert down');
    const old = harness.rows.find((r) => r.configId === 'exo-config:ap-old');
    const target = harness.rows.find((r) => r.configId === 'exo-config:ap-new');
    expect(old?.status).toBe('active');
    expect(old?.supersededBy ?? null).toBeNull();
    expect(target?.status).toBe('retired');
    expect(harness.events).toHaveLength(0);
  });

  it('对抗审查：并发激活同一 (org+exo+mode) 不得产生两条 active（active 唯一）', async () => {
    // READ COMMITTED 竞态编排：本事务以旧快照起手（只见 ap-old active）；
    // 快照之后并发事务 T1 提交了「ap-old→superseded、ap-b→active」。
    // 旧实现：本事务对 ap-old 的 supersede UPDATE（where status='active'）
    // 命中 0 行是**静默**的，随后照常激活 ap-c → 组内出现 ap-b/ap-c 两条 active
    // （DB 只有普通索引，active 唯一只靠服务层——失守）。
    const rows = [
      configRow('exo-config:ap-old', ORG_A),
      configRow('exo-config:ap-b', ORG_A, {
        id: '00000000-0000-4000-8000-000000000002',
        status: 'superseded',
        recordJson: { configId: 'exo-config:ap-b', kind: 'assist_profile', exoId: EXO_ID, tenantId: ORG_A, status: 'superseded', supportMode: 'lift_assist', effectiveFrom: '2026-08-16T09:00:00Z', auditTrail: [{ actor: 'person:op-1', action: 'recorded', at: '2026-08-16T09:00:00Z' }] },
      }),
      configRow('exo-config:ap-c', ORG_A, {
        id: '00000000-0000-4000-8000-000000000003',
        status: 'retired',
        recordJson: { configId: 'exo-config:ap-c', kind: 'assist_profile', exoId: EXO_ID, tenantId: ORG_A, status: 'retired', supportMode: 'lift_assist', effectiveFrom: '2026-08-16T10:00:00Z', auditTrail: [{ actor: 'person:op-1', action: 'recorded', at: '2026-08-16T10:00:00Z' }] },
      }),
    ];
    const { service } = createConfigDb(rows, {
      onFirstTxSelect: () => {
        const concurrent = rows.find((r) => r.configId === 'exo-config:ap-old');
        if (concurrent) {
          concurrent.status = 'superseded';
          concurrent.supersededBy = 'exo-config:ap-b';
        }
        const b = rows.find((r) => r.configId === 'exo-config:ap-b');
        if (b) b.status = 'active';
      },
    });
    await service.activateProfile(ORG_A, 'exo-config:ap-c', 'person:op-2');
    const activeIds = rows.filter((r) => r.status === 'active').map((r) => r.configId).sort();
    // active 唯一：无论并发如何交错，提交后同组至多一条 active，且是本次目标。
    expect(activeIds).toEqual(['exo-config:ap-c']);
  });

  it('非 assist_profile 不可激活（显式拒绝）', async () => {
    const { service } = createConfigDb([
      configRow('exo-config:ft-1', ORG_A, { kind: 'fit', status: 'fitted', personId: 'person:p1', fittedAt: new Date(), fitter: 'person:op-2' }),
    ]);
    await expect(service.activateProfile(ORG_A, 'exo-config:ft-1', 'person:op-2'))
      .rejects.toThrow(BadRequestException);
  });

  it('租户作用域：他租户配置不可见（§15）', async () => {
    const { service } = createConfigDb([
      configRow('exo-config:ap-a', ORG_A),
      configRow('exo-config:ap-b', ORG_B),
    ]);
    const listA = await service.listConfigs(ORG_A);
    expect(listA).toHaveLength(1);
    expect(listA[0].configId).toBe('exo-config:ap-a');
    await expect(service.getConfig(ORG_A, 'exo-config:ap-b'))
      .rejects.toThrow(BadRequestException);
  });
});
