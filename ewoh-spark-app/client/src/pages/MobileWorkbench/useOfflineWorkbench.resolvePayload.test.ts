/* buildLocalResolvePayload · 冲突项「采用本地」的附件重建测试（攻击面 b）。
 *
 * 背景：离线异常提交（带照片）入队时，附件引用只在 flush 投递瞬间由
 * buildSyncOne 临时合并进请求体，队列里的 item.body 从不包含它。若冲突解析
 * 「采用本地」直接拿 item.body 重放，重放的本地值会静默丢掉现场照片。
 * 不变量：
 *  1. 带附件的冲突项 → 重放 payload 必须包含刚上传的附件引用；
 *  2. 上传拿到的是队列里那份原始附件（名称/类型一致）；
 *  3. 无附件 / 附件已被清理的项 → 按原 body 重放（不编造引用）；
 *  4. body 为空的项重放为空对象，而不是 undefined 透传。
 */
import { buildLocalResolvePayload } from '../../lib/offlineDb';
import type { OfflineAttachment, SimpleStore, StoredPendingAction } from '../../lib/offlineDb';

function memoryAttachmentStore(): SimpleStore<OfflineAttachment> & {
  values: Map<string, OfflineAttachment>;
} {
  const values = new Map<string, OfflineAttachment>();
  return {
    values,
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

function item(overrides: Partial<StoredPendingAction> = {}): StoredPendingAction {
  return {
    key: 'q-1',
    id: 'q-1',
    type: 'transition',
    orderId: 'WO-1',
    stepId: 'S1',
    action: 'pause',
    body: { code: 'MOBILE_EXCEPTION', note: '划伤' },
    idempotencyKey: 'k-1',
    queuedAt: '2026-09-10T10:00:00.000Z',
    status: 'conflict',
    ...overrides,
  };
}

describe('buildLocalResolvePayload（冲突重放前重建附件引用）', () => {
  it('带附件的冲突项：重放 payload 必须包含刚上传的附件引用', async () => {
    const store = memoryAttachmentStore();
    await store.put({
      key: 'att-1',
      id: 'att-1',
      name: 'scratch.jpg',
      contentType: 'image/jpeg',
      blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
      size: 10,
      createdAt: '2026-09-10T10:00:00.000Z',
    });
    const upload = jest.fn().mockResolvedValue({
      id: 'FILE-1',
      filename: 'scratch.jpg',
      contentType: 'image/jpeg',
    });

    const payload = await buildLocalResolvePayload(
      item({ attachmentId: 'att-1' }),
      store,
      upload,
    );

    expect(upload).toHaveBeenCalledTimes(1);
    const uploaded = upload.mock.calls[0][0] as File;
    expect(uploaded.name).toBe('scratch.jpg');
    expect(uploaded.type).toBe('image/jpeg');
    expect(payload).toEqual({
      code: 'MOBILE_EXCEPTION',
      note: '划伤',
      attachments: [{ id: 'FILE-1', filename: 'scratch.jpg', contentType: 'image/jpeg' }],
    });
  });

  it('无附件的冲突项：按原 body 重放，不上传', async () => {
    const upload = jest.fn();
    const payload = await buildLocalResolvePayload(item(), memoryAttachmentStore(), upload);
    expect(upload).not.toHaveBeenCalled();
    expect(payload).toEqual({ code: 'MOBILE_EXCEPTION', note: '划伤' });
  });

  it('附件已被清理：如实按原 body 重放（不编造附件引用）', async () => {
    const upload = jest.fn().mockResolvedValue({
      id: 'FILE-X',
      filename: 'x.jpg',
      contentType: 'image/jpeg',
    });
    // attachmentId 指向不存在的记录。
    const payload = await buildLocalResolvePayload(
      item({ attachmentId: 'missing' }),
      memoryAttachmentStore(),
      upload,
    );
    expect(upload).not.toHaveBeenCalled();
    expect(payload).toEqual({ code: 'MOBILE_EXCEPTION', note: '划伤' });
  });

  it('body 为空的项：重放为空对象而不是 undefined', async () => {
    const payload = await buildLocalResolvePayload(
      item({ body: undefined }),
      memoryAttachmentStore(),
      jest.fn(),
    );
    expect(payload).toEqual({});
  });
});
