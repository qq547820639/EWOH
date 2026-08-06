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

describe('WorkbenchExportService (取消 / 重试 / 认领)', () => {
  it('cancels a queued task immediately', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    const cancelled = await service.cancelExportTask(task.id, worker);
    expect(cancelled.status).toBe('cancelled');
  });

  it('requests cancellation of a running task (running → cancelling)', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const service = new WorkbenchExportService(store);
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    await service.claimExportTask(task.id, 'worker-1');
    const cancelling = await service.cancelExportTask(task.id, worker);
    expect(cancelling.status).toBe('cancelling');
    await service.confirmCancellation(task.id, true);
    const done = await service.getExportTask(task.id, worker);
    expect(done.status).toBe('cancelled');
  });

  it('forbids cancelling another user’s task', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    await expect(
      service.cancelExportTask(task.id, { userId: 'OTHER', primaryOrgId: 'org-1', roles: [] }),
    ).rejects.toThrow('only cancel your own export tasks');
  });

  it('retries a failed task back to queued with a backoff deadline', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    await service.fail(task.id, 'boom');
    await service.retryExportTask(task.id, 5 * 60 * 1000);
    const retried = await service.getExportTask(task.id, worker);
    expect(retried.status).toBe('queued');
    expect(retried.attempts ?? 0).toBe(0);
    expect(new Date(retried.nextRetryAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects retry of a terminal succeeded task', async () => {
    const service = new WorkbenchExportService(new InMemoryWorkbenchExportStore());
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    await service.claimExportTask(task.id, 'worker-1');
    await service.complete(task.id, '/file.csv');
    await expect(service.retryExportTask(task.id)).rejects.toThrow(
      'Cannot retry an export',
    );
  });

  it('only one of two workers can claim the same task', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const service = new WorkbenchExportService(store);
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    const first = await service.claimExportTask(task.id, 'worker-1');
    expect(first?.status).toBe('running');
    expect(first?.claimedBy).toBe('worker-1');
    const second = await service.claimExportTask(task.id, 'worker-2');
    expect(second).toBeUndefined();
  });

  it('re-claims a failed task whose retry deadline has elapsed', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const service = new WorkbenchExportService(store);
    const task = await service.createExportTask(worker, { role: 'operator', listKey: 'mySteps' });
    await service.fail(task.id, 'boom');
    const claimed = await service.claimExportTask(task.id, 'worker-1');
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
  });
});