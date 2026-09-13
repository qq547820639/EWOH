/**
 * WorkbenchNow — "现在需要我做什么"决策队列（FR6 交互愿景落地）。
 *
 * 设计决策（2026-09-13，交互范式从"仪表盘"到"决策队列"）：
 *
 * 旧范式：用户进入系统 → 看到统计数字 + 多个面板 → 自己判断"有什么需要做的" → 自己去各页面处理。
 * 新范式：用户进入系统 → 第一眼就是"需要你决策的 N 件事"（按优先级排序，带影响面与处置入口）。
 *
 * 三层交互模型：
 *   Tier 1 "Now"：需要人决策的事项 ← 本组件
 *   Tier 2 "Watch"：系统自动处理中（可观测、建立信任）
 *   Tier 3 "Explore"：深入分析（既有页面）
 *
 * 为什么放在 FactoryOperations 顶部：这是 workshop_lead / dispatcher 的默认落地页。
 * 队列空时显式说"当前没有需要你决策的事项——系统正常运行中"（正面确认，不是空态）。
 */
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BellRing, ChevronRight, Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getWorkbenchNow, type WorkbenchNowItem } from '../../api/workbench';

const PRIORITY_LABELS: Record<number, { label: string; className: string }> = {
  1: { label: '紧急', className: 'bg-risk-blocked-soft text-risk-blocked-foreground border-risk-blocked-border' },
  2: { label: '高', className: 'bg-risk-degraded-soft text-risk-degraded-foreground border-risk-degraded-border' },
  4: { label: '通知', className: 'bg-muted text-muted-foreground border-border' },
};

const KIND_LABELS: Record<string, string> = {
  anomaly: '异常',
  notification: '提醒',
};

export function WorkbenchNowPanel(): React.ReactElement {
  const query = useQuery({
    queryKey: ['workbench-now'],
    queryFn: getWorkbenchNow,
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <section className="rounded-lg border border-border bg-card p-4" data-testid="workbench-now-loading">
        <p className="text-sm text-muted-foreground">工作台聚合加载中…</p>
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className="rounded-lg border border-risk-degraded-border bg-risk-degraded-soft p-4" data-testid="workbench-now-error">
        <p className="text-sm text-risk-degraded-foreground">
          工作台聚合读取失败（不显示为空态——读不到 ≠ 没有事项）
        </p>
      </section>
    );
  }

  const items = query.data?.items ?? [];

  if (items.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-4" data-testid="workbench-now-empty">
        <p className="text-sm text-muted-foreground">
          当前没有需要你决策的事项——系统正常运行中。
        </p>
      </section>
    );
  }

  const critical = items.filter((i) => i.priority === 1);
  const high = items.filter((i) => i.priority === 2);
  const normal = items.filter((i) => i.priority > 2);

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      data-testid="workbench-now"
      aria-label="现在需要我做什么"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          需要你决策的事项
          <span className="ml-2 text-muted-foreground font-normal">
            {critical.length > 0 && <span className="text-risk-blocked-foreground">紧急 {critical.length} · </span>}
            {high.length > 0 && <span className="text-risk-degraded-foreground">高 {high.length} · </span>}
            共 {items.length} 项
          </span>
        </h2>
      </div>

      <ul className="space-y-2" role="list">
        {items.slice(0, 10).map((item) => (
          <WorkbenchNowRow key={item.ref} item={item} />
        ))}
      </ul>
      {items.length > 10 && (
        <p className="mt-2 text-xs text-muted-foreground">
          还有 {items.length - 10} 项未显示（按优先级截断）
        </p>
      )}
    </section>
  );
}

function WorkbenchNowRow({ item }: { item: WorkbenchNowItem }): React.ReactElement {
  const style = PRIORITY_LABELS[item.priority] ?? PRIORITY_LABELS[4]!;
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;
  return (
    <li
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/60 px-3 py-2"
      data-testid={`workbench-item-${item.kind}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-xs font-medium ${style.className}`}
        >
          {style.label}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{kindLabel}</span>
        <span className="truncate text-sm text-foreground">{item.title}</span>
      </div>
      <Link
        to={item.route}
        className="shrink-0 text-xs font-medium text-primary hover:underline"
        aria-label={`去处理：${item.title}`}
      >
        去处理
        <ChevronRight className="ml-0.5 inline size-3" />
      </Link>
    </li>
  );
}
