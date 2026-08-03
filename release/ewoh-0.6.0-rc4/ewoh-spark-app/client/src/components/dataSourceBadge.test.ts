import { dataSourceClass, dataSourceLabel } from './DataSourceBadge';

describe('data source badge contract', () => {
  it('labels every required data source vocabulary value', () => {
    expect(dataSourceLabel('real')).toBe('真机');
    expect(dataSourceLabel('controlled_test')).toBe('受控测试');
    expect(dataSourceLabel('simulated')).toBe('模拟');
    expect(dataSourceLabel('replayed')).toBe('回放');
    expect(dataSourceLabel('stale')).toBe('过期');
    expect(dataSourceLabel('offline')).toBe('离线');
  });

  it('keeps unknown sources visible instead of silently masking them', () => {
    expect(dataSourceLabel('lidar_scan')).toBe('lidar_scan');
    expect(dataSourceLabel(undefined)).toBe('—');
  });

  it('assigns a distinct visual class for each data source state', () => {
    const classes = ['real', 'controlled_test', 'simulated', 'replayed', 'stale', 'offline'].map(
      (source) => dataSourceClass(source),
    );
    expect(new Set(classes).size).toBe(6);
  });
});
