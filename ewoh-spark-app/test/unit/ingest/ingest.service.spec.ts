import { BadRequestException } from '@nestjs/common';
import { IngestService } from '../../../server/modules/ingest/ingest.service';
import {
  ewohDevice,
  ewohEvent,
  ewohSpatialEntity,
  ewohTelemetry,
} from '@server/database/schema';

function createIngestDb(selectResults: unknown[][]) {
  const insertRows: Array<{
    table: unknown;
    row: Record<string, unknown>;
  }> = [];
  let selectCall = 0;
  const selectLimit = jest.fn().mockImplementation(() =>
    Promise.resolve(
      selectResults[Math.min(selectCall++, selectResults.length - 1)] ?? [],
    ),
  );
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: selectLimit })),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        return { onConflictDoUpdate: jest.fn().mockResolvedValue([]) };
      }),
    })),
  };
  return { db, insertRows, selectLimit };
}

function createRuleEngine() {
  return {
    evaluate: jest.fn().mockResolvedValue(2),
  };
}

describe('IngestService canonical UnifiedExoFrame mapping', () => {
  it('maps nested pose/load/device/quality fields into telemetry and device rows', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const ruleEngine = createRuleEngine();
    const service = new IngestService(
      db as never,
      ruleEngine as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-INGEST-1',
      event_time: new Date().toISOString(),
      source_type: 'real',
      pose: {
        trunk_pitch_deg: 50,
        angular_velocity_dps: 12.3,
        joint_angles_deg: { left_knee: 45 },
      },
      load: {
        assist_level: 0.6,
        torque_nm: 18.5,
        cumulative_load_score: 0.85,
      },
      device: {
        battery_pct: 88,
        temperature_c: 36.5,
        fault_code: null,
      },
      quality: {
        packet_loss_pct: 1.2,
        confidence: 0.95,
        status: 'good',
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.data_quality).toBe('good');
    const telemetry = insertRows.find(
      (entry) => entry.table === ewohTelemetry,
    )?.row;
    expect(telemetry?.deviceId).toBe('EXO-INGEST-1');
    expect(telemetry?.pitchDeg).toBe(50);
    expect(telemetry?.loadScore).toBe(0.85);
    expect(telemetry?.batteryPct).toBe(88);
    expect(telemetry?.assistLevel).toBe(0.6);
    expect(telemetry?.torqueNm).toBe(18.5);
    expect(telemetry?.angularVelocityDps).toBe(12.3);
    expect(telemetry?.temperatureC).toBe(36.5);
    expect(telemetry?.dataConfidence).toBe(0.95);
    expect(telemetry?.dataQuality).toBe('good');
    expect(telemetry?.sourceType).toBe('real');

    const device = insertRows.find((entry) => entry.table === ewohDevice)?.row;
    expect(device?.deviceId).toBe('EXO-INGEST-1');
    expect(device?.batteryPct).toBe(88);
    expect(device?.sourceType).toBe('real');
    expect(ruleEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'EXO-INGEST-1',
        pitchDeg: 50,
        loadScore: 0.85,
        batteryPct: 88,
      }),
    );
  });

  it('normalizes a legacy 0-100 load_score to 0-1', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
    );

    await service.ingestExoskeleton({
      device_id: 'EXO-LEGACY',
      entity_id: 'EXO-LEGACY',
      event_time: new Date().toISOString(),
      load_score: 80,
      pitch_deg: 12,
      battery_pct: 90,
    });

    const telemetry = insertRows.find(
      (entry) => entry.table === ewohTelemetry,
    )?.row;
    expect(telemetry?.loadScore).toBe(0.8);
    expect(telemetry?.pitchDeg).toBe(12);
  });

  it('marks battery out of range as invalid and still persists the row', async () => {
    const { db, insertRows } = createIngestDb([[{}], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-BAD-BATTERY',
      event_time: new Date().toISOString(),
      device: { battery_pct: 150 },
    });

    expect(result.accepted).toBe(true);
    expect(result.data_quality).toBe('invalid');
    const telemetry = insertRows.find(
      (entry) => entry.table === ewohTelemetry,
    )?.row;
    expect(telemetry?.dataQuality).toBe('invalid');
  });

  it('skips duplicate raw_ref frames', async () => {
    const { db, insertRows } = createIngestDb([[{}], [{}]]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-DUP',
      event_time: new Date().toISOString(),
      raw_ref: 'sha256-duplicate',
    });

    expect(result.accepted).toBe(false);
    expect(result.skipped).toBe(true);
    expect(
      insertRows.some((entry) => entry.table === ewohTelemetry),
    ).toBe(false);
  });

  it('rejects unknown entities with a data-quality event', async () => {
    const { db, insertRows } = createIngestDb([[], []]);
    const service = new IngestService(
      db as never,
      createRuleEngine() as unknown as never,
    );

    const result = await service.ingestExoskeleton({
      entity_id: 'EXO-UNKNOWN',
      event_time: new Date().toISOString(),
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('不存在');
    expect(
      insertRows.some((entry) => entry.table === ewohEvent),
    ).toBe(true);
  });

  it('requires an entity or device identifier', async () => {
    const service = new IngestService(
      {} as never,
      createRuleEngine() as unknown as never,
    );

    await expect(
      service.ingestExoskeleton({
        event_time: new Date().toISOString(),
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
