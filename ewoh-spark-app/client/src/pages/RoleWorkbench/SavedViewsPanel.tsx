import { useCallback, useReducer, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  deleteWorkbenchView,
  saveWorkbenchView,
  type WorkbenchView,
} from '../../api/operations';
import { Button } from '@client/src/components/ui/button';
import { DangerousActionDialog } from '../../components/DangerousActionDialog';
import {
  canUndo,
  createDangerIdempotencyKey,
  DANGEROUS_IDLE,
  dangerousReducer,
} from '../../lib/dangerousModel';

/**
 * 「已保存视图」面板：服务端持久化 / 跨设备 / 共享。
 * 删除视图属于危险操作，走 影响预览 → 二次确认 → 幂等删除 → 可撤销 的完整闭环，
 * 并累计审计记录。撤销 = 在窗口内用原视图重新保存（restore）。
 */
export interface SavedViewsPanelProps {
  role: string;
  views: WorkbenchView[];
  onViewsChanged: () => void;
}

export function SavedViewsPanel({
  role,
  views,
  onViewsChanged,
}: SavedViewsPanelProps): React.ReactElement | null {
  const [danger, dispatch] = useReducer(dangerousReducer, DANGEROUS_IDLE);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<WorkbenchView | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    dispatch({ type: 'reset' });
    setPending(null);
  }, []);

  const startDelete = useCallback(
    (view: WorkbenchView) => {
      setPending(view);
      dispatch({
        type: 'preview',
        idempotencyKey: createDangerIdempotencyKey('delete', 'workbench-view', view.key),
      });
      // 视图删除的影响可本地确定，无需额外网络预览。
      dispatch({
        type: 'preview-success',
        impact: {
          action: 'delete',
          targetType: 'workbench-view',
          targetId: view.key,
          summary: `删除该角色的已保存视图「${view.listKey}」`,
          affectedCount: 1,
          irreversible: false,
          requiresConfirmation: true,
        },
      });
      setOpen(true);
    },
    [],
  );

  const confirmDelete = useCallback(async () => {
    if (!pending) return;
    const idem = createDangerIdempotencyKey('delete', 'workbench-view', pending.key);
    dispatch({ type: 'confirm' });
    try {
      await deleteWorkbenchView(pending.key);
      dispatch({ type: 'confirm-success', actionId: idem, compensation: { kind: 'restore', description: '恢复视图' } });
      onViewsChanged();
    } catch (error) {
      dispatch({
        type: 'confirm-fail',
        error: error instanceof Error ? error.message : '删除失败',
      });
    }
  }, [pending, onViewsChanged]);

  const undoDelete = useCallback(async () => {
    if (!pending) return;
    dispatch({ type: 'undo' });
    try {
      await saveWorkbenchView(pending.key, {
        role,
        listKey: pending.listKey,
        filter: pending.filter,
        sortKey: pending.sortKey,
        sortDir: pending.sortDir,
        limit: pending.limit,
        shared: pending.shared,
      });
      dispatch({ type: 'undo-success' });
      onViewsChanged();
    } catch (error) {
      dispatch({
        type: 'undo-fail',
        error: error instanceof Error ? error.message : '撤销失败',
      });
    }
  }, [pending, role, onViewsChanged]);

  if (!views.length) return null;

  const busy = danger.phase === 'confirming';

  return (
    <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3">
      <h2 className="mb-2 text-xs font-semibold text-[hsl(220_14%_14%)]">
        已保存视图（服务端，跨设备）
      </h2>
      <ul className="space-y-1">
        {views.map((view) => (
          <li
            key={view.key}
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-[hsl(218_10%_42%)]"
          >
            <span>
              {view.listKey}
              {view.filter ? ` · ${view.filter}` : ''}
              {view.sortKey ? ` · 按 ${view.sortKey}` : ''}
              {view.shared ? ' · 共享' : ''}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => startDelete(view)}
            >
              <Trash2 className="size-3" />
              删除
            </Button>
          </li>
        ))}
      </ul>
      <DangerousActionDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        phase={danger.phase}
        impact={danger.impact}
        error={danger.error}
        busy={busy}
        canUndoNow={canUndo(danger)}
        onConfirm={() => void confirmDelete()}
        onUndo={() => void undoDelete()}
      />
    </section>
  );
}