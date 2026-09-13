import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dispatchPlanV2, getPlan, type DispatchWaveSummary } from '../../api/scheduler';
import { getAuthUser, getCurrentOperator } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import type { SchedulingPlanV2 } from '@shared/api.interface';
import { errorDescription, parseError } from '../../lib/errorContract';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  buildWaveConfirmCopy,
  describeWaveResult,
  pendingCandidates,
  selectionKey,
  toWaveCandidates,
  type WaveCandidate,
} from './waveDispatchLogic';

/**
 * 分波次派工面板（部分执行）。
 *
 * 为什么需要它：后端与契约自 2026-09-10 起支持 `assignmentIds` 波次派工，但
 * 在此之前**只有 API/脚本可用**——真实班组长无法在界面上"先派一部分"。
 * 目标 §三明确要求"审批、拒绝、**部分执行**和回滚"，因此这里补齐用户操作面。
 *
 * 三条交互约束（依据破坏半径与不可逆性的通行做法）：
 *  1. **批量必须声明条数**：确认文案写死"本波 N 条 / 派发后剩余 M 条"，
 *     不让用户派超出预期；
 *  2. **命名确切后果**：写清是否使方案进入终态（终态后不能再加波），以及
 *     派工会占用资源、**取消派工走方案级「取消/回滚」（DR-5，/plans/:planId/cancel）：未开始 assignment 回退、预占释放、任务回待派发池**；
 *  3. **安全默认**：默认不预选任何任务，主按钮使用真实动词（"派发 N 条"），
 *     不出现"确定/OK"；不可派工的项标为已提交并禁止勾选，而不是隐藏。
 *
 * 权限：派工是写路径，仅 global_admin / dispatcher / workshop_lead 可执行
 * （与服务端路由角色一致）。非授权角色只看到说明，不渲染按钮。
 */

const DISPATCH_ROLES = ['global_admin', 'dispatcher', 'workshop_lead'];

function canDispatch(roles: string[] | null | undefined): boolean {
  if (!roles?.length) return false;
  return DISPATCH_ROLES.some((role) => roles.includes(role));
}

function timeLabel(value: string | null): string {
  if (!value) return '未记录时间';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function candidateLabel(c: WaveCandidate): string {
  const who = c.personId ?? '未指定人员';
  const device = c.deviceId ? ` · 设备 ${c.deviceId}` : '';
  const station = c.stationId ? ` · 工位 ${c.stationId}` : '';
  return `${c.taskId} · ${who}${device}${station}`;
}

export function WaveDispatchPanel({ planId }: { planId: string }): React.ReactElement | null {
  const client = useQueryClient();
  const roles = getAuthUser()?.roles;
  const allowed = canDispatch(roles);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<DispatchWaveSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const planQuery = useQuery({
    // 必须走租户分片的 schedulerPlan 键（与对象工作台 / SSE 事件流共享同一份
    // 缓存）。旧的裸键 ['plan-wave', planId] 既没有 org 分片（CLI-715：跨租户
    // 切换账号可能命中上一租户缓存），也让同一份方案数据出现两个缓存副本——
    // SSE 刷新详情、面板里仍是旧待派工集合，选中的项可能已被他人派发。
    queryKey: queryKeys.schedulerPlan(planId),
    queryFn: () => getPlan(planId),
    enabled: allowed,
    staleTime: 10_000,
  });

  const candidates = useMemo(
    () => toWaveCandidates(planQuery.data?.assignments),
    [planQuery.data],
  );
  const pending = useMemo(() => pendingCandidates(candidates), [candidates]);
  const pendingIds = useMemo(() => new Set(pending.map((c) => c.assignmentId)), [pending]);
  const confirmCopy = useMemo(
    () => buildWaveConfirmCopy(candidates, selected),
    [candidates, selected],
  );

  const mutation = useMutation({
    mutationFn: (ids: string[]) => dispatchPlanV2(planId, getCurrentOperator(), { assignmentIds: ids }),
    onSuccess: (plan) => {
      setResult(plan.dispatch ?? null);
      setNotice(null);
      setConfirmOpen(false);
      setSelected([]);
      // 派工改变方案事实（部分波：仍 approved；派完：终态 dispatched），三处缓存
      // 必须一起前进：详情键失效重取、活跃列表就地替换。只刷本面板会让列表卡片
      // 仍显示"已审批/下发执行"，再次点击只会得到 409 PLAN_NOT_APPROVED。
      void client.invalidateQueries({ queryKey: queryKeys.schedulerPlan(planId) });
      client.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) =>
        (prev ?? []).map((p) => (p.planId === planId ? plan : p)),
      );
    },
    onError: (error) => {
      setConfirmOpen(false);
      // 服务端可能因"波内含已派工项/资源冲突/快照过期"整体拒绝——不做部分应用，
      // 因此这里必须让用户刷新后重新选择，并如实说明**服务端的业务原因**。
      // 注意：不能用 errorDescription（axios 只给出 "Request failed with status
      // code 409"），必须用 parseError 解出 API 错误信封里的 message，
      // 否则用户看不到 DISPATCH_WAVE_INVALID 指出的具体问题项。
      const parsed = parseError(error);
      setNotice(`本波被整体拒绝（未产生任何派发）：${parsed.message}`);
      void client.invalidateQueries({ queryKey: queryKeys.schedulerPlan(planId) });
    },
  });

  if (!allowed) return null;
  if (planQuery.isLoading) {
    return <p className="mt-2 text-xs text-muted-foreground" role="status">正在读取本方案的待派工任务…</p>;
  }
  if (planQuery.isError) {
    return (
      <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert">
        待派工任务读取失败：{errorDescription(planQuery.error)}。无法确认可派工范围，暂不提供派工入口。
      </p>
    );
  }
  if (pending.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid={`wave-no-pending-${planId}`}>
        本方案没有待派工任务（可能已全部派发）。
      </p>
    );
  }

  const allSelected = selected.length === pending.length;

  return (
    <section className="mt-3 rounded border border-border p-3" aria-labelledby={`wave-title-${planId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`wave-title-${planId}`} className="text-xs font-medium">分波派工（部分执行）</h4>
        <Badge variant="secondary" className="text-[10px]">
          待派工 {pending.length} 条
        </Badge>
        {selected.length > 0 && (
          <Badge className="text-[10px]" data-testid={`wave-selected-count-${planId}`}>
            已选 {selected.length} 条
          </Badge>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={() => setSelected(allSelected ? [] : pending.map((c) => c.assignmentId))}
          >
            {allSelected ? '清空选择' : '全选待派工'}
          </Button>
        </div>
      </div>

      <ul className="mt-2 space-y-1">
        {candidates.map((c) => {
          const checked = selected.includes(c.assignmentId);
          return (
            <li key={c.assignmentId} className="flex items-start gap-2 text-xs">
              <Checkbox
                id={`wave-${planId}-${c.assignmentId}`}
                className="mt-0.5"
                checked={checked}
                disabled={!pendingIds.has(c.assignmentId)}
                onCheckedChange={(next) => {
                  setSelected((prev) => next
                    ? [...prev, c.assignmentId]
                    : prev.filter((id) => id !== c.assignmentId));
                }}
                aria-label={`选择 ${c.taskId}`}
              />
              <label htmlFor={`wave-${planId}-${c.assignmentId}`} className="cursor-pointer">
                <span className="font-medium">{candidateLabel(c)}</span>
                <span className="ml-2 text-muted-foreground">
                  {timeLabel(c.plannedStartAt)} → {timeLabel(c.plannedEndAt)}
                </span>
                <span className="ml-2 text-muted-foreground">状态 {c.status}</span>
                {c.committed && <span className="ml-2 text-risk-degraded-foreground">已提交，不可再派</span>}
              </label>
            </li>
          );
        })}
      </ul>

      {notice && (
        <p className="mt-2 rounded border border-risk-degraded-border bg-risk-degraded-soft p-2 text-xs text-risk-degraded-foreground" role="alert" data-testid={`wave-notice-${planId}`}>
          {notice}
        </p>
      )}
      {result && (
        <p className="mt-2 rounded border border-border bg-muted p-2 text-xs" role="status" data-testid={`wave-result-${planId}`}>
          {describeWaveResult(result)}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!confirmCopy || mutation.isPending}
          onClick={() => setConfirmOpen(true)}
          data-testid={`wave-dispatch-${planId}`}
        >
          {confirmCopy ? `派发选中的 ${confirmCopy.count} 条` : '请选择要派发的任务'}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          波内全有或全无：任一任务不可派发时整波拒绝，不会只派一部分。
        </span>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid={`wave-confirm-${planId}`}>
          <DialogHeader>
            <DialogTitle>{confirmCopy?.title ?? '确认派发'}</DialogTitle>
            <DialogDescription data-testid={`wave-consequence-${planId}`}>
              {confirmCopy?.consequence ?? ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button
              disabled={mutation.isPending || !confirmCopy}
              onClick={() => mutation.mutate(selected)}
              data-testid={`wave-confirm-submit-${planId}`}
            >
              {mutation.isPending ? '派发中…' : (confirmCopy?.confirmLabel ?? '派发')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default WaveDispatchPanel;

/** 选择集的稳定键（供外层在切换方案时重置选择）。 */
export { selectionKey };
