import * as fs from 'fs';
import * as path from 'path';

/**
 * 内存版 `ApprovalService`（V212）：审批实例只存在 `private readonly instances = new Map()` 里——
 * 没有租户谓词、没有过期、没有落库。它至今还挂在 `ApprovalModule` 的 `providers` 与 `exports` 上
 * （Nest 会在生产进程里构造它，只是那张 Map 永远是空的），而生产的审批走
 * `ApprovalPersistenceService`（`approval.controller.ts` 里的字段名叫 `approvalService`，
 * 类型却是持久版）。
 *
 * 这条用例钉的是「**生产码里没有消费者**」这个应然不变量：下一个 `import` 它的产品文件会让这里变红，
 * 从而逼出"这次注入要不要走持久版"的判断，而不是让旁路 API 悄悄多一个用户。
 */
const SERVER = path.resolve(__dirname, '../../../server');
/** 定义它自己的文件与模块装配位点不算消费者（providers/exports 必须写类名）。 */
const EXEMPT = [
  path.resolve(SERVER, 'modules/approval/approval.service.ts'),
];
const MEMORY_CLASS = /\bApprovalService\b/;

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) productFiles(p, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.module.ts') && !/\.spec\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function consumers(files: string[]): string[] {
  return files.filter(
    (f) =>
      !EXEMPT.includes(f) &&
      f.split(path.sep).join('/') !== 'server/modules/approval/approval.service.ts' &&
      MEMORY_CLASS.test(fs.readFileSync(f, 'utf8')),
  );
}

describe('内存版 ApprovalService 的装配面与消费面（V212）', () => {
  const files = productFiles(SERVER);

  it('分母自证：确实扫到了产品码，且能看到持久版审批服务在用（否则下面那条"零消费者"是假绿）', () => {
    expect(files.length).toBeGreaterThan(100);
    const persistent = files.filter((f) => /\bApprovalPersistenceService\b/.test(fs.readFileSync(f, 'utf8')));
    expect(persistent.length).toBeGreaterThan(0);
  });

  it('生产码里没有任何文件引用内存版 ApprovalService（它只是被装配着，没有人用）', () => {
    const hits = consumers(files).map((f) => path.relative(SERVER, f));
    expect(hits).toEqual([]);
  });

  it('判据会开火：一个假的消费者必须被抓到', () => {
    const fake = `constructor(private readonly svc: ApprovalService) {}`;
    expect(MEMORY_CLASS.test(fake)).toBe(true);
  });

  it('判据不误伤：持久版的类名里含同一个子串，按词边界不得命中', () => {
    const persistent = `import { ApprovalPersistenceService } from './approval-persistence.service';
    private readonly approvalService: ApprovalPersistenceService;`;
    expect(MEMORY_CLASS.test(persistent)).toBe(false);
  });
});
