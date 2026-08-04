import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * 未处理风险/审批/同步失败入口。基于离线队列待同步数量（countPending）
 * 显示顶栏徽标，并提供风险告警、指挥中心等人口。真实后端契约接入前，
 * 待同步数量为离线队列真实值，其余为演示入口。
 */
const PendingInbox = ({ pendingCount }: { pendingCount: number }) => {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`待处理事项${pendingCount > 0 ? `，${pendingCount} 条待同步` : ''}`}
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)] hover:text-[hsl(220_14%_14%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(221_83%_53%)]"
        >
          <Inbox className="h-4 w-4" aria-hidden />
          {pendingCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[hsl(0_84%_60%)] px-1 text-[10px] font-semibold text-white"
              aria-hidden
            >
              {pendingCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>待处理事项</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => navigate('/alerts')}>
          风险告警
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/command-center')}>
          指挥中心
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          待同步 {pendingCount} 条（离线队列）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default PendingInbox;