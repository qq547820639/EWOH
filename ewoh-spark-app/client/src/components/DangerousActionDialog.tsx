import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@client/src/components/ui/alert-dialog';
import { Button } from '@client/src/components/ui/button';
import {
  dangerousPhaseLabel,
  type DangerousPhase,
  type DangerousImpact,
} from '../lib/dangerousModel';

/**
 * 危险操作二次确认对话框（共享组件）。
 *
 * 展示影响预览（summary / affectedCount / irreversible），提供「取消 / 确认」
 * 与可撤销窗口内的「撤销」入口。根本不只靠颜色告警——受影响数量、不可逆性、
 * 阶段文案都以文本表达，便于屏幕阅读器与色弱用户。
 */
export interface DangerousActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: DangerousPhase;
  impact: DangerousImpact | null;
  error: string | null;
  busy: boolean;
  canUndoNow: boolean;
  onConfirm: () => void;
  onUndo: () => void;
}

export function DangerousActionDialog({
  open,
  onOpenChange,
  phase,
  impact,
  error,
  busy,
  canUndoNow,
  onConfirm,
  onUndo,
}: DangerousActionDialogProps): React.ReactElement {
  const previewing = phase === 'previewing';
  const confirming = phase === 'confirming';
  const executed = phase === 'executed';
  const undone = phase === 'undone';
  const failed = phase === 'failed';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>危险操作确认</AlertDialogTitle>
          <AlertDialogDescription>
            {previewing
              ? '正在评估影响范围…'
              : impact
                ? `将${impact.irreversible ? '不可逆地' : ''}${impact.summary}（影响 ${impact.affectedCount} 项）。`
                : '等待操作…'}
            {impact?.irreversible && (
              <span className="block text-sm font-medium text-red-600">
                此操作不可撤销，请确认无误后再执行。
              </span>
            )}
            {failed && error && (
              <span className="block text-sm font-medium text-red-600">
                操作失败：{error}
              </span>
            )}
            <span className="block text-xs text-[hsl(218_10%_42%)]">
              {dangerousPhaseLabel(phase)}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          {executed && canUndoNow ? (
            <Button variant="outline" onClick={onUndo} disabled={busy}>
              撤销
            </Button>
          ) : (
            (!executed && !undone && (
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  onConfirm();
                }}
                disabled={busy || previewing || (phase !== 'confirm' && phase !== 'confirming' && !failed)}
              >
                {confirming ? '执行中…' : '确认执行'}
              </AlertDialogAction>
            ))
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}