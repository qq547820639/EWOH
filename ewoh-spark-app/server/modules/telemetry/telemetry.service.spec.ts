import { TelemetryService, TELEMETRY_MAX_BATCH } from './telemetry.service';

/**
 * 埋点落库测试。核心契约：
 * 1. 白名单外事件跳过（端点公开可写，防刷库）；
 * 2. 静默失败——写库异常不抛 500；
 * 3. 批量上限 TELEMETRY_MAX_BATCH。
 */

function createService() {
  const inserted: Array<Record<string, unknown>> = [];
  let failInsert = false;
  const db = {
    insert: () => ({
      values: (rows: unknown) => {
        if (failInsert) return Promise.reject(new Error('db down'));
        const list = Array.isArray(rows) ? rows : [rows];
        inserted.push(...(list as Array<Record<string, unknown>>));
        return Promise.resolve();
      },
    }),
  } as never;
  const service = new TelemetryService(db);
  return { service, inserted, setFail: () => (failInsert = true) };
}

const actor = { primaryOrgId: 'org-1', userId: 'u-1', roles: ['dispatcher'] } as never;

describe('TelemetryService.recordBatch', () => {
  it('合法事件写入 ewoh_event，eventType=ui_telemetry、status=closed', async () => {
    const { service, inserted } = createService();
    const result = await service.recordBatch(
      [{ name: 'object_workbench_view', at: 1725148800000, props: { objectType: 'scheduling_plan' } }],
      actor,
    );
    expect(result).toEqual({ accepted: 1 });
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.eventType).toBe('ui_telemetry');
    expect(row.eventCode).toBe('object_workbench_view');
    expect(row.status).toBe('closed');
    expect(row.sourceType).toBe('telemetry');
    expect(row.orgId).toBe('org-1');
    expect(row.eventId).toMatch(/^tel-/);
    expect(row.evidenceJson).toEqual({ props: { objectType: 'scheduling_plan' } });
  });

  it('白名单外事件跳过（端点公开可写，防刷库）', async () => {
    const { service, inserted } = createService();
    const result = await service.recordBatch([
      { name: 'object_workbench_view' },
      { name: 'not_in_allowlist' },
      { name: 'drop_table' },
    ]);
    expect(result.accepted).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it('非法输入（null/缺 name/非字符串）逐条跳过，不抛错', async () => {
    const { service, inserted } = createService();
    const result = await service.recordBatch([
      null as never,
      { name: 123 } as never,
      { name: 'terminal_action_click' },
    ]);
    expect(result.accepted).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it('批量超过上限时截断到 TELEMETRY_MAX_BATCH', async () => {
    const { service, inserted } = createService();
    const events = Array.from({ length: TELEMETRY_MAX_BATCH + 30 }, () => ({
      name: 'nav_source',
    }));
    const result = await service.recordBatch(events);
    expect(result.accepted).toBe(TELEMETRY_MAX_BATCH);
    expect(inserted).toHaveLength(TELEMETRY_MAX_BATCH);
  });

  it('org 上下文缺失时 orgId 为 null（列可空），仍接受', async () => {
    const { service, inserted } = createService();
    const result = await service.recordBatch([{ name: 'nav_source' }]);
    expect(result.accepted).toBe(1);
    expect(inserted[0].orgId).toBeNull();
  });

  it('写库异常静默失败：返回 accepted=0，不抛 500', async () => {
    const { service, setFail } = createService();
    setFail();
    await expect(
      service.recordBatch([{ name: 'nav_source' }]),
    ).resolves.toEqual({ accepted: 0 });
  });

  it('空批次直接返回 0', async () => {
    const { service } = createService();
    expect(await service.recordBatch([])).toEqual({ accepted: 0 });
    expect(await service.recordBatch(undefined)).toEqual({ accepted: 0 });
  });
});
