import { Tag } from 'lucide-react';
import {
  APP_VERSION,
  formatDataFreshness,
  type AppContext,
} from '@/lib/appContext';

/**
 * 当前版本与数据新鲜度徽标。真实数据接入前，新鲜度显示「暂无（待接入）」，
 * 不伪造后端时间。
 */
const VersionFreshnessBadge = ({ context }: { context: AppContext }) => {
  return (
    <div className="flex items-center gap-2 text-[11px] text-[hsl(218_10%_42%)]">
      <span
        className="inline-flex items-center gap-1 rounded-md border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] px-1.5 py-0.5 font-medium text-[hsl(220_14%_14%)]"
        title="应用版本"
      >
        <Tag className="h-3 w-3" aria-hidden />
        v{APP_VERSION}
      </span>
      <span>
        数据新鲜度：
        {context.lastDataUpdatedAt
          ? formatDataFreshness(context.lastDataUpdatedAt)
          : '暂无（待接入）'}
      </span>
    </div>
  );
};

export default VersionFreshnessBadge;