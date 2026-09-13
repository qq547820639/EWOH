import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldCheck, RefreshCw, PlayCircle, TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import { Checkbox } from '@client/src/components/ui/checkbox';
import { errorDescription } from '@client/src/lib/errorContract';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { getApprovalStatus, getSnapshot } from '@client/src/api/scheduler';
import { describeCapabilityApprovalFreshness } from '@shared/capability-requirements';
import { requestDeviceCapabilityRestoreApproval, setDeviceCapabilityStatus } from '../../api/dashboard';
import {
  describeBatchRestoreFailure,
  groupRestorableCapabilities,
  summarizeRestoreOutcome,
  sortedDeviceIds,
  type BatchRestoreGroup,
  type BatchRestoreResult,
} from './batchRestoreLogic';

/**
 * NO-23a：批量恢复设备能力（一次检修 → 一张审批 → 逐台带号落地）。
 *
 * 为什么必须批量：同一批外骨骼/吊具检修完，现场要恢复的是**一批**设备；
 * 逐台开抽屉、逐台申请审批会让人放弃恢复，设备就被悄悄永久排除在派工之外。
 *
 * 语义边界（与后端同口径，前端不做放行判定）：
 *   · 高风险能力（exo-lift / crane / interact.assist / forklift）→ 必须先申请安全审批，
 *     审批覆盖**选中设备名单**，24 小时内有效、每台设备消耗一次；
 *   · 低/中风险能力 → 直接恢复（停用是收紧不需审批，恢复它也不动高风险作业资格）；
 *   · 结果逐台列出并区分 全部成功 / 部分成功 / 全部失败；失败项**未消耗**审批额度，
 *     可直接重试（服务端把消耗与写入放在同一事务）。
 */
export interface BatchCapabilityRestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 执行完成后刷新设备列表（能力状态变化会改变世界模型判断）。 */
  onApplied?: () => void;
}

type Stage = 'select' | 'execute';

export function BatchCapabilityRestoreDialog({
  open,
  onOpenChange,
  onApplied,
}: BatchCapabilityRestoreDialogProps) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>('select');
  const [selectedCapability, setSelectedCapability] = useState<string | null>(null);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const [approvalStatus, setApprovalStatus] = useState<{
    id: string;
    status: string;
    approvedAt?: string;
    /** 审批覆盖的设备名单（指纹 metrics.deviceIds）——选择变化后据此拦下"批 A 恢复 B"。 */
    deviceIds?: string[] | null;
  } | null>(null);
  const [results, setResults] = useState<BatchRestoreResult[]>([]);

  const snapshotQuery = useQuery({
    queryKey: queryKeys.schedulerSnapshot,
    queryFn: () => getSnapshot(),
    enabled: open,
    staleTime: 10_000,
  });

  const { groups, missingDeviceIdCount } = useMemo(
    () => groupRestorableCapabilities(snapshotQuery.data ?? null),
    [snapshotQuery.data],
  );
  const group: BatchRestoreGroup | null = useMemo(
    () => groups.find((candidate) => candidate.capability === selectedCapability) ?? groups[0] ?? null,
    [groups, selectedCapability],
  );
  const outcome = useMemo(() => summarizeRestoreOutcome(results), [results]);

  /**
   * 默认全选**仅在切换批次时**发生（现场来这一趟就是为了把这批恢复掉）。
   * 依赖键是能力名而不是整个 group 对象：快照刷新会重建对象，但不应把现场
   * 手动取消的勾选又变回全选（那等于替现场改了执行范围）。
   */
  useEffect(() => {
    if (!group) return;
    setSelectedDeviceIds(group.devices.map((device) => device.deviceId));
    setApprovalId('');
    setApprovalStatus(null);
    setResults([]);
  }, [group?.capability]);

  const requestApprovalMutation = useMutation({
    // 与设备抽屉同一实现（entityType=device_capability_change、entityId=capability:<名>、
    // 指纹 = 排序后的 deviceIds）；审批覆盖**本次选中**的设备名单。
    mutationFn: (params: { capability: string; deviceIds: string[]; reason: string }) =>
      requestDeviceCapabilityRestoreApproval({
        capabilityKey: params.capability,
        deviceIds: params.deviceIds,
        reason: params.reason,
      }),
    onSuccess: (data) => {
      setApprovalId(data.id);
      setApprovalStatus({
        id: data.id,
        status: data.status,
        approvedAt: data.approvedAt,
        // 本地构造审批时就知道覆盖了哪些设备（与服务端指纹同一份输入）
        deviceIds: sortedDeviceIds(selectedDeviceIds),
      });
      toast.success('已提交安全审批申请', {
        description: `审批号 ${data.id}｜覆盖 ${selectedDeviceIds.length} 台设备，获批后点击"执行恢复"。`,
      });
    },
    onError: (err: unknown) => {
      toast.error('审批申请失败', { description: errorDescription(err) });
    },
  });

  const checkApprovalMutation = useMutation({
    mutationFn: (id: string) => getApprovalStatus(id),
    onSuccess: (data) => {
      const covered = String(data.subject?.metrics?.deviceIds ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      setApprovalStatus({
        id: data.id,
        status: data.status,
        approvedAt: data.approvedAt,
        deviceIds: covered.length > 0 ? covered : null,
      });
      const freshness = describeCapabilityApprovalFreshness(data.approvedAt ?? null);
      if (data.status === 'approved') toast.success('审批已通过', { description: freshness.label });
      else toast.info(`审批状态：${data.status}`, { description: '等待安全管理员处理。' });
    },
    onError: (err: unknown) => {
      toast.error('审批状态查询失败', { description: errorDescription(err) });
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (params: { capability: string; deviceIds: string[]; reason: string; approvalId?: string }) => {
      const collected: BatchRestoreResult[] = [];
      for (const deviceId of params.deviceIds) {
        try {
          const res = await setDeviceCapabilityStatus(deviceId, params.capability, {
            status: 'active',
            reason: params.reason,
            ...(params.approvalId ? { approvalId: params.approvalId } : {}),
          });
          collected.push({
            deviceId,
            ok: true,
            status: 200,
            message: res.changed ? null : '该能力已处于生效状态（无需变更）',
          });
        } catch (err) {
          const status =
            (err as { response?: { status?: number } })?.response?.status ?? null;
          collected.push({ deviceId, ok: false, status, message: describeBatchRestoreFailure(err) });
        }
      }
      return collected;
    },
    onSuccess: (collected) => {
      setResults(collected);
      const summary = summarizeRestoreOutcome(collected);
      if (summary.failed === 0) {
        toast.success('批量恢复完成', { description: summary.label });
      } else if (summary.succeeded > 0) {
        toast.warning('部分设备恢复失败', { description: summary.label });
      } else {
        toast.error('批量恢复失败', { description: summary.label });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.devices() });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerSnapshot });
      onApplied?.();
    },
    onError: (err: unknown) => {
      toast.error('批量恢复未能执行', { description: errorDescription(err) });
    },
  });

  const toggleDevice = (deviceId: string) => {
    setSelectedDeviceIds((current) =>
      current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId],
    );
  };

  const selectGroup = (next: BatchRestoreGroup) => {
    setSelectedCapability(next.capability);
    // 默认全选：现场来这一趟就是为了把这些设备恢复掉；逐台勾选是例外路径
    setSelectedDeviceIds(next.devices.map((device) => device.deviceId));
    setApprovalId('');
    setApprovalStatus(null);
    setResults([]);
  };

  // 选择是**显式**的：取消勾选后不得悄悄回退成"全选"（那会让现场以为只恢复部分、
  // 实际却动了全部）。空选择由按钮禁用 + 明确提示处理。
  const effectiveDevices = selectedDeviceIds;
  const sortedSelection = sortedDeviceIds(effectiveDevices);
  const needsApproval = group?.requiresApproval === true;
  // 审批覆盖名单必须与**当前选择**一致：批了 A 却去恢复 B，服务端会逐台拒绝，
  // 现场只会看到一串看不懂的失败。这里提前拦住并说明差在哪。
  const approvalCovered = approvalStatus?.deviceIds ?? null;
  const selectionMatchesApproval =
    !approvalCovered ||
    (approvalCovered.length === sortedSelection.length
      && sortedSelection.every((id) => approvalCovered.includes(id)));
  const approvalScopeWarning =
    needsApproval && approvalCovered && !selectionMatchesApproval
      ? `审批覆盖的设备名单是 ${approvalCovered.join('、')}，与当前选择（${sortedSelection.join('、') || '空'}）不一致：请恢复原选择，或重新申请覆盖当前名单的审批。`
      : null;
  const approvalUsable =
    !needsApproval ||
    (approvalStatus?.status === 'approved'
      && describeCapabilityApprovalFreshness(approvalStatus.approvedAt ?? null).valid
      && selectionMatchesApproval);

  const reset = () => {
    setStage('select');
    setSelectedCapability(null);
    setSelectedDeviceIds([]);
    setReason('');
    setApprovalId('');
    setApprovalStatus(null);
    setResults([]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[720px]" data-testid="batch-restore-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">批量恢复设备能力</DialogTitle>
          <DialogDescription className="text-xs">
            按能力聚合"被人为停用"的设备：一次检修后成批恢复，避免设备被悄悄永久排除在派工之外。
            高风险能力必须持**有效期内的安全审批**，审批覆盖选中设备名单（每台消耗一次）。
          </DialogDescription>
        </DialogHeader>

        {stage === 'select' && (
          <div className="space-y-3 text-xs">
            {snapshotQuery.isLoading && <p className="text-muted-foreground">加载世界模型快照…</p>}
            {snapshotQuery.isError && (
              <p className="text-risk-blocked-foreground" role="alert" data-testid="batch-restore-snapshot-error">
                世界模型快照读取失败：{errorDescription(snapshotQuery.error)}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => snapshotQuery.refetch()}
                >
                  重试
                </Button>
              </p>
            )}
            {!snapshotQuery.isLoading && groups.length === 0 && (
              <p className="text-muted-foreground" data-testid="batch-restore-empty">
                当前没有被人工停用的能力（没有需要恢复的对象）。
              </p>
            )}
            {missingDeviceIdCount > 0 && (
              <p className="text-risk-degraded-foreground" data-testid="batch-restore-missing-id">
                另有 {missingDeviceIdCount} 项停用能力所在设备缺少业务设备号，无法通过状态接口恢复（数据缺口，需先补登）。
              </p>
            )}

            {groups.length > 0 && (
              <div className="space-y-2">
                <div className="text-muted-foreground">选择要恢复的能力批次</div>
                <div className="space-y-1" data-testid="batch-restore-groups">
                  {groups.map((candidate) => {
                    const active = group?.capability === candidate.capability;
                    return (
                      <button
                        key={candidate.capability}
                        type="button"
                        data-testid={`batch-restore-group-${candidate.capability}`}
                        onClick={() => selectGroup(candidate)}
                        className={
                          'w-full rounded-md border px-2 py-1 text-left ' +
                          (active ? 'border-primary bg-muted' : 'border-border hover:bg-muted/50')
                        }
                      >
                        <span className="font-medium text-foreground">{candidate.capability}</span>
                        <span className="ml-2 text-muted-foreground">{candidate.devices.length} 台</span>
                        {candidate.requiresApproval && (
                          <Badge variant="outline" className="ml-2 text-[10px]" data-testid={`batch-restore-requires-approval-${candidate.capability}`}>
                            高风险 · 需安全审批
                          </Badge>
                        )}
                        <span className="ml-2 text-[10px] text-muted-foreground">{candidate.riskLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {group && (
              <div className="space-y-2 rounded-md border border-border px-2 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    选择设备（默认全选；未勾选的设备本次不恢复）
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="batch-restore-select-all"
                    onClick={() => setSelectedDeviceIds(group.devices.map((device) => device.deviceId))}
                  >
                    全选
                  </Button>
                </div>
                {sortedSelection.length === 0 && (
                  <p className="text-risk-degraded-foreground" role="alert" data-testid="batch-restore-no-selection">
                    尚未选择设备：本次不会恢复任何设备（至少勾选一台，或点"全选"）。
                  </p>
                )}
                <ul className="space-y-1" data-testid="batch-restore-devices">
                  {group.devices.map((device) => (
                    <li key={device.deviceId} className="flex items-start gap-2">
                      <Checkbox
                        id={`batch-restore-device-${device.deviceId}`}
                        data-testid={`batch-restore-device-${device.deviceId}`}
                        checked={effectiveDevices.includes(device.deviceId)}
                        onCheckedChange={() => toggleDevice(device.deviceId)}
                      />
                      <label
                        htmlFor={`batch-restore-device-${device.deviceId}`}
                        className="flex-1 cursor-pointer"
                      >
                        <span className="font-mono text-[11px] text-foreground">{device.deviceId}</span>
                        <span className="ml-2 text-muted-foreground">{device.name}</span>
                        {device.disabledDays !== null && (
                          <span className="ml-2 text-risk-degraded-foreground">
                            已停用 {device.disabledDays} 天
                          </span>
                        )}
                        {device.dataQuality && device.dataQuality !== 'FRESH' && (
                          <span className="ml-2 text-muted-foreground">数据质量 {device.dataQuality}</span>
                        )}
                        <div className="text-[10px] text-muted-foreground">
                          {device.operator ?? '操作人未记录'} ·{' '}
                          {device.at ? new Date(device.at).toLocaleString('zh-CN') : '时间未记录'} ·{' '}
                          {device.reason ?? '理由未记录'}
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {group && (
              <label className="block space-y-1" htmlFor="batch-restore-reason">
                <span className="text-muted-foreground">
                  恢复理由（必填，写入台账留痕与审计；审批单会带上它）
                </span>
                <textarea
                  id="batch-restore-reason"
                  className="min-h-[56px] w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                  data-testid="batch-restore-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="例如：本批助力模块已按计划检修并复检合格（2026-09-12 设备科）"
                />
              </label>
            )}
          </div>
        )}

        {stage === 'execute' && group && (
          <div className="space-y-3 text-xs">
            <div className="rounded-md border border-border px-2 py-2">
              <div className="text-foreground">
                {group.capability} · {sortedSelection.length} 台设备
                {needsApproval ? '（高风险，需安全审批）' : '（低/中风险，直接恢复）'}
              </div>
              <div className="text-[10px] text-muted-foreground">{sortedSelection.join('、')}</div>
            </div>

            {needsApproval && (
              <div className="space-y-2 rounded-md border border-border px-2 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="batch-restore-request-approval"
                    disabled={reason.trim().length === 0 || requestApprovalMutation.isPending}
                    title={reason.trim().length === 0 ? '请先填写恢复理由' : undefined}
                    onClick={() =>
                      requestApprovalMutation.mutate({
                        capability: group.capability,
                        deviceIds: sortedSelection,
                        reason: reason.trim(),
                      })
                    }
                  >
                    <ShieldCheck className="mr-1 h-3 w-3" />
                    {requestApprovalMutation.isPending ? '提交中…' : '申请安全审批'}
                  </Button>
                  <label className="flex items-center gap-1" htmlFor="batch-restore-approval-id">
                    <span className="text-muted-foreground">审批号</span>
                    <Input
                      id="batch-restore-approval-id"
                      className="h-7 w-[240px] font-mono text-[10px]"
                      data-testid="batch-restore-approval-input"
                      value={approvalId}
                      onChange={(event) => {
                        setApprovalId(event.target.value);
                        setApprovalStatus(null);
                      }}
                      placeholder="批准后填入（或点左侧按钮申请）"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="batch-restore-check-approval"
                    disabled={approvalId.trim().length === 0 || checkApprovalMutation.isPending}
                    onClick={() => checkApprovalMutation.mutate(approvalId.trim())}
                  >
                    <RefreshCw className="mr-1 h-3 w-3" />
                    刷新审批状态
                  </Button>
                </div>
                {approvalStatus && (
                  <p className="text-[10px] text-muted-foreground" data-testid="batch-restore-approval-status">
                    审批 {approvalStatus.id}：{approvalStatus.status} ·{' '}
                    {describeCapabilityApprovalFreshness(approvalStatus.approvedAt ?? null).label}
                  </p>
                )}
                {needsApproval && approvalStatus?.status === 'approved' && !approvalCovered && (
                  <p className="text-[10px] text-muted-foreground" data-testid="batch-restore-scope-unknown">
                    未能从审批单读到覆盖名单（该审批未携带对象描述）：执行时由服务端逐台核对，
                    未覆盖的设备会被拒绝并逐台说明。
                  </p>
                )}
                {approvalScopeWarning && (
                  <p className="text-[10px] text-risk-blocked-foreground" role="alert" data-testid="batch-restore-scope-warning">
                    {approvalScopeWarning}
                  </p>
                )}
                {!approvalUsable && !approvalScopeWarning && (
                  <p className="text-[10px] text-risk-degraded-foreground" data-testid="batch-restore-approval-blocked">
                    高风险能力恢复必须持**已通过且在有效期内**的审批号：请先申请审批并刷新状态。
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                data-testid="batch-restore-execute"
                disabled={reason.trim().length === 0 || !approvalUsable || executeMutation.isPending}
                onClick={() =>
                  executeMutation.mutate({
                    capability: group.capability,
                    deviceIds: sortedSelection,
                    reason: reason.trim(),
                    approvalId: approvalId.trim() || undefined,
                  })
                }
              >
                <PlayCircle className="mr-1 h-3 w-3" />
                {executeMutation.isPending ? '执行中…' : `执行恢复（${sortedSelection.length} 台）`}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setStage('select')}>
                返回选择
              </Button>
            </div>

            {results.length > 0 && (
              <div className="space-y-1 rounded-md border border-border px-2 py-2">
                <div
                  className={outcome.failed > 0 ? 'text-risk-degraded-foreground' : 'text-foreground'}
                  data-testid="batch-restore-summary"
                >
                  {outcome.failed > 0 && <TriangleAlert className="mr-1 inline h-3 w-3" />}
                  {outcome.label}
                </div>
                <ul className="space-y-0.5" data-testid="batch-restore-results">
                  {results.map((result) => (
                    <li key={result.deviceId} data-testid={`batch-restore-result-${result.deviceId}`}>
                      <span className="font-mono text-[10px] text-foreground">{result.deviceId}</span>
                      <span className={result.ok ? 'ml-2 text-muted-foreground' : 'ml-2 text-risk-blocked-foreground'}>
                        {result.ok ? '已恢复' : '失败'}
                        {result.status ? `（HTTP ${result.status}）` : ''}
                      </span>
                      {result.message && (
                        <span className="ml-2 text-[10px] text-muted-foreground">{result.message}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {outcome.failed > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="batch-restore-retry-failed"
                    disabled={executeMutation.isPending}
                    onClick={() =>
                      executeMutation.mutate({
                        capability: group.capability,
                        deviceIds: outcome.failures.map((failure) => failure.deviceId),
                        reason: reason.trim(),
                        approvalId: approvalId.trim() || undefined,
                      })
                    }
                  >
                    重试失败项（{outcome.failed} 台）
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {stage === 'select' && (
            <Button
              type="button"
              size="sm"
              data-testid="batch-restore-next"
              disabled={!group || reason.trim().length === 0 || sortedSelection.length === 0}
              title={reason.trim().length === 0 ? '请先填写恢复理由' : undefined}
              onClick={() => setStage('execute')}
            >
              下一步
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
