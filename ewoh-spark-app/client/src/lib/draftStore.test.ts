import { createDraftStore, draftKey, type DraftStore } from './draftStore';
import type { Draft, SimpleStore } from './offlineDb';

function createMemoryStore<T extends { key: string }>(): SimpleStore<T> {
  const values = new Map<string, T>();
  return {
    async getAll() {
      return Array.from(values.values());
    },
    async get(key) {
      return values.get(key);
    },
    async put(value) {
      values.set(value.key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async clear() {
      values.clear();
    },
    async count() {
      return values.size;
    },
  };
}

describe('draftStore', () => {
  let store: SimpleStore<Draft>;
  let drafts: DraftStore;

  beforeEach(() => {
    store = createMemoryStore<Draft>();
    drafts = createDraftStore(store);
  });

  it('saves and restores a draft', async () => {
    const field = { orderId: 'WO-1', stepId: 'S1', field: 'qcNote' };
    await drafts.save(field, '合格');
    expect(await drafts.get(field)).toBe('合格');
  });

  it('deletes a draft when the value is empty', async () => {
    const field = { orderId: 'WO-1', stepId: 'S1', field: 'qcNote' };
    await drafts.save(field, '合格');
    await drafts.save(field, '');
    expect(await drafts.get(field)).toBeUndefined();
  });

  it('clears all drafts for a step', async () => {
    await drafts.save({ orderId: 'WO-1', stepId: 'S1', field: 'qcNote' }, 'a');
    await drafts.save({ orderId: 'WO-1', stepId: 'S1', field: 'exceptionNote' }, 'b');
    await drafts.save({ orderId: 'WO-1', stepId: 'S2', field: 'qcNote' }, 'c');
    await drafts.clearStep('S1');
    expect(await drafts.getAll()).toHaveLength(1);
  });

  it('builds stable draft keys', () => {
    expect(draftKey('WO-1', 'S1', 'qcNote')).toBe('WO-1:S1:qcNote');
  });
});