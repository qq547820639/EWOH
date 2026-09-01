import { Link, useLocation } from 'react-router-dom';

/**
 * 页头职责条（DR-1 轻量收敛，j2-design-spec-addendum §4）。
 *
 * 驾驶舱三页分工对用户不可见、互相无跳转——本组件以统一模式呈现：
 * 一句话职责 + 三枚互链（当前页 aria-current 且不可点，其余 SPA 内跳转）。
 *
 * 明确不做（等 2 周 PV 数据后的 DR-1 二阶段）：
 * 不做 Tab 化合并、不做自动跳转、不隐藏侧边栏入口。
 *
 * 指挥地图是全屏特殊布局（无侧边栏，`app.tsx` 内独立路由），接入需单独评估
 * 其 1179 行 Shell 的顶部工具栏结构——本轮先覆盖两个 Layout 页，地图页留待观察。
 */

const DUTY_PAGES = [
  { path: '/command-map', label: '指挥地图', duty: '现场在哪里发生' },
  { path: '/command-center', label: '指挥中心', duty: '发生了什么、规模多大' },
  { path: '/digital-world', label: '数字世界', duty: '系统拓扑长什么样' },
] as const;

export function PageDutyHeader({ currentPath }: { currentPath: string }): React.ReactElement {
  const location = useLocation();
  const current = DUTY_PAGES.find((p) => p.path === currentPath);
  // 全屏页（如指挥地图）无此组件时，职责句取当前路径兜底。
  const duty =
    current?.duty ?? DUTY_PAGES.find((p) => location.pathname.startsWith(p.path))?.duty;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        本页回答：
        <span className="font-medium text-foreground">{duty ?? '—'}</span>
      </p>
      <nav aria-label="驾驶舱相关视图" className="mt-2 flex flex-wrap gap-2">
        {DUTY_PAGES.map((page) => {
          const isCurrent = page.path === currentPath;
          return isCurrent ? (
            <span
              key={page.path}
              aria-current="page"
              className="inline-flex min-h-11 items-center rounded-md border border-primary bg-primary/5 px-3 text-xs font-medium text-primary sm:min-h-0"
            >
              {page.label} · {page.duty}
            </span>
          ) : (
            <Link
              key={page.path}
              to={page.path}
              className="inline-flex min-h-11 items-center rounded-md border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:min-h-0"
            >
              {page.label} · {page.duty}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
