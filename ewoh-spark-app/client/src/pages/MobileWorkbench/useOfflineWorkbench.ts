import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  flushOfflineQueue,
  getLastSyncAt,
  migratePendingActionsFromLocalStorage,
  openOfflineDb,
  setLastSyncAt,
  createId,
  generateIdempotencyKey,
  type AuditLogEntry,
  type OfflineAttachment,
  type OfflineDatabase,
  type StoredPendingAction,
} from '../../lib/offlineDb';
import {
  compressImageFile,
  compressionForQuota,
  estimateAttachmentUsage,
  wouldExceedQuota,
} from '../../lib/attachmentCompression';
import { createDraftStore, type DraftStore } from '../../lib/draftStore';
import { uploadFile } from '../../api/files';
import { inspectMobileStep, transitionMobileStep } from '../../api/mobile';
import { getAuthUser } from '../../lib/auth';

export interface QueueAttachment {
  name: string;
  contentType: string;
  data: Blob;
}

export interface OfflineWorkbench {
  ready: boolean;
  isOnline: boolean;
  syncing: boolean;
  pendingActions: StoredPendingAction[];
  pendingCount: number;
  lastSyncAt: string | null;
  drafts: DraftStore | null;
  queueTransition: (opts: {
    orderId: string;
    stepId: string;
    action: string;
    body?: Record<string, unknown>;
    attachment?: QueueAttachment;
  }) => Promise<void>;
  queueInspection: (opts: {
    orderId: string;
    stepId: string;
    result: 'pass' | 'fail' | 'rework';
    note?: string;
  }) => Promise<void>;
  retryPending: (id: string) => Promise<void>;
  discardPending: (id: string) => Promise<void>;
  resolveConflict: (
    id: string,
    choice: 'local' | 'server' | 'manual',
  ) => Promise<void>;
  recordAudit: (entry: Omit<AuditLogEntry, 'key' | 'at'>) => Promise<void>;
  refreshPending: () => Promise<void>;
}

async function buildSyncOne(db: OfflineDatabase) {
  return async (item: StoredPendingAction): Promise<void> => {
    // TODO: idempotency — pass `item.idempotencyKey` (e.g. as an Idempotency-Key
    // header / body field) once the backend supports it. Until then the key is
    // only recorded locally in the audit log.
    if (item.type === 'transition') {
      let body = item.body;
      if (item.attachmentId) {
        const attachment = await db.attachments.get(item.attachmentId);
        if (attachment) {
          const file = new File([attachment.blob], attachment.name, {
            type: attachment.contentType,
          });
          const record = await uploadFile(file, `exception-${item.stepId}`);
          body = {
            ...(item.body ?? {}),
            attachments: [
              {
                id: record.id,
                filename: record.filename,
                contentType: record.contentType,
              },
            ],
          };
        }
      }
      await transitionMobileStep(
        item.orderId,
        item.stepId,
        item.action ?? '',
        body,
      );
      return;
    }
    await inspectMobileStep(item.orderId, item.stepId, {
      result: (item.body?.result as 'pass' | 'fail' | 'rework') ?? 'pass',
      note: item.body?.note as string | undefined,
    });
  };
}

export function useOfflineWorkbench(
  personId: string,
  options?: { onSynced?: () => void },
): OfflineWorkbench {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dbRef = useRef<OfflineDatabase | null>(null);
  const [ready, setReady] = useState(false);
  const [isOnline, setIsOnline] = useState(
    () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  );
  const [syncing, setSyncing] = useState(false);
  const [pendingActions, setPendingActions] = useState<StoredPendingAction[]>([]);
  const [lastSyncAt, setLastSyncAtState] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftStore | null>(null);

  const refreshPending = useCallback(async () => {
    const db = dbRef.current;
    if (!db) {
      return;
    }
    const items = await db.pendingActions.getAll();
    setPendingActions(items);
    setLastSyncAtState(await getLastSyncAt(db.syncState));
  }, []);

  // Open the DB once, migrate legacy localStorage, and hydrate status.
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      let db: OfflineDatabase;
      try {
        db = await openOfflineDb();
      } catch {
        // IndexedDB unavailable (private mode / old webview) — degrade to online-only.
        toast.error('离线存储不可用，将仅在线模式运行');
        return;
      }
      if (cancelled) {
        await db.close();
        return;
      }
      dbRef.current = db;
      try {
        await migratePendingActionsFromLocalStorage(
          typeof window !== 'undefined' ? window.localStorage : null,
          db.pendingActions,
          db.attachments,
          db.syncState,
        );
      } catch {
        // Migration is best-effort; never block a session on it.
      }
      setDrafts(createDraftStore(db.drafts));
      setReady(true);
      const items = await db.pendingActions.getAll();
      if (!cancelled) {
        setPendingActions(items);
        setLastSyncAtState(await getLastSyncAt(db.syncState));
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  // Online/offline listeners.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Auto-flush when online and ready.
  useEffect(() => {
    if (!isOnline || !ready || !dbRef.current) {
      return undefined;
    }
    let cancelled = false;
    const flush = async () => {
      const db = dbRef.current;
      if (!db) {
        return;
      }
      const items = await db.pendingActions.getAll();
      if (items.length === 0) {
        return;
      }
      setSyncing(true);
      const syncOne = await buildSyncOne(db);
      const result = await flushOfflineQueue(syncOne, db.pendingActions);
      await setLastSyncAt(db.syncState);
      if (!cancelled) {
        setSyncing(false);
        await refreshPending();
        if (result.synced.length > 0) {
          toast.success(`已同步 ${result.synced.length} 项离线操作`);
          optionsRef.current?.onSynced?.();
        }
        if (result.conflict.length > 0) {
          toast.error(`${result.conflict.length} 项操作存在状态冲突`, {
            description: '请在待同步队列中核对或重试。',
          });
        }
        if (result.failed.length > 0) {
          toast.error(`${result.failed.length} 项离线操作同步失败`, {
            description: '失败项不会阻塞队列中的其他操作。',
          });
        }
      }
    };
    void flush();
    return () => {
      cancelled = true;
    };
  }, [isOnline, ready, refreshPending]);

  const recordAudit = useCallback(
    async (entry: Omit<AuditLogEntry, 'key' | 'at'>) => {
      const db = dbRef.current;
      if (!db) {
        return;
      }
      await db.auditLog.put({
        ...entry,
        key: createId(),
        at: new Date().toISOString(),
      });
    },
    [],
  );

  const queueTransition = useCallback(
    async (opts: {
      orderId: string;
      stepId: string;
      action: string;
      body?: Record<string, unknown>;
      attachment?: QueueAttachment;
    }) => {
      const db = dbRef.current;
      if (!db) {
        throw new Error('离线存储不可用');
      }
      let attachmentId: string | undefined;
      if (opts.attachment) {
        const attachments = await db.attachments.getAll();
        const usage = estimateAttachmentUsage(attachments);
        const options = compressionForQuota(usage);
        const blob = await compressImageFile(
          new File([opts.attachment.data], opts.attachment.name, {
            type: opts.attachment.contentType,
          }),
          options,
        );
        if (wouldExceedQuota(usage, blob.size)) {
          throw new Error('附件容量已满，请先清理或减小照片再重试');
        }
        attachmentId = createId();
        await db.attachments.put({
          key: attachmentId,
          id: attachmentId,
          name: opts.attachment.name,
          contentType: opts.attachment.contentType,
          blob,
          size: blob.size,
          createdAt: new Date().toISOString(),
        });
      }
      const now = new Date().toISOString();
      const idempotencyKey = generateIdempotencyKey(
        opts.orderId,
        opts.stepId,
        opts.action,
      );
      const key = createId();
      await db.pendingActions.put({
        key,
        id: key,
        type: 'transition',
        orderId: opts.orderId,
        stepId: opts.stepId,
        action: opts.action,
        body: opts.body,
        attachmentId,
        idempotencyKey,
        actorId: personId,
        queuedAt: now,
        status: 'local',
        retryCount: 0,
      });
      await recordAudit({
        actorId: personId,
        action: `transition:${opts.action}`,
        idempotencyKey,
        result: 'queued',
        detail: { orderId: opts.orderId, stepId: opts.stepId },
      });
      await refreshPending();
    },
    [personId, recordAudit, refreshPending],
  );

  const queueInspection = useCallback(
    async (opts: {
      orderId: string;
      stepId: string;
      result: 'pass' | 'fail' | 'rework';
      note?: string;
    }) => {
      const db = dbRef.current;
      if (!db) {
        throw new Error('离线存储不可用');
      }
      const now = new Date().toISOString();
      const idempotencyKey = generateIdempotencyKey(opts.orderId, opts.stepId, 'inspection');
      const key = createId();
      await db.pendingActions.put({
        key,
        id: key,
        type: 'inspection',
        orderId: opts.orderId,
        stepId: opts.stepId,
        body: { result: opts.result, note: opts.note ?? null },
        idempotencyKey,
        actorId: personId,
        queuedAt: now,
        status: 'local',
        retryCount: 0,
      });
      await recordAudit({
        actorId: personId,
        action: 'inspection',
        idempotencyKey,
        result: 'queued',
        detail: { orderId: opts.orderId, stepId: opts.stepId, result: opts.result },
      });
      await refreshPending();
    },
    [personId, recordAudit, refreshPending],
  );

  const flushItem = useCallback(
    async (item: StoredPendingAction, includeManual: boolean) => {
      const db = dbRef.current;
      if (!db) {
        return;
      }
      setSyncing(true);
      const syncOne = await buildSyncOne(db);
      const result = await flushOfflineQueue(syncOne, db.pendingActions, {
        includeManual,
      });
      await setLastSyncAt(db.syncState);
      setSyncing(false);
      await refreshPending();
      return result;
    },
    [refreshPending],
  );

  const retryPending = useCallback(
    async (id: string) => {
      const db = dbRef.current;
      if (!db) {
        return;
      }
      if (!isOnline) {
        toast.error('当前处于离线状态，无法重试');
        return;
      }
      const item = (await db.pendingActions.getAll()).find((c) => c.id === id);
      if (!item) {
        return;
      }
      const result = await flushItem(item, true);
      if (result?.synced.length) {
        toast.success(`已重试同步：${item.stepId}`);
        optionsRef.current?.onSynced?.();
      } else if (result?.conflict.length) {
        toast.error(`重试仍存在状态冲突：${item.stepId}`);
      } else {
        toast.error(`重试失败：${item.stepId}`);
      }
    },
    [isOnline, flushItem],
  );

  const discardPending = useCallback(
    async (id: string) => {
      const db = dbRef.current;
      if (!db) {
        return;
      }
      const item = (await db.pendingActions.getAll()).find((c) => c.id === id);
      await db.pendingActions.delete(id);
      if (item?.attachmentId) {
        await db.attachments.delete(item.attachmentId);
      }
      await recordAudit({
        actorId: personId,
        action: item?.type ?? 'discard',
        idempotencyKey: item?.idempotencyKey ?? '',
        result: 'discarded',
      });
      await refreshPending();
      toast.info('已丢弃冲突项，请核对现场实际状态');
    },
    [personId, recordAudit, refreshPending],
  );

  /**
   * Resolves a conflict item. The backend state machine is authoritative and is
   * never bypassed here — all choices remove the queued action so it is not
   * re-delivered, and the decision is recorded in the audit log.
   * TODO: backend — add an idempotent/force-resolution endpoint so "采用本地" can
   * actually re-apply the local value to the server; until then the server state
   * stands and the local action is dropped.
   */
  const resolveConflict = useCallback(
    async (id: string, choice: 'local' | 'server' | 'manual') => {
      const db = dbRef.current;
      if (!db) {
        return;
      }
      const item = (await db.pendingActions.getAll()).find((c) => c.id === id);
      await db.pendingActions.delete(id);
      if (item?.attachmentId) {
        await db.attachments.delete(item.attachmentId);
      }
      await recordAudit({
        actorId: personId,
        action: item?.type ?? 'conflict',
        idempotencyKey: item?.idempotencyKey ?? '',
        result: `resolved:${choice}`,
        detail: { orderId: item?.orderId, stepId: item?.stepId },
      });
      await refreshPending();
      const label =
        choice === 'local'
          ? '已采用本地值'
          : choice === 'server'
            ? '已采用服务端值'
            : '已进入手动编辑';
      toast.info(`${label}：${item?.stepId ?? ''}`);
    },
    [personId, recordAudit, refreshPending],
  );

  return {
    ready,
    isOnline,
    syncing,
    pendingActions,
    pendingCount: pendingActions.length,
    lastSyncAt,
    drafts,
    queueTransition,
    queueInspection,
    retryPending,
    discardPending,
    resolveConflict,
    recordAudit,
    refreshPending,
  };
}