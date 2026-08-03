import { Badge } from './ui/badge';

export const DATA_SOURCE_LABELS: Record<string, string> = {
  real: '真机',
  controlled_test: '受控测试',
  simulated: '模拟',
  replayed: '回放',
  stale: '过期',
  offline: '离线',
};

const DATA_SOURCE_CLASSES: Record<string, string> = {
  real: 'bg-blue-100 text-blue-700 border-blue-200',
  controlled_test: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  simulated: 'bg-gray-100 text-gray-600 border-gray-200',
  replayed: 'bg-purple-100 text-purple-700 border-purple-200',
  stale: 'bg-orange-100 text-orange-700 border-orange-200',
  offline: 'bg-red-100 text-red-700 border-red-200',
};

export function dataSourceLabel(source?: string): string {
  return source ? (DATA_SOURCE_LABELS[source] ?? source) : '—';
}

export function dataSourceClass(source?: string): string {
  return DATA_SOURCE_CLASSES[source ?? ''] ?? 'bg-gray-100 text-gray-500 border-gray-200';
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
