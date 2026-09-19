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
import { AlertTriangle, ArrowRight, BellRing, CheckCircle2, Package, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getWorkbenchNow, type WorkbenchNowItem } from '../../api/workbench';

// NO-68e：severity 徽章改用语义 token（lint-design-tokens 拦截具名颜色；语义 token
// 会随主题/对比度联动，硬编码 named color 不会）。图标颜色走同族语义色。
const SEVERITY_STYLE: Record<number, { label: string; badge: string; icon: React.ReactNode }> = {
  1: {
    label: '紧急',
    badge: 'inline-flex items-center gap-1 rounded-full border border-risk-blocked-border bg-risk-blocked-soft px-2 py-0.5 text-xs font-semibold text-risk-blocked-foreground',
    icon: <AlertTriangle className="size-3.5 text-risk-blocked-foreground" />,
  },
  2: {
    label: '高',
    badge: 'inline-flex items-center gap-1 rounded-full border border-risk-degraded-border bg-risk-degraded-soft px-2 py-0.5 text-xs font-semibold text-risk-degraded-foreground',
    icon: <AlertTriangle className="size-3.5 text-risk-degraded-foreground" />,
  },
  3: {
    label: '缺口',
    badge: 'inline-flex items-center gap-1 rounded-full border border-risk-normal-border bg-risk-normal-soft px-2 py-0.5 text-xs font-semibold text-risk-normal-foreground',
    icon: <Package className="size-3.5 text-risk-normal-foreground" />,
  },
  4: {
    label: '待审批',
    badge: 'inline-flex items-center gap-1 rounded-full border border-risk-warning-border bg-risk-warning-soft px-2 py-0.5 text-xs font-semibold text-risk-warning-foreground',
    icon: <ShieldCheck className="size-3.5 text-risk-warning-foreground" />,
  },
  5: {
    label: '通知',
    badge: 'inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground',
    icon: <BellRing className="size-3.5 text-muted-foreground" />,
  },
};

const KIND_LABELS: Record<string, string> = {
  anomaly: '异常',
  material_gap: '物料缺口',
  approval: '待审批',
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
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-semantic-success" />
          <p className="text-sm font-medium text-foreground">
            当前没有需要你决策的事项——系统正常运行中。
          </p>
        </div>
      </section>
    );
  }

  const critical = items.filter((i) => i.priority === 1);
  const high = items.filter((i) => i.priority === 2);

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      data-testid="workbench-now"
      aria-label="现在需要我做什么"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">
          需要你决策的事项
        </h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {critical.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-risk-blocked-border bg-risk-blocked-soft px-2 py-0.5 font-semibold text-risk-blocked-foreground">
              紧急 {critical.length}
            </span>
          )}
          {high.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-risk-degraded-border bg-risk-degraded-soft px-2 py-0.5 font-semibold text-risk-degraded-foreground">
              高 {high.length}
            </span>
          )}
          <span>共 {items.length} 项</span>
        </div>
      </div>

      <ul className="space-y-1.5" role="list">
        {items.slice(0, 12).map((item) => (
          <NowQueueRow key={item.kind + ':' + item.ref} item={item} />
        ))}
      </ul>
      {items.length > 12 && (
        <p className="mt-2 text-xs text-muted-foreground">
          还有 {items.length - 12} 项未显示（按优先级截断）
        </p>
      )}
    </section>
  );
}

function NowQueueRow({ item }: { item: WorkbenchNowItem }): React.ReactElement {
  const style = SEVERITY_STYLE[item.priority] ?? SEVERITY_STYLE[5]!;
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;

  return (
    <li
      className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-muted/50"
      data-testid={`workbench-item-${item.kind}`}
    >
      {style.icon}
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${style.badge}`}>
        {kindLabel}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {item.title}
        {item.detail && (
          <span className="ml-1.5 text-xs text-muted-foreground">{item.detail}</span>
        )}
      </span>
      <Link
        to={item.route}
        className="shrink-0 rounded px-2 py-1 text-xs font-medium text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100"
        aria-label={`去处理：${item.title}`}
      >
        去处理
        <ArrowRight className="ml-0.5 inline size-3" />
      </Link>
    </li>
  );
}
