/// <reference types="jest" />
/* WorkbenchExportWorker 取消竞争回归（R2-SOP-012）：
 * 用户在 worker 产出中取消任务（running → cancelling）后：
 *  - produceCsv 必须在每页拉取前核对任务状态并中止；
 *  - catch 分支不得把取消竞争改写成 failed、更不得重排重试。
 * 原实现：complete() 状态机违约 → fail() 把 cancelling 改成 failed →
 * 写 nextRetryAt 重排 → 任务复活再次产出 → 最终 succeeded 并留下可下载
 * 产物——取消被静默忽略。
 * 同时覆盖 csvCell 的公式注入降级（CWE-1236）。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryWorkbenchExportStore,
  WorkbenchExportService,
} from './workbench-export.service';
import {
  WorkbenchExportWorkerService,
  escapeCsvFormula,
} from './workbench-export.worker';

const ACTOR = { userId: 'owner-1', primaryOrgId: 'org-1', roles: ['worker'] };

function makeWorker(store: InMemoryWorkbenchExportStore, exportService: WorkbenchExportService, onPage: (page: number) => Promise<void>) {
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
        // 模拟用户在 worker 拉取第一页时取消。
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
    // 取消必须被尊重：不得被改写成 failed（更不得重排后复活成 succeeded）。
    expect(final?.status).toBe('cancelling');
    expect(final?.downloadUrl).toBeUndefined();
    // 不重排：取消后的任务绝不再出现在可领取队列里。
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
    // '-cmd' 形态可被表格软件当公式，非纯数字 → 降级。
    expect(escapeCsvFormula('-cmd')).toBe("'-cmd");
  });
});
