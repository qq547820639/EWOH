import { useEffect, useState } from 'react';
import { openOfflineDb } from '@/lib/offlineDb';
import { readOfflineStatus, type OfflineStatusSnapshot } from '@/lib/offlineStatus';

/**
 * 读取并订阅离线/在线状态快照。首次挂载时从离线库读取，并监听
 * navigator.onLine 变化以实时切换在线/离线。
 */
export function useOfflineSnapshot(): OfflineStatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<OfflineStatusSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await openOfflineDb();
        const snap = await readOfflineStatus(db.pendingActions, db.syncState);
        if (cancelled) {
          db.close();
          return;
        }
        setSnapshot(snap);
        db.close();
      } catch {
        if (!cancelled) {
          setSnapshot({ online: true, pendingCount: 0, lastSyncAt: null, syncing: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onOnline = () => setSnapshot((s) => (s ? { ...s, online: true } : s));
    const onOffline = () => setSnapshot((s) => (s ? { ...s, online: false } : s));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return snapshot;
}