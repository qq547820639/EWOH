import { WorldCursorService, CursorExpiredError } from '../../../server/modules/world-cursor/world-cursor.service';
import { makeWorldDb } from '../../helpers/fake-world-db';

const ORG = 'org-cursor-test';

describe('world snapshot/delta cursor protocol（ADR-079：drizzle 假库）', () => {
  it('persists snapshot then returns incremental delta', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);

    await service.applyUpsert({ id: 'person-1', type: 'person' });
    // W4：游标读写显式租户上下文（org 谓词过滤，缺省 fail-closed）。
    const snapshot = await service.getSnapshot(ORG);
    expect(snapshot.entities).toHaveLength(1);

    await service.applyUpsert({ id: 'person-2', type: 'person' }, ORG);
    await service.applyRemoval('person-1', ORG);
    const delta = await service.getDelta(snapshot.cursor, 200, ORG);
    expect(delta.upserts.map((e) => e.id)).toEqual(['person-2']);
    expect(delta.removals).toEqual(['person-1']);
  });

  it('cursor 过期（快照推进后旧 cursor 失效）', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);
    await service.applyUpsert({ id: 'e1', type: 'person' }, ORG);
    const first = await service.getSnapshot(ORG);
    await service.applyUpsert({ id: 'e2', type: 'device' }, ORG);
    await service.getSnapshot(ORG);
    await expect(service.getDelta(first.cursor, 200, ORG)).rejects.toThrow(CursorExpiredError);
  });

  it('getSnapshot 缺省 org 上下文 → fail-closed 拒绝（W4）', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);
    await expect(service.getSnapshot()).rejects.toThrow(/org context missing/);
  });

  it('applyUpsert/applyRemoval 校验入参', async () => {
    const { db } = makeWorldDb();
    const service = new WorldCursorService(db as never);
    await expect(service.applyUpsert({ id: '', type: 'person' })).rejects.toThrow();
    await expect(service.applyRemoval('  ')).rejects.toThrow();
  });
});
