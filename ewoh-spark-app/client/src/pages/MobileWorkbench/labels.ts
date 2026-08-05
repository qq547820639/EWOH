import type { StoredPendingAction } from '../../lib/offlineDb';

export function stepStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '待开工',
    in_progress: '进行中',
    paused: '暂停',
    reported: '报工',
    reviewed: '审核',
    handed_over: '交收',
    cancelled: '取消',
  };
  return labels[status] ?? status;
}

export function orderStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: '草稿',
    released: '已释放',
    in_progress: '生产中',
    completed: '已完工',
    cancelled: '已取消',
  };
  return labels[status] ?? status;
}

export function pendingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    local: '本地',
    queued: '排队',
    syncing: '同步中',
    synced: '已同步',
    failed: '失败',
    conflict: '冲突',
  };
  return labels[status] ?? status;
}

export function pendingStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'conflict') {
    return 'destructive';
  }
  if (status === 'synced') {
    return 'secondary';
  }
  if (status === 'syncing') {
    return 'default';
  }
  return 'outline';
}

export function pendingActionLabel(item: StoredPendingAction): string {
  if (item.type === 'inspection') {
    return '质检';
  }
  const labels: Record<string, string> = {
    start: '开工',
    report: '报工',
    pause: '暂停',
    resume: '恢复',
    review: '审核',
    handover: '交收',
  };
  return labels[item.action ?? ''] ?? item.action ?? '操作';
}

export function scanTypeLabel(scanType: string): string {
  const labels: Record<string, string> = {
    device: '设备',
    material: '物料',
    batch: '批次',
    station: '工位',
    factory: '工厂',
  };
  return labels[scanType] ?? scanType;
}