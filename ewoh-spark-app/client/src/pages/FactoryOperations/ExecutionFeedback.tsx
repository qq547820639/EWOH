import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { listExecutions, updateExecution } from '../../api/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import { getAuthUser } from '../../lib/auth';
import { parseError } from '../../lib/errorContract';
import { Button } from '../../components/ui/button';
import { EXECUTION_STATUS_LABELS } from '../CommandMap/vm/executionFeedbackVM';
import { formatFreshness, isFactoryDataCurrent } from './factoryOperationsLogic';
import { buildExecutionReceiptRequest, receiptActions, receiptSourceLabel, submitExecutionReceipt, RECEIPT_ROLES, type ReceiptAction, type ReceiptExecution, type ReceiptRequest, type ReceiptSource } from './executionReceiptLogic';

function time(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '未记录';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function ExecutionReceiptRow({ execution, current }: { execution: ReceiptExecution; current: boolean }): React.ReactElement {
  const client = useQueryClient();
  const [source, setSource] = useState<ReceiptSource>('simulated');
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<ReceiptRequest | null>(null);
  const [saved, setSaved] = useState<ReceiptExecution | null>(null);
  const roles = getAuthUser()?.roles ?? [];
  const writable = roles.some((role) => RECEIPT_ROLES.includes(role));
  const displayed = saved ?? execution;
  const actions = receiptActions(displayed);
  const mutation = useMutation({
    mutationFn: (request: ReceiptRequest) => submitExecutionReceipt(displayed, request, getAuthUser()?.roles ?? [], current, updateExecution),
    retry: false,
    onSuccess: (result) => {
      setSaved(result);
      // 必须用公共前缀失效所有执行记录消费视图：React Query 是前缀匹配，更长的键
      // 匹配不到更短的查询键。用 schedulerExecutions(planId) 失效既命中不了无过滤的
      // 短键查询（本页默认视图 / 班次工作台），也命中不了现场作业台的
      // 'field-my-work'——回执提交后那些视图会继续显示旧执行状态。
      void client.invalidateQueries({ queryKey: queryKeys.schedulerExecutionsPrefix });
    },
  });
  const submit = (status: ReceiptAction) => {
    const request = buildExecutionReceiptRequest(status, source, new Date().toISOString(), reason);
    setLast(request); mutation.mutate(request);
  };
  const error = mutation.error ? parseError(mutation.error) : null;
  return <article className="rounded-lg border border-border p-4" data-testid={`execution-receipt-${execution.assignmentId}`}>
    <div className="flex flex-wrap justify-between gap-3"><div><h3 className="text-sm font-medium">任务 {displayed.taskTitle ?? '未知任务'}<span className="ml-1 text-xs font-normal text-muted-foreground">{displayed.taskId}</span></h3><p className="text-xs text-muted-foreground">人员 {displayed.personName ?? (displayed.personId ? '未知' : '未关联')}<span className="ml-1">{displayed.personId ?? ''}</span> · 分配 {displayed.assignmentId}</p><Link className="text-xs text-primary hover:underline" to={`/o/scheduling_plan/${encodeURIComponent(displayed.planId)}`}>查看方案 {displayed.planId}</Link></div><span className="text-sm">{EXECUTION_STATUS_LABELS[displayed.status] ?? displayed.status}</span></div>
    <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4"><div><dt>计划开始</dt><dd>{time(displayed.plannedStartAt)}</dd></div><div><dt>已记录开始</dt><dd>{time(displayed.actualStartAt)}</dd></div><div><dt>已记录结束</dt><dd>{time(displayed.actualEndAt)}</dd></div><div><dt>回执来源</dt><dd>{receiptSourceLabel(saved?.receipt?.source ?? displayed.receipt?.source ?? displayed.source)}</dd></div></dl>
    {saved && <div className="mt-3 rounded border border-border bg-muted p-3 text-xs" role="status"><p>服务端回执：{EXECUTION_STATUS_LABELS[saved.status]}，本次为{last?.reportedSource === 'manual_report' ? '人工报告' : '模拟回执'}，时间取自点击时刻。</p>{saved.receipt ? <><p>匹配反馈 {saved.receipt.matchedRows} 条 · 推进分配 {saved.receipt.advancedAssignments} 条 · 推进任务步骤 {saved.receipt.advancedTaskSteps} 条。</p><p>{saved.receipt.productionTrainingEligible ? '服务端标记可训练，仍需管理员核验现场证据。' : '服务端未将此回执认定为生产训练样本。'}</p>{saved.receipt.skips.length > 0 && <p className="text-risk-degraded-foreground">部分同步未推进：{saved.receipt.skips.join('；')}</p>}</> : <p>服务端未返回反馈匹配与推进结果，尚不能确认完整同步。</p>}</div>}
    {error && <div className="mt-3 rounded border border-risk-blocked-border bg-risk-blocked-soft p-3 text-sm" role="alert"><p>回执提交未确认：{error.message}</p><p>{error.recommendedAction}</p>{error.retryable && last && <Button size="sm" variant="outline" onClick={() => mutation.mutate(last)}>重试原回执</Button>}</div>}
    {!writable ? <p className="mt-3 text-xs text-muted-foreground">当前角色没有提交执行回执的权限。</p> : actions.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">终态执行记录仅供查看，不可再次修改。</p> : <div className="mt-3 space-y-3 border-t pt-3"><fieldset disabled={!current || mutation.isPending} className="flex flex-wrap gap-3 text-sm"><legend className="text-xs">本次报告来源</legend><label htmlFor={`receipt-source-simulated-${execution.assignmentId}`}><input id={`receipt-source-simulated-${execution.assignmentId}`} name={`receipt-source-${execution.assignmentId}`} type="radio" checked={source === 'simulated'} onChange={() => setSource('simulated')} /> 模拟回执</label><label htmlFor={`receipt-source-manual-${execution.assignmentId}`}><input id={`receipt-source-manual-${execution.assignmentId}`} name={`receipt-source-${execution.assignmentId}`} type="radio" checked={source === 'manual_report'} onChange={() => setSource('manual_report')} /> 人工报告（非设备实测）</label></fieldset><p className="text-xs text-muted-foreground">点击按钮记录当前时间；完成不会补造开始时间，不会发出设备控制命令。</p><div className="flex gap-2">{actions.includes('STARTED') && <Button size="sm" disabled={!current || mutation.isPending} onClick={() => submit('STARTED')}>报告开始</Button>}{actions.includes('COMPLETED') && <Button size="sm" disabled={!current || mutation.isPending} onClick={() => submit('COMPLETED')}>报告完成</Button>}</div><label htmlFor={`receipt-failure-reason-${execution.assignmentId}`} className="block text-xs">失败说明（报告失败时必填）<input id={`receipt-failure-reason-${execution.assignmentId}`} value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2 text-sm" placeholder="填写失败原因" /></label><Button size="sm" variant="outline" disabled={!current || mutation.isPending || !reason.trim()} onClick={() => submit('FAILED')}>报告失败</Button></div>}
  </article>;
}

export function ExecutionFeedback(): React.ReactElement {
  const [params, setParams] = useSearchParams(); const planId = params.get('plan')?.trim() || undefined; const [input, setInput] = useState(planId ?? ''); const [now, setNow] = useState(Date.now); const allowed = (getAuthUser()?.roles ?? []).some((role) => RECEIPT_ROLES.includes(role));
  useEffect(() => { setInput(planId ?? ''); }, [planId]); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const query = useQuery({ queryKey: queryKeys.schedulerExecutions(planId), queryFn: () => listExecutions(planId ? { planId } : {}), enabled: allowed, staleTime: 15_000, refetchInterval: 30_000 }); const rows = (query.data?.executions ?? []) as ReceiptExecution[]; const current = !query.isError && isFactoryDataCurrent(query.dataUpdatedAt, Math.max(now, Date.now()));
  return <section className="rounded-xl border border-border bg-card p-5 shadow-sm" aria-labelledby="execution-feedback-title"><div className="flex flex-wrap justify-between gap-3"><div><h2 id="execution-feedback-title" className="font-semibold">执行回执与结果</h2><p className="mt-1 text-xs text-muted-foreground">明确报告开始、完成或失败，查看服务端回执与同步结果。模拟与人工报告不自动视为现场证据。</p></div>{allowed && <Button data-testid="execution-refresh" size="sm" variant="outline" onClick={() => void query.refetch()}>刷新执行记录</Button>}</div>{!allowed ? <p className="mt-4 text-sm text-muted-foreground">当前角色无权查看或提交调度执行回执。</p> : <><form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); const next = new URLSearchParams(params); if (input.trim()) next.set('plan', input.trim()); else next.delete('plan'); setParams(next); }}><label htmlFor="execution-plan-filter" className="text-xs">方案编号<input id="execution-plan-filter" value={input} onChange={(event) => setInput(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2 text-sm sm:w-auto" placeholder="全部方案或输入编号" /></label><Button size="sm" variant="outline">查看方案回执</Button></form><p className="mt-3 text-xs text-muted-foreground">{formatFreshness(query.dataUpdatedAt, Math.max(now, Date.now()))} · 已取得 {rows.length} / {query.data?.total ?? '未知'} 条</p>{query.isError && <p className="mt-3 text-sm text-risk-blocked-foreground" role="alert">执行记录获取失败，暂停提交回执：{parseError(query.error).message}</p>}{query.isLoading && <p role="status">执行记录加载中…</p>}{!query.isLoading && !query.isError && rows.length === 0 && <p className="mt-4 text-sm text-muted-foreground">当前没有可回执记录，请核对方案是否已派工。</p>}<div className="mt-4 space-y-4">{rows.slice(0, 8).map((row) => <ExecutionReceiptRow key={row.executionId} execution={row} current={current} />)}</div></>}</section>;
}
