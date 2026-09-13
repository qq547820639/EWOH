import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import {
  orderStalenessChanges,
  type StalenessReportView,
} from './schedulingLogic';

/**
 * PlanStalenessPanel — 方案过期诊断面板（NO-62c）。
 *
 * 为什么需要：审批被 409 `PLAN_STALE` 拒绝时，页面原来只弹一句
 * 「该方案生成后现场状态已发生变化，请重新计算」。用户既不知道**变了什么**、
 * 也不知道是不是自己造成的（例如刚派了本方案的第一波），现场结果是审批人反复点
 * "通过"、调度员盲目重排——问题被掩盖而不是被处置（原则 5/7）。
 *
 * 本面板把后端诊断（与审批路径**同一实现**）摊开：
 *   · 差异逐项列出（外部变化在前，本方案自身效果在后并标注）；
 *   · 明确区分"能重排"与"快照已被清理，无法比较"（后者不许假装有新方案）；
 *   · 一键重排（重排仍走完整调度与审批链，不绕过任何闸门）。
 *
 * 纯展示：不自己取数、不自己判断新鲜度——判定口径只有后端一份。
 */
export interface PlanStalenessPanelProps {
  planId: string;
  report: StalenessReportView;
  replanPending?: boolean;
  replanAvailable?: boolean;
  onReplan: (planId: string) => void;
  onDismiss: () => void;
  /** 最多展示多少条差异（其余折叠为"还有 N 项"）。 */
  maxChanges?: number;
}

export function PlanStalenessPanel({
  planId,
  report,
  replanPending = false,
  replanAvailable = true,
  onReplan,
  onDismiss,
  maxChanges = 8,
}: PlanStalenessPanelProps): React.ReactElement {
  const { shown, hiddenCount } = orderStalenessChanges(report, maxChanges);
  const external = report.externalChangeCount ?? report.changes.filter((c) => !c.selfInflicted).length;
  const self = report.selfInflictedCount ?? report.changes.filter((c) => c.selfInflicted).length;
  return (
    <section
      className="rounded-lg border border-risk-blocked-border bg-risk-blocked-soft p-4"
      data-testid="plan-staleness-panel"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-risk-blocked-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            方案已过期：世界状态在生成之后发生了变化
          </p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{planId}</p>
          <p className="mt-2 text-sm text-foreground">{report.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            快照 {report.snapshotVersion} · 检查于{' '}
            {new Date(report.checkedAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour12: false,
            })}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="关闭过期诊断">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-risk-blocked-border text-risk-blocked-foreground">
          外部变化 {external}
        </Badge>
        <Badge variant="outline">本方案自身效果 {self}</Badge>
        {/* NO-64a：分档可见——"事实变了"与"只是证据变旧"必须能一眼分清（原则 5/7） */}
        {typeof report.contentChangeCount === 'number' && report.contentChangeCount > 0 && (
          <Badge variant="outline" className="border-risk-blocked-border text-risk-blocked-foreground">
            事实变化 {report.contentChangeCount}
          </Badge>
        )}
        {typeof report.blockedEvidenceCount === 'number' && report.blockedEvidenceCount > 0 && (
          <Badge variant="outline" className="border-risk-degraded-border text-risk-degraded-foreground">
            依赖资源证据过期 {report.blockedEvidenceCount}
          </Badge>
        )}
        {typeof report.evidenceAgedCount === 'number' && report.evidenceAgedCount > 0 && (
          <Badge variant="outline">仅证据老化 {report.evidenceAgedCount}（不阻断）</Badge>
        )}
        {!report.snapshotFound && <Badge variant="outline">快照已不可比</Badge>}
      </div>

      {shown.length > 0 ? (
        <ul className="mt-3 space-y-1" data-testid="plan-staleness-changes">
          {shown.map((change) => (
            <li key={`${change.kind}:${change.entityKey}`} className="text-sm text-foreground">
              <span className="mr-2 font-mono text-xs text-muted-foreground">
                {change.entityType}:{change.entityId}
              </span>
              {change.label}
              {change.severity === 'content' && (
                <span className="ml-2 text-xs text-risk-blocked-foreground">（事实变化）</span>
              )}
              {change.severity === 'blocked_evidence' && (
                <span className="ml-2 text-xs text-risk-degraded-foreground">
                  （方案依赖，证据已过期）
                </span>
              )}
              {change.severity === 'evidence' && (
                <span className="ml-2 text-xs text-muted-foreground">（仅证据老化）</span>
              )}
              {change.selfInflicted && (
                <span className="ml-2 text-xs text-muted-foreground">（本方案自身）</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          后端未提供差异明细（只报告了"已过期"）：请直接重新排程后再审批。
        </p>
      )}
      {hiddenCount > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">还有 {hiddenCount} 项差异未展示</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!replanAvailable || replanPending}
          onClick={() => onReplan(planId)}
          title={replanAvailable ? '按当前世界状态重新排程' : '该状态不支持直接重排'}
        >
          {replanPending ? (
            <RefreshCw className="mr-1 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
          )}
          按最新状态重新排程
        </Button>
        <span className="text-xs text-muted-foreground">
          重排不绕过审批：新方案仍需独立审批人确认
        </span>
      </div>
    </section>
  );
}

export default PlanStalenessPanel;
