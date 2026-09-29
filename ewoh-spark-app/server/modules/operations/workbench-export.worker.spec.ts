import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryWorkbenchExportStore, WorkbenchExportService } from './workbench-export.service';
import {
  purgeExpiredExportArtifacts,
  WorkbenchExportWorkerService,
  escapeCsvFormula,
} from './workbench-export.worker';

const ACTOR = { userId: 'owner-1', primaryOrgId: 'org-1', roles: ['worker'] };

function makeWorker(
  store: InMemoryWorkbenchExportStore,
  exportService: WorkbenchExportService,
  onPage: (page: number) => Promise<void>,
) {
  const roleWorkbench = {
    getWorkbenchList: async (role: string, listKey: string, query: { page?: number }) => {
      await onPage(query.page ?? 1);
      return {
        items: [{ stepId: 'S1', name: '=下载', status: 'pending', deviationMinutes: -3.5 }],
        total: 2,
        page: query.page ?? 1,
        pageSize: 500,
        hasMore: (query.page ?? 1) < 2,
        hasNextPage: (query.page ?? 1) < 2,
        nextCursor: null,
        status: 'ok',
        dataFreshness: new Date().toISOString(),
      };
    },
  };
  return new WorkbenchExportWorkerService(
    exportService,
    roleWorkbench as never,
    store as never,
  );
}

describe('WorkbenchExportWorker：取消竞争不复活（R2-SOP-012）', () => {
  let exportDir: string;

  beforeEach(() => {
    exportDir = mkdtempSync(join(tmpdir(), 'ewoh-export-spec-'));
    process.env.WORKBENCH_EXPORT_DIR = exportDir;
  });

  afterEach(() => {
    delete process.env.WORKBENCH_EXPORT_DIR;
    rmSync(exportDir, { recursive: true, force: true });
  });

  it('产出中被取消：状态停在 cancelling，且不再进入可领取队列', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const exportService = new WorkbenchExportService(store);
    let taskId = '';
    const worker = makeWorker(store, exportService, async (page) => {
      if (page === 1 && taskId) {
        await exportService.cancelExportTask(taskId, ACTOR);
      }
    });
    const task = await exportService.createExportTask(ACTOR as never, {
      role: 'operator',
      listKey: 'mySteps',
    });
    taskId = task.id;

    await worker.tick();

    const final = await store.get(taskId);
    expect(final?.status).toBe('cancelling');
    expect(final?.downloadUrl).toBeUndefined();
    expect(await store.listClaimable()).not.toContain(taskId);
  });

  it('正常产出（无取消）：仍能完成并记录下载地址', async () => {
    const store = new InMemoryWorkbenchExportStore();
    const exportService = new WorkbenchExportService(store);
    const worker = makeWorker(store, exportService, async () => {});
    const task = await exportService.createExportTask(ACTOR as never, {
      role: 'operator',
      listKey: 'mySteps',
    });
    await worker.tick();
    const final = await store.get(task.id);
    expect(final?.status).toBe('succeeded');
    expect(final?.downloadUrl).toContain(task.id);
  });
});

describe('workbench export artifact retention', () => {
  it('purges only expired managed UUID CSV artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ewoh-export-purge-'));
    const now = Date.now();
    const oldExport = join(dir, '11111111-1111-4111-8111-111111111111.csv');
    const freshExport = join(dir, '22222222-2222-4222-8222-222222222222.csv');
    const unrelated = join(dir, 'notes.csv');
    const oldReport = join(dir, '33333333-3333-4333-8333-333333333333.json');
    writeFileSync(oldExport, 'old');
    writeFileSync(freshExport, 'fresh');
    writeFileSync(unrelated, 'keep');
    writeFileSync(oldReport, 'keep');
    const oldTime = new Date(now - 26 * 60 * 60 * 1000);
    utimesSync(oldExport, oldTime, oldTime);
    utimesSync(oldReport, oldTime, oldTime);

    await expect(purgeExpiredExportArtifacts(dir, 25 * 60 * 60 * 1000, now)).resolves.toBe(1);
    expect(existsSync(oldExport)).toBe(false);
    expect(existsSync(freshExport)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(oldReport)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('escapeCsvFormula（CSV 公式注入降级，CWE-1236）', () => {
  it('以 = @ 制表符开头的文本前置降级符', () => {
    expect(escapeCsvFormula('=cmd|/c calc!A1')).toBe("'=cmd|/c calc!A1");
    expect(escapeCsvFormula('@SUM(1)')).toBe("'@SUM(1)");
    expect(escapeCsvFormula('\tTab')).toBe("'\tTab");
  });

  it('纯数字（含负数/小数/加号数）不被改写，程序化消费不受影响', () => {
    expect(escapeCsvFormula('-3.5')).toBe('-3.5');
    expect(escapeCsvFormula('42')).toBe('42');
    expect(escapeCsvFormula('+2.5')).toBe('+2.5');
  });

  it('普通文本与 -开头的非数字文本处理', () => {
    expect(escapeCsvFormula('hello')).toBe('hello');
    expect(escapeCsvFormula('-cmd')).toBe("'-cmd");
  });
});
