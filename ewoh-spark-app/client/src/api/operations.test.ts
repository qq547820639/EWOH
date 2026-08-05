import {
  confirmDangerous,
  createWorkbenchExport,
  deleteWorkbenchView,
  getWorkbenchExportTask,
  getWorkbenchList,
  listWorkbenchViews,
  previewDangerousImpact,
  saveWorkbenchView,
  undoDangerous,
} from './operations';
import { axiosForBackend } from '../lib/http';

jest.mock('../lib/http', () => ({
  axiosForBackend: jest.fn(),
}));

const mockAxios = axiosForBackend as jest.Mock;

describe('operations workbench API (服务端列表/导出/视图/危险操作)', () => {
  beforeEach(() => {
    mockAxios.mockReset();
  });

  it('queries a server-paginated workbench list with filter/sort', async () => {
    mockAxios.mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 20, hasMore: false } });
    await getWorkbenchList('operator', 'mySteps', { page: 1, pageSize: 20, filter: 'in_progress', sortKey: 'status', sortDir: 'asc' });
    const config = mockAxios.mock.calls[0][0];
    expect(config.url).toBe('/api/operations/workbench/list');
    expect(config.method).toBe('GET');
    expect(config.params).toMatchObject({ role: 'operator', listKey: 'mySteps', filter: 'in_progress' });
  });

  it('creates an async export task (server-owned, not client Blob)', async () => {
    mockAxios.mockResolvedValue({ data: { id: 'exp-1', status: 'queued', progress: 0 } });
    await createWorkbenchExport('manager', 'riskTrend', 'high');
    const config = mockAxios.mock.calls[0][0];
    expect(config.url).toBe('/api/operations/workbench/export');
    expect(config.method).toBe('POST');
    expect(config.data).toEqual({ role: 'manager', listKey: 'riskTrend', filter: 'high' });
  });

  it('polls an export task for progress', async () => {
    mockAxios.mockResolvedValue({ data: { id: 'exp-1', status: 'succeeded', progress: 100 } });
    const task = await getWorkbenchExportTask('exp-1');
    expect(task.status).toBe('succeeded');
    expect(mockAxios.mock.calls[0][0].url).toBe('/api/operations/workbench/export/exp-1');
  });

  it('persists a saved view to the server (cross-device)', async () => {
    mockAxios.mockResolvedValue({ data: { key: 'operator.mySteps', ownerId: 'u1' } });
    await saveWorkbenchView('operator.mySteps', { role: 'operator', listKey: 'mySteps', filter: 'fault', shared: true });
    const config = mockAxios.mock.calls[0][0];
    expect(config.url).toBe('/api/operations/workbench/views/operator.mySteps');
    expect(config.method).toBe('PUT');
    expect(config.data).toMatchObject({ shared: true });
  });

  it('lists and deletes saved views', async () => {
    mockAxios.mockResolvedValue({ data: [{ key: 'v1' }] });
    await listWorkbenchViews();
    expect(mockAxios.mock.calls[0][0].url).toBe('/api/operations/workbench/views');

    mockAxios.mockResolvedValue({ data: undefined });
    await deleteWorkbenchView('v1');
    expect(mockAxios.mock.calls[1][0].method).toBe('DELETE');
    expect(mockAxios.mock.calls[1][0].url).toBe('/api/operations/workbench/views/v1');
  });

  it('previews, confirms with idempotency, and undoes a dangerous action', async () => {
    mockAxios.mockResolvedValue({ data: { action: 'delete', irreversible: true } });
    await previewDangerousImpact({ action: 'delete', targetType: 'step', targetId: 'S1', affectedCount: 2 });
    expect(mockAxios.mock.calls[0][0].url).toBe('/api/operations/dangerous/impact');

    mockAxios.mockResolvedValue({ data: { actionId: 'act-1', compensation: { kind: 'noop' } } });
    await confirmDangerous({ action: 'delete', targetType: 'step', targetId: 'S1', idempotencyKey: 'k1' });
    expect(mockAxios.mock.calls[1][0].url).toBe('/api/operations/dangerous/confirm');
    expect(mockAxios.mock.calls[1][0].data.idempotencyKey).toBe('k1');

    mockAxios.mockResolvedValue({ data: { undo: true } });
    await undoDangerous('act-1', { targetType: 'step', targetId: 'S1', reason: '误操作' });
    expect(mockAxios.mock.calls[2][0].url).toBe('/api/operations/dangerous/act-1/undo');
  });
});