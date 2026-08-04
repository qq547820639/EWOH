import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock,
  FileClock,
  Fingerprint,
  ListChecks,
  ShieldAlert,
  Sparkles,
  Users,
  Warehouse,
} from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkGraph, getWorkOverview, type WorkOverview } from '../../api/work';
import { deriveExecutionOverview, type WaitingRecord } from './overviewModel';
import { formatTime, toneClasses, StatusBadge } from './shared';

/** W3.3 预设视图。 */
export type OverviewPreset = 'overview' | 'my-todos' | 'blocked' | 'approval' | 'evidence' | 'resources';

const PRESETS: Array<{ value: OverviewPreset; label: string; icon: typeof ListChecks }> = [
  { value: 'overview', label: '总览', icon: Sparkles },
  { value: 'my-todos', label: '我的待办', icon: Users },
  { value: 'blocked', label: '阻塞项', icon: AlertTriangle },
  { value: 'approval', label: '待批准', icon: ListChecks },
  { value: 'evidence', label: '证据过期', icon: FileClock },
  { value: 'resources', label: '资源冲突', icon: Warehouse },
];

const SectionCard = ({
  icon: Icon,
  title,
  accent,
  children,
}: {
  icon: typeof ListChecks;
  title: string;
  accent: 'red' | 'amber' | 'blue' | 'violet' | 'emerald' | 'sky';
  children: React.ReactNode;
}): React.ReactElement => {
  const accents: Record<string, string> = {
    red: 'text-red-600 bg-red-50',
    amber: 'text-amber-600 bg-amber-50',
    blue: 'text-blue-600 bg-blue-50',
    violet: 'text-violet-600 bg-violet-50',
    emerald: 'text-emerald-600 bg-emerald-50',
    sky: 'text-sky-600 bg-sky-50',
  };
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-md ${accents[accent]}`}>
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="font-semibold text-[hsl(220_14%_14%)]">{title}</h3>
      </div>
      {children}
    </section>
  );
};

const EmptySlot = ({ message }: { message: string }): React.ReactElement => (
  <p className="text-sm text-[hsl(218_10%_42%)]">{message}</p>
);

const WaitingItem = ({ record }: { record: WaitingRecord }): React.ReactElement => {
  const hours = Math.floor(record.waitMs / 3600_000);
  const tone =
    record.urgency === 'high' ? 'red' : record.urgency === 'medium' ? 'amber' : 'slate';
  return (
    <li className="flex items-start justify-between gap-3 border-b border-[hsl(220_14%_96%)] py-2 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
          {record.item.id} · {record.item.title}
        </p>
        <p className="text-xs text-[hsl(218_10%_42%)]">Owner {record.item.owner}</p>
      </div>
      <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${toneClasses[tone]}`}>
        {hours >= 24 ? `${Math.floor(hours / 24)} 天` : `${hours} 小时`}
      </span>
    </li>
  );
};

const ExecutionOverview = ({ writable }: { writable: boolean }): React.ReactElement => {
  const [preset, setPreset] = useState<OverviewPreset>('overview');

  const graphQuery = useQuery({
    queryKey: queryKeys.workGraph,
    queryFn: getWorkGraph,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const overviewQuery = useQuery<WorkOverview>({
    queryKey: queryKeys.workOverview,
    queryFn: getWorkOverview,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const overview = useMemo(
    () => (graphQuery.data ? deriveExecutionOverview(graphQuery.data) : null),
    [graphQuery.data],
  );

  /** 预设视图 → 展示的区块集合。 */
  const sectionForPreset = (key: 'gate' | 'blocked' | 'wait' | 'evidence' | 'risk' | 'overload' | 'conflict'): boolean => {
    switch (preset) {
      case 'overview':
        return true;
      case 'my-todos':
        return key === 'blocked' || key === 'wait' || key === 'gate' || key === 'risk';
      case 'blocked':
        return key === 'blocked' || key === 'wait';
      case 'approval':
        return key === 'gate' || key === 'risk';
      case 'evidence':
        return key === 'evidence';
      case 'resources':
        return key === 'overload' || key === 'conflict';
      default:
        return true;
    }
  };

  return (
    <QueryState
      isLoading={graphQuery.isLoading || overviewQuery.isLoading}
      isFetching={graphQuery.isFetching}
      isError={graphQuery.isError || overviewQuery.isError}
      isStale={graphQuery.isStale}
      isEmpty={!graphQuery.data}
      onRefresh={() => {
        graphQuery.refetch();
        overviewQuery.refetch();
      }}
      errorMessage={graphQuery.error instanceof Error ? graphQuery.error.message : '执行态势加载失败'}
      loadingMessage="正在汇总执行态势"
      updatedAt={Math.max(graphQuery.dataUpdatedAt, overviewQuery.dataUpdatedAt)}
    >
      <div className="space-y-4">
        {/* 预设视图切换 */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="预设视图">
          {PRESETS.map((item) => {
            const Icon = item.icon;
            const active = preset === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setPreset(item.value)}
                aria-pressed={active}
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium ${
                  active
                    ? 'border-blue-300 bg-blue-600 text-white'
                    : 'border-[hsl(220_14%_89%)] bg-white text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>

        {overview ? (
          <>
            {/* 下一项最优行动横幅 */}
            <div
              className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4"
              role="status"
              aria-live="polite"
            >
              <SignpostIcon />
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                  下一项最优行动
                </p>
                {overview.nextAction ? (
                  <>
                    <p className="mt-1 font-semibold text-[hsl(220_14%_14%)]">
                      {overview.nextAction.kind === 'gate'
                        ? `批准门禁 ${overview.nextAction.entity.gateId}`
                        : `推进任务 ${overview.nextAction.entity.id}`}
                    </p>
                    <p className="mt-0.5 text-sm text-[hsl(218_10%_42%)]">
                      {overview.nextAction.reason}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
                    全部任务已完成，没有待办行动。
                  </p>
                )}
              </div>
            </div>

            {/* 统计卡片 */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="未完成" value={overview.counts.pending} tone="amber" />
              <StatTile label="已完成" value={overview.counts.done} tone="emerald" />
              <StatTile label="开启门禁" value={overview.counts.gatesOpen} tone="blue" />
              <StatTile label="待批准" value={overview.gatesAwaitingApproval} tone="red" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {sectionForPreset('gate') && (
                <SectionCard icon={ListChecks} title="当前门禁" accent="red">
                  {overview.currentGate ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-[hsl(220_14%_14%)]">
                          {overview.currentGate.gateId} · {overview.currentGate.title}
                        </p>
                        <StatusBadge status={overview.currentGate.calculatedStatus} />
                      </div>
                      {overview.currentGate.conditions?.map((condition) => (
                        <p key={condition} className="text-xs text-[hsl(218_10%_42%)]">
                          · {condition}
                        </p>
                      ))}
                      {overview.currentGate.approver && (
                        <p className="text-xs text-[hsl(218_10%_42%)]">
                          批准人：{overview.currentGate.approver}
                        </p>
                      )}
                    </div>
                  ) : (
                    <EmptySlot message="当前没有需要推进的门禁。" />
                  )}
                </SectionCard>
              )}

              {sectionForPreset('blocked') && (
                <SectionCard icon={AlertTriangle} title="阻塞交付" accent="red">
                  {overview.blockedItems.length > 0 ? (
                    <ul className="divide-y divide-[hsl(220_14%_96%)]">
                      {overview.blockedItems.slice(0, 6).map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                              {item.id} · {item.title}
                            </p>
                            <p className="text-xs text-[hsl(218_10%_42%)]">Owner {item.owner}</p>
                          </div>
                          <StatusBadge status={item.status} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptySlot message="没有阻塞交付的任务。" />
                  )}
                </SectionCard>
              )}

              {sectionForPreset('wait') && (
                <SectionCard icon={Clock} title="最长等待" accent="amber">
                  {overview.longestWait.length > 0 ? (
                    <ul>
                      {overview.longestWait.map((record) => (
                        <WaitingItem key={record.item.id} record={record} />
                      ))}
                    </ul>
                  ) : (
                    <EmptySlot message="没有等待中的任务。" />
                  )}
                </SectionCard>
              )}

              {sectionForPreset('evidence') && (
                <SectionCard icon={FileClock} title="证据即将过期" accent="violet">
                  {overview.expiringEvidence.length > 0 ? (
                    <ul className="divide-y divide-[hsl(220_14%_96%)]">
                      {overview.expiringEvidence.map((entry) => {
                        const expired = Boolean(
                          entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now(),
                        );
                        return (
                          <li key={entry.evidenceId} className="flex items-start justify-between gap-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                                {entry.title || entry.evidenceId}
                              </p>
                              <p className="truncate text-xs text-[hsl(218_10%_42%)]">
                                {entry.path} · {entry.commitSha ? entry.commitSha.slice(0, 8) : '—'}
                              </p>
                            </div>
                            <span
                              className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${
                                expired
                                  ? 'border-red-200 bg-red-50 text-red-800'
                                  : 'border-amber-200 bg-amber-50 text-amber-800'
                              }`}
                            >
                              {expired ? '已过期' : `${formatTime(entry.expiresAt)}`}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <EmptySlot message="没有即将过期的证据。" />
                  )}
                </SectionCard>
              )}

              {sectionForPreset('risk') && (
                <SectionCard icon={ShieldAlert} title="待人类决策风险" accent="red">
                  {overview.needsHumanDecision.length > 0 ? (
                    <ul className="divide-y divide-[hsl(220_14%_96%)]">
                      {overview.needsHumanDecision.map((risk) => (
                        <li key={risk.id} className="flex items-start justify-between gap-3 py-2">
                          <p className="min-w-0 text-sm font-medium text-[hsl(220_14%_14%)]">
                            {risk.title}
                          </p>
                          <span className="shrink-0 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800">
                            {risk.severity}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptySlot message="没有需要人类决定的开放式高风险。" />
                  )}
                </SectionCard>
              )}

              {sectionForPreset('overload') && (
                <SectionCard icon={Users} title="人力 / Agent 过载" accent="sky">
                  {overview.overloaded.length > 0 ? (
                    <ul className="divide-y divide-[hsl(220_14%_96%)]">
                      {overview.overloaded.map((actor) => (
                        <li key={actor.actorId} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                              {actor.name} ({actor.actorId})
                            </p>
                            <p className="text-xs text-[hsl(218_10%_42%)]">{actor.role}</p>
                          </div>
                          <span className="shrink-0 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700">
                            {actor.load} 项
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptySlot message="没有过载的 Agent 或人力。" />
                  )}
                </SectionCard>
              )}

              {sectionForPreset('conflict') && (
                <SectionCard icon={Warehouse} title="资源冲突" accent="amber">
                  {overview.resourceConflicts.length > 0 ? (
                    <ul className="divide-y divide-[hsl(220_14%_96%)]">
                      {overview.resourceConflicts.map((resource) => (
                        <li key={resource.resourceId} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                              {resource.name} ({resource.resourceId})
                            </p>
                            {resource.purpose && (
                              <p className="truncate text-xs text-[hsl(218_10%_42%)]">
                                {resource.purpose}
                              </p>
                            )}
                          </div>
                          <StatusBadge status={resource.status} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptySlot message="没有资源冲突。" />
                  )}
                </SectionCard>
              )}
            </div>

            {overview.criticalPath && (
              <p className="text-xs text-[hsl(218_10%_42%)]">
                关键路径：{overview.criticalPath}
              </p>
            )}
          </>
        ) : null}
      </div>
    </QueryState>
  );
};

const SignpostIcon = (): React.ReactElement => (
  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
    <Fingerprint className="h-4 w-4" />
  </span>
);

const StatTile = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'amber' | 'blue' | 'red';
}): React.ReactElement => {
  const tones: Record<string, string> = {
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    blue: 'text-blue-600',
    red: 'text-red-600',
  };
  return (
    <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
      <p className="text-xs text-[hsl(218_10%_42%)]">{label}</p>
      <p className={`mt-0.5 text-2xl font-semibold ${tones[tone]}`}>{value}</p>
    </div>
  );
};

export default ExecutionOverview;