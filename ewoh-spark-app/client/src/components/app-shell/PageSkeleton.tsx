import { Skeleton } from '@/components/ui/skeleton';

/**
 * 路由懒加载时的页面级骨架屏。用于 React.Suspense 的回退，占位页面内容区域，
 * 保证页面布局在加载前后不会明显跳动（侧边栏/顶栏保持稳定，仅内容槽显示骨架）。
 */
const PageSkeleton = () => (
  <div
    className="flex min-h-[60vh] flex-col gap-4 p-6"
    role="status"
    aria-busy="true"
    aria-label="页面加载中"
  >
    <div className="space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72" />
    </div>
    <div className="grid gap-4 md:grid-cols-3">
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </div>
    <Skeleton className="h-40 rounded-xl" />
  </div>
);

export default PageSkeleton;