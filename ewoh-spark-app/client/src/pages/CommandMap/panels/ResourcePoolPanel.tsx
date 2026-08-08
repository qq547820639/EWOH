import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Users,
  Cpu,
  Factory,
  Activity,
  Battery,
  ChevronDown,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
// @deprecated 兼容路径：仅用于“AI 评估”展示，不再是调度写入路径。
import { allocateResources } from '@client/src/api/gamification';
import { replan } from '@client/src/api/scheduler';
import { getDevices } from '@client/src/api/dashboard';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { getCurrentOperator } from '@client/src/lib/auth';
import type {
  SpatialEntity,
  CurrentWorldState,
  DeviceInfo,
  ResourceItem,
  ResourceAllocationRequest,
  ResourceAllocationResult,
  AllocationEvaluation,
  SchedulingConstraint,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { ScrollArea } from '@client/src/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@client/src/components/ui/dropdown-menu';

interface ResourcePoolPanelProps {
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  /** 当前活动方案 ID（V2）。手动资源操作会作为 SchedulingConstraint 提交，触发对该方案的重排。 */
  planId?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  busy: '忙碌',
  idle: '空闲',
  occupied: '占用',
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'online':
    case 'idle':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'busy':
    case 'occupied':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'offline':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

function loadColor(load: number): string {
  if (load >= 0.8) return 'bg-red-500';
  if (load >= 0.6) return 'bg-orange-500';
  return 'bg-green-500';
}

function batteryColor(pct: number): string {
  if (pct <= 20) return 'bg-red-500';
  if (pct <= 50) return 'bg-orange-500';
  return 'bg-green-500';
}

function overallBadgeClass(overall: AllocationEvaluation['overall']): string {
  switch (overall) {
    case 'green':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'yellow':
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'red':
    default:
      return 'bg-red-500/20 text-red-400 border-red-500/30';
  }
}

function overallIcon(overall: AllocationEvaluation['overall']) {
  const cls = 'w-3.5 h-3.5';
  switch (overall) {
    case 'green':
      return <CheckCircle2 className={cls} />;
    case 'yellow':
      return <AlertTriangle className={cls} />;
    case 'red':
    default:
      return <XCircle className={cls} />;
  }
}

function buildResourceItems(
  entities: SpatialEntity[],
  worldState: CurrentWorldState | null,
  deviceInfos: DeviceInfo[] | undefined,
): { persons: ResourceItem[]; devices: ResourceItem[]; workstations: ResourceItem[] } {
  const persons: ResourceItem[] = [];
  const devices: ResourceItem[] = [];
  const workstations: ResourceItem[] = [];
  const workstationIds = new Set(
    entities.filter((e) => e.entityType === 'workstation').map((e) => e.entityId),
  );

  const assignedWorkstation = (entity: SpatialEntity, parentId?: string | null): string | null => {
    const candidate = parentId ?? entity.parentId;
    return candidate && workstationIds.has(candidate) ? candidate : null;
  };

  for (const e of entities) {
    if (e.entityType === 'person') {
      const p = worldState?.persons.find((x) => x.entityId === e.entityId);
      persons.push({
        entityId: e.entityId,
        name: e.name,
        type: 'person',
        assignedWorkstationId: assignedWorkstation(e),
        loadScore: p?.loadScore ?? null,
        status: p?.status ?? e.status ?? 'idle',
      });
    } else if (e.entityType === 'device') {
      const d = worldState?.devices.find((x) => x.entityId === e.entityId);
      const info = deviceInfos?.find(
        (item) => item.entityId === e.entityId || item.deviceId === e.entityId,
      );
      const extraBattery =
        typeof e.extra?.batteryPct === 'number' ? (e.extra.batteryPct as number) : null;
      const batteryPct = info?.batteryPct ?? extraBattery ?? null;
      devices.push({
        entityId: e.entityId,
        name: e.name,
        type: 'device',
        assignedWorkstationId: assignedWorkstation(e, info?.parentId),
        batteryPct,
        status: info ? (info.online ? 'online' : 'offline') : d?.status ?? e.status ?? 'online',
      });
    } else if (e.entityType === 'workstation') {
      const w = worldState?.workstations.find((x) => x.entityId === e.entityId);
      workstations.push({
        entityId: e.entityId,
        name: e.name,
        type: 'workstation',
        status: w?.status ?? e.status ?? 'idle',
        loadScore: w ? w.occupancy : null,
      });
    }
  }

  return { persons, devices, workstations };
}

function ResourceCard({
  item,
  workstations,
  onAllocate,
}: {
  item: ResourceItem;
  workstations: ResourceItem[];
  onAllocate: (targetId: string) => void;
}): React.ReactElement {
  const isPerson = item.type === 'person';
  const isDevice = item.type === 'device';
  const load = item.loadScore ?? 0;
  const battery = item.batteryPct ?? null;
  const assigned = workstations.find((w) => w.entityId === item.assignedWorkstationId);

  return (
    <div className="bg-white/5 rounded-lg p-3 border border-white/10">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-white/90 truncate">{item.name}</div>
          <div className="text-[10px] text-white/60 truncate mt-0.5">
            {item.entityId}
          </div>
        </div>
        <Badge
          className={cn('text-[9px] px-1.5 py-0', statusBadgeClass(item.status))}
        >
          {STATUS_LABEL[item.status] ?? item.status}
        </Badge>
      </div>

      {isPerson && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] text-white/70">
            <span>负荷</span>
            <span className="tabular-nums">{(load * 100).toFixed(0)}%</span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className={cn('h-full rounded-full', loadColor(load))}
              style={{ width: `${Math.min(100, load * 100)}%` }}
            />
          </div>
        </div>
      )}

      {isDevice && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] text-white/70">
            <span className="flex items-center gap-1">
              <Battery className="w-3 h-3" />
              电量
            </span>
            <span className="tabular-nums">{battery == null ? '—' : `${battery.toFixed(0)}%`}</span>
          </div>
          {battery == null ? (
            <div className="mt-0.5 h-1.5 rounded-full bg-white/10" />
          ) : (
            <div className="mt-0.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className={cn('h-full rounded-full', batteryColor(battery))}
                style={{ width: `${Math.min(100, battery)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {assigned && (
        <div className="mt-2 text-[10px] text-white/70">
          已分配: <span className="text-white/80">{assigned.name}</span>
        </div>
      )}

      {(isPerson || isDevice) && workstations.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="w-full h-6 mt-2 text-[10px]"
            >
              <ChevronDown className="w-3 h-3" />
              分配
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="bg-[hsl(220_14%_14%)] border-white/10 text-white min-w-[10rem]"
          >
            <DropdownMenuLabel className="text-[10px] text-white/70">
              选择目标工位
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-white/10" />
            {workstations.map((w) => (
              <DropdownMenuItem
                key={w.entityId}
                className="text-xs text-white/80 hover:bg-white/10 focus:bg-white/10"
                onClick={() => onAllocate(w.entityId)}
              >
                {w.name}
                <span className="ml-auto text-[9px] text-white/60">{w.entityId}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function EvaluationPanel({
  result,
}: {
  result: ResourceAllocationResult | null;
}): React.ReactElement {
  if (!result) {
    return (
      <div className="bg-white/5 rounded-lg p-3 border border-white/10 text-xs text-white/70">
        暂未进行 AI 评估，请分配资源后查看评估结果。
      </div>
    );
  }
  const ev = result.evaluation;
  return (
    <div className="bg-white/5 rounded-lg p-3 border border-white/10">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs text-white/80">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          AI 评估
          <Badge className="text-[9px] px-1 py-0 text-white/60 bg-white/10 border-white/10">
            已废弃·只读
          </Badge>
        </div>
        <Badge className={cn('text-[9px] px-1.5 py-0', overallBadgeClass(ev.overall))}>
          {overallIcon(ev.overall)}
          {ev.overall.toUpperCase()}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div>
          <div className="text-white/60">负荷均衡</div>
          <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-cyan-500 rounded-full"
              style={{ width: `${ev.loadBalance * 100}%` }}
            />
          </div>
          <div className="mt-0.5 text-white/70 tabular-nums">
            {(ev.loadBalance * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-white/60">技能匹配</div>
          <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-violet-500 rounded-full"
              style={{ width: `${ev.skillMatch * 100}%` }}
            />
          </div>
          <div className="mt-0.5 text-white/70 tabular-nums">
            {(ev.skillMatch * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-white/60">电量续航</div>
          <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full"
              style={{ width: `${ev.batteryEndurance * 100}%` }}
            />
          </div>
          <div className="mt-0.5 text-white/70 tabular-nums">
            {(ev.batteryEndurance * 100).toFixed(0)}%
          </div>
        </div>
      </div>

      {(ev.conflicts.length > 0 || ev.suggestions.length > 0) && (
        <div className="mt-2 space-y-1">
          {ev.conflicts.map((c, i) => (
            <div
              key={`c-${i}`}
              className="flex items-start gap-1 text-[10px] text-red-400"
            >
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{c}</span>
            </div>
          ))}
          {ev.suggestions.map((s, i) => (
            <div
              key={`s-${i}`}
              className="flex items-start gap-1 text-[10px] text-white/60"
            >
              <Sparkles className="w-3 h-3 mt-0.5 shrink-0 text-cyan-400" />
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 text-[10px] text-white/60">方案ID: {result.planId}</div>
    </div>
  );
}

const ResourcePoolPanel = ({
  entities,
  worldState,
  planId,
}: ResourcePoolPanelProps): React.ReactElement => {
  const { data: deviceInfos } = useQuery<DeviceInfo[]>({
    queryKey: queryKeys.devices(),
    queryFn: getDevices,
    refetchInterval: 30000,
  });

  const { persons, devices, workstations } = useMemo(
    () => buildResourceItems(entities, worldState, deviceInfos),
    [entities, worldState, deviceInfos],
  );

  const [allocations, setAllocations] = useState<
    Record<string, { targetType: 'workstation'; targetId: string }>
  >({});
  const [latestResult, setLatestResult] = useState<ResourceAllocationResult | null>(
    null,
  );

  /**
   * @deprecated 兼容评估路径：仅用于“AI 评估”展示，不再是授权的调度写入路径。
   * 正式的调度写入路径为 handleCommit → replan（SchedulingConstraint + V2 重排）。
   */
  const allocateMutation = useMutation({
    mutationFn: (body: ResourceAllocationRequest) => allocateResources(body),
    onSuccess: (data) => {
      setLatestResult(data);
      toast.success(`AI 评估完成: ${data.evaluation.overall.toUpperCase()}`);
      setAllocations({});
    },
    onError: () => {
      toast.error('资源分配失败');
    },
  });

  /**
   * 正式调度写入路径：把手动分配/锁定操作转换为 SchedulingConstraint，
   * 提交到现有 V2 replan 机制（复用 solver + SchedulingConstraint 架构，不另建第二套调度器）。
   */
  const replanMutation = useMutation({
    mutationFn: (body: {
      constraints: SchedulingConstraint[];
      operator?: string;
      reason?: string;
    }) => replan(planId!, { lockedConstraints: body.constraints, operator: body.operator, reason: body.reason }),
    onSuccess: () => {
      toast.success('约束已提交，重排完成');
      setAllocations({});
    },
    onError: () => {
      toast.error('重排失败');
    },
  });

  const handlePickTarget = (entityId: string, targetId: string) => {
    setAllocations((prev) => ({
      ...prev,
      [entityId]: { targetType: 'workstation', targetId },
    }));
  };

  /** 将手动分配目标转换为求解器可执行的锁定约束（LOCKED_PERSON / LOCKED_DEVICE + 目标工位）。 */
  const buildLockConstraints = (): SchedulingConstraint[] => {
    const personIds = new Set(persons.map((p) => p.entityId));
    const deviceIds = new Set(devices.map((d) => d.entityId));
    const constraints: SchedulingConstraint[] = [];
    for (const [entityId, v] of Object.entries(allocations)) {
      if (personIds.has(entityId)) {
        constraints.push({ type: 'LOCKED_PERSON', personId: entityId, stationId: v.targetId });
      } else if (deviceIds.has(entityId)) {
        constraints.push({ type: 'LOCKED_DEVICE', deviceId: entityId, stationId: v.targetId });
      }
    }
    return constraints;
  };

  /** 正式调度写入：提交约束并触发 V2 重排。 */
  const handleCommit = () => {
    if (!planId) {
      toast.error('请先在调度工作台选择活动方案');
      return;
    }
    const constraints = buildLockConstraints();
    if (constraints.length === 0) {
      toast.error('请先选择分配目标');
      return;
    }
    replanMutation.mutate({
      constraints,
      operator: getCurrentOperator(),
      reason: '资源池手动分配（SchedulingConstraint）',
    });
  };

  /** @deprecated 兼容评估：仅演示 AI 评估，不写入调度。 */
  const handleLegacyEvaluate = () => {
    const list = Object.entries(allocations).map(([entityId, v]) => ({
      entityId,
      targetType: v.targetType as 'person' | 'device',
      targetId: v.targetId,
    }));
    if (list.length === 0) {
      toast.error('请先选择分配目标');
      return;
    }
    allocateMutation.mutate({ allocations: list, operator: getCurrentOperator() });
  };

  const renderColumn = (
    title: string,
    icon: LucideIcon,
    items: ResourceItem[],
    accent: string,
  ) => {
    const Icon = icon;
    return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 border-r border-white/10 last:border-r-0">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/10 shrink-0">
        <Icon className={cn('w-3.5 h-3.5', accent)} />
        <span className="text-xs font-medium text-white/80">{title}</span>
        <span className="ml-auto text-[10px] text-white/60 tabular-nums">
          {items.length}
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {items.length === 0 ? (
            <div className="text-[10px] text-white/60 text-center py-4">暂无数据</div>
          ) : (
            items.map((item) => {
              const assigned =
                allocations[item.entityId]?.targetId ?? item.assignedWorkstationId ?? null;
              return (
                <ResourceCard
                  key={item.entityId}
                  item={{ ...item, assignedWorkstationId: assigned }}
                  workstations={workstations}
                  onAllocate={(targetId) => handlePickTarget(item.entityId, targetId)}
                />
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-[hsl(220_14%_14%)] text-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <Activity className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-xs font-medium text-white/80">资源池</span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] px-2"
          onClick={handleCommit}
          disabled={replanMutation.isPending || Object.keys(allocations).length === 0}
          title={planId ? undefined : '请先在调度工作台选择活动方案'}
        >
          <Sparkles className="w-3 h-3" />
          {replanMutation.isPending
            ? '重排中...'
            : `提交约束并重排 (${Object.keys(allocations).length})`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[10px] px-2 text-white/50"
          onClick={handleLegacyEvaluate}
          disabled={allocateMutation.isPending || Object.keys(allocations).length === 0}
          title="已废弃：仅用于 AI 评估展示，不再写入调度"
        >
          评估/兼容
        </Button>
      </div>

      <div className="flex-1 flex min-h-0">
        {renderColumn('人员', Users, persons, 'text-green-400')}
        {renderColumn('设备', Cpu, devices, 'text-blue-400')}
        {renderColumn('工位', Factory, workstations, 'text-orange-400')}
      </div>

      <div className="shrink-0 border-t border-white/10 p-2 max-h-[120px] overflow-y-auto">
        <EvaluationPanel result={latestResult} />
      </div>
    </div>
  );
};

export default ResourcePoolPanel;
