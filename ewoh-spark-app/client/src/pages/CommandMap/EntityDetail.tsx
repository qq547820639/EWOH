import { useEffect, useMemo, useRef } from 'react';
import { X, MapPin } from 'lucide-react';
import type {
  CurrentWorldState,
  DeviceInfo,
  EventInfo,
  OrganizationInfo,
  PersonnelInfo,
  SpatialEntity,
} from '@shared/api.interface';
import { UI_ARIA_LABELS } from '../../lib/a11y';
import { resolveEntityDetailData } from './entityDetailData';

interface EntityDetailProps {
  entityId: string | null;
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  personnel?: PersonnelInfo[];
  organizations?: OrganizationInfo[];
  devices?: DeviceInfo[];
  events?: EventInfo[];
  /** 调度解释：personId → 分配说明（why / 备选 / 路由估算） */
  planExplanation?: Map<string, PlanExplanation> | null;
  onOpenDisposition?: (eventId: string) => void;
  onClose?: () => void;
}

/** 单个人员的调度解释结构（与 CommandMap 保持一致）。 */
interface PlanExplanation {
  taskId: string;
  reasons: string[];
  alternatives: Array<Record<string, unknown>>;
  stationId: string | null;
  routeDistanceM?: number;
  plannedStart: string | null;
  plannedEnd: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  factory: '工厂',
  workshop: '车间',
  production_line: '产线',
  zone: '区域',
  workstation: '工位',
  device: '设备',
  person: '人员',
  camera: '摄像头',
  uwb_station: 'UWB基站',
  route: '通道',
  restricted_zone: '禁区',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-white/5">
      <span className="text-[11px] text-white/60 w-16 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-white/80 break-all flex-1">{value ?? '—'}</span>
    </div>
  );
}

function EventList({
  events,
  onOpenDisposition,
}: {
  events: EventInfo[];
  onOpenDisposition?: (eventId: string) => void;
}): React.ReactElement {
  if (events.length === 0) {
    return <p className="py-1 text-[11px] text-white/50">无</p>;
  }
  return (
    <div className="space-y-1">
      {events.map((event) => (
        <div key={event.eventId} className="rounded bg-white/5 p-2">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-[11px] text-white/80">{event.title}</span>
            <span className="shrink-0 text-[10px] text-white/50">{event.severity}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-1">
            <span className="truncate text-[10px] text-white/50">
              {event.status}
              {event.createdAt
                ? ` · ${new Date(event.createdAt).toLocaleString('zh-CN', { hour12: false })}`
                : ''}
            </span>
            {onOpenDisposition && (
              <button
                type="button"
                onClick={() => onOpenDisposition(event.eventId)}
                className="shrink-0 text-[10px] text-[hsl(217_91%_60%)] hover:underline"
              >
                处置
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const EntityDetail = ({
  entityId,
  entities,
  worldState,
  personnel = [],
  organizations = [],
  devices = [],
  events = [],
  planExplanation,
  onOpenDisposition,
  onClose,
}: EntityDetailProps): React.ReactElement => {
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const isOpen = Boolean(entityId);
    if (isOpen) {
      if (!wasOpenRef.current) {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      wasOpenRef.current = true;
      window.requestAnimationFrame(() => panelRef.current?.focus());
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }
  }, [entityId]);

  const entity = entityId
    ? entities.find((e) => e.entityId === entityId) ?? null
    : null;

  const personState =
    entity?.entityType === 'person' && worldState
      ? worldState.persons.find((p) => p.entityId === entity.entityId) ?? null
      : null;
  const deviceState =
    entity?.entityType === 'device' && worldState
      ? worldState.devices.find((d) => d.entityId === entity.entityId) ?? null
      : null;
  const workstationState =
    entity?.entityType === 'workstation' && worldState
      ? worldState.workstations.find((w) => w.entityId === entity.entityId) ?? null
      : null;

  const parent = entity?.parentId
    ? entities.find((e) => e.entityId === entity.parentId)
    : null;

  const detailData = useMemo(
    () => resolveEntityDetailData(entity, personnel, organizations, devices, events),
    [entity, personnel, organizations, devices, events],
  );

  const formatTime = (ts: string | null | undefined) =>
    ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';

  const content = entity ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-white truncate">{entity.name}</h3>
          <span className="inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[hsl(221_83%_53%)]/20 text-[hsl(217_91%_60%)]">
            {TYPE_LABELS[entity.entityType] ?? entity.entityType}
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            aria-label={UI_ARIA_LABELS.closeEntityDetail}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0">
          <Row
            label="实体ID"
            value={<code className="text-[11px] text-white/70">{entity.entityId}</code>}
          />
          <Row label="类型" value={TYPE_LABELS[entity.entityType] ?? entity.entityType} />
          <Row label="父级" value={parent ? parent.name : (entity.parentId ?? '—')} />
          <Row label="坐标" value={`(${entity.x}, ${entity.y})`} />
          <Row label="朝向" value={`${entity.yaw}°`} />
          <Row label="边界框" value={`${entity.bboxW} × ${entity.bboxH}`} />
          <Row label="状态" value={entity.status || '—'} />
          <Row label="来源" value={entity.sourceType || '—'} />
          <Row label="置信度" value={`${(entity.confidence * 100).toFixed(1)}%`} />
          <Row label="版本" value={`v${entity.version}`} />
          <Row label="更新时间" value={formatTime(entity.updatedAt)} />
        </div>

        {personState && (
          <div className="mt-3">
            <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
              实时状态
            </div>
            <Row label="设备ID" value={personState.deviceId ?? '—'} />
            <Row label="任务" value={personState.task ?? '—'} />
            <Row
              label="负荷"
              value={
                personState.loadScore != null
                  ? `${(personState.loadScore * 100).toFixed(0)}%`
                  : '—'
              }
            />
          </div>
        )}

        {detailData.person && (
          <div className="mt-3">
            <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
              人员档案
            </div>
            <Row
              label="组织"
              value={
                detailData.person.organization?.name ??
                detailData.person.personnel?.orgId ??
                '—'
              }
            />
            <Row label="岗位" value={detailData.person.personnel?.position ?? '—'} />
            <Row label="班组" value={detailData.person.personnel?.teamName ?? '—'} />
            <Row
              label="技能"
              value={detailData.person.personnel?.skills?.join('、') ?? '—'}
            />
            <Row
              label="风险"
              value={detailData.person.personnel?.riskLevel ?? '—'}
            />
            <Row
              label="外骨骼"
              value={personState?.deviceId ?? '未绑定'}
            />
            <div className="pt-2 text-[10px] text-white/60 uppercase tracking-wide">
              告警（{detailData.person.alerts.length}）
            </div>
            <EventList
              events={detailData.person.alerts}
              onOpenDisposition={onOpenDisposition}
            />
            <div className="pt-2 text-[10px] text-white/60 uppercase tracking-wide">
              最近事件
            </div>
            <EventList
              events={detailData.person.recentEvents}
              onOpenDisposition={onOpenDisposition}
            />
          </div>
        )}

        {entity?.entityType === 'person' &&
          entityId &&
          (() => {
            const exp = planExplanation?.get(entityId);
            if (!exp) return null;
            return (
              <div className="mt-3">
                <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
                  调度解释
                </div>
                <Row label="任务" value={exp.taskId} />
                <Row label="目标工位" value={exp.stationId ?? '—'} />
                <Row
                  label="规划窗口"
                  value={`${formatTime(exp.plannedStart)} → ${formatTime(exp.plannedEnd)}`}
                />
                <Row
                  label="路由估算"
                  value={
                    exp.routeDistanceM != null
                      ? `${exp.routeDistanceM.toFixed(0)} m`
                      : '—'
                  }
                />
                <div className="pt-2 text-[10px] text-white/60 uppercase tracking-wide">
                  选择理由
                </div>
                <div className="space-y-0.5">
                  {exp.reasons.length > 0 ? (
                    exp.reasons.map((r, i) => (
                      <div key={i} className="flex items-start gap-1 text-[11px] text-white/75">
                        <span className="text-white/30">·</span>
                        <span>{r}</span>
                      </div>
                    ))
                  ) : (
                    <div className="text-[11px] text-white/40">—</div>
                  )}
                </div>
                <div className="pt-2 text-[10px] text-white/60 uppercase tracking-wide">
                  备选人员（{exp.alternatives.length}）
                </div>
                <div className="space-y-0.5">
                  {exp.alternatives.length > 0 ? (
                    exp.alternatives.map((alt, i) => (
                      <div key={i} className="text-[11px] text-white/60">
                        {String(alt.personId ?? alt.person ?? '—')}
                        {alt.reason ? ` — ${String(alt.reason)}` : ''}
                      </div>
                    ))
                  ) : (
                    <div className="text-[11px] text-white/40">—</div>
                  )}
                </div>
              </div>
            );
          })()}

        {deviceState && (
          <div className="mt-3">
            <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
              实时状态
            </div>
            <Row label="设备ID" value={deviceState.deviceId ?? '—'} />
            <Row label="关联人员" value={deviceState.workerId ?? '—'} />
            <Row label="状态" value={deviceState.status || '—'} />
          </div>
        )}

        {detailData.device && (
          <div className="mt-3">
            <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
              设备档案
            </div>
            <Row
              label="电量"
              value={
                detailData.device.device?.batteryPct != null
                  ? `${detailData.device.device.batteryPct}%`
                  : '—'
              }
            />
            <Row
              label="固件"
              value={detailData.device.device?.firmwareVersion ?? '—'}
            />
            <Row
              label="协议"
              value={detailData.device.device?.protocolVersion ?? '—'}
            />
            <Row
              label="故障码"
              value={detailData.device.device?.faultCode ?? '—'}
            />
            <Row
              label="温度"
              value={
                detailData.device.device?.temperatureC != null
                  ? `${detailData.device.device.temperatureC}°C`
                  : '—'
              }
            />
            <Row
              label="最近通信"
              value={formatTime(detailData.device.device?.lastTelemetryAt)}
            />
            <div className="pt-2 text-[10px] text-white/60 uppercase tracking-wide">
              告警（{detailData.device.alerts.length}）
            </div>
            <EventList
              events={detailData.device.alerts}
              onOpenDisposition={onOpenDisposition}
            />
            <div className="pt-2 text-[10px] text-white/60 uppercase tracking-wide">
              最近事件
            </div>
            <EventList
              events={detailData.device.recentEvents}
              onOpenDisposition={onOpenDisposition}
            />
          </div>
        )}

        {workstationState && (
          <div className="mt-3">
            <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
              实时状态
            </div>
            <Row
              label="占用率"
              value={`${(workstationState.occupancy * 100).toFixed(0)}%`}
            />
            <Row label="状态" value={workstationState.status || '—'} />
          </div>
        )}

        {entity.extra && Object.keys(entity.extra).length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] text-white/60 uppercase tracking-wide mb-1">
              扩展字段
            </div>
            <pre className="text-[10px] text-white/60 bg-black/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(entity.extra, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  ) : (
    <div className="h-full flex flex-col items-center justify-center text-center py-10">
      <MapPin className="w-8 h-8 text-white/70 mb-2" />
      <p className="text-xs text-white/60">点击地图实体查看详情</p>
    </div>
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label="实体详情"
      className={`${
        entity
          ? 'absolute right-0 top-0 bottom-0 z-30 w-[280px] max-w-[calc(100%-1rem)] md:static md:z-auto md:max-w-none'
          : 'hidden w-[280px] md:block'
      } shrink-0 bg-[hsl(220_14%_14%)] border-l border-white/10 p-4`}
    >
      {content}
    </div>
  );
};

export default EntityDetail;
