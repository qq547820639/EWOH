import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, ChevronDown, ChevronRight, History, Check, X, Send, MapPin } from 'lucide-react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import {
  generatePlans,
  generateDataDrivenPlans,
  getPlans,
  confirmPlan,
  rejectPlan,
  getAudit,
} from '@client/src/api/scheduler';
import { dispatchPlan } from '@client/src/api/gamification';
import { getCurrentOperator } from '@client/src/lib/auth';
import type { SchedulePlan, ScheduleAudit } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { UI_ARIA_LABELS } from '../../../lib/a11y';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@client/src/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@client/src/components/ui/dialog';
import { Textarea } from '@client/src/components/ui/textarea';

const STATUS_OPTIONS: { label: string; value: string | undefined }[] = [
  { label: '全部', value: undefined },
  { label: '建议', value: 'proposed' },
  { label: '已确认', value: 'confirmed' },
  { label: '已拒绝', value: 'rejected' },
  { label: '已下发', value: 'dispatched' },
];

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'shadow':
      return 'bg-gray-500/20 text-gray-300 border-gray-500/30';
    case 'proposed':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'confirmed':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'rejected':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'dispatched':
      return 'bg-teal-500/20 text-teal-400 border-teal-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return dayjs(dateStr).format('MM-DD HH:mm');
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return dayjs(dateStr).format('MM-DD HH:mm');
}

function formatPct(val: number | undefined): string {
  if (val === undefined || val === null) return '—';
  const pct = Math.abs(val) <= 1 ? val * 100 : val;
  return `${pct.toFixed(1)}%`;
}

function getMetric(plan: SchedulePlan, key: string): number | undefined {
  if (!plan.metricsJson) return undefined;
  const val = plan.metricsJson[key];
  return typeof val === 'number' ? val : undefined;
}

/** 从 metricsJson 提取受影响实体 ID（兼容 affectedEntities / assignedEntities 两种存储格式）。 */
function getAffectedEntityIds(plan: SchedulePlan): string[] {
  if (!plan.metricsJson) return [];
  const ids = new Set<string>();
  for (const key of ['affectedEntities', 'assignedEntities']) {
    const val = plan.metricsJson[key];
    if (Array.isArray(val)) {
      for (const v of val) if (typeof v === 'string') ids.add(v);
    }
  }
  return Array.from(ids);
}

interface SchedulePanelProps {
  focusPlanId?: string | null;
  onFocusPlanConsumed?: () => void;
  /** 在调度模式地图上高亮某方案受影响人员 */
  onViewOnMap?: (personIds: string[]) => void;
}

export default function SchedulePanel({
  focusPlanId,
  onFocusPlanConsumed,
  onViewOnMap,
}: SchedulePanelProps) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<SchedulePlan | null>(null);
  const focusRowRef = useRef<HTMLTableRowElement | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SchedulePlan | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: plans, isLoading, isError } = useQuery<SchedulePlan[]>({
    queryKey: ['schedule-plans', statusFilter],
    queryFn: () => getPlans(statusFilter),
    refetchInterval: 10000,
  });

  // 聚焦到大脑建议关联的方案：展开并滚动到对应行；
  // 若当前筛选下找不到目标行（如为非 proposed 状态），自动切到「全部」筛选并提示。
  useEffect(() => {
    if (!focusPlanId || !plans) return;
    const target = plans.find((plan) => plan.planId === focusPlanId);
    if (target) {
      setExpandedId(target.id);
      // 等待展开后滚动到该行
      window.setTimeout(() => {
        focusRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    } else if (statusFilter !== undefined) {
      toast.info('目标方案不在当前筛选，已切换到全部');
      setStatusFilter(undefined);
    }
    onFocusPlanConsumed?.();
  }, [focusPlanId, plans, statusFilter, onFocusPlanConsumed]);

  const { data: audits } = useQuery<ScheduleAudit[]>({
    queryKey: ['schedule-audits'],
    queryFn: () => getAudit(),
    refetchInterval: 15000,
  });

  const generateMutation = useMutation({
    mutationFn: () => generatePlans({}),
    onSuccess: () => {
      toast.success('方案生成成功');
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
    },
    onError: () => {
      toast.error('方案生成失败');
    },
  });

  const generateAiMutation = useMutation({
    mutationFn: () => generateDataDrivenPlans({}),
    onSuccess: () => {
      toast.success('AI 数据驱动方案生成成功');
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
    },
    onError: (err) => {
      toast.error('AI 方案生成失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string }) =>
      confirmPlan(planId, { reason }),
    onSuccess: () => {
      toast.success('方案确认成功');
      setConfirmTarget(null);
      setConfirmReason('');
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-audits'] });
    },
    onError: () => {
      toast.error('方案确认失败');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string }) =>
      rejectPlan(planId, { reason }),
    onSuccess: () => {
      toast.success('方案已驳回');
      setRejectTarget(null);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-audits'] });
    },
    onError: () => {
      toast.error('方案驳回失败');
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: ({ planId }: { planId: string }) =>
      dispatchPlan(planId, { operator: getCurrentOperator() }),
    onSuccess: (data) => {
      if (data.status === 'conflict') {
        toast.error('下发冲突', { description: data.conflicts.join('；') });
      } else {
        toast.success('方案已下发执行');
      }
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-audits'] });
    },
    onError: () => {
      toast.error('下发失败');
    },
  });

  const handleConfirm = () => {
    if (!confirmTarget) return;
    if (!confirmReason.trim()) {
      toast.error('请填写确认理由');
      return;
    }
    confirmMutation.mutate({ planId: confirmTarget.planId, reason: confirmReason });
  };

  const handleReject = () => {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      toast.error('请填写驳回理由');
      return;
    }
    rejectMutation.mutate({ planId: rejectTarget.planId, reason: rejectReason });
  };

  const recentAudits = (audits ?? []).slice(0, 5);

  return (
    <div className="h-full flex flex-col bg-[hsl(220_14%_14%)] text-white">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <Button
          size="sm"
          onClick={() => generateAiMutation.mutate()}
          disabled={generateAiMutation.isPending}
        >
          <Sparkles className="w-3.5 h-3.5" />
          {generateAiMutation.isPending ? 'AI 生成中...' : 'AI 数据驱动'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
        >
          <Sparkles className="w-3.5 h-3.5" />
          {generateMutation.isPending ? '生成中...' : '模板生成'}
        </Button>
        <div className="w-px h-4 bg-white/10" />
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <Button
              key={opt.label}
              variant={statusFilter === opt.value ? 'default' : 'outline'}
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => setStatusFilter(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Plans table */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-center text-sm text-white/70">加载中...</div>
        ) : isError ? (
          <div className="p-4 text-center text-sm text-red-400">加载失败</div>
        ) : !plans || plans.length === 0 ? (
          <div className="p-4 text-center text-sm text-white/70">暂无数据</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/60 text-[10px] w-6" />
                <TableHead className="text-white/60 text-[10px]">方案名</TableHead>
                <TableHead className="text-white/60 text-[10px]">策略</TableHead>
                <TableHead className="text-white/60 text-[10px]">状态</TableHead>
                <TableHead className="text-white/60 text-[10px]">节拍提升(%)</TableHead>
                <TableHead className="text-white/60 text-[10px]">高负荷人员</TableHead>
                <TableHead className="text-white/60 text-[10px]">低电量风险</TableHead>
                <TableHead className="text-white/60 text-[10px]">受影响人员</TableHead>
                <TableHead className="text-white/60 text-[10px]">产量提升</TableHead>
                <TableHead className="text-white/60 text-[10px]">准时率</TableHead>
                <TableHead className="text-white/60 text-[10px]">理由</TableHead>
                <TableHead className="text-white/60 text-[10px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => {
                const isExpanded = expandedId === plan.id;
                const outputImp = getMetric(plan, 'outputImprovement');
                const onTimeRate = getMetric(plan, 'onTimeRate');
                const canConfirm = plan.status === 'proposed';
                const canDispatch = plan.status === 'confirmed';
                return (
                  <Fragment key={plan.id}>
                    <TableRow
                      ref={plan.planId === focusPlanId ? focusRowRef : undefined}
                      className="border-white/5 hover:bg-white/5"
                    >
                      <TableCell className="p-1">
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : plan.id)}
                          className="p-1 hover:bg-white/10 rounded"
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded ? UI_ARIA_LABELS.collapsePlan : UI_ARIA_LABELS.expandPlan
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3 text-white/60" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-white/60" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="text-[10px] text-white/90">
                        {plan.planName}
                      </TableCell>
                      <TableCell className="text-[10px] text-white/60">
                        {plan.strategy}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={cn('text-[9px] px-1.5', statusBadgeClass(plan.status))}
                        >
                          {plan.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[10px] text-white/80">
                        {formatPct(plan.taktImprovement)}
                      </TableCell>
                      <TableCell className="text-[10px] text-white/80">
                        {plan.highLoadPersons}
                      </TableCell>
                      <TableCell className="text-[10px] text-white/80">
                        {plan.lowBatteryRisk}
                      </TableCell>
                      <TableCell className="text-[10px] text-white/80">
                        {plan.affectedPersons}
                      </TableCell>
                      <TableCell className="text-[10px] text-white/80">
                        {formatPct(outputImp)}
                      </TableCell>
                      <TableCell className="text-[10px] text-white/80">
                        {formatPct(onTimeRate)}
                      </TableCell>
                      <TableCell
                        className="text-[10px] text-white/70 max-w-[200px] truncate"
                        title={plan.reason ?? ''}
                      >
                        {plan.reason ?? '—'}
                      </TableCell>
                      <TableCell className="p-1">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-2"
                            onClick={() => {
                              const ids = getAffectedEntityIds(plan);
                              if (ids.length > 0) {
                                onViewOnMap?.(ids);
                              } else {
                                toast.info('该方案未记录受影响实体，无法在地图上定位');
                              }
                            }}
                            title="在调度模式地图上高亮受影响人员"
                          >
                            <MapPin className="w-3 h-3" />
                            图中查看
                          </Button>
                          {canConfirm && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[10px] px-2"
                                onClick={() => {
                                  setConfirmTarget(plan);
                                  setConfirmReason('');
                                }}
                              >
                                <Check className="w-3 h-3" />
                                确认
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[10px] px-2 text-red-400 border-red-500/30"
                                onClick={() => {
                                  setRejectTarget(plan);
                                  setRejectReason('');
                                }}
                              >
                                <X className="w-3 h-3" />
                                驳回
                              </Button>
                            </>
                          )}
                          {canDispatch && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px] px-2 text-cyan-400 border-cyan-500/30"
                              onClick={() => dispatchMutation.mutate({ planId: plan.planId })}
                              disabled={dispatchMutation.isPending}
                            >
                              <Send className="w-3 h-3" />
                              下发
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="border-white/5">
                        <TableCell colSpan={12} className="bg-white/5 p-2">
                          <div className="text-[10px] text-white/60">
                            <div className="font-medium text-white/80 mb-1">
                              完整指标 (metricsJson)
                            </div>
                            <pre className="text-[9px] text-white/70 overflow-auto max-h-24">
                              {JSON.stringify(plan.metricsJson, null, 2)}
                            </pre>
                            {plan.confirmedBy && (
                              <div className="mt-1 text-white/60">
                                确认人: {plan.confirmedBy} | 确认时间:{' '}
                                {plan.confirmedAt
                                  ? dayjs(plan.confirmedAt).format('MM-DD HH:mm')
                                  : '—'}{' '}
                                | 确认理由: {plan.confirmReason ?? '—'}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Bottom: audit records */}
      <div className="shrink-0 border-t border-white/10 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <History className="w-3 h-3 text-white/60 shrink-0" />
          <span className="text-[10px] text-white/60 shrink-0">最近审计</span>
          <div className="flex-1 flex items-center gap-3 overflow-x-auto">
            {recentAudits.length > 0 ? (
              recentAudits.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-1 text-[10px] text-white/70 shrink-0"
                >
                  <span className="text-white/70">{a.action}</span>
                  <span>·</span>
                  <span>{a.planId}</span>
                  <span>·</span>
                  <span>{a.operator ?? '—'}</span>
                  <span>·</span>
                  <span>{timeAgo(a.createdAt)}</span>
                </div>
              ))
            ) : (
              <span className="text-[10px] text-white/60">暂无审计记录</span>
            )}
          </div>
        </div>
      </div>

      {/* Confirm dialog */}
      <Dialog
        open={!!confirmTarget}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">确认调度方案</DialogTitle>
            <DialogDescription className="text-white/70">
              {confirmTarget?.planName} · {confirmTarget?.strategy}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-white/60">确认理由（必填）</label>
            <Textarea
              value={confirmReason}
              onChange={(e) => setConfirmReason(e.target.value)}
              placeholder="请输入确认理由..."
              className="bg-white/5 border-white/10 text-white"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmTarget(null)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={confirmMutation.isPending || !confirmReason.trim()}
            >
              {confirmMutation.isPending ? '确认中...' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(open) => !open && setRejectTarget(null)}
      >
        <DialogContent className="bg-[hsl(220_14%_14%)] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">驳回调度方案</DialogTitle>
            <DialogDescription className="text-white/70">
              {rejectTarget?.planName} · {rejectTarget?.strategy}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-white/60">驳回理由（必填）</label>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="请输入驳回理由..."
              className="bg-white/5 border-white/10 text-white"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRejectTarget(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleReject}
              disabled={rejectMutation.isPending || !rejectReason.trim()}
            >
              {rejectMutation.isPending ? '驳回中...' : '驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
