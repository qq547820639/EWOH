import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Factory,
  Building2,
  Layers,
  Boxes,
  Square,
  MapPin,
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
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { Switch } from '@client/src/components/ui/switch';
import { Badge } from '@client/src/components/ui/badge';
import { Separator } from '@client/src/components/ui/separator';
import {
  Drawer,
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
} from '@client/src/api/dashboard';
import { getHierarchy, getEntities } from '@client/src/api/spatial';
import { listPersonnel } from '@client/src/api/organization';
import { queryKeys } from '@client/src/hooks/queryKeys';
import Timeline from '@client/src/components/Timeline';
import { normalizeTimelineEvent } from '@client/src/lib/timelineModel';

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

  // 打开/切换设备时同步表单
  useEffect(() => {
    if (!open) return;
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
        description: err instanceof Error ? err.message : undefined,
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

  const invalidateBindingsAndDevices = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.deviceBindings(device?.deviceId) });
    queryClient.invalidateQueries({ queryKey: ['devices'] });
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
        description: err instanceof Error ? err.message : undefined,
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
        description: err instanceof Error ? err.message : undefined,
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
        </DrawerHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
          {/* ===== 设备信息表单 ===== */}
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

          {/* ===== 绑定关系区块（仅 edit 模式） ===== */}
          {isEdit && (
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
                    <div className="text-xs text-muted-foreground">
                      未绑定空间实体
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

          {/* ===== 状态历史 / 时间线区块（仅 edit 模式） ===== */}
          {isEdit && (
            <>
              <Separator />
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

        <DrawerFooter className="flex-row justify-end gap-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            <X className="w-3.5 h-3.5" />
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMutation.isPending}
          >
            <Save className="w-3.5 h-3.5" />
            {saveMutation.isPending ? '保存中...' : '保存'}
          </Button>
        </DrawerFooter>
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
