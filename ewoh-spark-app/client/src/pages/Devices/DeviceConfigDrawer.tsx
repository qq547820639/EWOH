import { useEffect, useMemo, useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Factory,
  Building2,
  Layers,
  Boxes,
  Square,
  MapPin,
  Cpu,
  User,
  ChevronRight,
  Link2,
  Unlink,
  Save,
  X,
  History,
  Check,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type {
  DeviceInfo,
  CreateDeviceDto,
  UpdateDeviceDto,
  BindDeviceRequest,
  SpatialHierarchyNode,
  PersonnelInfo,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { errorDescription } from '@client/src/lib/errorContract';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { Switch } from '@client/src/components/ui/switch';
import { Badge } from '@client/src/components/ui/badge';
import { Separator } from '@client/src/components/ui/separator';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from '@client/src/components/ui/drawer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@client/src/components/ui/command';
import {
  createDevice,
  updateDevice,
  getDevices,
  getDeviceBindings,
  bindDevice,
  unbindDevice,
  getTelemetry,
  getDeviceDetail,
} from '@client/src/api/dashboard';
import { getHierarchy, getEntities } from '@client/src/api/spatial';
import { buildCapabilityViews, hasRegisteredLocation, formatDeviceCategory } from './devicesLogic';
import { listPersonnel } from '@client/src/api/organization';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@client/src/components/ui/dialog';
import { capabilityActionLabel, DISABLED_REVIEW_THRESHOLD_DAYS, type DeviceCapabilityView } from './devicesLogic';
import {
  describeApprovalFreshness,
  describeRestoreApprovalStatus,
  describeRestoreRejection,
  restoreRequiresSafetyApproval,
} from './devicesLogic';
import { requestDeviceCapabilityRestoreApproval, setDeviceCapabilityStatus } from '../../api/dashboard';
import { getApprovalDetail } from '@client/src/api/approvals';
import { queryKeys } from '@client/src/hooks/queryKeys';
import Timeline from '@client/src/components/Timeline';
import { normalizeTimelineEvent } from '@client/src/lib/timelineModel';
import ExecutionBoundaryPanel from './ExecutionBoundaryPanel';

export interface DeviceConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  device?: DeviceInfo | null;
  onSuccess?: () => void;
}

const ENTITY_TYPE_META: Record<
  string,
  { label: string; icon: LucideIcon }
> = {
  factory: { label: '工厂', icon: Factory },
  workshop: { label: '车间', icon: Building2 },
  production_line: { label: '产线', icon: Layers },
  zone: { label: '区域', icon: Boxes },
  workstation: { label: '工位', icon: Square },
};

const SOURCE_OPTIONS = [
  { value: 'real', label: '真机 (real)' },
  { value: 'simulated', label: '模拟 (simulated)' },
  { value: 'controlled_test', label: '受控测试 (controlled_test)' },
];

function sourceLabel(source?: string): string {
  const found = SOURCE_OPTIONS.find((o) => o.value === source);
  return found ? found.label : source ? source : '—';
}

const DeviceConfigDrawer = ({
  open,
  onOpenChange,
  mode,
  device,
  onSuccess,
}: DeviceConfigDrawerProps): React.ReactElement => {
  const isEdit = mode === 'edit';
  const queryClient = useQueryClient();

  // BUG-004 修复：vaul direction="right" 在某些版本中 ESC 键处理有缺陷，
  // 添加显式 keydown 监听作为后备关闭机制。
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        onOpenChange(false);
      }
    },
    [open, onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  // ===== 表单状态 =====
  const [deviceId, setDeviceId] = useState('');
  // 2026-08-20 移除 workerName（手动输入姓名已废弃，统一走结构化人员绑定下拉）。
  const [deviceModel, setDeviceModel] = useState('');
  const [batteryPct, setBatteryPct] = useState<string>('');
  const [online, setOnline] = useState(false);
  const [sourceType, setSourceType] = useState<string>('real');
  const [firmwareVersion, setFirmwareVersion] = useState('');
  const [hardwareVersion, setHardwareVersion] = useState('');
  const [protocolVersion, setProtocolVersion] = useState('');
  const [faultCode, setFaultCode] = useState('');
  const [temperatureC, setTemperatureC] = useState<string>('');

  // ===== 层级树选择器状态 =====
  const [showHierarchyPicker, setShowHierarchyPicker] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  // UX-IA-2026-08：编辑模式 3 步向导（0 基本信息 → 1 绑定关系 → 2 状态历史），
  // 新增模式仅步骤 0（绑定/历史依赖已保存设备，仅编辑可用）。
  const [step, setStep] = useState(0);
  const STEP_LABELS = ['基本信息', '绑定关系', '状态历史'] as const;

  // 打开/切换设备时同步表单
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setShowHierarchyPicker(false);
    setSelectedEntityId(null);
    if (isEdit && device) {
      setDeviceId(device.deviceId);
      setDeviceModel(device.deviceModel ?? '');
      setBatteryPct(device.batteryPct != null ? String(device.batteryPct) : '');
      setOnline(device.online ?? false);
      setSourceType(device.sourceType ?? 'real');
      setFirmwareVersion(device.firmwareVersion ?? '');
      setHardwareVersion(device.hardwareVersion ?? '');
      setProtocolVersion(device.protocolVersion ?? '');
      setFaultCode(device.faultCode ?? '');
      setTemperatureC(device.temperatureC != null ? String(device.temperatureC) : '');
    } else {
      setDeviceId('');
      setDeviceModel('');
      setBatteryPct('');
      setOnline(false);
      setSourceType('real');
      setFirmwareVersion('');
      setHardwareVersion('');
      setProtocolVersion('');
      setFaultCode('');
      setTemperatureC('');
    }
  }, [open, device, isEdit]);

  // ===== 保存设备 =====
  const saveMutation = useMutation({
    mutationFn: async () => {
      const battery = batteryPct === '' ? undefined : Number(batteryPct);
      const temp = temperatureC === '' ? undefined : Number(temperatureC);
      if (isEdit && device) {
        const body: UpdateDeviceDto = {
          deviceModel: deviceModel || undefined,
          batteryPct: battery,
          online,
          firmwareVersion: firmwareVersion || undefined,
          hardwareVersion: hardwareVersion || undefined,
          protocolVersion: protocolVersion || undefined,
          faultCode: faultCode || undefined,
          temperatureC: temp,
        };
        return updateDevice(device.deviceId, body);
      }
      const body: CreateDeviceDto = {
        deviceId: deviceId.trim(),
        deviceModel: deviceModel || undefined,
        batteryPct: battery,
        online,
        sourceType: sourceType || undefined,
        firmwareVersion: firmwareVersion || undefined,
        hardwareVersion: hardwareVersion || undefined,
        protocolVersion: protocolVersion || undefined,
      };
      return createDevice(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? '设备已更新' : '设备已创建');
      onSuccess?.();
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error('保存失败', {
        description: errorDescription(err),
      });
    },
  });

  const handleSave = () => {
    if (!isEdit && !deviceId.trim()) {
      toast.error('请填写设备ID');
      return;
    }
    saveMutation.mutate();
  };

  // ===== 绑定关系（仅 edit 模式） =====
  const bindingsQuery = useQuery({
    queryKey: queryKeys.deviceBindings(device?.deviceId),
    queryFn: () => getDeviceBindings(device!.deviceId),
    enabled: isEdit && open && !!device?.deviceId,
    refetchOnWindowFocus: false,
  });

  const personsQuery = useQuery({
    queryKey: queryKeys.spatialEntities,
    queryFn: () => getEntities({ type: 'person' }),
    enabled: isEdit && open,
    select: (items) => items.filter((item) => item.entityType === 'person'),
  });

  // ===== 绑定人员下拉（2026-08-20：替代手动输入 workerName）=====
  // 主数据源：人员与外骨骼档案（含姓名/工号，按档案实时同步）；
  // 空间身份映射：存量人员 spatial person 为 P0xx（地图/绑定原生身份），
  // 新增人员由 createPersonnel 同步建 UUID spatial 实体——绑定时 person 端
  // 一律取 spatial person id，保证 bindDevice 与 boundPersonName 反查可通。
  const personnelQuery = useQuery({
    queryKey: queryKeys.personnel({}),
    queryFn: () => listPersonnel({}),
    enabled: isEdit && open,
    refetchOnWindowFocus: true,
  });
  // 全部设备（boundPersonId 反查：某人员已被哪台设备占用）。
  const allDevicesQuery = useQuery({
    queryKey: queryKeys.devices({}),
    queryFn: () => getDevices(),
    enabled: isEdit && open,
    refetchOnWindowFocus: true,
  });
  const spatialPersons = personsQuery.data ?? [];
  /** name → spatial person entityId（存量 P0xx 映射；无映射者直接用档案 UUID）。 */
  const nameToSpatialId = useMemo(() => {
    const m = new Map<string, string>();
    for (const sp of spatialPersons) {
      if (!m.has(sp.name)) m.set(sp.name, sp.entityId);
    }
    return m;
  }, [spatialPersons]);
  const personSpatialId = (p: PersonnelInfo): string =>
    nameToSpatialId.get(p.name) ?? p.id;
  /** spatialId → 占用该人员的设备（一人一设备）。 */
  const deviceByPerson = useMemo(() => {
    const m = new Map<string, DeviceInfo>();
    for (const d of allDevicesQuery.data ?? []) {
      if (d.boundPersonId) m.set(d.boundPersonId, d);
    }
    return m;
  }, [allDevicesQuery.data]);
  const [personSearch, setPersonSearch] = useState('');
  const [personPickerOpen, setPersonPickerOpen] = useState(false);
  const boundPersonId = bindingsQuery.data?.boundPersonId ?? null;
  const boundPersonName = bindingsQuery.data?.boundPersonName ?? null;
  const filteredPersons = useMemo(() => {
    const kw = personSearch.trim().toLowerCase();
    const base = personnelQuery.data ?? [];
    if (!kw) return base;
    return base.filter(
      (p) =>
        p.name.toLowerCase().includes(kw) ||
        p.employeeNo.toLowerCase().includes(kw),
    );
  }, [personSearch, personnelQuery.data]);
  /** 本设备当前绑定人的 spatialId 若被其他设备占用——理论上不应发生，防御性提示。 */
  const bindPerson = (p: PersonnelInfo) => {
    if (!device) return;
    const spatialId = personSpatialId(p);
    // 防重复（前端拦截，服务端另有 409 硬校验兜底）：
    // 1) 该人员已被其他设备绑定 → 提示先解绑。
    const occupiedBy = deviceByPerson.get(spatialId);
    if (occupiedBy && occupiedBy.deviceId !== device.deviceId) {
      toast.error('绑定失败：该人员已被设备占用', {
        description: `${p.name} 已绑定 ${occupiedBy.deviceId}，请先在「人员与外骨骼」或该设备中解绑。`,
      });
      return;
    }
    // 2) 本设备已绑定其他人员 → 先解绑旧人员再绑定（换绑语义）。
    const doBind = () =>
      bindMutation.mutate({
        // spatialEntityId 传 undefined（服务端 !==undefined 才校验，null 会 404）。
        ...(bindingsQuery.data?.spatialEntityId
          ? { spatialEntityId: bindingsQuery.data.spatialEntityId }
          : {}),
        personEntityId: spatialId,
      });
    if (boundPersonId && boundPersonId !== spatialId) {
      unbindMutation.mutate(undefined, {
        onSuccess: doBind,
        onError: () => {
          toast.error('换绑失败：旧绑定解绑未成功');
        },
      });
      return;
    }
    doBind();
  };

  const hierarchyQuery = useQuery({
    queryKey: queryKeys.spatialHierarchy,
    queryFn: getHierarchy,
    enabled: isEdit && open && showHierarchyPicker,
  });

  // ===== 状态历史 / 统一时间线（仅 edit 模式，复用现有遥测接口） =====
  // 设备详情（含能力清单）：只在编辑模式打开抽屉时取，避免列表 N+1
  const detailQuery = useQuery({
    queryKey: ['device-detail', device?.deviceId],
    queryFn: () => getDeviceDetail(device!.deviceId),
    enabled: isEdit && open && !!device?.deviceId,
    refetchOnWindowFocus: false,
  });
  const capabilityViews = buildCapabilityViews(detailQuery.data?.capabilities ?? null);

  const telemetryQuery = useQuery({
    queryKey: ['device-telemetry', device?.deviceId],
    queryFn: () => getTelemetry(device!.deviceId),
    enabled: isEdit && open && !!device?.deviceId,
    refetchOnWindowFocus: false,
  });

  const timelineEvents = useMemo(
    () =>
      (telemetryQuery.data ?? []).map((t, index) =>
        normalizeTimelineEvent({
          id: t.id || `${device?.deviceId ?? 'device'}-telemetry-${index}`,
          timestamp: t.ts,
          actor: 'device',
          source: 'device',
          objectType: 'device',
          objectId: device?.deviceId,
          action: 'telemetry',
          previousState: null,
          currentState:
            t.qualityStatus ??
            (t.batteryPct != null ? `电量 ${t.batteryPct}%` : null),
          severity: t.qualityStatus === 'fault' ? 'high' : undefined,
          title: `设备遥测 · ${t.deviceId}`,
          status: t.qualityStatus ?? undefined,
          meta: {
            batteryPct: t.batteryPct,
            loadScore: t.loadScore,
            fatigueTrend: t.fatigueTrend,
          },
        }),
      ),
    [telemetryQuery.data, device?.deviceId],
  );

  /** 待变更状态的能力（打开理由对话框；理由必填，与后端同口径）。 */
  const [capabilityTarget, setCapabilityTarget] = useState<DeviceCapabilityView | null>(null);
  const [capabilityReason, setCapabilityReason] = useState('');
  /**
   * NO-21b：高风险能力恢复的审批号与已取得的审批状态。
   *
   * 现场（班组长/设备员）不该自己去翻审批台：对话框内直接发起安全审批、
   * 显示"还在等谁 / 已通过 / 已驳回"，获批后把审批号带进恢复请求。
   */
  const [capabilityApprovalId, setCapabilityApprovalId] = useState('');
  const [capabilityApproval, setCapabilityApproval] = useState<{
    id: string;
    status: string;
    steps?: Array<{ id: string; role: string; status: string }>;
    /** NO-22a：审批通过时间（前端据此显示有效期剩余，不代替后端判定）。 */
    approvedAt?: string | null;
  } | null>(null);
  const [capabilityGateNotice, setCapabilityGateNotice] = useState<string | null>(null);

  const requestRestoreApprovalMutation = useMutation({
    mutationFn: (params: { view: DeviceCapabilityView; reason: string }) =>
      requestDeviceCapabilityRestoreApproval({
        capabilityKey: params.view.name,
        deviceIds: [device!.deviceId],
        reason: params.reason,
      }),
    onSuccess: (data) => {
      setCapabilityApproval(data);
      setCapabilityApprovalId(data.id);
      setCapabilityGateNotice(null);
      const progress = describeRestoreApprovalStatus(data.status, data.steps);
      toast.success('已提交安全审批申请', {
        description: `${progress.label}。审批号：${data.id}`,
      });
    },
    onError: (err: unknown) => {
      toast.error('审批申请失败', { description: errorDescription(err) });
    },
  });

  const checkRestoreApprovalMutation = useMutation({
    mutationFn: (approvalId: string) => getApprovalDetail(approvalId),
    onSuccess: (data) => {
      const steps = (data.steps ?? []).map((step) => ({
        id: step.id,
        role: step.role,
        status: step.status,
      }));
      setCapabilityApproval({
        id: data.id,
        status: data.status ?? 'unknown',
        steps,
        approvedAt: data.approvedAt ?? null,
      });
      const progress = describeRestoreApprovalStatus(data.status, steps);
      if (progress.approved) {
        toast.success('审批已通过', {
          description: `${progress.label}；${describeApprovalFreshness(data.approvedAt ?? null).label}`,
        });
      } else {
        toast.info('审批尚未放行', { description: progress.label });
      }
    },
    onError: (err: unknown) => {
      toast.error('审批状态读取失败', { description: errorDescription(err) });
    },
  });

  const capabilityMutation = useMutation({
    mutationFn: (params: {
      view: DeviceCapabilityView;
      action: 'disable' | 'restore';
      reason: string;
      approvalId?: string;
    }) =>
      setDeviceCapabilityStatus(device!.deviceId, params.view.name, {
        status: params.action === 'disable' ? 'disabled' : 'active',
        reason: params.reason,
        ...(params.approvalId ? { approvalId: params.approvalId } : {}),
      }),
    onSuccess: (data, params) => {
      if (data.changed) {
        toast.success(params.action === 'disable' ? '能力已停用' : '能力已恢复', {
          description: '能力台账已更新并写入审计；调度按新状态重新判断派工资格。',
        });
      } else {
        // 幂等 no-op：如实告知"没有发生变化"，不假装执行过
        toast.info('能力状态未变化', { description: '当前状态与请求一致，未产生新的变更与审计记录。' });
      }
      setCapabilityTarget(null);
      setCapabilityReason('');
      setCapabilityApprovalId('');
      setCapabilityApproval(null);
      setCapabilityGateNotice(null);
      // 详情（能力清单）与列表都要刷新：能力状态变化会改变世界模型对该设备的判断
      queryClient.invalidateQueries({ queryKey: ['device-detail', device!.deviceId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.devices() });
    },
    onError: (err: unknown) => {
      // 三类拒绝的下一步动作不同（无号 / 已过期 / 已用掉），必须分别说明，
      // 并把"该做什么"留在对话框里，而不是只弹一条 toast 就消失
      const rejection = describeRestoreRejection(err);
      if (rejection.nextStep) setCapabilityGateNotice(rejection.nextStep);
      if (rejection.kind === 'approval_stale' || rejection.kind === 'approval_consumed') {
        // 旧审批号已无用：清空输入，避免现场反复用同一个号撞墙
        setCapabilityApprovalId('');
        setCapabilityApproval(null);
      }
      toast.error('能力状态变更失败', { description: errorDescription(err) });
    },
  });

  const invalidateBindingsAndDevices = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.deviceBindings(device?.deviceId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.devices() });
  };

  const bindMutation = useMutation({
    mutationFn: (body: BindDeviceRequest) => bindDevice(device!.deviceId, body),
    onSuccess: (_data, body) => {
      toast.success(body.spatialEntityId ? '空间实体已绑定' : '人员绑定已更新');
      setShowHierarchyPicker(false);
      setSelectedEntityId(null);
      invalidateBindingsAndDevices();
    },
    onError: (err: unknown) => {
      toast.error('绑定失败', {
        description: errorDescription(err),
      });
    },
  });

  const unbindMutation = useMutation({
    mutationFn: () => unbindDevice(device!.deviceId),
    onSuccess: () => {
      toast.success('已解绑');
      invalidateBindingsAndDevices();
    },
    onError: (err: unknown) => {
      toast.error('解绑失败', {
        description: errorDescription(err),
      });
    },
  });

  const handleConfirmBindEntity = () => {
    if (!selectedEntityId) {
      toast.error('请先选择一个空间实体');
      return;
    }
    bindMutation.mutate({
      spatialEntityId: selectedEntityId,
      personEntityId: bindingsQuery.data?.boundPersonId ?? null,
    });
  };

  const bindingPath = bindingsQuery.data?.hierarchyPath ?? [];
  const bindingLoading = bindingsQuery.isLoading;

  /**
   * NO-21b：高风险恢复的"为什么现在不能提交"。
   *
   * 三种情况分开说：没号 / 号已读但未放行 / 可以提交。既不做"点了没反应"的禁用按钮，
   * 也不让未获批的审批看起来可用（后端仍会兜底拒绝）。
   */
  const capabilityNeedsApproval =
    capabilityTarget !== null && restoreRequiresSafetyApproval(capabilityTarget);
  const capabilityApprovalProgress = capabilityApproval
    ? describeRestoreApprovalStatus(capabilityApproval.status, capabilityApproval.steps)
    : null;
  const capabilitySubmitBlockedReason = !capabilityNeedsApproval
    ? null
    : capabilityApprovalId.trim().length === 0
      ? '高风险能力恢复必须带已获批的审批号（后端会拒绝无号恢复）'
      : capabilityApprovalProgress && !capabilityApprovalProgress.approved
        ? `审批尚未放行：${capabilityApprovalProgress.label}；此刻提交会被后端拒绝`
        : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="sm:max-w-[560px] w-full">
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-base text-foreground">
            {isEdit ? '编辑设备' : '新增设备'}
          </DrawerTitle>
          <DrawerDescription className="text-xs text-muted-foreground">
            {isEdit && device
              ? `设备ID：${device.deviceId}`
              : '填写设备基础信息后保存'}
          </DrawerDescription>
          {/* UX-IA-2026-08：分步指示器——按任务分组降低单屏字段密度。 */}
          {isEdit && (
            <div
              role="tablist"
              aria-label="设备配置步骤"
              className="mt-2 flex gap-1 rounded-lg border border-border bg-muted/40 p-1"
            >
              {STEP_LABELS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  role="tab"
                  aria-selected={step === index}
                  onClick={() => setStep(index)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    step === index
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {index + 1}. {label}
                </button>
              ))}
            </div>
          )}
        </DrawerHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
          {/* ===== 设备信息表单（步骤 1；新增模式恒显） ===== */}
          {(step === 0 || !isEdit) && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  设备ID <span className="text-red-500">*</span>
                </Label>
                {isEdit ? (
                  <div className="h-9 px-3 flex items-center rounded-md border border-border bg-muted text-sm text-foreground font-medium">
                    {deviceId}
                  </div>
                ) : (
                  <Input
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    placeholder="例如 EXO-001"
                    className="h-9"
                  />
                )}
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">设备类别</Label>
                <div className="h-9 px-3 flex items-center rounded-md border border-border bg-muted text-sm text-foreground">
                  {formatDeviceCategory(device?.deviceCategory)}
                </div>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">设备型号</Label>
                <Input
                  value={deviceModel}
                  onChange={(e) => setDeviceModel(e.target.value)}
                  placeholder="型号"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">电量 (%)</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={batteryPct}
                  onChange={(e) => setBatteryPct(e.target.value)}
                  placeholder="0-100"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">在线状态</Label>
                <div className="h-9 flex items-center gap-2">
                  <Switch checked={online} onCheckedChange={setOnline} />
                  <span className="text-xs text-foreground">
                    {online ? '在线' : '离线'}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">来源类型</Label>
                {isEdit ? (
                  <div className="h-9 px-3 flex items-center rounded-md border border-border bg-muted text-sm text-muted-foreground">
                    {sourceLabel(sourceType)}
                  </div>
                ) : (
                  <Select value={sourceType} onValueChange={setSourceType}>
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">固件版本</Label>
                <Input
                  value={firmwareVersion}
                  onChange={(e) => setFirmwareVersion(e.target.value)}
                  placeholder="例如 v1.2.0"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">硬件版本</Label>
                <Input
                  value={hardwareVersion}
                  onChange={(e) => setHardwareVersion(e.target.value)}
                  placeholder="例如 HW-2"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">协议版本</Label>
                <Input
                  value={protocolVersion}
                  onChange={(e) => setProtocolVersion(e.target.value)}
                  placeholder="例如 proto-3"
                  className="h-9"
                />
              </div>

              {isEdit && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">故障码</Label>
                    <Input
                      value={faultCode}
                      onChange={(e) => setFaultCode(e.target.value)}
                      placeholder="无"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">温度 (℃)</Label>
                    <Input
                      type="number"
                      value={temperatureC}
                      onChange={(e) => setTemperatureC(e.target.value)}
                      placeholder="例如 36.5"
                      className="h-9"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
          )}

          {/* ===== 绑定关系区块（步骤 2，仅 edit 模式） ===== */}
          {isEdit && step === 1 && (
            <>
              <Separator />
              <div className="space-y-3">
                <div className="flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-sm font-semibold text-foreground">
                    绑定关系
                  </span>
                </div>

                {/* 当前层级路径面包屑 */}
                <div className="rounded-md border border-border bg-muted p-3">
                  <div className="text-[10px] text-muted-foreground mb-1">
                    建筑层级路径
                  </div>
                  {bindingLoading ? (
                    <div className="text-xs text-muted-foreground">加载中...</div>
                  ) : bindingPath.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-0.5 text-xs text-foreground">
                      {bindingPath.map((node, idx) => {
                        const meta = ENTITY_TYPE_META[node.entityType];
                        const Icon = meta?.icon ?? MapPin;
                        return (
                          <span key={node.entityId} className="flex items-center gap-0.5">
                            {idx > 0 && (
                              <ChevronRight className="w-3 h-3 text-muted-foreground" />
                            )}
                            <Icon className="w-3 h-3 text-muted-foreground" />
                            <span>{node.name}</span>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    /* 位置未登记必须显式说清（而不是留白）：地图/空间约束/
                       影响面分析都依赖空间实体，缺它等于这些能力对该设备不可用。 */
                    <div className="text-xs text-muted-foreground" data-testid="device-location-unregistered">
                      位置未登记（未绑定空间实体，地图与空间约束不覆盖该设备）
                    </div>
                  )}
                  {/* 绑定人员：档案下拉（姓名/工号搜索，2026-08-20 替代手动输入） */}
                  <div className="mt-3 space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      绑定人员（从已录入人员中选择）
                    </Label>
                    <Popover
                      open={personPickerOpen}
                      onOpenChange={setPersonPickerOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-expanded={personPickerOpen}
                          className="w-full h-9 justify-between font-normal"
                          disabled={!isEdit}
                        >
                          <span className="inline-flex items-center gap-1.5 truncate">
                            <User className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            {boundPersonName
                              ? boundPersonName
                              : '选择人员…'}
                          </span>
                          <Search className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-[320px] p-0"
                        align="start"
                        side="bottom"
                      >
                        <Command>
                          <CommandInput
                            placeholder="搜索姓名 / 工号…"
                            value={personSearch}
                            onValueChange={setPersonSearch}
                            className="h-9"
                          />
                          <CommandList>
                            <CommandEmpty>
                              {personnelQuery.isLoading
                                ? '正在加载人员…'
                                : '未找到匹配人员'}
                            </CommandEmpty>
                            <CommandGroup heading="人员档案">
                              {filteredPersons.map((p) => {
                                const spatialId = personSpatialId(p);
                                const occupiedBy =
                                  deviceByPerson.get(spatialId);
                                const isSelf =
                                  occupiedBy?.deviceId === device?.deviceId;
                                const isCurrent = boundPersonId === spatialId;
                                const disabledItem =
                                  !!occupiedBy && !isSelf && !isCurrent;
                                return (
                                  <CommandItem
                                    key={p.id}
                                    value={`${p.name} ${p.employeeNo}`}
                                    disabled={disabledItem}
                                    onSelect={() => {
                                      bindPerson(p);
                                      setPersonPickerOpen(false);
                                      setPersonSearch('');
                                    }}
                                    className="flex items-center justify-between gap-2"
                                  >
                                    <span className="flex items-center gap-2 min-w-0">
                                      <span className="truncate font-medium">
                                        {p.name}
                                      </span>
                                      <span className="shrink-0 text-xs text-muted-foreground">
                                        {p.employeeNo}
                                      </span>
                                    </span>
                                    <span className="flex items-center gap-1.5 shrink-0">
                                      {occupiedBy && !isSelf && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] text-red-600 border-red-200 bg-red-50"
                                        >
                                          已绑定 {occupiedBy.deviceId}
                                        </Badge>
                                      )}
                                      {isCurrent && (
                                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                                      )}
                                    </span>
                                  </CommandItem>
                                );
                              })}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {boundPersonName && (
                      <p className="text-[11px] text-muted-foreground">
                        当前绑定：{boundPersonName}。更换人员将自动解绑旧绑定；
                        选中已被他人占用的设备会提示先解绑。
                      </p>
                    )}
                  </div>
                </div>

                {/* 绑定空间实体按钮 + 层级树 */}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedEntityId(null);
                      setShowHierarchyPicker((v) => !v);
                    }}
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    {showHierarchyPicker ? '收起层级选择' : '绑定空间实体'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => unbindMutation.mutate()}
                    disabled={unbindMutation.isPending}
                    className="text-red-600 hover:text-red-700"
                  >
                    <Unlink className="w-3.5 h-3.5" />
                    解绑
                  </Button>
                </div>

                {/* ===== 设备能力（2026-09-10 能力模型）：只读事实，来自摄入登记 ===== */}
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-semibold text-foreground">设备能力</span>
                    <span className="text-[10px] text-muted-foreground">
                      （摄入路径自动登记；决定世界模型能用这台设备的哪些事实）
                    </span>
                  </div>
                  {detailQuery.isLoading ? (
                    <div className="text-xs text-muted-foreground">加载中...</div>
                  ) : detailQuery.isError ? (
                    <div className="text-xs text-risk-degraded-foreground" role="alert">
                      能力清单读取失败：无法确认该设备能提供哪些事实。
                    </div>
                  ) : capabilityViews.length === 0 ? (
                    <div className="text-xs text-muted-foreground" data-testid="device-capabilities-empty">
                      尚未登记能力（该设备类别未声明可观测/可执行维度）
                    </div>
                  ) : (
                    <ul className="space-y-1" data-testid="device-capabilities">
                      {capabilityViews.map((capability) => (
                        <li
                          key={capability.key}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
                          data-testid={`device-capability-${capability.key}`}
                        >
                          <span className="font-medium text-foreground">{capability.label}</span>
                          {/* 权威契约字段：kind（谁的能力）+ mode（观测/交互）+ name */}
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {capability.kindLabel}
                          </span>
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {capability.modeLabel}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {capability.name}
                          </span>
                          {/* NO-19a：安全等级必须可见（放宽高风险能力需安全负责人确认） */}
                          <span
                            className={
                              capability.risk === 'high'
                                ? 'rounded border border-risk-blocked-border px-1.5 py-0.5 text-[10px] text-risk-blocked-foreground'
                                : 'rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground'
                            }
                            data-testid={`device-capability-risk-${capability.key}`}
                            title={capability.riskLabel}
                          >
                            {capability.riskLabel}
                          </span>
                          <span
                            className={
                              capability.effective
                                ? 'rounded border border-risk-normal-border px-1.5 py-0.5 text-[10px] text-risk-normal-foreground'
                                : 'rounded border border-risk-blocked-border px-1.5 py-0.5 text-[10px] text-risk-blocked-foreground'
                            }
                            data-testid={`device-capability-status-${capability.key}`}
                          >
                            {capability.statusLabel}
                          </span>
                          {capability.note && (
                            <span className="text-[10px] text-risk-degraded-foreground">
                              {capability.note}
                            </span>
                          )}
                          {/* 人工生命周期入口：能力决定派工资格，误声明必须可处置 */}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="ml-auto h-6 px-2 text-[10px]"
                            data-testid={`device-capability-action-${capability.key}`}
                            disabled={capabilityActionLabel(capability).blockedReason !== null}
                            title={capabilityActionLabel(capability).blockedReason ?? undefined}
                            onClick={() => setCapabilityTarget(capability)}
                          >
                            {capabilityActionLabel(capability).label}
                          </Button>
                          {capability.lifecycleNote && (
                            <span
                              className="w-full text-[10px] text-muted-foreground"
                              data-testid={`device-capability-lifecycle-${capability.key}`}
                            >
                              {capability.lifecycleNote}
                              {capability.disabledDays !== null && ` · 已停用 ${capability.disabledDays} 天`}
                            </span>
                          )}
                          {capability.needsReview && (
                            <span
                              className="w-full text-[10px] text-risk-degraded-foreground"
                              data-testid={`device-capability-review-${capability.key}`}
                            >
                              已停用超过 {DISABLED_REVIEW_THRESHOLD_DAYS} 天：请复核是否恢复，或确认该设备不再需要此能力
                              （长期停用会让它一直无资格承接这类任务）。
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {capabilityViews.length > 0 && capabilityViews.some((c) => c.fields.length > 0) && (
                    <p className="text-[10px] text-muted-foreground">
                      来源字段：{capabilityViews.flatMap((c) => c.fields).join('、')}
                    </p>
                  )}
                </div>


                {showHierarchyPicker && (
                  <div className="rounded-md border border-border p-2 space-y-2">
                    <div className="text-[10px] text-muted-foreground">
                      仅可选择 工厂/车间/产线/区域/工位 节点
                    </div>
                    <div className="max-h-56 overflow-y-auto pr-1">
                      {hierarchyQuery.isLoading ? (
                        <div className="text-xs text-muted-foreground py-4 text-center">
                          加载中...
                        </div>
                      ) : hierarchyQuery.data && hierarchyQuery.data.length > 0 ? (
                        <HierarchyTree
                          nodes={hierarchyQuery.data}
                          selectedId={selectedEntityId}
                          onSelect={(id) => setSelectedEntityId(id)}
                        />
                      ) : (
                        <div className="text-xs text-muted-foreground py-4 text-center">
                          暂无可选层级
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-border">
                      <Button
                        size="sm"
                        onClick={handleConfirmBindEntity}
                        disabled={!selectedEntityId || bindMutation.isPending}
                      >
                        确认绑定
                      </Button>
                    </div>
                  </div>
                )}

                {/* 绑定人员下拉（2026-08-20：已上移至「绑定关系」区块的
                    可搜索档案下拉，此处旧 Select 废弃移除） */}
              </div>
            </>
          )}

          {/* ===== 状态历史 / 时间线区块（步骤 3，仅 edit 模式） ===== */}
          {isEdit && step === 2 && (
            <>
              <Separator />
              {/* NO-66a：执行边界（在飞/排队（设备忙）/撤回原因/授权可信度）——
                  现场问题"这台设备为什么不动"的答案就在这里，而不是只有网关能读。
                  放在「状态历史」而不是「绑定关系」：它是**运行状态**，不是绑定配置。 */}
              {device?.deviceId && <ExecutionBoundaryPanel deviceId={device.deviceId} />}
              <div className="space-y-3">
                <div className="flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-sm font-semibold text-foreground">
                    状态历史 / 时间线
                  </span>
                </div>
                {telemetryQuery.isLoading ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">
                    加载中...
                  </div>
                ) : timelineEvents.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
                    暂无历史记录
                  </div>
                ) : (
                  <Timeline events={timelineEvents} />
                )}
              </div>
            </>
          )}
        </div>

        <DrawerFooter className="flex-row justify-between gap-2 border-t border-border">
          {/* UX-IA-2026-08：步骤导航（编辑模式）；保存作用于基本信息，恒可用。 */}
          <div>
            {isEdit && step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                上一步
              </Button>
            )}
          </div>
          <div className="flex gap-2">
          {isEdit && step < 2 && (
            <Button variant="outline" size="sm" onClick={() => setStep((s) => s + 1)}>
              下一步
            </Button>
          )}
          {/* BUG-004 修复：用 DrawerClose 包裹取消按钮，确保 vaul 原生关闭机制生效 */}
          <DrawerClose asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              <X className="w-3.5 h-3.5" />
              取消
            </Button>
          </DrawerClose>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMutation.isPending}
          >
            <Save className="w-3.5 h-3.5" />
            {saveMutation.isPending ? '保存中...' : '保存'}
          </Button>
          </div>
        </DrawerFooter>

      {/* 能力状态变更：理由必填（与后端同口径），并显式说明影响面 */}
      <Dialog
        open={capabilityTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setCapabilityTarget(null);
            setCapabilityReason('');
            setCapabilityApprovalId('');
            setCapabilityApproval(null);
            setCapabilityGateNotice(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[440px]" data-testid="capability-status-dialog">
          <DialogHeader>
            <DialogTitle className="text-base">
              {capabilityTarget && capabilityActionLabel(capabilityTarget).action === 'disable'
                ? '停用设备能力'
                : '恢复设备能力'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              能力决定该设备能否被派工（<span className="font-mono">requiredDeviceCapabilities</span> 匹配）。
              变更立即生效并写入审计；摄入路径**不会**自动恢复人工停用的能力。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-xs">
            <div className="rounded-md border border-border px-2 py-1">
              <span className="font-medium text-foreground">{capabilityTarget?.label}</span>
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{capabilityTarget?.name}</span>
            </div>
            <label className="block space-y-1" htmlFor="capability-status-reason">
              <span className="text-muted-foreground">
                变更理由（必填，写入台账留痕与审计，现场据此追溯）
              </span>
              <textarea
                id="capability-status-reason"
                className="min-h-[64px] w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                value={capabilityReason}
                onChange={(event) => setCapabilityReason(event.target.value)}
                placeholder="例如：该设备实际未安装温度传感器（现场核对 2026-09-11）"
              />
            </label>
            {capabilityTarget && capabilityActionLabel(capabilityTarget).blockedReason && (
              <p className="text-[10px] text-risk-degraded-foreground" role="alert">
                {capabilityActionLabel(capabilityTarget).blockedReason}
              </p>
            )}

            {capabilityTarget && restoreRequiresSafetyApproval(capabilityTarget) && (
              <div className="space-y-2 rounded-md border border-risk-degraded-border px-2 py-2">
                <p className="text-[10px] text-risk-degraded-foreground" data-testid="capability-restore-approval-hint">
                  该能力为高风险：恢复 = 设备重新具备高风险作业资格，属执行边界变更，
                  必须由安全管理员审批（后端闸门 HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL），
                  现场不得单独放行。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="capability-restore-request-approval"
                    disabled={capabilityReason.trim().length === 0 || requestRestoreApprovalMutation.isPending}
                    title={
                      capabilityReason.trim().length === 0
                        ? '请先填写变更理由：审批单会带上该理由，审批人据此判断'
                        : undefined
                    }
                    onClick={() => {
                      if (!capabilityTarget) return;
                      requestRestoreApprovalMutation.mutate({
                        view: capabilityTarget,
                        reason: capabilityReason.trim(),
                      });
                    }}
                  >
                    {requestRestoreApprovalMutation.isPending ? '提交中…' : '申请安全审批'}
                  </Button>
                  <label className="flex items-center gap-1" htmlFor="capability-restore-approval-id">
                    <span className="text-muted-foreground">审批号</span>
                    <input
                      id="capability-restore-approval-id"
                      data-testid="capability-restore-approval-input"
                      className="w-[220px] rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px]"
                      value={capabilityApprovalId}
                      onChange={(event) => setCapabilityApprovalId(event.target.value)}
                      placeholder="批准后填入（或点上方按钮获取）"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="capability-restore-check-approval"
                    disabled={capabilityApprovalId.trim().length === 0 || checkRestoreApprovalMutation.isPending}
                    onClick={() => checkRestoreApprovalMutation.mutate(capabilityApprovalId.trim())}
                  >
                    刷新审批状态
                  </Button>
                </div>
                {capabilityApproval && (
                  <p className="text-[10px] text-muted-foreground" data-testid="capability-restore-approval-status">
                    {describeRestoreApprovalStatus(capabilityApproval.status, capabilityApproval.steps).label}
                    {' · '}
                    <span className="font-mono">{capabilityApproval.id}</span>
                  </p>
                )}
                {capabilityApproval && (
                  // NO-22a：时效可见——"还有多久能用"直接决定现场是否要重新申请
                  <p
                    className={
                      describeApprovalFreshness(capabilityApproval.approvedAt ?? null).valid
                        ? 'text-[10px] text-muted-foreground'
                        : 'text-[10px] text-risk-degraded-foreground'
                    }
                    data-testid="capability-restore-approval-freshness"
                  >
                    {describeApprovalFreshness(capabilityApproval.approvedAt ?? null).label}
                  </p>
                )}
                {capabilityGateNotice && (
                  <p className="text-[10px] text-risk-blocked-foreground" role="alert" data-testid="capability-restore-gate-notice">
                    {capabilityGateNotice}
                  </p>
                )}
                {capabilitySubmitBlockedReason && (
                  <p
                    className="text-[10px] text-risk-blocked-foreground"
                    role="alert"
                    data-testid="capability-restore-blocked-reason"
                  >
                    {capabilitySubmitBlockedReason}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setCapabilityTarget(null);
                setCapabilityReason('');
                setCapabilityApprovalId('');
                setCapabilityApproval(null);
                setCapabilityGateNotice(null);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="capability-status-confirm"
              disabled={
                capabilityReason.trim().length === 0 ||
                capabilityMutation.isPending ||
                capabilitySubmitBlockedReason !== null
              }
              title={capabilitySubmitBlockedReason ?? undefined}
              onClick={() => {
                if (!capabilityTarget) return;
                capabilityMutation.mutate({
                  view: capabilityTarget,
                  action: capabilityActionLabel(capabilityTarget).action,
                  reason: capabilityReason.trim(),
                  approvalId: capabilityApprovalId.trim() || undefined,
                });
              }}
            >
              {capabilityTarget && capabilityActionLabel(capabilityTarget).action === 'disable'
                ? '确认停用'
                : '确认恢复'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </DrawerContent>
    </Drawer>
  );
};

/** 递归渲染层级树 */
function HierarchyTree({
  nodes,
  selectedId,
  onSelect,
  depth = 0,
}: {
  nodes: SpatialHierarchyNode[];
  selectedId: string | null;
  onSelect: (entityId: string) => void;
  depth?: number;
}): React.ReactElement | null {
  if (!nodes || nodes.length === 0) return null;
  return (
    <div className={cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-border pl-2')}>
      {nodes.map((node) => {
        const meta = ENTITY_TYPE_META[node.entity.entityType];
        const Icon = meta?.icon ?? MapPin;
        const selectable = !!meta;
        const isSelected = selectedId === node.entity.entityId;
        return (
          <div key={node.entity.id}>
            <button
              type="button"
              disabled={!selectable}
              onClick={() => selectable && onSelect(node.entity.entityId)}
              className={cn(
                'flex items-center gap-1.5 w-full text-left px-2 py-1 rounded text-xs border',
                isSelected
                  ? 'bg-blue-50 text-blue-700 border-blue-300'
                  : selectable
                    ? 'hover:bg-muted text-foreground border-transparent'
                    : 'text-muted-foreground border-transparent cursor-not-allowed opacity-60',
              )}
            >
              <Icon className="w-3 h-3 shrink-0" />
              <span className="truncate">{node.entity.name}</span>
              {meta && (
                <Badge
                  variant="outline"
                  className="ml-auto text-[9px] px-1 py-0 border-border text-muted-foreground"
                >
                  {meta.label}
                </Badge>
              )}
            </button>
            {node.children && node.children.length > 0 && (
              <HierarchyTree
                nodes={node.children}
                selectedId={selectedId}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default DeviceConfigDrawer;
