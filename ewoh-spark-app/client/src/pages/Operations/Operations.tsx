import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Activity,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Gauge,
  PackageCheck,
  Plus,
  ShieldCheck,
  TimerReset,
  Wrench,
} from 'lucide-react';
import {
  getEfficiencySummary,
  getOperationsSummary,
  listEfficiencyEntries,
  listMaintenanceAssets,
  listMaintenanceTasks,
  listMaintenanceTools,
  listStandardHours,
  listWorkCenters,
  registerEfficiencyEntry,
  registerMaintenanceAsset,
  registerMaintenanceTask,
  registerMaintenanceTool,
  registerStandardHour,
  transitionMaintenanceAsset,
  transitionMaintenanceTask,
  transitionMaintenanceTool,
  upsertWorkCenter,
  type EfficiencyEntry,
  type MaintenanceAsset,
  type MaintenanceTask,
  type MaintenanceTool,
  type OperationsSummary,
  type StandardHour,
  type WorkCenter,
  type WorkCenterFlags,
} from '../../api/operations';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

const TABS = ['总览', '维保资产', '维保任务', '工装校验', '工作中心', '标准工时', '人员效率'] as const;
type Tab = (typeof TABS)[number];

const formatTime = (value: string | null | undefined): string =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—';

const emptyFlags: WorkCenterFlags = {
  firstInspectionRequired: false,
  materialConsumptionRequired: false,
  reportReviewRequired: false,
  handoverRequired: false,
  scanRequired: false,
  exoskeletonRequired: false,
  riskConfirmationRequired: false,
  toolingCheckRequired: false,
};

const flagLabels: Array<{ key: keyof WorkCenterFlags; label: string }> = [
  { key: 'firstInspectionRequired', label: '首检必需' },
  { key: 'materialConsumptionRequired', label: '投料记录' },
  { key: 'reportReviewRequired', label: '报工审核' },
  { key: 'handoverRequired', label: '工序交收' },
  { key: 'scanRequired', label: '扫码作业' },
  { key: 'exoskeletonRequired', label: '外骨骼要求' },
  { key: 'riskConfirmationRequired', label: '风险确认' },
  { key: 'toolingCheckRequired', label: '工装点检' },
];

function ActionButton({
  onClick,
  disabled,
  children,
  tone = 'default',
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  tone?: 'default' | 'success' | 'danger';
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
      : tone === 'danger'
        ? 'bg-red-600 hover:bg-red-700 text-white'
        : 'bg-primary hover:bg-primary/90 text-primary-foreground';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium disabled:opacity-40 ${toneClass}`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-0 rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary"
      />
    </label>
  );
}

const Operations = (): React.ReactElement => {
  const queryClient = useQueryClient();
  // UX-IA-2026-08：tab 状态同步 URL（?tab=，replace 不污染历史），
  // 支持搜索直达与收藏视图；非法值回退「总览」。
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(urlTab ?? '') ? (urlTab as Tab) : '总览';
  const setTab = (next: Tab) => {
    setSearchParams(next === '总览' ? {} : { tab: next }, { replace: true });
  };

  const [assetName, setAssetName] = useState('');
  const [assetCategory, setAssetCategory] = useState('device');
  const [assetLocation, setAssetLocation] = useState('');
  const [assetInterval, setAssetInterval] = useState('90');

  const [taskTitle, setTaskTitle] = useState('');
  const [taskAsset, setTaskAsset] = useState('');
  const [taskType, setTaskType] = useState('preventive');
  const [taskPriority, setTaskPriority] = useState('medium');
  // CLI-203：完成结果按 taskId 维护（原共享单值，A 任务输入残留到 B 任务提交）。
  const [completeResults, setCompleteResults] = useState<Record<string, string>>({});

  const [toolName, setToolName] = useState('');
  const [toolCategory, setToolCategory] = useState('tooling');
  const [toolInterval, setToolInterval] = useState('180');

  const [wcName, setWcName] = useState('');
  const [wcLocation, setWcLocation] = useState('');
  const [wcCapabilities, setWcCapabilities] = useState('');
  const [wcFlags, setWcFlags] = useState<WorkCenterFlags>(emptyFlags);

  const [shWorkCenter, setShWorkCenter] = useState('');
  const [shCode, setShCode] = useState('');
  const [shName, setShName] = useState('');
  const [shMinutes, setShMinutes] = useState('10');

  const [efWorker, setEfWorker] = useState('');
  const [efWorkCenter, setEfWorkCenter] = useState('');
  const [efCode, setEfCode] = useState('');
  const [efActual, setEfActual] = useState('');
  const [efStandard, setEfStandard] = useState('');

  const invalidateAll = () => {
    for (const key of [
      queryKeys.operationsSummary,
      queryKeys.operationsAssets,
      queryKeys.operationsTasks,
      queryKeys.operationsTools,
      queryKeys.operationsWorkCenters,
      queryKeys.operationsStandardHours,
      queryKeys.operationsEfficiency,
      queryKeys.operationsEfficiencySummary,
    ]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const summaryQuery = useQuery<OperationsSummary>({
    queryKey: queryKeys.operationsSummary,
    queryFn: getOperationsSummary,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const assetsQuery = useQuery<MaintenanceAsset[]>({
    queryKey: queryKeys.operationsAssets,
    queryFn: listMaintenanceAssets,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const tasksQuery = useQuery<MaintenanceTask[]>({
    queryKey: queryKeys.operationsTasks,
    queryFn: listMaintenanceTasks,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const toolsQuery = useQuery<MaintenanceTool[]>({
    queryKey: queryKeys.operationsTools,
    queryFn: listMaintenanceTools,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const workCentersQuery = useQuery<WorkCenter[]>({
    queryKey: queryKeys.operationsWorkCenters,
    queryFn: listWorkCenters,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const standardHoursQuery = useQuery<StandardHour[]>({
    queryKey: queryKeys.operationsStandardHours,
    queryFn: listStandardHours,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const efficiencyQuery = useQuery<EfficiencyEntry[]>({
    queryKey: queryKeys.operationsEfficiency,
    queryFn: listEfficiencyEntries,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const efficiencySummaryQuery = useQuery({
    queryKey: queryKeys.operationsEfficiencySummary,
    queryFn: getEfficiencySummary,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // CLI-204：以下 9 个写操作 mutation 全部补 onError（失败 toast 透传 err.message）。
  const addAsset = useMutation({
    mutationFn: () =>
      registerMaintenanceAsset({
        name: assetName.trim(),
        category: assetCategory,
        location: assetLocation.trim() || undefined,
        intervalDays: Number(assetInterval),
      }),
    onSuccess: () => {
      invalidateAll();
      setAssetName('');
      setAssetLocation('');
    },
    onError: (err) => {
      toast.error('资产登记失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
  const assetAction = useMutation({
    mutationFn: (vars: { assetId: string; action: 'flag_maintenance' | 'activate' | 'decommission' }) =>
      transitionMaintenanceAsset(vars.assetId, vars.action),
    onSuccess: invalidateAll,
    onError: (err) => {
      toast.error('资产状态变更失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const addTask = useMutation({
    mutationFn: () =>
      registerMaintenanceTask({
        title: taskTitle.trim(),
        assetId: taskAsset || undefined,
        taskType,
        priority: taskPriority,
      }),
    onSuccess: () => {
      invalidateAll();
      setTaskTitle('');
      setTaskAsset('');
    },
    onError: (err) => {
      toast.error('任务登记失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
  const taskAction = useMutation({
    mutationFn: (vars: {
      taskId: string;
      action: 'start' | 'complete' | 'cancel';
      result?: string;
    }) =>
      transitionMaintenanceTask(vars.taskId, vars.action, {
        result: vars.result,
        // CLI-229：note 由用户输入的结果注入（原硬编码 'workbench complete'）。
        note:
          vars.action === 'complete' && vars.result?.trim()
            ? `完成结果：${vars.result.trim()}`
            : undefined,
      }),
    onSuccess: (_data, vars) => {
      invalidateAll();
      // CLI-203：仅清除该任务的完成结果输入。
      if (vars.action === 'complete') {
        setCompleteResults((current) => {
          const next = { ...current };
          delete next[vars.taskId];
          return next;
        });
      }
    },
    onError: (err) => {
      toast.error('任务状态变更失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const addTool = useMutation({
    mutationFn: () => {
      // P2（2026-08-19 审计）：同 addAsset——空串数字输入显式拒绝不静默传 0。
      const interval = Number(toolInterval);
      if (!toolInterval.trim() || !Number.isFinite(interval) || interval <= 0) {
        throw new Error('校准周期必须为正数（天）');
      }
      return registerMaintenanceTool({
        name: toolName.trim(),
        category: toolCategory,
        calibrationIntervalDays: interval,
      });
    },
    onSuccess: () => {
      invalidateAll();
      setToolName('');
    },
    onError: (err) => {
      toast.error('工装登记失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
  const toolAction = useMutation({
    mutationFn: (vars: { toolId: string; action: 'calibrate' | 'retire' }) =>
      transitionMaintenanceTool(vars.toolId, vars.action),
    onSuccess: invalidateAll,
    onError: (err) => {
      toast.error('工装操作失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const saveWorkCenter = useMutation({
    mutationFn: () =>
      upsertWorkCenter({
        name: wcName.trim(),
        location: wcLocation.trim() || undefined,
        capabilities: wcCapabilities
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        flags: wcFlags,
      }),
    onSuccess: () => {
      invalidateAll();
      setWcName('');
      setWcLocation('');
      setWcCapabilities('');
      setWcFlags(emptyFlags);
    },
    onError: (err) => {
      toast.error('工作中心保存失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const addStandardHour = useMutation({
    mutationFn: () =>
      registerStandardHour({
        workCenterId: shWorkCenter.trim(),
        operationCode: shCode.trim(),
        operationName: shName.trim(),
        standardMinutes: Number(shMinutes),
      }),
    onSuccess: () => {
      invalidateAll();
      setShCode('');
      setShName('');
    },
    onError: (err) => {
      toast.error('标准工时登记失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const addEfficiency = useMutation({
    mutationFn: () => {
      // P2（2026-08-19 审计）：actualMinutes 空串静默传 0——显式拒绝
      //（standardMinutes 已有三元判空，保持不变）。
      const actual = Number(efActual);
      if (!efActual.trim() || !Number.isFinite(actual) || actual <= 0) {
        throw new Error('实际工时必须为正数（分钟）');
      }
      return registerEfficiencyEntry({
        workerId: efWorker.trim(),
        workCenterId: efWorkCenter.trim(),
        operationCode: efCode.trim(),
        actualMinutes: actual,
        standardMinutes: efStandard ? Number(efStandard) : undefined,
      });
    },
    onSuccess: () => {
      invalidateAll();
      setEfWorker('');
      setEfCode('');
      setEfActual('');
      setEfStandard('');
    },
    onError: (err) => {
      toast.error('效率记录登记失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const summary = summaryQuery.data;
  const assets = assetsQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];
  const tools = toolsQuery.data ?? [];
  const workCenters = workCentersQuery.data ?? [];
  const standardHours = standardHoursQuery.data ?? [];
  const efficiency = efficiencyQuery.data ?? [];
  const efficiencySummary = efficiencySummaryQuery.data;

  const metrics = [
    { label: '维保资产', value: summary?.assetCount ?? 0, icon: BriefcaseBusiness },
    { label: '进行中任务', value: summary?.inProgressTasks ?? 0, icon: CalendarClock },
    { label: '待校准工装', value: summary?.calibrationDueCount ?? 0, icon: TimerReset },
    { label: '平均效率', value: `${efficiencySummary?.averageEfficiencyPercent ?? 0}%`, icon: Gauge },
  ];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">运维中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            维保、工装、工作中心配置与人员效率。
          </p>
        </div>
        <div className="flex items-start gap-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div
                key={metric.label}
                className="flex min-w-[120px] items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <Icon className="h-4 w-4 text-primary" />
                <div>
                  <p className="text-xs text-muted-foreground">{metric.label}</p>
                  <p className="text-base font-bold text-foreground">
                    {metric.value}
                  </p>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </header>

      {/* UX-IA-2026-08：tab 条粘性置顶——长内容切换后随时可换区，防「滚入深区后找不到导航」。 */}
      <div className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1 shadow-sm">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              tab === item
                ? 'bg-primary text-white'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === '总览' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <QueryState
            isLoading={summaryQuery.isLoading}
            isFetching={summaryQuery.isFetching}
            isError={summaryQuery.isError}
            isEmpty={!summary}
            onRefresh={() => summaryQuery.refetch()}
            errorMessage="运营总览加载失败"
            emptyMessage="暂无运营数据"
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['计划任务', summary?.plannedTasks ?? 0],
                ['完成任务', summary?.completedTasks ?? 0],
                ['工作中心', summary?.workCenterCount ?? 0],
                ['标准工时', summary?.standardHourCount ?? 0],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
                </div>
              ))}
            </div>
          </QueryState>
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ClipboardList className="h-4 w-4 text-primary" />
              临近维保
            </h2>
            <div className="mt-3 space-y-2">
              {(summary?.nextMaintenanceDue ?? []).map((item) => (
                <div
                  key={item.assetId}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate font-medium">{item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatTime(item.nextDueAt)}
                  </span>
                </div>
              ))}
              {(summary?.nextMaintenanceDue ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">暂无临近维保</p>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === '维保资产' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
              onSubmit={(event) => {
                event.preventDefault();
                addAsset.mutate();
              }}
            >
              <Field label="资产名称" value={assetName} onChange={setAssetName} placeholder="CNC-01" />
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                分类
                <select
                  value={assetCategory}
                  onChange={(event) => setAssetCategory(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="device">设备</option>
                  <option value="tooling">工装</option>
                  <option value="utility">公用设施</option>
                </select>
              </label>
              <Field label="位置" value={assetLocation} onChange={setAssetLocation} />
              <Field label="维保周期（天）" type="number" value={assetInterval} onChange={setAssetInterval} />
              <div className="flex items-end">
                <ActionButton onClick={() => addAsset.mutate()} disabled={addAsset.isPending || !assetName.trim()}>
                  <Plus className="h-3.5 w-3.5" />
                  登记资产
                </ActionButton>
              </div>
            </form>
          </div>
          <QueryState
            isLoading={assetsQuery.isLoading}
            isFetching={assetsQuery.isFetching}
            isError={assetsQuery.isError}
            isEmpty={assets.length === 0}
            onRefresh={() => assetsQuery.refetch()}
            emptyMessage="暂无维保资产"
          >
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">资产</th>
                    <th className="px-4 py-3 font-medium">分类</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">下次维保</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr key={asset.assetId} className="border-b border-muted last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{asset.name}</p>
                        <p className="text-xs text-muted-foreground">{asset.assetId}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{asset.category}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-muted px-2 py-1 text-xs">
                          {asset.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">{formatTime(asset.nextDueAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          {asset.status === 'maintenance_required' && (
                            <ActionButton
                              tone="success"
                              onClick={() => assetAction.mutate({ assetId: asset.assetId, action: 'activate' })}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              恢复
                            </ActionButton>
                          )}
                          {asset.status !== 'decommissioned' && (
                            <ActionButton
                              onClick={() => assetAction.mutate({ assetId: asset.assetId, action: 'flag_maintenance' })}
                            >
                              <Wrench className="h-3.5 w-3.5" />
                              报修
                            </ActionButton>
                          )}
                          {asset.status !== 'decommissioned' && (
                            <ActionButton
                              tone="danger"
                              onClick={() => assetAction.mutate({ assetId: asset.assetId, action: 'decommission' })}
                            >
                              退役
                            </ActionButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
      )}

      {tab === '维保任务' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
              onSubmit={(event) => {
                event.preventDefault();
                addTask.mutate();
              }}
            >
              <Field label="任务标题" value={taskTitle} onChange={setTaskTitle} />
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                资产
                <select
                  value={taskAsset}
                  onChange={(event) => setTaskAsset(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="">未绑定</option>
                  {assets.map((asset) => (
                    <option key={asset.assetId} value={asset.assetId}>
                      {asset.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                类型
                <select
                  value={taskType}
                  onChange={(event) => setTaskType(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="inspection">点检</option>
                  <option value="preventive">保养</option>
                  <option value="repair">维修</option>
                  <option value="calibration">校准</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                优先级
                <select
                  value={taskPriority}
                  onChange={(event) => setTaskPriority(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </label>
              <div className="flex items-end">
                <ActionButton onClick={() => addTask.mutate()} disabled={addTask.isPending || !taskTitle.trim()}>
                  <Plus className="h-3.5 w-3.5" />
                  新建任务
                </ActionButton>
              </div>
            </form>
          </div>
          <QueryState
            isLoading={tasksQuery.isLoading}
            isFetching={tasksQuery.isFetching}
            isError={tasksQuery.isError}
            isEmpty={tasks.length === 0}
            onRefresh={() => tasksQuery.refetch()}
            emptyMessage="暂无维保任务"
          >
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">任务</th>
                    <th className="px-4 py-3 font-medium">类型</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">结果</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.taskId} className="border-b border-muted last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{task.title}</p>
                        <p className="text-xs text-muted-foreground">{task.taskId}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{task.taskType}</td>
                      <td className="px-4 py-3">{task.status}</td>
                      <td className="px-4 py-3 text-xs">{task.result ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {task.status === 'planned' && (
                            <ActionButton onClick={() => taskAction.mutate({ taskId: task.taskId, action: 'start' })}>
                              <Activity className="h-3.5 w-3.5" />
                              开工
                            </ActionButton>
                          )}
                          {task.status === 'in_progress' && (
                            <>
                              <input
                                value={completeResults[task.taskId] ?? ''}
                                onChange={(event) =>
                                  setCompleteResults((current) => ({
                                    ...current,
                                    [task.taskId]: event.target.value,
                                  }))
                                }
                                placeholder="结果"
                                className="h-8 w-28 rounded-md border border-border px-2 text-xs"
                              />
                              <ActionButton
                                tone="success"
                                onClick={() =>
                                  taskAction.mutate({
                                    taskId: task.taskId,
                                    action: 'complete',
                                    result: completeResults[task.taskId] ?? '',
                                  })
                                }
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                完成
                              </ActionButton>
                              <ActionButton
                                tone="danger"
                                onClick={() => taskAction.mutate({ taskId: task.taskId, action: 'cancel' })}
                              >
                                取消
                              </ActionButton>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
      )}

      {tab === '工装校验' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
              onSubmit={(event) => {
                event.preventDefault();
                addTool.mutate();
              }}
            >
              <Field label="工装名称" value={toolName} onChange={setToolName} />
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                分类
                <select
                  value={toolCategory}
                  onChange={(event) => setToolCategory(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="tooling">工装</option>
                  <option value="fixture">夹具</option>
                  <option value="gauge">量具</option>
                </select>
              </label>
              <Field label="校准周期（天）" type="number" value={toolInterval} onChange={setToolInterval} />
              <div className="flex items-end">
                <ActionButton onClick={() => addTool.mutate()} disabled={addTool.isPending || !toolName.trim()}>
                  <Plus className="h-3.5 w-3.5" />
                  登记工装
                </ActionButton>
              </div>
            </form>
          </div>
          <QueryState
            isLoading={toolsQuery.isLoading}
            isFetching={toolsQuery.isFetching}
            isError={toolsQuery.isError}
            isEmpty={tools.length === 0}
            onRefresh={() => toolsQuery.refetch()}
            emptyMessage="暂无工装记录"
          >
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">工装</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">上次校准</th>
                    <th className="px-4 py-3 font-medium">下次校准</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((tool) => (
                    <tr key={tool.toolId} className="border-b border-muted last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{tool.name}</p>
                        <p className="text-xs text-muted-foreground">{tool.toolId}</p>
                      </td>
                      <td className="px-4 py-3">{tool.status}</td>
                      <td className="px-4 py-3 text-xs">{formatTime(tool.lastCalibratedAt)}</td>
                      <td className="px-4 py-3 text-xs">{formatTime(tool.nextCalibrationAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          {tool.status !== 'retired' && (
                            <ActionButton
                              tone="success"
                              onClick={() => toolAction.mutate({ toolId: tool.toolId, action: 'calibrate' })}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              校准
                            </ActionButton>
                          )}
                          {tool.status !== 'retired' && (
                            <ActionButton
                              tone="danger"
                              onClick={() => toolAction.mutate({ toolId: tool.toolId, action: 'retire' })}
                            >
                              报废
                            </ActionButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
      )}

      {tab === '工作中心' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              onSubmit={(event) => {
                event.preventDefault();
                saveWorkCenter.mutate();
              }}
            >
              <Field label="工作中心名称" value={wcName} onChange={setWcName} />
              <Field label="位置" value={wcLocation} onChange={setWcLocation} />
              <Field
                label="能力（逗号分隔）"
                value={wcCapabilities}
                onChange={setWcCapabilities}
                placeholder="mes-p0,oee"
              />
              <div className="flex items-end">
                <ActionButton onClick={() => saveWorkCenter.mutate()} disabled={saveWorkCenter.isPending || !wcName.trim()}>
                  <PackageCheck className="h-3.5 w-3.5" />
                  保存配置
                </ActionButton>
              </div>
            </form>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {flagLabels.map((flag) => (
                <label key={flag.key} className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={wcFlags[flag.key]}
                    onChange={(event) =>
                      setWcFlags((current) => ({ ...current, [flag.key]: event.target.checked }))
                    }
                    className="h-4 w-4 accent-[hsl(221_83%_53%)]"
                  />
                  {flag.label}
                </label>
              ))}
            </div>
          </div>
          <QueryState
            isLoading={workCentersQuery.isLoading}
            isFetching={workCentersQuery.isFetching}
            isError={workCentersQuery.isError}
            isEmpty={workCenters.length === 0}
            onRefresh={() => workCentersQuery.refetch()}
            emptyMessage="暂无工作中心配置"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              {workCenters.map((workCenter) => (
                <div key={workCenter.workCenterId} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-foreground">{workCenter.name}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {workCenter.location ?? '未指定位置'} · {workCenter.workCenterId}
                      </p>
                    </div>
                    <span className="rounded-full bg-muted px-2 py-1 text-xs">
                      {workCenter.capabilities.join(' / ') || '—'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {flagLabels
                      .filter((flag) => workCenter.flags[flag.key])
                      .map((flag) => (
                        <span key={flag.key} className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                          {flag.label}
                        </span>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </QueryState>
        </div>
      )}

      {tab === '标准工时' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
              onSubmit={(event) => {
                event.preventDefault();
                addStandardHour.mutate();
              }}
            >
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                工作中心
                <select
                  value={shWorkCenter}
                  onChange={(event) => setShWorkCenter(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="">选择</option>
                  {workCenters.map((workCenter) => (
                    <option key={workCenter.workCenterId} value={workCenter.workCenterId}>
                      {workCenter.name}
                    </option>
                  ))}
                </select>
              </label>
              <Field label="工序代码" value={shCode} onChange={setShCode} />
              <Field label="工序名称" value={shName} onChange={setShName} />
              <Field label="标准分钟" type="number" value={shMinutes} onChange={setShMinutes} />
              <div className="flex items-end">
                <ActionButton
                  onClick={() => addStandardHour.mutate()}
                  disabled={addStandardHour.isPending || !shWorkCenter || !shCode.trim()}
                >
                  <Plus className="h-3.5 w-3.5" />
                  登记
                </ActionButton>
              </div>
            </form>
          </div>
          <QueryState
            isLoading={standardHoursQuery.isLoading}
            isFetching={standardHoursQuery.isFetching}
            isError={standardHoursQuery.isError}
            isEmpty={standardHours.length === 0}
            onRefresh={() => standardHoursQuery.refetch()}
            emptyMessage="暂无标准工时"
          >
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">工作中心</th>
                    <th className="px-4 py-3 font-medium">工序</th>
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">标准分钟</th>
                    <th className="px-4 py-3 font-medium">技能等级</th>
                  </tr>
                </thead>
                <tbody>
                  {standardHours.map((hour) => (
                    <tr key={hour.standardHourId} className="border-b border-muted last:border-0">
                      <td className="px-4 py-3">{hour.workCenterId}</td>
                      <td className="px-4 py-3 font-mono text-xs">{hour.operationCode}</td>
                      <td className="px-4 py-3">{hour.operationName}</td>
                      <td className="px-4 py-3 font-bold">{hour.standardMinutes}</td>
                      <td className="px-4 py-3 text-muted-foreground">{hour.skillLevel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
      )}

      {tab === '人员效率' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">记录数</p>
              <p className="mt-1 text-2xl font-bold">{efficiencySummary?.entryCount ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">人员数</p>
              <p className="mt-1 text-2xl font-bold">{efficiencySummary?.workerCount ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">公平性标准差</p>
              <p className="mt-1 text-2xl font-bold">{efficiencySummary?.fairnessStdDev ?? 0}</p>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
              onSubmit={(event) => {
                event.preventDefault();
                addEfficiency.mutate();
              }}
            >
              <Field label="人员 ID" value={efWorker} onChange={setEfWorker} />
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                工作中心
                <select
                  value={efWorkCenter}
                  onChange={(event) => setEfWorkCenter(event.target.value)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <option value="">选择</option>
                  {workCenters.map((workCenter) => (
                    <option key={workCenter.workCenterId} value={workCenter.workCenterId}>
                      {workCenter.name}
                    </option>
                  ))}
                </select>
              </label>
              <Field label="工序代码" value={efCode} onChange={setEfCode} />
              <Field label="实际分钟" type="number" value={efActual} onChange={setEfActual} />
              <Field label="标准分钟（可选）" type="number" value={efStandard} onChange={setEfStandard} />
              <div className="flex items-end">
                <ActionButton
                  onClick={() => addEfficiency.mutate()}
                  disabled={addEfficiency.isPending || !efWorker.trim() || !efWorkCenter || !efActual}
                >
                  <Plus className="h-3.5 w-3.5" />
                  记录
                </ActionButton>
              </div>
            </form>
          </div>
          <QueryState
            isLoading={efficiencyQuery.isLoading}
            isFetching={efficiencyQuery.isFetching}
            isError={efficiencyQuery.isError}
            isEmpty={efficiency.length === 0}
            onRefresh={() => efficiencyQuery.refetch()}
            emptyMessage="暂无效率记录"
          >
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">人员</th>
                    <th className="px-4 py-3 font-medium">工序</th>
                    <th className="px-4 py-3 font-medium">实际/标准</th>
                    <th className="px-4 py-3 font-medium">偏差</th>
                    <th className="px-4 py-3 font-medium">效率</th>
                    <th className="px-4 py-3 font-medium">来源</th>
                  </tr>
                </thead>
                <tbody>
                  {efficiency.map((entry) => (
                    <tr key={entry.entryId} className="border-b border-muted last:border-0">
                      <td className="px-4 py-3 font-medium">{entry.workerId}</td>
                      <td className="px-4 py-3 font-mono text-xs">{entry.operationCode}</td>
                      <td className="px-4 py-3">
                        {entry.actualMinutes} / {entry.standardMinutes} 分钟
                      </td>
                      <td className="px-4 py-3">{entry.deviationMinutes}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs ${
                            entry.efficiencyPercent >= 100
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {entry.efficiencyPercent}%
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{entry.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </div>
      )}
    </div>
  );
};

export default Operations;
