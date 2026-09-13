import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKBENCH_EXPORT_STORE,
  WorkbenchExportService,
  type WorkbenchExportStore,
  type WorkbenchExportTask,
} from './workbench-export.service';
import { RoleWorkbenchService } from './role-workbench.service';

/**
 * R2-SOP-006：workbench 异步导出 worker（消费端）。
 *
 * 此前导出管道只有生产侧（create/get），claim/advance/complete/fail/retry
 * 全部无调用方——任务永远停在 queued 直到 24h 过期（断头管道）。本 worker
 * 补齐消费端：
 *   轮询 listClaimable → claimExportTask（原子抢占）→ 分页拉取
 *   RoleWorkbenchService 列表（重放创建时的角色快照过 RBAC 门）→ 生成 CSV
 *   → advance 进度 → complete 记录 downloadUrl。
 *
 * 失败语义：fail + 按 attempts 指数退避写 nextRetryAt（claim 的
 * failed && nextRetryAt<=now 分支保证退避窗口），超过 MAX_ATTEMPTS 终态失败。
 * 单实例内串行消费（tick 重入保护）；多实例部署下由 claim 原子性保证不重复。
 *
 * 开关：WORKBENCH_EXPORT_WORKER_DISABLED=true 或
 * WORKBENCH_EXPORT_WORKER_INTERVAL_MS<=0 时禁用；默认 5s 轮询。
 * 产物落盘：WORKBENCH_EXPORT_DIR（默认 os.tmpdir()/ewoh-workbench-exports），
 * downloadUrl 指向 GET /api/operations/workbench/export/:id/download（带
 * owner/admin 门），文件本体不进 URL。
 */

const DEFAULT_INTERVAL_MS = 5_000;
const PAGE_SIZE = 500;
const MAX_ROWS = 20_000;
const MAX_ATTEMPTS = 3;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  const escaped = escapeCsvFormula(text);
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

/**
 * R2-SOP-011：CSV 公式注入防护（CWE-1236）。导出内容含用户可控文本
 * （工单标题/备注/过滤词等），以 =、+、@ 或制表符开头且非纯数字的单元格
 * 被表格软件当公式执行（DDE/超链接钓鱼）。统一前置 `'` 降级为文本；
 * 纯数字（含负数/小数）保持原样，不破坏程序化消费。
 */
export function escapeCsvFormula(text: string): string {
  const first = text.charAt(0);
  if (first !== '=' && first !== '@' && first !== '\t' && first !== '\r' && first !== '+' && first !== '-') {
    return text;
  }
  if ((first === '+' || first === '-') && Number.isFinite(Number(text))) {
    return text;
  }
  return `'${text}`;
}

@Injectable()
export class WorkbenchExportWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkbenchExportWorkerService.name);
  private readonly workerId = `export-worker-${randomUUID().slice(0, 8)}`;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly exportService: WorkbenchExportService,
    private readonly roleWorkbench: RoleWorkbenchService,
    @Inject(WORKBENCH_EXPORT_STORE) private readonly store: WorkbenchExportStore,
  ) {}

  onApplicationBootstrap(): void {
    const disabled =
      (process.env.WORKBENCH_EXPORT_WORKER_DISABLED ?? '').trim().toLowerCase() ===
      'true';
    const intervalMs = Number(
      process.env.WORKBENCH_EXPORT_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
    );
    if (disabled || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      this.logger.log(
        `workbench export worker disabled (interval=${intervalMs}ms, disabled=${disabled})`,
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `workbench export worker started (${this.workerId}, interval=${intervalMs}ms)`,
    );
  }

  onApplicationDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 单次扫描：领取并处理所有可领取任务（暴露为 public 便于测试/运维触发）。 */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let processed = 0;
    try {
      const ids = await this.store.listClaimable();
      for (const id of ids) {
        if (await this.processOne(id)) processed += 1;
      }
    } catch (error) {
      this.logger.warn(
        `workbench export worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
    return processed;
  }

  private async processOne(taskId: string): Promise<boolean> {
    const claimed = await this.exportService.claimExportTask(
      taskId,
      this.workerId,
    );
    if (!claimed) return false;
    try {
      const artifact = await this.produceCsv(claimed);
      const downloadUrl = this.persistArtifact(claimed.id, artifact.csv);
      await this.exportService.complete(taskId, downloadUrl, {
        rowCount: artifact.rowCount,
        fileSize: Buffer.byteLength(artifact.csv, 'utf8'),
      });
      return true;
    } catch (error) {
      // 取消竞争收口：complete/fail 的状态机违约若源于用户取消
      // （cancelling/cancelled），不得改写为 failed、更不得重排重试——
      // 否则已取消的导出会被静默复活并最终产出可下载产物。
      const current = await this.store.get(taskId);
      if (current && (current.status === 'cancelling' || current.status === 'cancelled')) {
        this.logger.log(
          `workbench export ${taskId} cancelled mid-run; not requeued (attempts=${claimed.attempts ?? 1})`,
        );
        return false;
      }
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `workbench export ${taskId} failed (attempts=${claimed.attempts ?? 1}): ${message}`,
      );
      await this.exportService.fail(taskId, message.slice(0, 500)).catch(() => {
        /* 状态机违约（如已被并发取消）时静默——下次扫描不再领取 */
      });
      const attempts = claimed.attempts ?? 1;
      if (attempts < MAX_ATTEMPTS) {
        // 指数退避：30s / 60s / ...（claim 的 failed&&nextRetryAt 分支生效）
        const backoffMs = 30_000 * 2 ** (attempts - 1);
        await this.store.update(taskId, {
          nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
        });
      }
      return false;
    }
  }

  /** 分页拉全量（封顶 MAX_ROWS）并生成 CSV；每页回报进度。 */
  private async produceCsv(
    task: WorkbenchExportTask,
  ): Promise<{ csv: string; rowCount: number }> {
    const lines: string[] = [];
    let headerWritten = false;
    let processed = 0;
    let total = 0;
    let page = 1;
    for (;;) {
      // 每页拉取前核对任务状态：已被取消（cancelling/cancelled）时立即中止，
      // 不再继续产出。否则"用户取消 + worker 恰在产出中"的竞争下，取消被
      // 静默忽略，导出照常完成并留下可下载产物。
      const current = await this.store.get(task.id);
      if (!current || current.status !== 'running') {
        throw new Error(
          `workbench export ${task.id} aborted: task status is '${current?.status ?? 'unknown'}' (cancelled or reassigned)`,
        );
      }
      const result = await this.roleWorkbench.getWorkbenchList(
        task.role,
        task.listKey,
        {
          page,
          pageSize: PAGE_SIZE,
          filter: task.filter || undefined,
        },
        task.ownerId,
        {
          userId: task.ownerId,
          primaryOrgId: task.orgId,
          roles: task.actorRoles ?? [],
          accessibleOrgIds: [task.orgId],
          isGlobalAdmin: false,
        },
      );
      total = result.total;
      for (const item of result.items) {
        const record = item as Record<string, unknown>;
        if (!headerWritten) {
          lines.push(Object.keys(record).map(csvCell).join(','));
          headerWritten = true;
        }
        lines.push(Object.keys(record).map((key) => csvCell(record[key])).join(','));
        processed += 1;
        if (processed >= MAX_ROWS) break;
      }
      await this.exportService
        .advance(
          task.id,
          total > 0 ? Math.min(99, (processed / total) * 100) : 99,
          processed,
          total,
        )
        .catch(() => {
          /* 取消竞争：advance 失败由下一次 claim/状态机兜底 */
        });
      const hasMore = result.hasNextPage || result.hasMore;
      if (!hasMore || processed >= MAX_ROWS) break;
      page += 1;
    }
    return { csv: `${lines.join('\n')}\n`, rowCount: processed };
  }

  private persistArtifact(taskId: string, csv: string): string {
    const dir =
      process.env.WORKBENCH_EXPORT_DIR?.trim() ||
      join(tmpdir(), 'ewoh-workbench-exports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${taskId}.csv`), csv, 'utf8');
    return `/api/operations/workbench/export/${taskId}/download`;
  }
}
