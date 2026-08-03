import { useEffect, useState } from 'react';
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
  type LucideIcon,
} from 'lucide-react';
import type {
  DeviceInfo,
  CreateDeviceDto,
  UpdateDeviceDto,
  BindDeviceRequest,
  SpatialHierarchyNode,
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
  createDevice,
  updateDevice,
  getDeviceBindings,
  bindDevice,
  unbindDevice,
} from '@client/src/api/dashboard';
import { getHierarchy, getEntities } from '@client/src/api/spatial';
import { queryKeys } from '@client/src/hooks/queryKeys';

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
  const [workerName, setWorkerName] = useState('');
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
      setWorkerName(device.workerName ?? '');
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
      setWorkerName('');
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
          workerName: workerName || undefined,
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
        workerName: workerName || undefined,
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

  const hierarchyQuery = useQuery({
    queryKey: queryKeys.spatialHierarchy,
    queryFn: getHierarchy,
    enabled: isEdit && open && showHierarchyPicker,
  });

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

  const handlePersonChange = (val: string) => {
    bindMutation.mutate({
      spatialEntityId: bindingsQuery.data?.spatialEntityId ?? null,
      personEntityId: val === 'none' ? null : val,
    });
  };

  const personValue = bindingsQuery.data?.boundPersonId ?? 'none';
  const bindingPath = bindingsQuery.data?.hierarchyPath ?? [];
  const bindingLoading = bindingsQuery.isLoading;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="sm:max-w-[560px] w-full">
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-base text-[hsl(220_14%_14%)]">
            {isEdit ? '编辑设备' : '新增设备'}
          </DrawerTitle>
          <DrawerDescription className="text-xs text-[hsl(218_10%_42%)]">
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
                <Label className="text-xs text-[hsl(218_10%_42%)]">
                  设备ID <span className="text-red-500">*</span>
                </Label>
                {isEdit ? (
                  <div className="h-9 px-3 flex items-center rounded-md border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] text-sm text-[hsl(220_14%_14%)] font-medium">
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

              <div className="space-y-1.5">
                <Label className="text-xs text-[hsl(218_10%_42%)]">工人姓名</Label>
                <Input
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                  placeholder="姓名"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-[hsl(218_10%_42%)]">设备型号</Label>
                <Input
                  value={deviceModel}
                  onChange={(e) => setDeviceModel(e.target.value)}
                  placeholder="型号"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-[hsl(218_10%_42%)]">电量 (%)</Label>
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
                <Label className="text-xs text-[hsl(218_10%_42%)]">在线状态</Label>
                <div className="h-9 flex items-center gap-2">
                  <Switch checked={online} onCheckedChange={setOnline} />
                  <span className="text-xs text-[hsl(220_14%_14%)]">
                    {online ? '在线' : '离线'}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-[hsl(218_10%_42%)]">来源类型</Label>
                {isEdit ? (
                  <div className="h-9 px-3 flex items-center rounded-md border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] text-sm text-[hsl(218_10%_42%)]">
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
                <Label className="text-xs text-[hsl(218_10%_42%)]">固件版本</Label>
                <Input
                  value={firmwareVersion}
                  onChange={(e) => setFirmwareVersion(e.target.value)}
                  placeholder="例如 v1.2.0"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-[hsl(218_10%_42%)]">硬件版本</Label>
                <Input
                  value={hardwareVersion}
                  onChange={(e) => setHardwareVersion(e.target.value)}
                  placeholder="例如 HW-2"
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-[hsl(218_10%_42%)]">协议版本</Label>
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
                    <Label className="text-xs text-[hsl(218_10%_42%)]">故障码</Label>
                    <Input
                      value={faultCode}
                      onChange={(e) => setFaultCode(e.target.value)}
                      placeholder="无"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-[hsl(218_10%_42%)]">温度 (℃)</Label>
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
                  <Link2 className="w-3.5 h-3.5 text-[hsl(218_10%_42%)]" />
                  <span className="text-sm font-semibold text-[hsl(220_14%_14%)]">
                    绑定关系
                  </span>
                </div>

                {/* 当前层级路径面包屑 */}
                <div className="rounded-md border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] p-3">
                  <div className="text-[10px] text-[hsl(218_10%_42%)] mb-1">
                    建筑层级路径
                  </div>
                  {bindingLoading ? (
                    <div className="text-xs text-[hsl(218_10%_42%)]">加载中...</div>
                  ) : bindingPath.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-0.5 text-xs text-[hsl(220_14%_14%)]">
                      {bindingPath.map((node, idx) => {
                        const meta = ENTITY_TYPE_META[node.entityType];
                        const Icon = meta?.icon ?? MapPin;
                        return (
                          <span key={node.entityId} className="flex items-center gap-0.5">
                            {idx > 0 && (
                              <ChevronRight className="w-3 h-3 text-[hsl(218_10%_42%)]" />
                            )}
                            <Icon className="w-3 h-3 text-[hsl(218_10%_42%)]" />
                            <span>{node.name}</span>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-[hsl(218_10%_42%)]">
                      未绑定空间实体
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-1.5 text-xs">
                    <User className="w-3 h-3 text-[hsl(218_10%_42%)]" />
                    <span className="text-[hsl(218_10%_42%)]">绑定人员：</span>
                    <span className="text-[hsl(220_14%_14%)] font-medium">
                      {bindingsQuery.data?.boundPersonName ?? '未绑定'}
                    </span>
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
                  <div className="rounded-md border border-[hsl(220_14%_89%)] p-2 space-y-2">
                    <div className="text-[10px] text-[hsl(218_10%_42%)]">
                      仅可选择 工厂/车间/产线/区域/工位 节点
                    </div>
                    <div className="max-h-56 overflow-y-auto pr-1">
                      {hierarchyQuery.isLoading ? (
                        <div className="text-xs text-[hsl(218_10%_42%)] py-4 text-center">
                          加载中...
                        </div>
                      ) : hierarchyQuery.data && hierarchyQuery.data.length > 0 ? (
                        <HierarchyTree
                          nodes={hierarchyQuery.data}
                          selectedId={selectedEntityId}
                          onSelect={(id) => setSelectedEntityId(id)}
                        />
                      ) : (
                        <div className="text-xs text-[hsl(218_10%_42%)] py-4 text-center">
                          暂无可选层级
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-[hsl(220_14%_89%)]">
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

                {/* 绑定人员下拉 */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-[hsl(218_10%_42%)]">绑定人员</Label>
                  <Select
                    value={personValue}
                    onValueChange={handlePersonChange}
                    disabled={bindMutation.isPending}
                  >
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">未绑定</SelectItem>
                      {(personsQuery.data ?? []).map((p) => (
                        <SelectItem key={p.entityId} value={p.entityId}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </div>

        <DrawerFooter className="flex-row justify-end gap-2 border-t border-[hsl(220_14%_89%)]">
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
    <div className={cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-[hsl(220_14%_89%)] pl-2')}>
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
                    ? 'hover:bg-[hsl(220_14%_96%)] text-[hsl(220_14%_14%)] border-transparent'
                    : 'text-[hsl(218_10%_42%)] border-transparent cursor-not-allowed opacity-60',
              )}
            >
              <Icon className="w-3 h-3 shrink-0" />
              <span className="truncate">{node.entity.name}</span>
              {meta && (
                <Badge
                  variant="outline"
                  className="ml-auto text-[9px] px-1 py-0 border-[hsl(220_14%_89%)] text-[hsl(218_10%_42%)]"
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
