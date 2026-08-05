import { useEffect, useState } from 'react';
import { isDataStale } from '../../lib/offlineStatus';
import { resolveNetworkQuality, type ConnectionLike, type NetworkQuality } from '../../lib/networkQuality';

export interface WorkbenchNetworkState {
  isOnline: boolean;
  quality: NetworkQuality;
  isSlow: boolean;
  isStale: boolean;
  syncFailed: boolean;
}

interface Frame {
  isOnline: boolean;
  lastSyncAt: string | null;
  pendingStatuses: readonly string[];
}

function readConnection(): ConnectionLike | undefined {
  if (typeof navigator === 'undefined' || !navigator.connection) {
    return undefined;
  }
  const conn = navigator.connection as unknown as {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
  return {
    effectiveType: conn.effectiveType,
    downlink: conn.downlink,
    rtt: conn.rtt,
    saveData: conn.saveData,
  };
}

/**
 * Derives the workbench connection + data-freshness status from raw inputs.
 * Pure and injectable so it is unit-testable without a real network.
 */
export function deriveNetworkState(frame: Frame): WorkbenchNetworkState {
  const quality: NetworkQuality = resolveNetworkQuality(frame.isOnline, readConnection());
  return {
    isOnline: frame.isOnline,
    quality,
    isSlow: quality === 'slow',
    isStale: isDataStale(frame.lastSyncAt),
    syncFailed: frame.pendingStatuses.some(
      (status) => status === 'failed' || status === 'conflict',
    ),
  };
}

/**
 * React hook feeding {@link deriveNetworkState} from the live workbench and
 * live `navigator.connection` changes (Network Information API).
 */
export function useNetworkState(frame: Frame): WorkbenchNetworkState {
  const [connection, setConnection] = useState<ConnectionLike | undefined>(() =>
    readConnection(),
  );

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.connection) {
      return undefined;
    }
    const conn = navigator.connection as unknown as EventTarget & {
      addEventListener?: (type: string, cb: () => void) => void;
      removeEventListener?: (type: string, cb: () => void) => void;
    };
    const refresh = () => setConnection(readConnection());
    conn.addEventListener?.('change', refresh);
    return () => conn.removeEventListener?.('change', refresh);
  }, []);

  const quality: NetworkQuality = resolveNetworkQuality(frame.isOnline, connection);
  return {
    isOnline: frame.isOnline,
    quality,
    isSlow: quality === 'slow',
    isStale: isDataStale(frame.lastSyncAt),
    syncFailed: frame.pendingStatuses.some(
      (status) => status === 'failed' || status === 'conflict',
    ),
  };
}