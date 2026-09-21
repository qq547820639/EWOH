import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getMyFieldWork } from '../../api/scheduler';
import { listExoSessions } from '../../api/exo';
import { queryKeys } from '../../hooks/queryKeys';
import { getAuthUser } from '../../lib/auth';
import { parseError } from '../../lib/errorContract';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { EXECUTION_STATUS_LABELS } from '../CommandMap/vm/executionFeedbackVM';
import { formatFreshness, isFactoryDataCurrent, FACTORY_DATA_STALE_AFTER_MS } from '../FactoryOperations/factoryOperationsLogic';
import { ExecutionReceiptRow } from '../FactoryOperations/ExecutionFeedback';
import {
  buildFieldReminders,
  summarizeFieldWork,
  type FieldExecution,
  type FieldExoSession,
  type FieldReminder,
  type FieldReminderSeverity,
} from './fieldOperationsLogic';

/**
 * 现场交互层工作台（外骨骼 + 移动端视角）。
 *
 * 存在的理由：`/api/exo/sessions`、`/api/exo/configs` 与调度执行回执后端都已
 * 具备，但产品层没有现场视角——现场人员看不到"我这班要做什么、我的外骨骼
 * 绑定是否还在、数据还作不作数"。本页把平台权威事实投影为现场可执行的提醒，
 * 并复用已验证的统一回执路径上报结果。
 *
 * 三条硬约束：
 *  1. 提醒只由平台事实派生（派工 + 执行 + 外骨骼会话），没有事实就没有提醒；
 *  2. 数据过期时**停止**产出待办类提醒，只显示可信度告警，绝不拿旧数据当现值；
 *  3. 本页不下发任何设备控制（关节/力矩/助力/限速）。外骨骼安全控制留在
 *     控制器本地，平台侧只做只读状态与绑定管理。
 */

const SEVERITY_STYLES: Record<FieldReminderSeverity, { box: string; label: string; icon: string }> = {
  overdue: {
    box: 'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground',
    label: '已逾期',
    icon: '!',
  },
  attention: {
    box: 'border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground',
    label: '需注意',
    icon: '△',
  },
  info: {
    box: 'border-border bg-muted text-foreground',
    label: '信息',
    icon: 'i',
  },
};

function ReminderCard({ reminder }: { reminder: FieldReminder }): React.ReactElement {
  const style = SEVERITY_STYLES[reminder.severity];
  return (
    <article className={`rounded-lg border p-4 ${style.box}`} data-testid={`field-reminder-${reminder.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="text-sm font-semibold">{style.icon}</span>
        <h3 className="text-sm font-medium">{reminder.title}</h3>
        <span className="ml-auto text-xs uppercase tracking-wide">{style.label}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed">{reminder.detail}</p>
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] opacity-80">
        <div className="flex gap-1"><dt>来源</dt><dd data-testid="reminder-origin">{reminder.source.origin}</dd></div>
        <div className="flex gap-1">
          <dt>依据时间</dt>
          <dd>{reminder.source.asOf ? new Date(reminder.source.asOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未提供'}</dd>
        </div>
        <div className="flex gap-1"><dt>可信度</dt><dd>{reminder.source.fresh ? '数据新鲜' : '数据已过期'}</dd></div>
      </dl>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {reminder.assignmentId && (
          <Link className="text-primary hover:underline" to={`/o/scheduling_plan/${encodeURIComponent(reminder.planId ?? '')}`}>
            查看方案 {reminder.planId}
          </Link>
        )}
        {reminder.sessionId && (
          <span className="text-muted-foreground">会话 {reminder.sessionId}</span>
        )}
      </div>
    </article>
  );
}

export default function FieldOperations(): React.ReactElement {
  const user = getAuthUser();
  const [now, setNow] = useState(() => Date.now());
  const [showReceipt, setShowReceipt] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * 现场身份：把登录账号映射到业务人员 ID。
   *
   * 平台的人-账号绑定由 personnel 域维护；此处只在账号显式携带 personId 时
   * 采信，拿不到就不猜——猜测会把别人的待办显示给当前用户，比不显示更危险。
   */
  const personId = useMemo(() => {
    const candidate = user?.personId;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  }, [user]);

  /**
   * 现场工作投影：走按人收敛的 `field/my-work`。
   *
   * 为什么不用 `listExecutions({personId})`：SchedulerController 整体限定为
   * 调度/班组长角色，`worker` 拿不到 `GET /executions`（403），现场作业台对真正
   * 的现场人员会直接不可用。`field/my-work` 的范围由服务端从签名令牌推导，
   * 工人只能看到分配给自己的记录。
   */
  const executionsQuery = useQuery({
    queryKey: queryKeys.schedulerExecutions('field-my-work'),
    queryFn: getMyFieldWork,
    staleTime: 15_000,
    refetchInterval: 30_000,
    // 未绑定人员时不发请求：服务端会 403，前端先如实告知更清楚。
    enabled: Boolean(personId),
  });
  const exoQuery = useQuery({
    queryKey: [...queryKeys.schedulerExecutions('exo-sessions-field')],
    queryFn: () => listExoSessions({ status: 'active' }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // 服务端返回的 personId 是权威绑定；客户端本地值只用于决定是否发起请求。
  const serverPersonId = executionsQuery.data?.personId ?? null;
  const effectivePersonId = serverPersonId ?? personId;
  const executions = (executionsQuery.data?.executions ?? []) as unknown as FieldExecution[];
  const exoSessions = (exoQuery.data ?? []) as unknown as FieldExoSession[];
  const dataUpdatedAt = executionsQuery.dataUpdatedAt;
  // 未绑定人员时不发请求——没有数据不等于数据过期，单独区分（下方按 personId 分支呈现）。
  const dataAvailable = Boolean(personId && !executionsQuery.isLoading && !executionsQuery.isError);
  const dataFresh = Boolean(personId && dataAvailable && isFactoryDataCurrent(dataUpdatedAt, Math.max(now, Date.now())));

  const reminders = useMemo(() => buildFieldReminders({
    personId: effectivePersonId,
    executions,
    exoSessions,
    now,
    dataFresh,
    dataAvailable,
    dataUpdatedAt,
    staleAfterMs: FACTORY_DATA_STALE_AFTER_MS,
    // 会话请求失败 → 绑定状态未知，逻辑层不得据此断言"未绑定"。
    exoDataAvailable: !exoQuery.isError && exoQuery.isSuccess,
  }), [effectivePersonId, executions, exoSessions, now, dataFresh, dataUpdatedAt, exoQuery.isError, exoQuery.isSuccess]);

  // 传入页面时钟，保证与"新鲜度/提醒"使用同一时刻判定（避免同一屏两套时间）。
  const summary = useMemo(
    () => summarizeFieldWork(executions, effectivePersonId, now),
    [executions, effectivePersonId, now],
  );
  const overdue = reminders.filter((r) => r.severity === 'overdue').length;
  const attention = reminders.filter((r) => r.severity === 'attention').length;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">现场作业台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          面向现场人员与外骨骼使用者的视图：本班任务、待回执事项、外骨骼绑定状态。
          提醒来自平台派工与执行记录，数据过期时不会给出待办结论。
        </p>
      </header>

      {/* 身份与数据可信度：先说清"我是谁、数据多新"，再谈做什么。 */}
      <Card>
        <CardHeader><CardTitle className="text-sm">现场身份与数据可信度</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {personId ? (
            <p className="text-sm">
              已识别业务人员：
              <span className="font-medium">{executionsQuery.data?.personName ?? '未知'}（{personId}）</span>
              {!executionsQuery.data?.personName && (
                <span className="ml-2 text-xs text-muted-foreground">人员域暂无该编号的姓名记录</span>
              )}
            </p>
          ) : (
            <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground" role="alert">
              当前账号未绑定业务人员（personId）。为避免把他人任务显示给你，本页<strong>不会</strong>推断你的任务列表。
              请由班组长在人员管理中完成账号绑定。
            </p>
          )}
          {executionsQuery.isError && (
            <p className="rounded border border-risk-blocked-border bg-risk-blocked-soft p-3 text-sm text-risk-blocked-foreground" role="alert">
              执行记录获取失败：{parseError(executionsQuery.error).message}。当前无法给出可靠的现场提醒。
            </p>
          )}
          {exoQuery.isError && (
            <p className="rounded border border-risk-degraded-border bg-risk-degraded-soft p-3 text-sm text-risk-degraded-foreground" role="alert">
              外骨骼会话获取失败：{parseError(exoQuery.error).message}。绑定状态未知，不代表未绑定。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span data-testid="field-freshness">{formatFreshness(dataUpdatedAt, Math.max(now, Date.now()))}</span>
            <span>执行记录 {executions.length} 条</span>
            <span>活跃外骨骼会话 {exoSessions.length} 个</span>
            <Button size="sm" variant="outline" onClick={() => { void executionsQuery.refetch(); void exoQuery.refetch(); }}>
              刷新现场数据
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 本班概览（仅在身份可用时呈现，避免 0 值被读成"我没有任务"） */}
      {personId && (
      <section aria-labelledby="field-summary-title">
        <h2 id="field-summary-title" className="text-sm font-semibold">本班任务概况</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-4">
          {[
            { label: '待开工', value: summary.open },
            { label: '进行中', value: summary.started },
            { label: '已逾期', value: summary.overdue, emphasise: summary.overdue > 0 },
            { label: '已完成', value: summary.done },
          ].map((item) => (
            <div key={item.label} className={`rounded-lg border p-3 ${item.emphasise ? 'border-risk-blocked-border bg-risk-blocked-soft' : 'border-border'}`}>
              <div className="text-xs text-muted-foreground">{item.label}</div>
              <div className="text-lg font-semibold" data-testid={`field-summary-${item.label}`}>{item.value}</div>
            </div>
          ))}
        </div>
      </section>
      )}

      {/* 现场提醒 */}
      <section aria-labelledby="field-reminders-title">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 id="field-reminders-title" className="text-sm font-semibold">现场提醒</h2>
          <span className="text-xs text-muted-foreground">
            {reminders.length} 条（逾期 {overdue} · 需注意 {attention}）
          </span>
        </div>
        {personId && executionsQuery.isLoading && <p className="mt-3 text-sm" role="status">加载现场数据…</p>}
        {personId && !executionsQuery.isLoading && reminders.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">当前没有需要现场处理的提醒。</p>
        )}
        {!personId && (
          <p className="mt-3 text-sm text-muted-foreground">
            账号未绑定业务人员，本页不推断你的任务，因此不显示提醒。
          </p>
        )}
        <div className="mt-3 space-y-3">
          {reminders.map((reminder) => (
            <ReminderCard key={`${reminder.kind}-${reminder.assignmentId ?? reminder.sessionId ?? 'x'}`} reminder={reminder} />
          ))}
        </div>
      </section>

      {/* 执行回执：复用已验证的统一回执路径（执行表 + 反馈 + 来源/训练资格） */}
      <section aria-labelledby="field-receipt-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="field-receipt-title" className="text-sm font-semibold">现场回执</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              报告开工、完工或失败。回执会同时写入执行记录与反馈，并如实标注来源与训练资格。
            </p>
          </div>
          <Button size="sm" variant={showReceipt ? 'outline' : 'default'} onClick={() => setShowReceipt((v) => !v)}>
            {showReceipt ? '收起回执面板' : '打开回执面板'}
          </Button>
        </div>
        {showReceipt && (
          <div className="mt-3 space-y-4">
            {/*
              刻意**不**内嵌 FactoryOperations 的 ExecutionFeedback：它读的是
              全厂 `GET /api/scheduler/executions`，现场人员（worker）没有该读权限，
              内嵌等于给目标用户一个必然 403 的面板。这里改用本页已取得的
              field/my-work 记录渲染回执行；提交仍走统一回执端点（服务端按
              assignment.personId === ctx.personId 校验归属）。
            */}
            {executions.length === 0 && (
              <p className="text-sm text-muted-foreground">当前没有可回执的执行记录。</p>
            )}
            {executions.map((execution) => (
              <ExecutionReceiptRow
                key={execution.executionId}
                execution={execution as unknown as Parameters<typeof ExecutionReceiptRow>[0]['execution']}
                current={dataFresh}
              />
            ))}
          </div>
        )}
      </section>

      {/* 边界声明：现场人员必须清楚本页不控制设备 */}
      <footer className="rounded-lg border border-border bg-muted p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">执行边界</p>
        <p className="mt-1">
          本页只呈现只读状态与提醒，<strong>不下发</strong>任何关节、力矩、助力或限速指令。
          外骨骼的急停、限扭、关节实时控制与失联安全态始终在设备控制器本地执行，平台不代理也不覆盖。
          显示"未绑定/无会话"仅表示平台没有查到事实，不代表设备故障或离线。
        </p>
      </footer>
    </div>
  );
}
