import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ControlService } from './control.service';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';

/**
 * 控制命令**投递积压**巡检 worker（NO-68a）。
 *
 * 为什么需要定时：命令下发后迟迟没投到设备（网关掉线 / 指纹密钥两侧不配对 /
 * 投递配额用尽 / 设备一直忙）时，`sent` 状态会**静静地躺着**——现场只觉得"设备不动"，
 * 运维不知道该看什么。提醒的价值恰恰在"没人主动看"的时候，与逾期行动项/审批到期同纪律：
 *   · 逐租户开 GUC 事务（后台没有请求上下文，RLS 会把行全部挡住）；
 *   · 只写提醒与审计，**绝不改命令/设备事实**（巡检是只读的）；
 *   · 同一设备的同一积压按确定性 notificationId 幂等，不重复打扰；
 *   · 单租户失败只留痕不中断；
 *   · 默认 10 分钟一次，`CONTROL_BACKLOG_WORKER_DISABLED=1` 可关。
 */
/**
 * 巡检间隔解析：正整数 env 才接受，非法/缺失回退默认（invalid 时回调留痕）。
 *
 * 为什么必须显式守卫：`setInterval(fn, NaN)` 在 Node 里会被当成 **1ms**（实测
 * TimeoutNaNWarning: duration set to 1）——一次配置手误（如把表达式写进 env）会把
 * "10 分钟巡检一次"变成**每毫秒扫一次库**的热循环（tick 虽有 running 防重入，但
 * 每轮结束立刻开始下一轮，DB 持续被打）。配置错误必须可见，不许静默变成最坏值。
 */
export function backlogIntervalMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  fallback = 10 * 60_000,
  onInvalid?: (message: string) => void,
): number {
  const raw = env.CONTROL_BACKLOG_WORKER_INTERVAL_MS;
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    onInvalid?.(`非法 CONTROL_BACKLOG_WORKER_INTERVAL_MS "${raw}"，回退默认 ${fallback}ms（配置错误必须可见）`);
    return fallback;
  }
  return Math.floor(parsed);
}

@Injectable()
export class ControlDeliveryBacklogWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlDeliveryBacklogWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly controlService: ControlService,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit(): void {
    if (process.env.CONTROL_BACKLOG_WORKER_DISABLED === '1') {
      this.logger.log('投递积压 worker 已禁用（CONTROL_BACKLOG_WORKER_DISABLED=1）');
      return;
    }
    const intervalMs = backlogIntervalMs(process.env, 10 * 60_000, (message) => this.logger.warn(message));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`投递积压 worker 已启动（interval=${intervalMs}ms）`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 单次扫描：逐租户（GUC 事务）跑同一实现。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orgIds = await this.requestDatabaseContext.runInTransaction(
        buildGucSettings({ userId: 'system:control-backlog', primaryOrgId: '' }),
        async () => this.controlService.listOrgsWithPendingCommands(),
      );
      for (const orgId of orgIds) {
        try {
          const result = await this.requestDatabaseContext.runInTransaction(
            buildGucSettings({ userId: 'system:control-backlog', primaryOrgId: orgId }),
            async () => this.controlService.sweepDeliveryBacklog({
              userId: 'system:control-backlog',
              primaryOrgId: orgId,
            } as never),
          );
          if (result.devicesWithBacklog > 0) {
            this.logger.warn(
              `投递积压 org=${orgId} 命令=${result.scanned} 设备=${result.devicesWithBacklog} `
                + `新建提醒=${result.created} 已存在=${result.duplicates} sla=${result.slaMs}ms`,
            );
          }
        } catch (error) {
          this.logger.warn(
            `投递积压巡检 org=${orgId} 失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`投递积压巡检失败：${error instanceof Error ? error.message : String(error)}`);
      await this.auditService
        .appendAuditLog({
          actorId: 'system:control-backlog',
          orgId: '',
          action: 'control.delivery_backlog_sweep_failed',
          entityType: 'control_command',
          entityId: 'worker',
          reason: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    } finally {
      this.running = false;
    }
  }
}
