import type { Draft, SimpleStore } from './offlineDb';

export interface DraftField {
  orderId: string;
  stepId: string;
  field: string;
}

/** Stable, unique key for a draft (orderId + stepId + field). */
export function draftKey(orderId: string, stepId: string, field: string): string {
  return `${orderId}:${stepId}:${field}`;
}

export interface DraftStore {
  save(field: DraftField, value: unknown): Promise<void>;
  get(field: DraftField): Promise<unknown | undefined>;
  clear(field: DraftField): Promise<void>;
  clearStep(stepId: string): Promise<void>;
  getAll(): Promise<Draft[]>;
}

/**
 * IndexedDB-backed draft store. Drafts survive refresh/restart and are restored
 * when the workbench reloads. Instantiating is cheap; the underlying store is
 * injected so tests can use an in-memory fake.
 */
export function createDraftStore(store: SimpleStore<Draft>): DraftStore {
  return {
    async save(field, value) {
      if (value === undefined || value === null || value === '') {
        await store.delete(draftKey(field.orderId, field.stepId, field.field));
        return;
      }
      await store.put({
        key: draftKey(field.orderId, field.stepId, field.field),
        orderId: field.orderId,
        stepId: field.stepId,
        field: field.field,
        value,
        updatedAt: new Date().toISOString(),
      });
    },
    async get(field) {
      const record = await store.get(draftKey(field.orderId, field.stepId, field.field));
      return record?.value;
    },
    async clear(field) {
      await store.delete(draftKey(field.orderId, field.stepId, field.field));
    },
    async clearStep(stepId) {
      const drafts = await store.getAll();
      for (const draft of drafts) {
        if (draft.stepId === stepId) {
          await store.delete(draft.key);
        }
      }
    },
    async getAll() {
      return store.getAll();
    },
  };
}