import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { getDeviceExecutionBoundary, type DeviceCommandView } from '../../api/control';
import { formatTimestamp } from '@client/src/lib/credibility';

/**
 * ExecutionBoundaryPanel — 设备执行边界面板（NO-66a）。
 *
 * 现场问题："这台设备为什么不动？""刚才那条命令为什么被拒？"
 * 平台侧其实全都有事实（下发 / 投递确认 / 执行回执 / 授权复核撤回 / 未授权执行 /
 * 一车一活排队 / 指纹方案与复核结论），但此前**只有网关（机器身份）能读**。
 *
 * 展示纪律（原则 5/6/7）：
 *   - 状态逐条区分：待投递 / **排队（设备忙，暂缓≠失败）** / 已投递未回执 / 已执行 / 失败 /
 *     已撤回（授权复核未通过，附原因码与人话说明）；
 *   - 授权可信度可见：指纹**方案**（签名 v2 / 一致性 v1 / 无）与**是否复核通过**分开显示，
 *     不把"没验过"渲染成"已验证"；
 *   - 违规留痕单列（`delivery_rejected` / `authorization_violation`）——安全事件不能混在"失败"里；
 *   - 读失败显式报错、空列表显式说明（不显示"一切正常"的假状态）。
 */
export interface ExecutionBoundaryPanelProps {
  deviceId: string;
  /** 只展示最近 N 条（缺省 8）。 */
  limit?: number;
}

const DELIVERY_STATE_META: Record<string, { label: string; className: string }> = {
  awaiting_delivery: { label: '待投递', className: 'text-muted-foreground' },
  queued_device_busy: { label: '排队（设备忙）', className: 'text-risk-degraded-foreground' },
  queued_quota: { label: '排队（配额用尽）', className: 'text-risk-degraded-foreground' },
  gateway_received: { label: '已投递未回执', className: 'text-foreground' },
  executed: { label: '已执行', className: 'text-risk-normal-foreground' },
  failed: { label: '执行失败', className: 'text-risk-blocked-foreground' },
  revoked: { label: '已撤回（授权复核未通过）', className: 'text-risk-blocked-foreground' },
  expired: { label: '已超时', className: 'text-risk-degraded-foreground' },
};

function deliveryStateMeta(state: string) {
  return DELIVERY_STATE_META[state] ?? { label: state || '未知状态', className: 'text-foreground' };
}

/** 指纹可信度：方案 + 是否复核通过（两件事分开说）。 */
function fingerprintText(command: DeviceCommandView): string {
  if (command.fingerprintScheme === 'hmac-sha256:v2') {
    return command.fingerprintVerified ? '签名指纹已验签（HMAC-SHA256）' : '签名指纹未验签';
  }
  if (command.fingerprintScheme === 'fnv1a64:v1') {
    return command.fingerprintVerified ? '一致性指纹已核对（无密钥）' : '一致性指纹未核对';
  }
  return '无授权指纹（存量命令）';
}

export function ExecutionBoundaryPanel({
  deviceId,
  limit = 8,
}: ExecutionBoundaryPanelProps): React.ReactElement {
  const query = useQuery({
    queryKey: ['device-execution-boundary', deviceId, limit],
    queryFn: () => getDeviceExecutionBoundary(deviceId, limit),
    enabled: Boolean(deviceId),
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="execution-boundary-loading">
        <Loader2 className="size-3 animate-spin" aria-hidden /> 正在读取执行边界…
      </p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <p className="flex items-start gap-2 text-sm text-risk-blocked-foreground" data-testid="execution-boundary-error">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        执行边界读取失败：{query.error instanceof Error ? query.error.message : '未知错误'}（不显示"一切正常"的假状态）
      </p>
    );
  }
  const { commands, summary, checkedAt } = query.data;
  return (
    <section className="space-y-2" data-testid="execution-boundary-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">执行边界</span>
        <Badge variant="outline">在飞 {summary.inFlight}</Badge>
        <Badge variant="outline" className={summary.queued > 0 ? 'text-risk-degraded-foreground' : undefined}>
          排队 {summary.queued}
        </Badge>
        <Badge variant="outline">待投递 {summary.awaitingDelivery}</Badge>
        {summary.revoked > 0 && (
          <Badge variant="outline" className="text-risk-blocked-foreground">
            已撤回 {summary.revoked}
          </Badge>
        )}
        {summary.quota && summary.quota.perMinute > 0 && (
          <Badge
            variant="outline"
            className={summary.quota.remaining === 0 ? 'text-risk-degraded-foreground' : undefined}
          >
            投递配额：窗口内已投 {summary.quota.usedInWindow} / 上限 {summary.quota.perMinute} 每分钟
            {summary.quota.remaining === 0 ? '（已用尽：命令排队到下一分钟，不是失败）' : ''}
          </Badge>
        )}
        {/* NO-68a：投递老化——"没人看的时候积压是否存在"必须在面板上直接可答 */}
        {typeof summary.overdue === 'number' && summary.overdue > 0 && (
          <Badge variant="outline" className="text-risk-blocked-foreground">
            投递积压 {summary.overdue} 条（最久等待{' '}
            {Math.max(1, Math.round(Number(summary.oldestWaitingMs ?? 0) / 60_000))} 分钟，超过 SLA{' '}
            {Math.round(Number(summary.deliverySlaMs ?? 0) / 60_000)} 分钟）
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">检查于 {formatTimestamp(checkedAt)}</span>
      </div>
      {summary.busyBlocker && (
        <p className="text-xs text-risk-degraded-foreground">
          设备正在执行 <span className="font-mono">{summary.busyBlocker}</span>：后续运动命令按
          "一车一活"排队（暂缓 ≠ 失败，设备空下来自动投递）；停止/暂停等降险动作不受排队约束。
        </p>
      )}
      {commands.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="execution-boundary-empty">
          该设备当前没有控制命令记录（无命令 ≠ 设备正常，设备状态请看上方状态与时序）。
        </p>
      ) : (
        <ul className="space-y-1" data-testid="execution-boundary-commands">
          {commands.slice(0, limit).map((command) => {
            const meta = deliveryStateMeta(command.deliveryState);
            return (
              <li key={command.commandId} className="rounded-md border border-border px-2 py-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{command.commandKey}</span>
                  <span className={meta.className}>{meta.label}</span>
                  <span className="text-xs text-muted-foreground">{formatTimestamp(command.sentAt)}</span>
                  {/* 授权可信度：方案 + 复核结论分开显示 */}
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {command.fingerprintVerified ? (
                      <ShieldCheck className="size-3" aria-hidden />
                    ) : (
                      <ShieldAlert className="size-3" aria-hidden />
                    )}
                    {fingerprintText(command)}
                  </span>
                </div>
                {command.deliveryNote && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{command.deliveryNote}</p>
                )}
                {command.ack && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3" aria-hidden />
                    投递确认：{command.ack.delivered ? '已投递' : '被网关拒绝'}
                    {command.ack.reason ? `（${command.ack.reason}）` : ''}
                  </p>
                )}
                {command.receipt && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" aria-hidden />
                    执行回执：{command.receipt.result === 'executed' ? '已执行' : '执行失败'}
                    {command.receipt.at ? ` · ${formatTimestamp(command.receipt.at)}` : ''}
                  </p>
                )}
                {command.violations.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5" data-testid="execution-boundary-violations">
                    {command.violations.map((violation) => (
                      <li key={`${violation.resultType}-${violation.at ?? ''}`} className="text-xs text-risk-blocked-foreground">
                        {violation.resultType === 'authorization_violation'
                          ? `未授权执行（${violation.resultCode ?? '未知原因'}）——设备在授权失效后仍然动作，请按安全事件处置`
                          : `投递被拒并撤回（${violation.resultCode ?? '未知原因'}）`}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default ExecutionBoundaryPanel;
