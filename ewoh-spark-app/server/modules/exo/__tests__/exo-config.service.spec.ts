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

function createConfigDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
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
  };
  const service = new ExoConfigService(db as never);
  return { rows: state.rows, events, service };
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
