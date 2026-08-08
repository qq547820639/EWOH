/* SensorIngestService 单元测试（P1-Ingest decomposition）。
 *
 * 覆盖 environment / camera / spatial scan / location 四类传感器 ingest 的
 * 独立落库路径（从 IngestService 抽出后行为不变）。
 */
import { SensorIngestService } from '@server/modules/ingest/sensor-ingest.service';
import {
  ewohEnvironment,
  ewohWorldState,
  ewohSpatialEntity,
} from '@server/database/schema';

function createDb() {
  const insertCalls: Array<{ table: unknown; rows: unknown[] }> = [];
  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((rows: unknown[]) => {
        insertCalls.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        return {
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        };
      }),
    })),
  };
  return { db, insertCalls };
}

describe('SensorIngestService', () => {
  it('ingestEnvironment 写入 ewoh_environment', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestEnvironment({
      sensor_id: 'SEN-1',
      event_time: new Date().toISOString(),
      temperature: 25.5,
      source_type: 'real',
    });

    expect(res.accepted).toBe(true);
    const envInsert = insertCalls.find((c) => c.table === ewohEnvironment);
    expect(envInsert).toBeDefined();
    expect((envInsert!.rows[0] as Record<string, unknown>).sensorId).toBe('SEN-1');
  });

  it('ingestCamera 写入 ewoh_world_state（每个 detection 一条）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestCamera({
      camera_id: 'CAM-1',
      event_time: new Date().toISOString(),
      detections: [
        { class_name: 'person', confidence: 0.9 },
        { class_name: 'person', confidence: 0.8, track_id: 'T-2' },
      ],
    });

    expect(res.accepted).toBe(true);
    const wsInsert = insertCalls.find((c) => c.table === ewohWorldState);
    expect(wsInsert!.rows).toHaveLength(2);
  });

  it('ingestSpatialScan upsert ewoh_spatial_entity', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestSpatialScan({
      entity_id: 'WS-1',
      entity_type: 'workstation',
      source_type: 'real' as never,
      x: 10,
      y: 20,
    });

    expect(res.accepted).toBe(true);
    const entInsert = insertCalls.find((c) => c.table === ewohSpatialEntity);
    expect(entInsert).toBeDefined();
    expect((entInsert!.rows[0] as Record<string, unknown>).entityId).toBe('WS-1');
  });

  it('ingestLocation 写入 ewoh_world_state（定位状态快照）', async () => {
    const { db, insertCalls } = createDb();
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestLocation({
      entity_id: 'P-1',
      locator: 'uwb',
      confidence: 0.9,
      x: 5,
      y: 6,
      ts: new Date().toISOString(),
    });

    expect(res.accepted).toBe(true);
    const wsInsert = insertCalls.find((c) => c.table === ewohWorldState);
    expect(wsInsert).toBeDefined();
    const state = (wsInsert!.rows[0] as Record<string, unknown>).stateJson as Record<string, unknown>;
    expect(state.locator).toBe('uwb');
  });

  it('DB 失败 → accepted=false 且不抛异常', async () => {
    const db = {
      insert: jest.fn(() => {
        throw new Error('db down');
      }),
    };
    const svc = new SensorIngestService(db as never);

    const res = await svc.ingestEnvironment({
      sensor_id: 'SEN-X',
      event_time: new Date().toISOString(),
    });

    expect(res.accepted).toBe(false);
    expect(res.data_quality).toBe('invalid');
  });
});
