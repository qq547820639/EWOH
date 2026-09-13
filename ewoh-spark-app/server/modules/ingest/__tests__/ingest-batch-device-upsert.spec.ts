/// <reference types="jest" />
/* 回归（UR4 对抗审查 2026-09-13）：批量外骨骼接入的设备台账 upsert 与批内幂等。
 *
 * 1) R2-SOP-020 的本意是"批量 set 字段与单帧 upsertDevice 对齐"。单帧路径对
 *    帧**缺失**的元数据用 `?? undefined`（不更新、保留既有值）；批量路径却直接
 *    `excluded.*`——帧没带 battery_pct/fault_code 时把台账里已知值**擦成 NULL**。
 *    后果：调度 candidate-engine 对"电量未知"给无穷能耗罚 → fail-closed 不派工，
 *    一批不带电量的帧就能让设备凭空从可派工集合消失；fault_code 同理被清。
 *    修复后 set 必须是 coalesce(excluded.x, 现值)。
 * 2) 批量路径的 raw_ref 预检只查库——同一批里两帧 raw_ref 相同（重放缓冲）
 *    时两行都写进 ewoh_telemetry，传输级幂等在批内失效。
 */
import { IngestService } from '../ingest.service';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_CTX = {
  userId: 'ingest',
  primaryOrgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  isGlobalAdmin: false,
};

interface ConflictCapture {
  target: unknown;
  set: Record<string, unknown>;
}

function makeBatchHarness() {
  const inserted: Array<Array<Record<string, unknown>>> = [];
  const conflicts: ConflictCapture[] = [];
  // 第 1 次 where = entity 预检（命中）、第 2 次 = raw_ref 预检（库里无重复）。
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest
          .fn()
          .mockResolvedValueOnce([{ entityId: 'exo-1' }])
          .mockResolvedValueOnce([]),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((v: Array<Record<string, unknown>>) => {
        inserted.push(v);
        const p = Promise.resolve() as Promise<void> & {
          onConflictDoUpdate: (c: ConflictCapture) => Promise<void>;
        };
        p.onConflictDoUpdate = (c) => {
          conflicts.push(c);
          return Promise.resolve();
        };
        return p;
      }),
    })),
  };
  const service = new IngestService(
    db as never,
    { evaluate: jest.fn().mockResolvedValue(0) } as never,
    {} as never,
    {} as never,
    { handleTrigger: jest.fn() } as never,
    { resolveBatch: jest.fn().mockResolvedValue(new Map()) } as never,
  );
  return { service, inserted, conflicts };
}

function frameNoBattery(recordId: string): Record<string, unknown> {
  return {
    device_id: 'exo-1',
    entity_id: 'exo-1',
    event_time: new Date().toISOString(),
    record_id: recordId,
    // 故意不带 battery_pct / fault_code / firmware_version 等元数据
  };
}

describe('批量接入：设备台账 upsert 不擦除帧缺失的已知元数据', () => {
  it('冲突更新对可空元数据用 coalesce(excluded, 现值)（与单帧 ?? undefined 同口径）', async () => {
    const { service, conflicts } = makeBatchHarness();
    await service.ingestExoskeletonBatch([frameNoBattery('rec-1') as never], ORG_CTX as never);
    expect(conflicts).toHaveLength(1);
    const dialect = new PgDialect();
    const setSql = (fragment: unknown): string => {
      expect(fragment).toBeDefined();
      return dialect.sqlToQuery(fragment as SQL).sql;
    };
    // 帧缺电量 → 保留台账现值，绝不写 excluded 的 NULL
    expect(setSql(conflicts[0].set.batteryPct)).toContain('coalesce(excluded.battery_pct');
    expect(setSql(conflicts[0].set.faultCode)).toContain('coalesce(excluded.fault_code');
    expect(setSql(conflicts[0].set.firmwareVersion)).toContain('coalesce(excluded.firmware_version');
    expect(setSql(conflicts[0].set.temperatureC)).toContain('coalesce(excluded.temperature_c');
  });

  it('批量首插设备行带类别 exoskeleton（与单帧 upsertDevice 同源）', async () => {
    const { service, inserted } = makeBatchHarness();
    await service.ingestExoskeletonBatch([frameNoBattery('rec-2') as never], ORG_CTX as never);
    // inserted[0] = 设备行数组，inserted[1] = 遥测行数组
    const deviceRows = inserted[0];
    expect(deviceRows[0].deviceCategory).toBe('exoskeleton');
  });
});

describe('批量接入：批内 raw_ref 幂等', () => {
  it('同一批内两帧 raw_ref 相同 → 第二帧 skipped，不写第二行遥测', async () => {
    const { service, inserted } = makeBatchHarness();
    const t = new Date().toISOString();
    const f1 = { device_id: 'exo-1', entity_id: 'exo-1', event_time: t, record_id: 'rec-dup' };
    const f2 = { ...f1 };
    const result = await service.ingestExoskeletonBatch([f1, f2] as never, ORG_CTX as never);
    expect(result.results[0].accepted).toBe(true);
    expect(result.results[1].skipped).toBe(true);
    // inserted[1] = 遥测行数组：只有第一帧落库
    const telemetryRows = inserted[1];
    expect(telemetryRows).toHaveLength(1);
  });
});
