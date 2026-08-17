import { Badge } from './ui/badge';

export const DATA_SOURCE_LABELS: Record<string, string> = {
  real: '真机',
  controlled_test: '受控测试',
  simulated: '模拟',
  replayed: '回放',
  stale: '过期',
  offline: '离线',
};

/** CLI-337：全部映射到语义设计令牌（6 个状态的视觉类保持互异）。 */
const DATA_SOURCE_CLASSES: Record<string, string> = {
  real: 'bg-info/10 text-info border-info/30',
  controlled_test: 'bg-warning/10 text-warning border-warning/30',
  simulated: 'bg-muted text-muted-foreground border-border',
  replayed: 'bg-risk-conflict/10 text-risk-conflict border-risk-conflict/30',
  stale: 'bg-risk-degraded/15 text-risk-degraded-foreground border-risk-degraded-border',
  offline: 'bg-destructive/10 text-destructive border-destructive/30',
};

export function dataSourceLabel(source?: string): string {
  return source ? (DATA_SOURCE_LABELS[source] ?? source) : '—';
}

export function dataSourceClass(source?: string): string {
  return DATA_SOURCE_CLASSES[source ?? ''] ?? 'bg-muted text-muted-foreground border-border';
}

export function DataSourceBadge({
  source,
  className,
}: {
  source?: string;
  className?: string;
}): React.ReactElement {
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${dataSourceClass(source)} ${className ?? ''}`}>
      {dataSourceLabel(source)}
    </Badge>
  );
}
