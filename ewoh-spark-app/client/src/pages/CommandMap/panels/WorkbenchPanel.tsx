import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Users,
  Zap,
  Clock,
  ListChecks,
  Map,
  Sparkles,
  Check,
  X,
  Gauge,
} from 'lucide-react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { getOverview, getEvents, handleEvent } from '@client/src/api/dashboard';
import { getPlans, confirmPlan, rejectPlan } from '@client/src/api/scheduler';
import { getCurrentOperator } from '@client/src/lib/auth';
import type {
  OverviewStats,
  EventInfo,
  SchedulePlan,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@client/src/components/ui/card';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { ScrollArea } from '@client/src/components/ui/scroll-area';

interface WorkbenchPanelProps {
  onNavigate?: (tab: string) => void;
  onModeChange?: (mode: string) => void;
  onSelectEntity?: (id: string | null) => void;
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

function severityBadgeClass(severity: string): string {
  switch (severity) {
    case 'L3':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'L2':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'L1':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

export default function WorkbenchPanel({
  onNavigate,
  onModeChange,
  onSelectEntity,
}: WorkbenchPanelProps) {
  const queryClient = useQueryClient();
  const { data: overview, isLoading: loadingOverview } = useQuery<OverviewStats>({
    queryKey: ['workbench-overview'],
    queryFn: getOverview,
    refetchInterval: 5000,
  });

  const { data: openEvents } = useQuery<EventInfo[]>({
    queryKey: ['workbench-events-open'],
    queryFn: () => getEvents(10, 'open'),
    refetchInterval: 5000,
  });

  const { data: proposedPlans } = useQuery<SchedulePlan[]>({
    queryKey: ['workbench-plans-proposed'],
    queryFn: () => getPlans('proposed'),
    refetchInterval: 10000,
  });

  const confirmMutation = useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string }) =>
      confirmPlan(planId, { reason, operator: getCurrentOperator() }),
    onSuccess: () => {
      toast.success('方案已确认');
      queryClient.invalidateQueries({ queryKey: ['workbench-plans-proposed'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
    },
    onError: () => toast.error('方案确认失败'),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string }) =>
      rejectPlan(planId, { reason, operator: getCurrentOperator() }),
    onSuccess: () => {
      toast.success('方案已驳回');
      queryClient.invalidateQueries({ queryKey: ['workbench-plans-proposed'] });
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
    },
    onError: () => toast.error('方案驳回失败'),
  });

  const handleMutation = useMutation({
    mutationFn: (eventId: string) =>
      handleEvent(eventId, {
        handlerAction: 'manual_handle',
        handlerNote: '班组长工作台快速处置',
        operator: getCurrentOperator(),
      }),
    onSuccess: () => {
      toast.success('事件已处置');
      queryClient.invalidateQueries({ queryKey: ['workbench-events-open'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
    },
    onError: () => toast.error('事件处置失败'),
  });

  const kpis = [
    {
      label: '在线设备',
      value: overview ? `${overview.deviceOnline}/${overview.deviceTotal}` : '—',
      icon: Activity,
      color: 'text-blue-400',
      action: () => onNavigate?.('resource'),
    },
    {
      label: '在岗人员',
      value: overview?.workerCount ?? '—',
      icon: Users,
      color: 'text-green-400',
      action: () => {
        onModeChange?.('body_load');
        onNavigate?.('resource');
      },
    },
    {
      label: '未结事件',
      value: overview?.eventOpen ?? '—',
      icon: AlertTriangle,
      color: 'text-orange-400',
      action: () => onNavigate?.('events'),
    },
    {
      label: '严重事件',
      value: overview?.eventCritical ?? '—',
      icon: Zap,
      color: 'text-red-400',
      action: () => onNavigate?.('events'),
    },
    {
      label: '平均负荷',
      value: overview ? `${(overview.avgLoad * 100).toFixed(1)}%` : '—',
      icon: Gauge,
      color: 'text-cyan-400',
      action: () => onModeChange?.('body_load'),
    },
  ];

  return (
    <div className="h-full flex gap-3 p-3 bg-[hsl(220_14%_14%)] text-white overflow-hidden">
      {/* Card 1: Shift overview (可点击下钻) */}
      <Card className="flex-1 bg-white/5 border-white/10 min-w-0">
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs text-white/80 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            班次概览
            <span className="ml-auto text-[9px] text-white/40 font-normal">点击指标可下钻</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {loadingOverview ? (
            <div className="text-xs text-white/70">加载中...</div>
          ) : !overview ? (
            <div className="text-xs text-white/70">暂无数据</div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5">
              {kpis.map((kpi) => (
                <button
                  key={kpi.label}
                  onClick={kpi.action}
                  className="flex items-center justify-between rounded px-1 py-0.5 hover:bg-white/5 transition-colors text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <kpi.icon className={cn('w-3 h-3', kpi.color)} />
                    <span className="text-[10px] text-white/70">{kpi.label}</span>
                  </div>
                  <span className="text-xs font-semibold text-white/90">{kpi.value}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2: Pending plans (内嵌审批) */}
      <Card className="flex-1 bg-white/5 border-white/10 flex flex-col min-h-0 min-w-0">
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs text-white/80 flex items-center gap-1.5">
            <ListChecks className="w-3.5 h-3.5" />
            待审批方案
            {(proposedPlans?.length ?? 0) > 0 && (
              <Badge className="text-[9px] px-1.5 bg-blue-500/20 text-blue-400">
                {proposedPlans?.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 flex-1 min-h-0">
          <ScrollArea className="h-full">
            {proposedPlans && proposedPlans.length > 0 ? (
              <div className="space-y-1.5">
                {proposedPlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="p-2 rounded bg-white/5 border border-white/5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-medium text-white/90 truncate">
                        {plan.planName}
                        {plan.taktImprovement > 0 && (
                          <span className="ml-1 text-cyan-400">
                            节拍+{plan.taktImprovement}%
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          size="sm"
                          className="h-5 text-[9px] px-1.5 min-w-0"
                          onClick={() =>
                            confirmMutation.mutate({
                              planId: plan.planId,
                              reason: '班组长确认',
                            })
                          }
                          disabled={confirmMutation.isPending}
                        >
                          <Check className="w-2.5 h-2.5" />
                          批准
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-5 text-[9px] px-1.5 min-w-0 text-red-400 border-red-500/30"
                          onClick={() =>
                            rejectMutation.mutate({
                              planId: plan.planId,
                              reason: '班组长驳回',
                            })
                          }
                          disabled={rejectMutation.isPending}
                        >
                          <X className="w-2.5 h-2.5" />
                          驳回
                        </Button>
                      </div>
                    </div>
                    <div className="text-[9px] text-white/60 mt-0.5 line-clamp-2">
                      {plan.reason ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-white/70 text-center py-4">
                暂无待审批方案
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Card 3: Events to watch (内嵌处置) */}
      <Card className="flex-1 bg-white/5 border-white/10 flex flex-col min-h-0 min-w-0">
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs text-white/80 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            需关注事件
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 flex-1 min-h-0">
          <ScrollArea className="h-full">
            {openEvents && openEvents.length > 0 ? (
              <div className="space-y-1">
                {openEvents.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-2">
                    <Badge
                      className={cn('text-[9px] px-1 py-0', severityBadgeClass(ev.severity))}
                    >
                      {ev.severity}
                    </Badge>
                    <span className="text-[10px] text-white/80 flex-1 truncate">
                      {ev.title}
                    </span>
                    <span className="text-[9px] text-white/60 shrink-0">
                      {timeAgo(ev.createdAt)}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 text-[9px] px-1.5 shrink-0 text-green-400 border-green-500/30"
                      onClick={() => handleMutation.mutate(ev.eventId || ev.id)}
                      disabled={handleMutation.isPending}
                    >
                      <Check className="w-2.5 h-2.5" />
                      处置
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-white/70 text-center py-4">暂无未结事件</div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Card 4: Quick actions (真实跳转) */}
      <Card className="w-40 bg-white/5 border-white/10 shrink-0">
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs text-white/80 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            快速操作
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-1.5">
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => onNavigate?.('schedule')}
          >
            <Sparkles className="w-3 h-3" />
            调度审批
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => onNavigate?.('events')}
          >
            <AlertTriangle className="w-3 h-3" />
            事件中心
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => onNavigate?.('timeline')}
          >
            <Clock className="w-3 h-3" />
            时间轴回放
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => onModeChange?.('production')}
          >
            <Map className="w-3 h-3" />
            地图视图
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}