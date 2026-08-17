/// <reference types="jest" />
/* R2-SOP-003 / R2-SAM-003 回归：ingestSpatialScan 的 upsert 冲突目标必须是
 * 租户复合键 (org_id, entity_id)——跨租户同 entity_id 的扫描不允许覆盖他租户
 * 行的 sourceType/confidence/extra（standalone_059 复合唯一配套）。 */
import { SensorIngestService } from '../sensor-ingest.service';

interface CapturedUpsert {
  values: Record<string, unknown>;
  conflictTarget: unknown[];
}

function makeDb(captured: CapturedUpsert[]) {
  return {
    insert: jest.fn(() => ({
      values(v: Record<string, unknown>) {
        return {
          onConflictDoUpdate(cfg: { target: unknown[] }) {
            captured.push({ values: v, conflictTarget: cfg.target });
            return Promise.resolve();
          },
        };
      },
    })),
  };
}

describe('R2-SOP-003/R2-SAM-003: ingestSpatialScan 复合冲突目标', () => {
  it('upsert 冲突目标为 [orgId, entityId] 且 values 带 orgId', async () => {
    const captured: CapturedUpsert[] = [];
    const service = new SensorIngestService(makeDb(captured) as never);
    const response = await service.ingestSpatialScan(
      {
        entity_id: 'workstation:WS-01',
        entity_type: 'workstation',
        x: 1,
        y: 2,
        yaw: 0,
        source_type: 'lidar_scan',
        confidence: 0.9,
      },
      'org-1',
    );
    expect(response.accepted).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].values.orgId).toBe('org-1');
    // 冲突目标必须含 org 维度（复合唯一 uq_ewoh_spatial_entity_org_entity）
    const target = captured[0].conflictTarget as Array<{ name: string }>;
    expect(target.map((column) => column.name)).toEqual(
      expect.arrayContaining(['org_id', 'entity_id']),
    );
  });

  it('org 缺失 → fail-closed 拒绝（不写全局行）', async () => {
    const captured: CapturedUpsert[] = [];
    const service = new SensorIngestService(makeDb(captured) as never);
    const response = await service.ingestSpatialScan(
      { entity_id: 'workstation:WS-01', source_type: 'lidar_scan' } as never,
      null,
    );
    expect(response.accepted).toBe(false);
    expect(captured).toHaveLength(0);
  });
});
