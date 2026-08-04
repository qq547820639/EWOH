import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  clearRecentAccess,
  readRecentAccess,
  recordRecentAccess,
  resolveNavLabel,
  type RecentEntry,
} from '@/lib/appContext';

/**
 * 最近访问下拉：记录当前路由（localStorage），列表项可跳转，支持清空。
 */
const RecentAccessMenu = ({ pathname }: { pathname: string }) => {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<RecentEntry[]>(() => readRecentAccess());

  useEffect(() => {
    const label = resolveNavLabel(pathname) ?? '未知页面';
    setEntries(recordRecentAccess(pathname, label));
  }, [pathname]);

  const handleClear = () => {
    clearRecentAccess();
    setEntries([]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="最近访问"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)] hover:text-[hsl(220_14%_14%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(221_83%_53%)]"
        >
          <Clock className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>最近访问</DropdownMenuLabel>
        {entries.length === 0 ? (
          <DropdownMenuItem disabled>暂无最近访问</DropdownMenuItem>
        ) : (
          entries.map((entry) => (
            <DropdownMenuItem
              key={entry.path}
              onSelect={() => navigate(entry.path)}
            >
              <span className="truncate">{entry.label}</span>
              <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                {entry.path}
              </span>
            </DropdownMenuItem>
          ))
        )}
        {entries.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={handleClear}>
              <Trash2 className="h-4 w-4" aria-hidden />
              清空最近访问
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default RecentAccessMenu;