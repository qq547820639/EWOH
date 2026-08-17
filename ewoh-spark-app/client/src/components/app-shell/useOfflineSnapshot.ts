import { useCallback, useEffect, useState } from 'react';
import { logger } from '@/lib/logger';
import { openOfflineDb } from '@/lib/offlineDb';
import { readOfflineStatus, type OfflineStatusSnapshot } from '@/lib/offlineStatus';

/**
 * 读取并订阅离线/在线状态快照。首次挂载时从离线库读取，并监听
 * navigator.onLine 变化以实时切换在线/离线。
 *
 * 网络状态切换时重新读取 IndexedDB（CLI-313）：pendingCount / lastSyncAt
 * 可能在离线期间变化，仅更新 online 字段会展示过期的待同步数量。
 */
export function useOfflineSnapshot(): OfflineStatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<OfflineStatusSnapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const db = await openOfflineDb();
      try {
        return await readOfflineStatus(db.pendingActions, db.syncState);
      } finally {
        db.close();
      }
    } catch (error) {
      // CLI-312：读取失败不静默吞掉，记录日志便于排查离线库损坏/被锁等问题。
      logger.error('useOfflineSnapshot: 读取离线状态失败，回退默认快照', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snap = await refresh();
      if (cancelled) return;
      setSnapshot(
        snap ?? { online: true, pendingCount: 0, lastSyncAt: null, syncing: false },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const resync = async (online: boolean) => {
      const snap = await refresh();
      setSnapshot(
        snap ? { ...snap, online } : { online, pendingCount: 0, lastSyncAt: null, syncing: false },
      );
    };
    const onOnline = () => void resync(true);
    const onOffline = () => void resync(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refresh]);

  return snapshot;
}
