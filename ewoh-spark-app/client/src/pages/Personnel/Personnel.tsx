import { useEffect, useMemo, useState } from 'react';
import { errorDescription } from '@client/src/lib/errorContract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Loader2, Plus, Search, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { createPersonnel, listOrganizations, listPersonnel } from '../../api/organization';
import { getDevices, bindDevice, unbindDevice } from '../../api/dashboard';
import type { DeviceInfo, PersonnelInfo } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const riskLabel: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

/** 人员状态（对齐库内 available/busy/high_load）。 */
const PERSONNEL_STATUS_OPTIONS = [
  { value: 'available', label: '在岗可调配' },
  { value: 'busy', label: '任务中' },
  { value: 'high_load', label: '高负荷' },
] as const;

const Personnel = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [employeeNo, setEmployeeNo] = useState('');
  const [orgId, setOrgId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [position, setPosition] = useState('');
  const [skills, setSkills] = useState('');
  const [status, setStatus] = useState('available');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const query = useQuery<PersonnelInfo[]>({
    queryKey: queryKeys.personnel({ keyword: debouncedKeyword || undefined }),
    queryFn: () => listPersonnel({ keyword: debouncedKeyword || undefined }),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const orgQuery = useQuery({
    queryKey: queryKeys.organizations,
    queryFn: listOrganizations,
    enabled: open,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const rows = query.data ?? [];
  const orgOptions = orgQuery.data ?? [];

  // ===== 设备绑定（双入口：人员侧绑定外骨骼，2026-08-20）=====
  // 设备列表含 boundPersonId（人员 extra.device_id 反查），既是绑定列展示数据源，
  // 也是绑定弹窗的设备候选；60s 轮询与设备中心一致。
  const devicesQuery = useQuery<DeviceInfo[]>({
    queryKey: queryKeys.devices({}),
    queryFn: () => getDevices(),
    refetchInterval: 60000,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const devices = devicesQuery.data ?? [];
  /** personId → 当前绑定设备（一人一设备：person.extra.device_id 反查）。 */
  const deviceByPerson = useMemo(() => {
    const m = new Map<string, DeviceInfo>();
    for (const d of devices) {
      if (d.boundPersonId) m.set(d.boundPersonId, d);
    }
    return m;
  }, [devices]);

  const [bindOpen, setBindOpen] = useState(false);
  const [bindTarget, setBindTarget] = useState<PersonnelInfo | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  const openBindDialog = (person: PersonnelInfo) => {
    setBindTarget(person);
    setSelectedDeviceId(deviceByPerson.get(person.id)?.deviceId ?? 'none');
    setBindOpen(true);
  };

  /**
   * 绑定/换绑/解绑（人员侧）。
   * 语义：一人一设备、一设备一人。bindDevice 直接覆盖 person.extra.device_id，
   * 但不清旧设备 extra.worker_id —— 换绑前先 unbind 旧设备（含目标设备被他人
   * 占用时的释放），保证 extra 双向引用干净。
   */
  const bindMutation = useMutation({
    mutationFn: async ({
      person,
      deviceId,
    }: {
      person: PersonnelInfo;
      deviceId: string | null;
    }) => {
      const currentDevice = deviceByPerson.get(person.id);
      const targetDevice = deviceId ? devices.find((d) => d.deviceId === deviceId) : null;
      // 1) 人员原绑定设备 → 先解绑（换绑/解绑场景）。
      if (currentDevice && currentDevice.deviceId !== deviceId) {
        await unbindDevice(currentDevice.deviceId);
      }
      // 2) 目标设备被他人占用 → 释放（换人占用设备的场景）。
      if (
        targetDevice &&
        targetDevice.boundPersonId &&
        targetDevice.boundPersonId !== person.id
      ) {
        await unbindDevice(targetDevice.deviceId);
      }
      // 3) 绑定目标设备（deviceId=null 表示仅解绑）。
      if (targetDevice) {
        await bindDevice(targetDevice.deviceId, { personEntityId: person.id });
      }
    },
    onSuccess: (_data, variables) => {
      toast.success(
        variables.deviceId
          ? `已为 ${variables.person.name} 绑定外骨骼 ${variables.deviceId}`
          : `已解绑 ${variables.person.name} 的外骨骼`,
      );
      setBindOpen(false);
      setBindTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.devices({}) });
      queryClient.invalidateQueries({ queryKey: queryKeys.personnel({}) });
    },
    onError: (error) => {
      toast.error('绑定操作失败', {
        description: errorDescription(error),
      });
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createPersonnel({
        name: name.trim(),
        employeeNo: employeeNo.trim(),
        ...(orgId ? { orgId } : {}),
        ...(teamName.trim() ? { teamName: teamName.trim() } : {}),
        ...(position.trim() ? { position: position.trim() } : {}),
        ...(skills.trim() ? { skills: skills.split(',').map((skill) => skill.trim()).filter(Boolean) } : {}),
        status,
      }),
    onSuccess: () => {
      toast.success('人员已创建');
      setOpen(false);
      setName('');
      setEmployeeNo('');
      setOrgId('');
      setTeamName('');
      setPosition('');
      setSkills('');
      setStatus('available');
      queryClient.invalidateQueries({ queryKey: queryKeys.personnel({}) });
    },
    onError: (error) => {
      toast.error('创建失败', {
        description: errorDescription(error),
      });
    },
  });

  const canSubmit = name.trim().length > 0 && employeeNo.trim().length > 0 && !createMutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    createMutation.mutate();
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">人员与外骨骼</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            人员档案、组织归属、技能与健康风险概览（实施配置：录入甲方人员并绑定外骨骼设备；也可在「设备中心 → 设备详情」中反向绑定）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索姓名 / 工号 / 岗位"
              aria-label="搜索人员"
              className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <Button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2">
            <Plus className="size-4" aria-hidden />
            新增人员
          </Button>
        </div>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || rows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载人员数据"
        emptyMessage="暂无人员记录，点击右上角「新增人员」录入。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">姓名</th>
                <th className="px-5 py-3 font-medium">工号</th>
                <th className="px-5 py-3 font-medium">组织</th>
                <th className="px-5 py-3 font-medium">岗位</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">风险</th>
                <th className="px-5 py-3 font-medium">绑定外骨骼</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((person) => {
                const boundDevice = deviceByPerson.get(person.id);
                return (
                <tr key={person.id} className="hover:bg-muted">
                  <td className="px-5 py-3 font-medium text-foreground">{person.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{person.employeeNo}</td>
                  <td className="px-5 py-3 text-muted-foreground">{person.orgId ?? '-'}</td>
                  <td className="px-5 py-3">{person.position ?? '-'}</td>
                  <td className="px-5 py-3">{person.status ?? '-'}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${
                        person.riskLevel === 'high'
                          ? 'bg-red-100 text-red-700'
                          : person.riskLevel === 'medium'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {/* CLI-220：显式默认标签（未定义/未知 riskLevel 不再渲染为空）。 */}
                      {riskLabel[person.riskLevel ?? 'low'] ?? `未知(${person.riskLevel ?? '—'})`}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {boundDevice ? (
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-foreground">
                        <Link2 className="size-3 text-primary" aria-hidden />
                        {boundDevice.deviceId}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">未绑定</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => openBindDialog(person)}
                      aria-label={`绑定外骨骼：${person.name}`}
                    >
                      {boundDevice ? '换绑' : '绑定'}
                    </Button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新增人员</DialogTitle>
            <DialogDescription>
              录入甲方人员档案（姓名/工号必填）。人员创建后，可在「设备中心 → 设备详情」中绑定外骨骼。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor="person-name" className="text-sm font-medium">
                  姓名 <span className="text-red-500">*</span>
                </label>
                <Input
                  id="person-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="如：王建国"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="person-no" className="text-sm font-medium">
                  工号 <span className="text-red-500">*</span>
                </label>
                <Input
                  id="person-no"
                  value={employeeNo}
                  onChange={(event) => setEmployeeNo(event.target.value)}
                  placeholder="如：EMP-013"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="person-org" className="text-sm font-medium">所属组织</label>
              <Select value={orgId} onValueChange={setOrgId}>
                <SelectTrigger id="person-org">
                  <SelectValue placeholder="（不选则归属当前组织）" />
                </SelectTrigger>
                <SelectContent>
                  {orgOptions.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}（{org.orgType}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor="person-team" className="text-sm font-medium">班组</label>
                <Input
                  id="person-team"
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder="如：总装一班"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="person-pos" className="text-sm font-medium">岗位</label>
                <Input
                  id="person-pos"
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                  placeholder="如：装配工"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="person-skills" className="text-sm font-medium">技能</label>
              <Input
                id="person-skills"
                value={skills}
                onChange={(event) => setSkills(event.target.value)}
                placeholder="逗号分隔，如：assembly, welding"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="person-status" className="text-sm font-medium">状态</label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="person-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERSONNEL_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                创建
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* 绑定外骨骼弹窗（人员侧双入口，2026-08-20） */}
      <Dialog open={bindOpen} onOpenChange={setBindOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>绑定外骨骼</DialogTitle>
            <DialogDescription>
              为 {bindTarget?.name}（{bindTarget?.employeeNo}）分配外骨骼设备。
              一人一设备：换绑会自动释放原设备；所选设备若已被他人占用，将先解绑再绑定。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="bind-device" className="text-sm font-medium">
                外骨骼设备
              </label>
              <Select value={selectedDeviceId} onValueChange={setSelectedDeviceId}>
                <SelectTrigger id="bind-device">
                  <SelectValue placeholder="选择设备" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Unlink className="size-3" aria-hidden />
                      不绑定（解绑当前设备）
                    </span>
                  </SelectItem>
                  {devices.map((d) => {
                    const occupied =
                      d.boundPersonId && d.boundPersonId !== bindTarget?.id
                        ? d.boundPersonName ?? d.boundPersonId
                        : null;
                    return (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.deviceId}
                        {d.deviceModel ? `（${d.deviceModel}）` : ''}
                        {occupied ? ` · 已绑定：${occupied}` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            {devicesQuery.isLoading && (
              <p className="text-xs text-muted-foreground">正在加载设备列表…</p>
            )}
            {devicesQuery.isError && (
              <p className="text-xs text-red-500">设备列表加载失败，请稍后重试。</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setBindOpen(false)}>
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  !bindTarget ||
                  bindMutation.isPending ||
                  (selectedDeviceId ===
                    (deviceByPerson.get(bindTarget?.id ?? '')?.deviceId ?? 'none') &&
                    selectedDeviceId !== 'none')
                }
                onClick={() => {
                  if (!bindTarget) return;
                  bindMutation.mutate({
                    person: bindTarget,
                    deviceId: selectedDeviceId === 'none' ? null : selectedDeviceId,
                  });
                }}
                className="inline-flex items-center gap-2"
              >
                {bindMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {selectedDeviceId === 'none' ? '确认解绑' : '确认绑定'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Personnel;
