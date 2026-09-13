import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatLastSync, type OfflineStatusSnapshot } from '@/lib/offlineStatus';

/**
 * 在线/离线/降级状态指示器。展示在线/离线徽标、待同步数量与最后同步时间。
 */
const OnlineStatusBadge = ({ snapshot }: { snapshot: OfflineStatusSnapshot | null }) => {
  if (!snapshot) {
    return (
      <Badge variant="outline" className="border-border text-muted-foreground">
        连接中…
      </Badge>
    );
  }
  const offline = !snapshot.online;
  const pending = snapshot.pendingCount > 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            'gap-1.5 border-border bg-card text-foreground',
            (offline || pending) && 'border-destructive/30 bg-destructive/10 text-destructive-on-soft',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              offline ? 'bg-destructive' : 'bg-success',
            )}
            aria-hidden
          />
          {offline ? '离线' : '在线'}
          {pending && <span className="font-semibold">待同步 {snapshot.pendingCount}</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <span>最后同步：{formatLastSync(snapshot.lastSyncAt)}</span>
      </TooltipContent>
    </Tooltip>
  );
};

export default OnlineStatusBadge;