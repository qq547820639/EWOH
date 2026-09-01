import type { ReactElement } from 'react';

/**
 * 指标卡（OD-7）——替代 `JSON.stringify(metrics)` 直出。
 *
 * 背景：`Scheduling.tsx:195-197` 曾把整个 metrics 对象 dump 给最终用户，
 * 调度员需要阅读原始结构才能决策。指标卡把同组数据转为
 * 「大数字 + 单位 + 语义色 + 阈值提示」，原始结构折叠进详情供排查。
 *
 * 约束（横切 X-3）：颜色一律走语义 Token，禁止 Tailwind 默认语义色族。
 */

export type MetricTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: MetricTone;
}

const TONE_CLASS: Record<MetricTone, string> = {
  neutral: 'text-foreground',
  good: 'text-risk-normal-foreground',
  warn: 'text-risk-degraded-foreground',
  bad: 'text-risk-blocked-foreground',
};

export function MetricCard({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
}: MetricCardProps): ReactElement {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-3">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-2xl font-medium tabular-nums ${TONE_CLASS[tone]}`}>
        {value}
        {unit ? (
          <span className="ml-0.5 text-[13px] font-normal text-muted-foreground">{unit}</span>
        ) : null}
      </p>
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** 指标卡网格容器：窄屏 2 列、中屏 3 列、宽屏 5 列。 */
export function MetricGrid({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
  );
}

/**
 * 方案指标卡组（OD-7）。
 *
 * 阈值口径与 UX 原型一致：延期 >30min 判红、负荷 >80% 判黄、其余中性。
 * 单位内嵌，避免用户自行换算。
 */
export interface PlanMetrics {
  lateMinutes?: number;
  walkingMeters?: number;
  stationWaitMinutes?: number;
  maxWorkload?: number;
  changeCost?: number;
  assignedTasks?: number;
  unassignedTasks?: number;
}

export function PlanMetricGrid({ metrics }: { metrics: PlanMetrics }): ReactElement {
  const late = metrics.lateMinutes ?? 0;
  const workload = metrics.maxWorkload ?? 0;
  const assigned = metrics.assignedTasks;
  const unassigned = metrics.unassignedTasks;
  const total = assigned != null && unassigned != null ? assigned + unassigned : undefined;

  return (
    <MetricGrid>
      <MetricCard
        label="延期"
        value={late.toFixed(1)}
        unit="min"
        tone={late > 30 ? 'bad' : late > 0 ? 'warn' : 'good'}
        hint={late > 30 ? '超阈值 30min' : late > 0 ? '在容差内' : '无延期'}
      />
      <MetricCard
        label="移动距离"
        value={Math.round(metrics.walkingMeters ?? 0).toLocaleString('zh-CN')}
        unit="m"
      />
      <MetricCard
        label="工位等待"
        value={(metrics.stationWaitMinutes ?? 0).toFixed(1)}
        unit="min"
      />
      <MetricCard
        label="最大负荷"
        value={Math.round(workload * 100)}
        unit="%"
        tone={workload > 0.9 ? 'bad' : workload > 0.8 ? 'warn' : 'good'}
        hint={workload > 0.9 ? '超上限 90%' : workload > 0.8 ? '接近上限' : '安全区间'}
      />
      {total != null ? (
        <MetricCard
          label="已分配"
          value={`${assigned}/${total}`}
          tone={(unassigned ?? 0) > 0 ? 'warn' : 'good'}
          hint={(unassigned ?? 0) > 0 ? `${unassigned} 项待分配` : '全部已分配'}
        />
      ) : (
        <MetricCard
          label="切换成本"
          value={(metrics.changeCost ?? 0).toFixed(1)}
        />
      )}
    </MetricGrid>
  );
}
