import { CloudOff, Database, RefreshCw, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { sanitizeUserText } from '@client/src/components/AppErrorState';

/** 数据健康度：partial=部分数据缺失 / stale=展示的是过期数据 / degraded=服务降级 / offline=离线 */
export type DataHealth = 'partial' | 'stale' | 'degraded' | 'offline';

export interface DataStateBannerProps {
  health: DataHealth;
  /** 一句话现象（会做安全清洗，不展示原始堆栈/JSON） */
  message?: string;
  /** 可选的补充说明 */
  detail?: string;
  /** 重试/刷新回调 */
  onRetry?: () => void;
}

const HEALTH_PRESENTATION: Record<
  DataHealth,
  { icon: LucideIcon; label: string; containerClass: string; iconClass: string }
> = {
  partial: {
    icon: Database,
    label: '部分数据缺失',
    containerClass: 'border-amber-200 bg-amber-50',
    iconClass: 'text-amber-600',
  },
  stale: {
    icon: TriangleAlert,
    label: '数据已过期',
    containerClass: 'border-amber-200 bg-amber-50',
    iconClass: 'text-amber-600',
  },
  degraded: {
    icon: CloudOff,
    label: '服务降级',
    containerClass: 'border-orange-200 bg-orange-50',
    iconClass: 'text-orange-600',
  },
  offline: {
    icon: WifiOff,
    label: '离线',
    containerClass: 'border-sky-200 bg-sky-50',
    iconClass: 'text-sky-600',
  },
};

const DEFAULT_MESSAGE: Record<DataHealth, string> = {
  partial: '部分数据暂时不可用，其余功能可正常使用。',
  stale: '正在展示上次成功获取的数据，可能不是最新。',
  degraded: '服务当前处于降级状态，部分功能可能受限。',
  offline: '网络连接已断开，操作将加入待同步队列。',
};

/**
 * 「数据状态」统一提示：以一致的语义渲染 partial / stale / degraded / offline。
 * 所有文案均经过 sanitizeUserText 清洗，绝不暴露原始异常。
 */
const DataStates = ({
  health,
  message,
  detail,
  onRetry,
}: DataStateBannerProps): React.ReactElement => {
  const presentation = HEALTH_PRESENTATION[health];
  const Icon = presentation.icon;
  const text = sanitizeUserText(message) || DEFAULT_MESSAGE[health];
  const detailText = sanitizeUserText(detail);

  return (
    <div
      role={health === 'offline' ? 'alert' : 'status'}
      aria-live="polite"
      className={`flex flex-col gap-3 rounded-lg border p-4 text-sm ${presentation.containerClass}`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 size-5 shrink-0 ${presentation.iconClass}`} />
        <div className="min-w-0">
          <p className="font-semibold text-[hsl(220_14%_14%)]">{presentation.label}</p>
          <p className="mt-0.5 text-[hsl(220_14%_14%)]">{text}</p>
          {detailText && <p className="mt-1 text-[hsl(218_10%_42%)]">{detailText}</p>}
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

export default DataStates;