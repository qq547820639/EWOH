import { buildConflictModel } from '../../lib/offlineConflict';
import type { StoredPendingAction } from '../../lib/offlineDb';
import { Button } from '@client/src/components/ui/button';

/**
 * Renders the local-vs-server conflict diff for a 409/412 item and lets the
 * user choose how to resolve it. Never silently overwrites — the decision is
 * always surfaced for explicit choice.
 */
export function ConflictResolution({
  item,
  onResolve,
}: {
  item: StoredPendingAction;
  onResolve: (choice: 'local' | 'server' | 'manual') => void;
}): React.ReactElement {
  const localValue = item.body;
  const serverValue = item.conflict?.serverValue;
  const model = buildConflictModel(localValue, serverValue);
  return (
    <div className="mt-2 w-full rounded bg-white p-2 text-xs">
      <p className="font-medium text-[hsl(220_14%_14%)]">状态冲突 — 请选择处理方式</p>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <div>
          <p className="text-[hsl(218_10%_42%)]">本地值</p>
          <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-[hsl(220_14%_96%)] p-1 font-mono text-[10px] text-[hsl(220_14%_14%)]">
            {JSON.stringify(localValue ?? null, null, 2) || '—'}
          </pre>
        </div>
        <div>
          <p className="text-[hsl(218_10%_42%)]">服务端值</p>
          {serverValue === undefined ? (
            <p className="mt-0.5 rounded bg-[hsl(220_14%_96%)] p-1 text-amber-700">
              服务端未返回当前值
            </p>
          ) : (
            <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-[hsl(220_14%_96%)] p-1 font-mono text-[10px] text-[hsl(220_14%_14%)]">
              {JSON.stringify(serverValue, null, 2) || '—'}
            </pre>
          )}
        </div>
      </div>
      {model.diff.length > 0 && (
        <div className="mt-1">
          <p className="text-[hsl(218_10%_42%)]">差异</p>
          <ul className="mt-0.5 space-y-0.5">
            {model.diff.map((diff, index) => (
              <li
                key={index}
                className="rounded bg-[hsl(220_14%_96%)] px-1 py-0.5 font-mono text-[10px]"
              >
                {diff.path || '—'}：{JSON.stringify(diff.local)} → {JSON.stringify(diff.server)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-1 text-[hsl(218_10%_42%)]">
        推荐：{model.recommended === 'server' ? '采用服务端' : '采用本地'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={() => onResolve('local')}>
          采用本地
        </Button>
        <Button size="sm" variant="outline" onClick={() => onResolve('server')}>
          采用服务端
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onResolve('manual')}>
          手动编辑
        </Button>
      </div>
    </div>
  );
}