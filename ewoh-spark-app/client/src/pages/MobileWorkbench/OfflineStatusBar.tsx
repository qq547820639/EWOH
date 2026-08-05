import { Loader2, Wifi, WifiOff, AlertTriangle, CloudOff } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { formatLastSync } from '../../lib/offlineStatus';
import type { WorkbenchNetworkState } from './useNetworkState';

export interface OfflineStatusBarProps {
  network: WorkbenchNetworkState;
  pendingCount: number;
  lastSyncAt: string | null;
  syncing: boolean;
}

/**
 * Prominent online/offline/weak-network/stale/syncing/sync-failed indicator
 * strip. Uses the existing industrial visual language (hsl semantic tokens).
 */
export function OfflineStatusBar({
  network,
  pendingCount,
  lastSyncAt,
  syncing,
}: OfflineStatusBarProps): React.ReactElement {
  const { isOnline, isSlow, isStale, syncFailed } = network;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-3 py-2 text-sm"
    >
      <span
        className={`inline-flex items-center gap-1.5 font-medium ${
          isOnline ? 'text-emerald-700' : 'text-amber-600'
        }`}
      >
        {isOnline ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
        {isOnline ? '在线' : '离线'}
      </span>
      {isOnline && isSlow && (
        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
          <CloudOff className="size-3" />
          弱网
        </span>
      )}
      {isStale && isOnline && !syncing && (
        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
          <AlertTriangle className="size-3" />
          数据陈旧
        </span>
      )}
      {syncFailed && (
        <span className="inline-flex items-center gap-1 text-xs text-red-700">
          <AlertTriangle className="size-3" />
          同步失败
        </span>
      )}
      <Badge variant="outline">待同步 {pendingCount}</Badge>
      <span className="text-xs text-[hsl(218_10%_42%)]">
        最后同步：{formatLastSync(lastSyncAt)}
      </span>
      {syncing && (
        <span className="inline-flex items-center gap-1 text-xs text-[hsl(218_10%_42%)]">
          <Loader2 className="size-3 animate-spin" />
          同步中
        </span>
      )}
    </div>
  );
}