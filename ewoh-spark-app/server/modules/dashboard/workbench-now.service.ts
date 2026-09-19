import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ControlService } from '../control/control.service';

/**
 * "现在需要我做什么"聚合（2026-09-13，FR6 交互愿景落地）。
 *
 * 为什么单独一个端点而不是让前端拼 5 个查询：班组长开机第一眼的问题是
 * "现在有什么要我处理的"——答案散落在异常/审批/通知/物料四个域里，
 * 前端拼装意味着 4 次请求 + 4 套优先级排序逻辑 + 4 份"读失败伪装成 0"的风险。
 * 后端一次聚合、统一优先级排序，前端只渲染——"开机即知"的地基。
 *
 * 优先级语义（从高到低）：
 *   1. critical 开异常（安全/质量红灯）
 *   2. high 开异常
 *   3. 物料缺口（需求 > 库存，影响交付）
 *   4. 待审批提案（人在关键节点必须介入的）
 *   5. 严重级未读通知（积压待处置的）
 *
 * 每一条都带 kind / ref / route——聚合不造新事实，只是已有事实的优先级索引。
 */

export interface NowItem {
  kind: 'anomaly' | 'approval' | 'notification' | 'material_gap';
  priority: 1 | 2 | 3 | 4 | 5;
  title: string;
  ref: string;
  route: string;
  severity: string | null;
  createdAt: string;
  /** 附加量化信息（缺口量、等待时长等），前端直接渲染 */
  detail?: string;
}

@Injectable()
export class WorkbenchNowService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly controlService?: ControlService,
  ) {}

  async getNow(actor?: OrgContext): Promise<{
    items: NowItem[];
    generatedAt: string;
  }> {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：工作台聚合必须带租户上下文');
    }

    const [anomalies, notifications, proposals, materialGaps, backlog] = await Promise.all([
      this.readOpenAnomalies(orgId),
      this.readCriticalNotifications(orgId),
      this.readPendingProposals(orgId),
      this.readMaterialGaps(orgId),
      // NO-77a：投递积压**实时快照**（不依赖"恰好有人跑过巡检"；判定与巡检同一实现）
      this.readDeliveryBacklog(orgId),
    ]);

    const items: NowItem[] = [
      ...anomalies.map((r) => ({
        kind: 'anomaly' as const,
        priority: (r.severity === 'critical' ? 1 : 2) as 1 | 2,
        title: r.title ?? `设备异常 ${r.deviceId ?? ''}`,
        ref: r.eventId,
        route: '/alerts',
        severity: r.severity,
        createdAt: r.createdAt,
      })),
      ...materialGaps.map((m) => ({
        kind: 'material_gap' as const,
        priority: 3 as const,
        title: `物料缺口 ${m.materialId}：需求 ${m.demand} > 库存 ${m.stock}`,
        ref: m.materialId,
        route: '/materials',
        severity: 'high',
        createdAt: m.generatedAt,
        detail: `需求 ${m.demand} / 库存 ${m.stock} / 缺口 ${m.gap}`,
      })),
      ...proposals.map((p) => ({
        kind: 'approval' as const,
        priority: 4 as const,
        title: `学习提案待审批 ${p.kind}：${p.parameter} ${p.baseline}→${p.candidate}`,
        ref: p.proposalId,
        route: '/learning-console',
        severity: 'medium',
        createdAt: p.createdAt,
      })),
      ...(backlog && backlog.totals.commands > 0
        ? [
            {
              kind: 'anomaly' as const,
              // 升级（≥3× SLA）= 管理层事件 → priority 1；普通积压 → 2（与高优异常同级）
              priority: (backlog.totals.escalatedDevices > 0 ? 1 : 2) as 1 | 2,
              title:
                `投递积压：${backlog.totals.devices} 台设备 ${backlog.totals.commands} 条命令`
                + `（最久等待 ${Math.max(1, Math.round((backlog.totals.oldestWaitingMs ?? 0) / 60_000))} 分钟）`
                + (backlog.totals.escalatedDevices > 0
                  ? `，${backlog.totals.escalatedDevices} 台已升级`
                  : ''),
              ref: 'delivery-backlog',
              route: '/devices',
              severity: backlog.totals.escalatedDevices > 0 ? 'critical' : 'high',
              createdAt: new Date().toISOString(),
              detail:
                `未交付 ${backlog.totals.undelivered} / 已投未回执 ${backlog.totals.receivedNotExecuted}`
                + `（SLA ${Math.round(backlog.slaMs / 60_000)} 分钟）`,
            },
          ]
        : []),
      ...notifications.map((n) => ({
        kind: 'notification' as const,
        priority: 5 as const,
        title: n.title,
        ref: n.notificationId,
        route: '/field-operations',
        severity: n.severity,
        createdAt: n.createdAt,
      })),
    ];

    items.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt < b.createdAt ? -1 : 1;
    });

    return { items, generatedAt: new Date().toISOString() };
  }

  private async readOpenAnomalies(orgId: string): Promise<Array<{
    eventId: string;
    title: string | null;
    deviceId: string | null;
    severity: string;
    createdAt: string;
  }>> {
    const rows = (await this.db.execute(sql`
      SELECT event_id, title, device_id, severity, created_at
        FROM ewoh_event
       WHERE org_id = ${orgId}
         AND event_type IN (
           'AndonRaised',
           'DeviceOffline',
           'QualityFindingDetected',
           'DeviceLowBattery',
           'WorkerHighLoad',
           'WorkerPostureRisk',
           'DataDegraded'
         )
         AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 20
    `)) as unknown as Array<{
      event_id: string;
      title: string | null;
      device_id: string | null;
      severity: string;
      created_at: string | Date;
    }>;
    return rows.map((r) => ({
      eventId: String(r.event_id),
      title: r.title,
      deviceId: r.device_id,
      severity: r.severity ?? 'medium',
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  private async readCriticalNotifications(orgId: string): Promise<Array<{
    notificationId: string;
    title: string;
    severity: string;
    createdAt: string;
  }>> {
    const rows = (await this.db.execute(sql`
      SELECT notification_id, title, severity, _created_at AS created_at
        FROM ewoh_notification
       WHERE org_id = ${orgId}
         AND status = 'pending'
         AND severity IN ('high', 'critical')
       ORDER BY _created_at DESC
       LIMIT 20
    `)) as unknown as Array<{
      notification_id: string;
      title: string;
      severity: string;
      created_at: string | Date;
    }>;
    return rows.map((r) => ({
      notificationId: String(r.notification_id),
      title: r.title,
      severity: r.severity,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  private async readPendingProposals(orgId: string): Promise<Array<{
    proposalId: string;
    kind: string;
    parameter: string;
    baseline: string;
    candidate: string;
    createdAt: string;
  }>> {
    const rows = (await this.db.execute(sql`
      SELECT proposal_id, kind, parameter,
             baseline_value::text AS baseline,
             candidate_value::text AS candidate,
             _created_at AS created_at
        FROM ewoh_learning_proposal
       WHERE org_id = ${orgId}
         AND status IN ('proposed', 'shadow_evaluated')
       ORDER BY _created_at DESC
       LIMIT 20
    `)) as unknown as Array<{
      proposal_id: string;
      kind: string;
      parameter: string;
      baseline: string;
      candidate: string;
      created_at: string | Date;
    }>;
    return rows.map((r) => ({
      proposalId: String(r.proposal_id),
      kind: r.kind,
      parameter: r.parameter,
      baseline: r.baseline,
      candidate: r.candidate,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  private async readMaterialGaps(orgId: string): Promise<Array<{
    materialId: string;
    demand: number;
    stock: number;
    gap: number;
    generatedAt: string;
  }>> {
    const rows = (await this.db.execute(sql`
      SELECT m.material_id, m.name,
             COALESCE(req.total_demand, 0) AS demand,
             COALESCE(stk.total_stock, 0) AS stock
        FROM ewoh_material m
        LEFT JOIN (
          SELECT material_id, SUM(quantity::numeric) AS total_stock
            FROM ewoh_material_stock
           WHERE org_id = ${orgId} AND quantity_status = 'known'
           GROUP BY material_id
        ) stk ON stk.material_id = m.material_id
        LEFT JOIN (
          SELECT material_id, SUM(quantity::numeric) AS total_demand
            FROM ewoh_material_requirement
           WHERE org_id = ${orgId} AND quantity_status = 'known' AND status = 'open'
             AND requirement_type = 'demand'
           GROUP BY material_id
        ) req ON req.material_id = m.material_id
       WHERE COALESCE(req.total_demand, 0) > COALESCE(stk.total_stock, 0)
       ORDER BY (COALESCE(req.total_demand, 0) - COALESCE(stk.total_stock, 0)) DESC
       LIMIT 20
    `)) as unknown as Array<{
      material_id: string;
      name: string | null;
      demand: string | number;
      stock: string | number;
    }>;
    return rows.map((r) => {
      const demand = Number(r.demand ?? 0);
      const stock = Number(r.stock ?? 0);
      return {
        materialId: String(r.material_id),
        demand,
        stock,
        gap: Math.max(0, demand - stock),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** NO-77a：投递积压实时快照（ControlService 同一判定实现；失败如实返回 null——工作台不因此整页失败）。 */
  private async readDeliveryBacklog(orgId: string) {
    if (!this.controlService) return null;
    try {
      return await this.controlService.getDeliveryBacklogSnapshot({
        userId: 'system:workbench-now',
        primaryOrgId: orgId,
      } as never);
    } catch {
      // 快照失败不阻塞工作台其余事实（异常计数/告警由调用方日志承载）
      return null;
    }
  }
}
