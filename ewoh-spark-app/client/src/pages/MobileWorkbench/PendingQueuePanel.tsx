import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { computeNextRetryAt } from '../../lib/offlineStatus';
import type { StoredPendingAction } from '../../lib/offlineDb';
import { ConflictResolution } from './ConflictResolution';
import {
  pendingActionLabel,
  pendingStatusLabel,
  pendingStatusVariant,
} from './labels';

export interface PendingQueuePanelProps {
  items: StoredPendingAction[];
  onRetry: (id: string) => void;
  onBatchRetry: (ids: string[]) => void;
  onDiscard: (id: string) => void;
  onResolve: (id: string, choice: 'local' | 'server' | 'manual') => void;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return '—';
  }
  return new Date(iso).toLocaleString();
}

/**
 * Renders the offline pending queue with the complete per-item field set
 * (type, timestamps, status, retry count, next retry time, idempotency key,
 * business entity) plus batch selection for one-shot retry.
 */
export function PendingQueuePanel({
  items,
  onRetry,
  onBatchRetry,
  onDiscard,
  onResolve,
}: PendingQueuePanelProps): React.ReactElement {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const selectableIds = useMemo(() => {
    const failed = items.filter((i) => i.status === 'failed').map((i) => i.id);
    const conflict = items.filter((i) => i.status === 'conflict').map((i) => i.id);
    return new Set([...failed, ...conflict]);
  }, [items]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) =>
      current.size === selectableIds.size ? new Set() : new Set(selectableIds),
    );
  };

  const handleBatchRetry = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) {
      return;
    }
    onBatchRetry(ids);
    setSelected(new Set());
  };

  return (
    <section
      aria-label="待同步队列"
      className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[hsl(220_14%_14%)]">待同步队列</h2>
        <div className="flex items-center gap-2">
          {selectableIds.size > 0 && (
            <label className="flex items-center gap-1 text-xs text-[hsl(218_10%_42%)]">
              <input
                type="checkbox"
                checked={selected.size === selectableIds.size}
                onChange={toggleAll}
                aria-label="全选可重试项"
              />
              全选
            </label>
          )}
          <Badge variant="outline">{items.length}</Badge>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="mb-2">
          <Button
            size="sm"
            variant="default"
            onClick={handleBatchRetry}
            className="gap-1"
          >
            <RefreshCw className="size-3" />
            批量重试（{selected.size}）
          </Button>
        </div>
      )}
      <ul className="space-y-2">
        {items.map((item) => {
          const nextRetryAt = computeNextRetryAt(item);
          const selectable = selectableIds.has(item.id);
          return (
            <li
              key={item.id}
              className="flex flex-wrap items-start gap-2 rounded border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_98%)] p-2"
            >
              {selectable && (
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  aria-label={`选择 ${item.stepId}`}
                  className="mt-1"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                  {item.stepId} · {pendingActionLabel(item)}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-[hsl(218_10%_42%)]">
                  工单 {item.orderId} / 工序 {item.stepId}
                </p>
                {item.error?.message && (
                  <p className="mt-0.5 truncate text-xs text-red-700">
                    {item.error.message}
                  </p>
                )}
                <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[10px] text-[hsl(218_10%_42%)] sm:grid-cols-2">
                  <div>
                    <dt className="inline">类型：</dt>
                    <dd className="inline">{pendingActionLabel(item)}</dd>
                  </div>
                  <div>
                    <dt className="inline">创建时间：</dt>
                    <dd className="inline">{formatTime(item.queuedAt)}</dd>
                  </div>
                  <div>
                    <dt className="inline">当前状态：</dt>
                    <dd className="inline">{pendingStatusLabel(item.status)}</dd>
                  </div>
                  <div>
                    <dt className="inline">重试次数：</dt>
                    <dd className="inline">{item.retryCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt className="inline">下次重试：</dt>
                    <dd className="inline">{formatTime(nextRetryAt)}</dd>
                  </div>
                  <div>
                    <dt className="inline">幂等键：</dt>
                    <dd className="inline break-all">{item.idempotencyKey}</dd>
                  </div>
                  {item.lastAttemptAt && (
                    <div>
                      <dt className="inline">最近尝试：</dt>
                      <dd className="inline">{formatTime(item.lastAttemptAt)}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <Badge variant={pendingStatusVariant(item.status)}>
                {pendingStatusLabel(item.status)}
              </Badge>
              {(item.status === 'failed' || item.status === 'conflict') && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRetry(item.id)}
                >
                  <RefreshCw className="size-3" />
                  重试
                </Button>
              )}
              {item.status === 'conflict' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDiscard(item.id)}
                >
                  丢弃
                </Button>
              )}
              {item.status === 'conflict' && (
                <div className="w-full">
                  <ConflictResolution
                    item={item}
                    onResolve={(choice) => onResolve(item.id, choice)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}