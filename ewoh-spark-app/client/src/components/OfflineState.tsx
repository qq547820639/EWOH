import { RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';

interface OfflineStateProps {
  /** 可选标题，默认「当前处于离线状态」 */
  title?: string;
  /** 可选描述 */
  description?: string;
  /** 待同步数量，可选显示 */
  pendingCount?: number;
  /** 重试/重连回调 */
  onRetry?: () => void;
}

const OfflineState = ({
  title = '当前处于离线状态',
  description = '网络连接已断开，操作将加入待同步队列，联网后自动提交。',
  pendingCount,
  onRetry,
}: OfflineStateProps): React.ReactElement => {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-col gap-3 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <WifiOff className="mt-0.5 size-5 shrink-0 text-sky-600" />
        <div className="min-w-0">
          <p className="font-semibold text-[hsl(220_14%_14%)]">{title}</p>
          <p className="mt-0.5 text-[hsl(220_14%_14%)]">{description}</p>
          {typeof pendingCount === 'number' && pendingCount >= 0 && (
            <p className="mt-1 text-[hsl(218_10%_42%)]">
              待同步 {pendingCount} 项操作
            </p>
          )}
        </div>
      </div>

      {onRetry && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        </div>
      )}
    </div>
  );
};

export default OfflineState;