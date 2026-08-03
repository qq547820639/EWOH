import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Users,
  Zap,
  Clock,
  ListChecks,
  Map,
  Sparkles,
} from 'lucide-react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { getOverview, getEvents } from '@client/src/api/dashboard';
import { getPlans } from '@client/src/api/scheduler';
import type { OverviewStats, EventInfo, SchedulePlan } from '@shared/api.interface';
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

export default function WorkbenchPanel() {
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

  const kpis = [
    {
      label: '在线设备',
      value: overview ? `${overview.deviceOnline}/${overview.deviceTotal}` : '—',
      icon: Activity,
      color: 'text-blue-400',
    },
    {
      label: '在岗人员',
      value: overview?.workerCount ?? '—',
      icon: Users,
      color: 'text-green-400',
    },
    {
      label: '未结事件',
      value: overview?.eventOpen ?? '—',
      icon: AlertTriangle,
      color: 'text-orange-400',
    },
    {
      label: '严重事件',
      value: overview?.eventCritical ?? '—',
      icon: Zap,
      color: 'text-red-400',
    },
    {
      label: '平均负荷',
      value: overview ? `${(overview.avgLoad * 100).toFixed(1)}%` : '—',
      icon: Activity,
      color: 'text-cyan-400',
    },
  ];

  return (
    <div className="h-full flex gap-3 p-3 bg-[hsl(220_14%_14%)] text-white overflow-hidden">
      {/* Card 1: Shift overview */}
      <Card className="flex-1 bg-white/5 border-white/10 min-w-0">
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs text-white/80 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            班次概览
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
                <div key={kpi.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <kpi.icon className={cn('w-3 h-3', kpi.color)} />
                    <span className="text-[10px] text-white/70">{kpi.label}</span>
                  </div>
                  <span className="text-xs font-semibold text-white/90">{kpi.value}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2: Pending plans */}
      <Card className="flex-1 bg-white/5 border-white/10 flex flex-col min-h-0 min-w-0">
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs text-white/80 flex items-center gap-1.5">
            <ListChecks className="w-3.5 h-3.5" />
            待审批方案
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
                    <div className="text-[10px] font-medium text-white/90">
                      {plan.planName}
                    </div>
                    <div className="text-[9px] text-white/60 mt-0.5 line-clamp-2">
                      {plan.reason ?? '—'}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 text-[9px] px-1.5 mt-1"
                      onClick={() => toast.info('请切换到「调度方案」标签页')}
                    >
                      前往审批
                    </Button>
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

      {/* Card 3: Events to watch */}
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
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-white/70 text-center py-4">暂无未结事件</div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Card 4: Quick actions */}
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
            onClick={() => toast.info('请切换到「调度方案」标签页')}
          >
            <Sparkles className="w-3 h-3" />
            生成调度方案
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => toast.info('请切换到「事件中心」标签页')}
          >
            <AlertTriangle className="w-3 h-3" />
            查看事件中心
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => toast.info('请切换到「时间轴回放」标签页')}
          >
            <Clock className="w-3 h-3" />
            时间轴回放
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[10px] justify-start"
            onClick={() => toast.info('请切换到地图视图')}
          >
            <Map className="w-3 h-3" />
            查看地图
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
