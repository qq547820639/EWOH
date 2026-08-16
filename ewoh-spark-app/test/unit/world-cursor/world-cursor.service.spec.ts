import { WorldCursorService, CursorExpiredError } from '../../../server/modules/world-cursor/world-cursor.service';
import { makeWorldDb } from '../../helpers/fake-world-db';

describe('world snapshot/delta cursor protocol（ADR-079：drizzle 假库）', () => {
  it('persists snapshot then returns incremental delta', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);

    await service.applyUpsert({ id: 'person-1', type: 'person' });
    const snapshot = await service.getSnapshot();
    expect(snapshot.entities).toHaveLength(1);

    await service.applyUpsert({ id: 'person-2', type: 'person' });
    await service.applyRemoval('person-1');
    const delta = await service.getDelta(snapshot.cursor);
    expect(delta.upserts.map((e) => e.id)).toEqual(['person-2']);
    expect(delta.removals).toEqual(['person-1']);
  });

  it('cursor 过期（快照推进后旧 cursor 失效）', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);
    await service.applyUpsert({ id: 'e1', type: 'person' });
    const first = await service.getSnapshot();
    await service.applyUpsert({ id: 'e2', type: 'device' });
    await service.getSnapshot();
    await expect(service.getDelta(first.cursor)).rejects.toThrow(CursorExpiredError);
  });

  it('applyUpsert/applyRemoval 校验入参', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);
    await expect(service.applyUpsert({ id: '', type: 'person' })).rejects.toThrow();
    await expect(service.applyRemoval('  ')).rejects.toThrow();
  });
});
