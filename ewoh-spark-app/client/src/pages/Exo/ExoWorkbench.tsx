import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Accessibility, RefreshCw, PlayCircle, StopCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import ErrorState from '@client/src/components/ErrorState';
import { errorDescription } from '@client/src/lib/errorContract';
import { queryKeys } from '@client/src/hooks/queryKeys';
import {
  abortExoSession,
  correctExoSessionWearer,
  endExoSession,
  getExoDeviceContext,
  getExoDeviationSummary,
  getExoTelemetryConsistency,
  listExoSessions,
  startExoSession,
  type ExoSessionRecord,
  type ExoTelemetryVerdict,
} from '@client/src/api/exo';
import { searchDevices } from '@client/src/api/dashboard';
import { listPersonnel } from '@client/src/api/organization';
import {
  abortReasonError,
  buildDeviationReviewRows,
  buildExoSessionRows,
  formatDuration,
  isExoVerdictActionable,
  planWearerCorrection,
  summarizeExoSessions,
} from './exoSessionLogic';

/**
 * 外骨骼作业台（NO-33a）。
 *
 * 补齐愿景里"人员通过平台、移动端和**外骨骼**参与执行"的产品面：后端会话 API
 * （ADR-032/033）与客户端封装早已存在，但一直没有页面消费——现场看不到自己外骨骼的
 * 会话状态，班组长也判断不了"谁还戴着没交回"。
 *
 * 边界（与 `client/src/api/exo.ts` 一致，绝不放宽）：
 *   · 只做**会话绑定**的开始/结束/中止，不下发任何关节、力矩、助力或限速指令；
 *   · 会话是显式、临时、可审计的：终态不可复开，新绑定 = 新会话；
 *   · 中止必须写理由（结束事实完整）。
 */
export default function ExoWorkbench() {
  const queryClient = useQueryClient();
  const [selectedExoId, setSelectedExoId] = useState('');
  const [selectedPersonId, setSelectedPersonId] = useState('');
  const [expectedEndAt, setExpectedEndAt] = useState('');
  const [abortTarget, setAbortTarget] = useState<ExoSessionRecord | null>(null);
  const [abortReason, setAbortReason] = useState('');
  // NO-43a：按实际佩戴人更正（人核实遥测冲突之后，把结论落成事实）。
  const [correctTarget, setCorrectTarget] = useState<ExoSessionRecord | null>(null);
  const [correctNote, setCorrectNote] = useState('');
  // NO-38a：偏差复盘（运行记忆）——按设备/人员聚合"预计 vs 实际"。
  const [deviationGroupBy, setDeviationGroupBy] = useState<'device' | 'person'>('device');
  // NO-40a：绑定任务（默认勾选——唯一在飞任务时继承计划结束时间，提升偏差可比性）
  const [bindTask, setBindTask] = useState(true);

  const sessionsQuery = useQuery({
    queryKey: ['exo', 'sessions'],
    queryFn: () => listExoSessions({}),
    refetchInterval: 30000,
  });
  const devicesQuery = useQuery({
    queryKey: ['exo', 'exo-devices'],
    queryFn: () => searchDevices({ category: 'exoskeleton' }),
  });
  const personnelQuery = useQuery({
    queryKey: ['exo', 'personnel'],
    queryFn: () => listPersonnel({}),
  });
  /**
   * NO-40a：选中设备后的上下文（在飞任务 / 当前会话 / 绑定建议）。
   * 仅在选了设备时查询；`enabled` 避免空请求。
   */
  const deviceContextQuery = useQuery({
    queryKey: ['exo', 'device-context', selectedExoId, selectedPersonId],
    queryFn: () => getExoDeviceContext({ exoId: selectedExoId.trim(), ...(selectedPersonId.trim() ? { personId: selectedPersonId.trim() } : {}) }),
    enabled: selectedExoId.trim().length > 0,
    refetchInterval: 30000,
  });
  const deviceContext = deviceContextQuery.data ?? null;
  const suggestedTaskId = deviceContext?.suggestion.taskId ?? null;
  // 人员列表（既有的选择器数据；NO-43a 的更正对话框复用同一份来解析姓名，不额外请求）。
  const personnelList = (personnelQuery.data ?? []) as Array<{ personId?: string; id?: string; name?: string }>;

  /**
   * NO-41a：佩戴事实双源一致性（会话声明 × 遥测）。只展示后端判定与理由，
   * 前端不重算、不把"无遥测"说成"没在戴"。
   */
  const consistencyQuery = useQuery({
    queryKey: ['exo', 'consistency'],
    queryFn: () => getExoTelemetryConsistency(),
    refetchInterval: 30000,
  });
  const consistencyBySession = useMemo(() => {
    const map = new Map<
      string,
      {
        verdict: ExoTelemetryVerdict;
        reason: string;
        needsHumanCheck: boolean;
        telemetryWorkerRef: string | null;
        evidenceAgeMs: number | null;
        evidenceTs: string | null;
        sessionPersonRef: string | null;
      }
    >();
    for (const item of consistencyQuery.data?.sessions ?? []) {
      map.set(item.sessionId, {
        verdict: item.verdict,
        reason: item.reason,
        needsHumanCheck: item.needsHumanCheck,
        telemetryWorkerRef: item.telemetryWorkerRef ?? item.evidence?.workerId ?? null,
        evidenceAgeMs: item.evidenceAgeMs ?? null,
        evidenceTs: item.evidence?.ts ?? null,
        sessionPersonRef: item.sessionPersonRef ?? null,
      });
    }
    return map;
  }, [consistencyQuery.data]);

  /**
   * NO-43a：人员 id → 姓名（用已加载的人员列表解析；解析不到就只显示 id）。
   * 绝不猜名字：不认识的 id 原样透出，避免"看起来像张三"的错误归因。
   */
  const personName = (ref: string | null | undefined): string => {
    const bare = String(ref ?? '').trim().replace(/^person:/, '');
    if (!bare) return '未记录';
    const hit = personnelList.find((p) => {
      const candidates = [p.personId, p.id].map((v) => String(v ?? '').replace(/^person:/, ''));
      return candidates.includes(bare);
    });
    const name = hit?.name ? String(hit.name) : '';
    return name ? `${name}（${bare}）` : bare;
  };

  // NO-38a：偏差复盘数据（30 天窗口；口径由服务端钉死，前端只展示）。
  const deviationQuery = useQuery({
    queryKey: ['exo', 'deviation-summary', deviationGroupBy],
    queryFn: () => getExoDeviationSummary({ days: 30, groupBy: deviationGroupBy }),
    refetchInterval: 60000,
  });

  const rows = useMemo(() => buildExoSessionRows(sessionsQuery.data ?? []), [sessionsQuery.data]);
  const summary = useMemo(() => summarizeExoSessions(rows), [rows]);
  const deviationRows = useMemo(
    () => buildDeviationReviewRows(deviationQuery.data?.groups ?? []),
    [deviationQuery.data],
  );
  const deviationTotalsRow = useMemo(
    () => (deviationQuery.data ? buildDeviationReviewRows([deviationQuery.data.totals])[0] ?? null : null),
    [deviationQuery.data],
  );
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['exo', 'sessions'] });

  const startMutation = useMutation({
    mutationFn: () =>
      startExoSession({
        exoId: selectedExoId.trim(),
        personId: selectedPersonId.trim(),
        ...(expectedEndAt ? { expectedEndAt: new Date(expectedEndAt).toISOString() } : {}),
        // NO-40a：绑定唯一在飞任务（勾选且确有建议时）；计划结束时间由服务端继承，
        // 现场手填的 expectedEndAt 优先（来源会写进会话记录）。
        ...(bindTask && suggestedTaskId ? { taskId: suggestedTaskId } : {}),
      }),
    onSuccess: () => {
      toast.success('会话已开始', {
        description:
          bindTask && suggestedTaskId
            ? '已绑定在飞任务：预计结束时间按任务计划继承（可在会话列表核对来源）。'
            : '绑定是临时且可审计的：终态不可复开，新绑定=新会话。',
      });
      setSelectedExoId('');
      setSelectedPersonId('');
      setExpectedEndAt('');
      invalidate();
    },
    onError: (err: unknown) => toast.error('开始会话失败', { description: errorDescription(err) }),
  });

  const endMutation = useMutation({
    mutationFn: (sessionId: string) => {
      // NO-42a：命中"需人核实"的会话在收工时把校验判定与依据写进结束理由。
      const conflict = consistencyBySession.get(sessionId);
      const reason = conflict?.needsHumanCheck
        ? `遥测校验（${conflict.verdict}）：${conflict.reason}`
        : undefined;
      return endExoSession(sessionId, reason ? { reason } : {});
    },
    onSuccess: (result: { resolvedNotificationCount?: number } | undefined) => {
      // NO-44a：处置顺带关闭的提醒必须说出来——否则班组长不知道"通知中心的待办去哪了"。
      const closed = result?.resolvedNotificationCount ?? 0;
      toast.success('会话已结束', {
        description: closed > 0 ? `已同步关闭 ${closed} 条相关提醒（处置痕迹可查）。` : undefined,
      });
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    onError: (err: unknown) => toast.error('结束会话失败', { description: errorDescription(err) }),
  });

  const abortMutation = useMutation({
    mutationFn: (params: { sessionId: string; reason: string }) =>
      abortExoSession(params.sessionId, { reason: params.reason }),
    onSuccess: (result: { resolvedNotificationCount?: number } | undefined) => {
      const closed = result?.resolvedNotificationCount ?? 0;
      toast.success('会话已中止', {
        description:
          '中止理由已写入会话事实，可供复盘。'
          + (closed > 0 ? ` 已同步关闭 ${closed} 条相关提醒。` : ''),
      });
      setAbortTarget(null);
      setAbortReason('');
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    onError: (err: unknown) => toast.error('中止会话失败', { description: errorDescription(err) }),
  });

  /**
   * NO-43a：按实际佩戴人更正。平台不自动做这件事——只有人点了确认（并留下核实说明）
   * 才会执行；响应带出"旧会话 + 新会话"两条事实，页面据此如实回执。
   */
  const correctMutation = useMutation({
    mutationFn: (params: { sessionId: string; personId: string; note: string }) =>
      correctExoSessionWearer(params.sessionId, {
        personId: params.personId,
        ...(params.note.trim() ? { reason: `现场核实：${params.note.trim()}` } : {}),
      }),
    onSuccess: (result) => {
      toast.success('已按实际佩戴人更正', {
        description:
          `旧会话已结束（${String(result.ended?.sessionId ?? '')}）`
          + `，为 ${String(result.toPersonId ?? '')} 新开进行中会话（${String(result.started?.sessionId ?? '')}）；`
          + '设备仍被占用，收工请按常规流程结束新会话。'
          + ((result.resolvedNotificationCount ?? 0) > 0
            ? ` 已同步关闭旧会话的 ${result.resolvedNotificationCount} 条提醒。`
            : ''),
      });
      setCorrectTarget(null);
      setCorrectNote('');
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['exo', 'consistency'] });
    },
    onError: (err: unknown) => toast.error('更正佩戴人失败', { description: errorDescription(err) }),
  });

  const exoDevices = devicesQuery.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Accessibility className="h-7 w-7 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">外骨骼作业台</h1>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="exo-summary">
              {/* FE-1：会话读失败时 summarizeExoSessions([]) 会给出"当前没有外骨骼会话记录"——
                  把"没读到"说成"没有会话"。页头是最显眼的位置，这里必须先说读失败。 */}
              {sessionsQuery.isError
                ? '会话读取失败：无法统计会话（不代表没有外骨骼会话）'
                : summary.label}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              平台只管理**会话绑定**（谁在用哪台、何时开始/结束），不下发关节、力矩、助力或限速指令——
              设备本地安全控制留在控制器。
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          data-testid="exo-refresh"
          disabled={sessionsQuery.isFetching}
          onClick={() => sessionsQuery.refetch()}
        >
          <RefreshCw className="mr-1 h-4 w-4" />
          {sessionsQuery.isFetching ? '刷新中…' : '刷新'}
        </Button>
      </header>

      {sessionsQuery.isError && (
        <div className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked-foreground" data-testid="exo-error">
          会话读取失败：{errorDescription(sessionsQuery.error)}
        </div>
      )}

      {/* ── 开始会话 ───────────────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-card p-4" data-testid="exo-start">
        <h2 className="mb-3 text-lg font-semibold text-foreground">开始会话（现场佩戴）</h2>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-muted-foreground">外骨骼设备</span>
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              data-testid="exo-device-select"
              value={selectedExoId}
              onChange={(event) => setSelectedExoId(event.target.value)}
            >
              <option value="">请选择设备</option>
              {exoDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.deviceId}
                  {device.workerName ? `（${device.workerName}）` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">佩戴人员</span>
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              data-testid="exo-person-select"
              value={selectedPersonId}
              onChange={(event) => setSelectedPersonId(event.target.value)}
            >
              <option value="">请选择人员</option>
              {personnelList.map((person) => {
                const id = String(person.personId ?? person.id ?? '');
                return (
                  <option key={id} value={id}>
                    {person.name ? `${person.name}（${id}）` : id}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">预计结束（可选）</span>
            <Input
              type="datetime-local"
              className="h-8 text-xs"
              data-testid="exo-expected-end"
              value={expectedEndAt}
              onChange={(event) => setExpectedEndAt(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            data-testid="exo-start-submit"
            disabled={
              startMutation.isPending || selectedExoId.trim() === '' || selectedPersonId.trim() === ''
            }
            title={
              selectedExoId.trim() === '' || selectedPersonId.trim() === ''
                ? '设备与人员都必须选择（绑定是显式事实，不猜）'
                : undefined
            }
            onClick={() => startMutation.mutate()}
          >
            <PlayCircle className="mr-1 h-4 w-4" />
            {startMutation.isPending ? '开始中…' : '开始会话'}
          </Button>
        </div>
        {/* FE-1：设备台账**读失败**必须优先渲染错误/权限态。
            设备查询走 /api/dashboard/devices（角色 = global_admin/dispatcher/safety_admin/device_ops），
            而本页对 worker 开放 → worker 打开页面必得 403。此时 devicesQuery.data 为 undefined，
            旧写法（只判 !isLoading）会把"你没权限"渲染成「台账里还没有外骨骼类别设备」——
            把"读不到"伪造成"不存在"。改用 ErrorState：403 渲染「权限不足」，500 渲染服务器错误，并带重试。 */}
        {devicesQuery.isError ? (
          <div className="mt-2" data-testid="exo-devices-error">
            <ErrorState
              error={devicesQuery.error}
              errorMessage="外骨骼设备台账读取失败（不代表台账里没有设备）。"
              onRetry={() => devicesQuery.refetch()}
            />
          </div>
        ) : (
          exoDevices.length === 0 && !devicesQuery.isLoading && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="exo-no-devices">
              台账里还没有外骨骼类别设备：请先在设备页登记（或用模拟器接入），平台不会凭空造设备。
            </p>
          )
        )}
        {/* FE-1：人员名单同理——读失败时下拉为空，但"空下拉"不等于"没有人"。
            这里显式说出退化后果（姓名解析退化为人员 ID），避免现场据此以为无人可派。 */}
        {personnelQuery.isError && (
          <p className="mt-2 text-xs text-risk-degraded-foreground" data-testid="exo-personnel-error">
            人员名单读取失败：{errorDescription(personnelQuery.error)}
            （下拉为空不代表没有人员；责任人姓名会退化为人员 ID）
          </p>
        )}

        {/* NO-40a：设备上下文——这台设备现在的在飞任务/会话，以及"可绑定什么"。
            绑定后预计结束时间会继承任务计划（提升偏差可比性）；多任务时后端不给建议，
            页面如实展示原因，不替现场选择。 */}
        {selectedExoId.trim() !== '' && (
          <div className="mt-3 rounded-md border border-border bg-background/40 p-3 text-xs" data-testid="exo-device-context">
            {deviceContextQuery.isError && (
              <p className="text-risk-degraded-foreground" data-testid="exo-device-context-error">
                设备上下文读取失败：{errorDescription(deviceContextQuery.error)}（不显示成"没有在飞任务"）
              </p>
            )}
            {deviceContextQuery.isLoading && <p className="text-muted-foreground">读取设备上下文…</p>}
            {deviceContext && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">设备上下文</span>
                  <span className="text-muted-foreground">
                    {deviceContext.registered ? '台账已登记' : '不在台账（无法被任务引用）'}
                  </span>
                  {deviceContext.activeSession && (
                    <span className="text-risk-degraded-foreground" data-testid="exo-device-context-active">
                      当前佩戴中：{deviceContext.activeSession.personId}（会话 {deviceContext.activeSession.sessionId}）
                    </span>
                  )}
                </div>
                <div className="mt-1 text-muted-foreground" data-testid="exo-device-context-tasks">
                  在飞任务 {deviceContext.inFlightTasks.length} 张
                  {deviceContext.inFlightTasks.map((task) => (
                    <span key={task.taskId} className="ml-2">
                      · {task.title ?? task.taskId}（{task.status}
                      {task.assigneeId ? ` · 受派人 ${task.assigneeId}` : ' · 未指派人员'}
                      {task.planEnd ? ` · 计划结束 ${new Date(task.planEnd).toLocaleString('zh-CN')}` : ' · 无计划结束'}）
                    </span>
                  ))}
                </div>
                <p
                  className={
                    deviceContext.suggestion.assigneeMatches
                      ? 'mt-1 text-muted-foreground'
                      : 'mt-1 text-risk-degraded-foreground'
                  }
                  data-testid="exo-device-context-suggestion"
                >
                  {deviceContext.suggestion.reason}
                </p>
                {suggestedTaskId && (
                  <label className="mt-2 flex items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      data-testid="exo-bind-task"
                      checked={bindTask}
                      onChange={(event) => setBindTask(event.target.checked)}
                    />
                    绑定在飞任务
                    {deviceContext.suggestion.expectedEndAt
                      ? `并继承计划结束时间 ${new Date(deviceContext.suggestion.expectedEndAt).toLocaleString('zh-CN')}`
                      : '（该任务无可用计划结束时间）'}
                    {expectedEndAt ? '｜已手填预计结束，手填值优先' : ''}
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* ── 会话列表 ───────────────────────────────────────────── */}
      <section data-testid="exo-sessions">
        <h2 className="mb-3 text-lg font-semibold text-foreground">会话（进行中优先）</h2>
        {rows.length === 0 ? (
          /* FE-1：会话读失败时上方已渲染错误横幅，这里**绝不**再渲染"没有会话记录"——
             否则同一屏既有"读取失败"又有"当前没有会话记录"，用户仍会读到"不存在"的结论。 */
          sessionsQuery.isError ? null : (
            <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground" data-testid="exo-empty">
              当前没有外骨骼会话记录：开始会话后会出现在这里（含历史与中止）。
            </div>
          )
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.sessionId}
                className="rounded-lg border border-border bg-card p-3"
                data-testid={`exo-session-${row.sessionId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      <span className="font-mono">{row.exoId ?? '设备未记录'}</span>
                      <span className="mx-1 text-muted-foreground">·</span>
                      <span>{row.personId ?? '人员未记录'}</span>
                      <span
                        className="ml-2 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground"
                        data-testid={`exo-status-${row.sessionId}`}
                      >
                        {row.statusLabel}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      开始 {row.startedAt ? new Date(row.startedAt).toLocaleString('zh-CN') : '未记录'}
                      {' · '}
                      {row.isActive ? `已进行 ${row.durationLabel}` : `持续 ${row.durationLabel}`}
                      {row.expectedEndAt
                        ? ` · 预计结束 ${new Date(row.expectedEndAt).toLocaleString('zh-CN')}`
                          + (row.expectedEndSource === 'task_plan_end' ? '（继承任务计划）' : '')
                        : ''}
                      {row.taskId ? ` · 任务 ${row.taskId}` : ''}
                      {row.actualEndAt ? ` · 实际结束 ${new Date(row.actualEndAt).toLocaleString('zh-CN')}` : ''}
                      {row.endedBy ? ` · 结束人 ${row.endedBy}` : ''}
                      {row.reason ? ` · 理由 ${row.reason}` : ''}
                      {/* NO-43a：更正链路必须双向可见——否则这里只是两条互不相关的会话，
                          事后无法回答"这次更正对应哪条新会话/这条是谁交接来的"。 */}
                      {row.correctedTo ? ` · 已交接给 ${row.correctedTo}` : ''}
                      {row.correctedFrom ? ` · 由 ${row.correctedFrom} 更正而来` : ''}
                    </div>
                    {/* NO-36b：预计 vs 实际（运行记忆）。进行中显示"剩余/已超时"，
                        终态显示偏差；没记录预计就明说不能比较，不冒充准时。 */}
                    {/* NO-41a：佩戴事实双源校验——会话是声明、遥测是证据；
                        不一致必须显式暴露（无遥测 = 无佐证，不是"没在戴"）。 */}
                    {row.isActive && consistencyBySession.get(row.sessionId) && (
                      <div
                        className={`mt-0.5 text-xs ${
                          consistencyBySession.get(row.sessionId)?.needsHumanCheck
                            || isExoVerdictActionable(consistencyBySession.get(row.sessionId)?.verdict)
                            ? 'text-risk-degraded-foreground'
                            : 'text-muted-foreground'
                        }`}
                        data-testid={`exo-consistency-${row.sessionId}`}
                      >
                        遥测校验：
                        {{
                          consistent: '与遥测一致',
                          wearer_mismatch: '佩戴人与遥测不符（需核实）',
                          activity_only: '遥测显示有人在用，但未上报佩戴人',
                          inactive_suspect: '疑似未佩戴/已离岗（需核实）',
                          stale_telemetry: '遥测证据已过期',
                          no_telemetry: '无遥测佐证',
                        }[consistencyBySession.get(row.sessionId)?.verdict ?? 'no_telemetry']}
                        {consistencyBySession.get(row.sessionId)?.reason
                          ? `｜${consistencyBySession.get(row.sessionId)?.reason}`
                          : ''}
                      </div>
                    )}
                    <div
                      className={`mt-0.5 text-xs ${
                        row.overdue || row.deviationState === 'over'
                          ? 'text-risk-degraded-foreground'
                          : 'text-muted-foreground'
                      }`}
                      data-testid={`exo-deviation-${row.sessionId}`}
                    >
                      {row.isActive
                        ? row.overdue
                          ? `已超时 ${formatDuration(row.overdueMs)}，请核实是否需要收工`
                          : row.remainingMs !== null
                            ? `距预计结束还有 ${formatDuration(row.remainingMs)}`
                            : row.deviationLabel
                        : row.deviationLabel}
                    </div>
                    {row.attentionLabel && (
                      <div
                        className="mt-1 text-xs text-risk-degraded-foreground"
                        data-testid={`exo-attention-${row.sessionId}`}
                      >
                        <TriangleAlert className="mr-0.5 inline h-3 w-3" />
                        {row.attentionLabel}
                      </div>
                    )}
                  </div>
                  {row.isActive && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`exo-end-${row.sessionId}`}
                        disabled={endMutation.isPending}
                        onClick={() => endMutation.mutate(row.sessionId)}
                      >
                        <StopCircle className="mr-1 h-4 w-4" />
                        结束会话
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`exo-abort-${row.sessionId}`}
                        onClick={() => {
                          setAbortTarget({ sessionId: row.sessionId } as ExoSessionRecord);
                          setAbortReason('');
                        }}
                      >
                        中止
                      </Button>
                      {/* NO-42a：遥测校验要求人核实时，给一个**带证据理由**的收工动作——
                          结束事实里写清"为什么结束"（否则事后无法复盘这次收工的依据）。 */}
                      {consistencyBySession.get(row.sessionId)?.needsHumanCheck && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`exo-verify-end-${row.sessionId}`}
                          disabled={endMutation.isPending}
                          onClick={() => endMutation.mutate(row.sessionId)}
                          title="按遥测校验结论收工：结束理由会写入会话事实（含校验判定与依据）"
                        >
                          核实并收工
                        </Button>
                      )}
                      {/* NO-43a：遥测指明了"别人在戴"时，人核实之后可以按实际佩戴人更正——
                          交接语义（旧的收工 + 新的开始），而不是把字段偷偷改掉。 */}
                      {planWearerCorrection(consistencyBySession.get(row.sessionId), {
                        sessionId: row.sessionId,
                        personId: row.personId,
                        status: row.status,
                      }).targetPersonId && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`exo-correct-${row.sessionId}`}
                          disabled={correctMutation.isPending}
                          onClick={() => {
                            setCorrectTarget({ sessionId: row.sessionId } as ExoSessionRecord);
                            setCorrectNote('');
                          }}
                          title="按遥测指名的实际佩戴人交接：旧会话收工留痕，新会话按实际佩戴人重开"
                        >
                          按遥测佩戴人更正
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 中止理由（必须填写：结束事实完整）───────────────────── */}
      {abortTarget && (
        <section className="rounded-lg border border-risk-degraded-border bg-card p-4" data-testid="exo-abort-dialog">
          <h2 className="text-sm font-semibold text-foreground">中止会话（异常/提前终止）</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            中止是终态：该会话不可复开，新的佩戴需要新建会话。理由会写入会话事实供复盘。
          </p>
          <textarea
            className="mt-2 min-h-[56px] w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
            data-testid="exo-abort-reason"
            value={abortReason}
            onChange={(event) => setAbortReason(event.target.value)}
            placeholder="例如：作业完成但人员提前离岗，未走正常收工流程（班组长 2026-09-12）"
          />
          {abortReasonError(abortReason) && (
            <p className="mt-1 text-xs text-risk-degraded-foreground" data-testid="exo-abort-error">
              {abortReasonError(abortReason)}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              data-testid="exo-abort-submit"
              disabled={abortMutation.isPending || abortReasonError(abortReason) !== null}
              onClick={() =>
                abortMutation.mutate({
                  sessionId: String(abortTarget.sessionId ?? ''),
                  reason: abortReason.trim(),
                })
              }
            >
              确认中止
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAbortTarget(null);
                setAbortReason('');
              }}
            >
              取消
            </Button>
          </div>
        </section>
      )}

      {/* ── NO-43a：按实际佩戴人更正（交接语义，不是改字段）────────────
          决策原则要求建议必须带来源/时间/影响面/约束/风险——所以这里先把证据摆出来，
          再让人确认。平台永远不会自己触发这次更正。 */}
      {correctTarget && (() => {
        const plan = planWearerCorrection(consistencyBySession.get(String(correctTarget.sessionId ?? '')), {
          sessionId: String(correctTarget.sessionId ?? ''),
          personId: rows.find((r) => r.sessionId === correctTarget.sessionId)?.personId ?? null,
          status: rows.find((r) => r.sessionId === correctTarget.sessionId)?.status ?? null,
        });
        const sessionId = String(correctTarget.sessionId ?? '');
        return (
          <section className="rounded-lg border border-risk-degraded-border bg-card p-4" data-testid="exo-correct-dialog">
            <h2 className="text-sm font-semibold text-foreground">按实际佩戴人更正（佩戴人交接）</h2>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="exo-correct-evidence">
              证据：{plan.evidenceLabel}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="exo-correct-impact">
              影响面：{plan.impactLabel}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="exo-correct-risk">
              约束与风险：{plan.riskLabel}
            </p>
            <p className="mt-1 text-xs text-foreground" data-testid="exo-correct-target">
              更正对象：{personName(plan.targetPersonId)}
            </p>
            <textarea
              className="mt-2 min-h-[56px] w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
              data-testid="exo-correct-note"
              value={correctNote}
              onChange={(event) => setCorrectNote(event.target.value)}
              placeholder="核实说明（可选）：例如 现场确认是李四在戴，张三已交回（班组长 2026-09-12）"
            />
            {plan.blockedReason && (
              <p className="mt-1 text-xs text-risk-degraded-foreground" data-testid="exo-correct-blocked">
                {plan.blockedReason}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                data-testid="exo-correct-submit"
                disabled={correctMutation.isPending || plan.targetPersonId === null}
                onClick={() =>
                  correctMutation.mutate({
                    sessionId,
                    personId: String(plan.targetPersonId ?? ''),
                    note: correctNote,
                  })
                }
              >
                确认交接并更正
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCorrectTarget(null);
                  setCorrectNote('');
                }}
              >
                取消
              </Button>
            </div>
          </section>
        );
      })()}

      {/* ── NO-38a：偏差复盘（运行记忆）─────────────────────────────
          预计 vs 实际是闭环的最后一步：只给事实与计数，比率由服务端按门槛判定；
          样本不足时页面必须显示"证据不足"，绝不显示 0%。 */}
      <section className="rounded-lg border border-border bg-card p-4" data-testid="exo-deviation-review">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">偏差复盘（预计 vs 实际）</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="exo-deviation-groupby">
              分组
            </label>
            <select
              id="exo-deviation-groupby"
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={deviationGroupBy}
              onChange={(event) => setDeviationGroupBy(event.target.value === 'person' ? 'person' : 'device')}
            >
              <option value="device">按设备</option>
              <option value="person">按人员</option>
            </select>
          </div>
        </div>
        {deviationQuery.isError && (
          <p className="mt-2 text-xs text-risk-degraded-foreground" data-testid="exo-deviation-error">
            偏差复盘读取失败：{errorDescription(deviationQuery.error)}（不显示成"没有偏差"）
          </p>
        )}
        {deviationQuery.data && (
          <>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="exo-deviation-scope">
              窗口：最近 {deviationQuery.data.windowDays} 天 · 扫描 {deviationQuery.data.scanned} 条已收工会话 ·
              口径门槛 {deviationQuery.data.minSample} 条可比样本 ·
              可比样本率{' '}
              {deviationQuery.data.plannedCoverageRate === null
                ? '无样本'
                : `${Math.round(deviationQuery.data.plannedCoverageRate * 100)}%（越接近 100%，"预计 vs 实际"越可信）`}
              {deviationQuery.data.truncated ? '｜注意：结果被上限截断，不是全部历史' : ''}
            </p>
            <ul className="mt-3 space-y-2">
              {[...(deviationTotalsRow ? [deviationTotalsRow] : []), ...deviationRows].map((row) => (
                <li
                  key={`${row.key}-${row.label}`}
                  className="rounded border border-border p-2 text-xs"
                  data-testid={`exo-deviation-row-${row.key}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{row.label}</span>
                    <span className="text-muted-foreground">{row.sampleLabel}</span>
                    <span
                      className={row.insufficientSample ? 'text-muted-foreground' : 'text-foreground'}
                    >
                      {row.onTimeRateLabel}
                    </span>
                    {row.hasOver && (
                      <span className="rounded border border-risk-degraded-border px-1 text-risk-degraded-foreground">
                        有超时
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-muted-foreground">{row.deviationLabel}</div>
                  {row.notes.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-[11px] text-muted-foreground">
                      {row.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <ul className="mt-3 list-disc pl-4 text-[11px] text-muted-foreground" data-testid="exo-deviation-notes">
              {deviationQuery.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        )}
        {deviationQuery.isLoading && (
          <p className="mt-2 text-xs text-muted-foreground">加载偏差复盘…</p>
        )}
      </section>
    </div>
  );
}
