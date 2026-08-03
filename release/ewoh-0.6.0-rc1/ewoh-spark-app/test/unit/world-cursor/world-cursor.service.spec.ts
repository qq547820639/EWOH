import { WorldCursorService, CursorExpiredError } from '../../../server/modules/world-cursor/world-cursor.service';

describe('world snapshot/delta cursor protocol', () => {
  it('persists snapshot then returns incremental delta', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { seq: 1, entity_id: 'person-1', delta_type: 'upsert', payload: { id: 'person-1', type: 'person' } },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ snapshot_version: 1 }])
      .mockResolvedValueOnce([
        { seq: 2, entity_id: 'person-2', delta_type: 'upsert', payload: { id: 'person-2', type: 'person' } },
        { seq: 3, entity_id: 'person-1', delta_type: 'removal', payload: null },
      ]);
    const service = new WorldCursorService({ execute } as never);

    await service.applyUpsert({ id: 'person-1', type: 'person' });
    const snapshot = await service.getSnapshot();
    expect(snapshot.entities).toHaveLength(1);

    await service.applyUpsert({ id: 'person-2', type: 'person' });
    await service.applyRemoval('person-1');
    const delta = await service.getDelta(snapshot.cursor);
    expect(delta.upserts.map((entity) => entity.id)).toEqual(['person-2']);
    expect(delta.removals).toEqual(['person-1']);
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('ewoh_world_delta_log');
    expect(JSON.stringify(execute.mock.calls[3][0])).toContain('ewoh_world_snapshot');
  });

  it('expires with 410 semantics when snapshot version changes', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { seq: 1, entity_id: 'person-1', delta_type: 'upsert', payload: { id: 'person-1', type: 'person' } },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          snapshot_version: 1,
          payload: { entities: [{ id: 'person-1', type: 'person' }], lastSeq: 1, generatedAt: '2026-08-03T00:00:00.000Z' },
          entity_count: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ snapshot_version: 2 }]);
    const service = new WorldCursorService({ execute } as never);

    await service.applyUpsert({ id: 'person-1', type: 'person' });
    const cursor = (await service.getSnapshot()).cursor;
    await service.getSnapshot();

    await expect(service.getDelta(cursor)).rejects.toThrow(CursorExpiredError);
  });
});
