import {
  InMemoryWorkbenchExportStore,
  WorkbenchExportService,
} from '../../../server/modules/operations/workbench-export.service';

const admin = { userId: 'A-1', primaryOrgId: 'org-1', roles: ['global_admin'] };
const worker = { userId: 'P-1', primaryOrgId: 'org-1', roles: ['worker'] };

function createAuditMock() {
  return { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
}

describe('WorkbenchExportService (异步导出任务)', () => {
  it('creates a queued export task with permission, expiry and audit', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const audit = createAuditMock();
    const service = new WorkbenchExportService(store, audit as never);

    const task = await service.createExportTask(admin, { role: 'manager', listKey: 'riskTrend' });

    expect(task.status).toBe('queued');
    expect(task.progress).toBe(0);
    expect(task.ownerId).toBe('A-1');
    expect(new Date(task.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workbench.export.requested', entityType: 'workbench_export' }),
    );
  });

  it('rejects export of a role the user has no permission for', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    await expect(
      service.createExportTask(worker, { role: 'manager', listKey: 'riskTrend' }),
    ).rejects.toThrow('not authorized');
  });

  it('rejects an unknown workbench role', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    await expect(
      service.createExportTask(admin, { role: 'nobody' as never, listKey: 'x' }),
    ).rejects.toThrow('role must be one of');
  });

  it('advances progress and completes with a download target', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const service = new WorkbenchExportService(store);
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });

    await service.advance(task.id, 50, 5, 10);
    let current = await service.getExportTask(task.id, worker);
    expect(current.status).toBe('running');
    expect(current.progress).toBe(50);

    await service.complete(task.id, '/api/operations/workbench/export/file.csv');
    current = await service.getExportTask(task.id, worker);
    expect(current.status).toBe('succeeded');
    expect(current.progress).toBe(100);
    expect(current.downloadUrl).toBe('/api/operations/workbench/export/file.csv');
  });

  it('marks a task expired when read after its deadline', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const audit = createAuditMock();
    const service = new WorkbenchExportService(store, audit as never);
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });

    const expired = await service.getExportTask(task.id, worker, Date.now() + 48 * 60 * 60 * 1000);
    expect(expired.status).toBe('expired');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workbench.export.expired' }),
    );
  });

  it('forbids reading another user’s export task', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const service = new WorkbenchExportService(store);
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    await expect(
      service.getExportTask(task.id, { userId: 'OTHER', primaryOrgId: 'org-1', roles: [] }),
    ).rejects.toThrow('only inspect your own export tasks');
  });

  it('throws NotFound for an unknown task', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    await expect(
      service.getExportTask('missing', worker),
    ).rejects.toThrow('not found');
  });
});