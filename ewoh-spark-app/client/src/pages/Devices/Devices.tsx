import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Plus, Pencil, Link2, TriangleAlert, Layers } from 'lucide-react';
import { searchDevices } from '@client/src/api/dashboard';
import { getEntities } from '@client/src/api/spatial';
import { queryKeys } from '@client/src/hooks/queryKeys';
import type { DeviceInfo, DeviceSearchQuery, SpatialEntity } from '@shared/api.interface';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { DataSourceBadge } from '@client/src/components/DataSourceBadge';
import AppErrorState from '@client/src/components/AppErrorState';
import { errorDescription } from '@client/src/lib/errorContract';
import DeviceConfigDrawer from './DeviceConfigDrawer';
import { BatchCapabilityRestoreDialog } from './BatchCapabilityRestoreDialog';
import ResponsibilityDialog from './ResponsibilityDialog';
import { listDeviceResponsibilities } from '@client/src/api/deviceResponsibility';
import { listPersonnel } from '@client/src/api/organization';
import {
  buildResponsibilityViews,
  uncoveredView,
  type DeviceResponsibilityView,
} from './responsibilityLogic';
import {
  buildDeviceSearchQuery,
  CATEGORY_FILTER_OPTIONS,
  formatDeviceCategory,
  hasBatteryReading,
  type CategoryFilter,
} from './devicesLogic';

type OnlineFilter = 'all' | 'online' | 'offline';
type SourceFilter = 'all' | 'real' | 'simulated' | 'controlled_test' | 'replayed' | 'stale' | 'offline';
type OrderBy =
  | 'batteryDesc'
  | 'battery'
  | 'lastTelemetryAtDesc'
  | 'deviceId'
  | 'deviceIdDesc';

const TABLE_COL_COUNT = 12;

const Devices = (): React.ReactElement => {
  // ===== 搜索参数 =====
  const [keyword, setKeyword] = useState('');
  const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>('all');
  const [batteryMin, setBatteryMin] = useState<string>('');
  const [batteryMax, setBatteryMax] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [orderby, setOrderby] = useState<OrderBy>('batteryDesc');

  // ===== 抽屉状态 =====
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create');
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  /** NO-23a：批量恢复被人为停用的能力（一次检修 → 一张审批 → 逐台落地）。 */
  const [batchRestoreOpen, setBatchRestoreOpen] = useState(false);
  /** NO-50a：设备责任人对谁负责（提醒点名到人）——在表格里可看、可设置。 */
  const [responsibilityDeviceId, setResponsibilityDeviceId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // 统一走纯函数（devicesLogic.buildDeviceSearchQuery）：页面不再内联第二份查询拼装
  const searchQuery: DeviceSearchQuery = useMemo(
    () =>
      buildDeviceSearchQuery({
        keyword,
        onlineFilter,
        batteryMin,
        batteryMax,
        sourceFilter,
        categoryFilter,
        orderby,
      }),
    [keyword, onlineFilter, batteryMin, batteryMax, sourceFilter, categoryFilter, orderby],
  );

  const {
    data: devices,
    isLoading,
    isFetching,
    isError,
    error,
    dataUpdatedAt,
    refetch,
  } = useQuery<DeviceInfo[]>({
    queryKey: queryKeys.devices(searchQuery),
    queryFn: () => searchDevices(searchQuery),
    refetchInterval: 30000,
  });

  // 数据过期（stale）判定：超过 2 个刷新周期未成功更新即视为过期数据
  const isStale = dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 60000;

  // 拉取全部空间实体，用于 parentId -> 名称映射
  const { data: entities } = useQuery<SpatialEntity[]>({
    queryKey: queryKeys.spatialEntities,
    queryFn: () => getEntities(),
    refetchInterval: 60000,
  });

  /**
   * NO-50a：一页设备的责任关系（**批量**读，避免 N+1），以及人员姓名映射。
   * 责任关系是"提醒点名到谁"的依据，因此缺失必须显式（未登记责任人）。
   */
  const responsibilityQuery = useQuery({
    queryKey: ['device-responsibilities', 'page'],
    queryFn: () => listDeviceResponsibilities(),
    refetchInterval: 60000,
  });
  const personnelQuery = useQuery({ queryKey: ['devices', 'personnel'], queryFn: () => listPersonnel({}) });
  const nameByPersonId = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of (personnelQuery.data ?? []) as Array<{ personId?: string; id?: string; name?: string }>) {
      const id = String(person.personId ?? person.id ?? '').replace(/^person:/, '');
      if (id && person.name) map.set(id, String(person.name));
    }
    return map;
  }, [personnelQuery.data]);
  const responsibilityByDevice = useMemo(
    () => buildResponsibilityViews(responsibilityQuery.data ?? [], nameByPersonId),
    [responsibilityQuery.data, nameByPersonId],
  );
  const responsibilityViewOf = (deviceId: string): DeviceResponsibilityView =>
    responsibilityByDevice.get(deviceId) ?? uncoveredView(deviceId);
  /** 未登记责任人的设备数（页面顶部汇总，促使班组长补齐）。 */
  const uncoveredDevices = useMemo(
    () => (devices ?? []).filter((d) => responsibilityViewOf(d.deviceId).uncovered).length,
    [devices, responsibilityByDevice],
  );

  const entityNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (entities ?? []).forEach((e) => {
      m.set(e.entityId, e.name);
      m.set(e.id, e.name);
    });
    return m;
  }, [entities]);

  // CLI-104：useMemo 包裹（配合 30s refetchInterval，避免每次重渲重算 map）。
  const batteryData = useMemo(
    () =>
      (devices || []).map((d) => ({
        name: d.deviceId,
        battery: d.batteryPct,
        online: d.online,
      })),
    [devices],
  );

  const batteryColor = (pct: number) =>
    pct > 50 ? '#22c55e' : pct > 20 ? '#eab308' : '#ef4444';

  const handleCreate = () => {
    setSelectedDevice(null);
    setDrawerMode('create');
    setDrawerOpen(true);
  };

  const handleEdit = (d: DeviceInfo) => {
    setSelectedDevice(d);
    setDrawerMode('edit');
    setDrawerOpen(true);
  };

  const handleBind = (d: DeviceInfo) => {
    setSelectedDevice(d);
    setDrawerMode('edit');
    setDrawerOpen(true);
  };

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.devices() });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">设备态势总览</h1>
          <p className="text-sm text-muted-foreground mt-1">
            设备台账：外骨骼与感知层设备（环境传感器 / 摄像头 / 定位标签）的状态、
            电量与在线情况
          </p>
          {/* NO-50a：责任人缺失是"安灯提醒发不到人"的直接原因，页面顶部就要看得见。 */}
          {/* FE-1：责任关系**读失败**时，责任关系表退化为空 → 每台设备都被判成"未登记责任人"，
              于是这行会伪造出"未登记责任人的设备 N 台"。读失败必须显式说读不到，不得落回业务结论。 */}
          <p
            className={`mt-1 text-xs ${
              uncoveredDevices > 0 || responsibilityQuery.isError || isError
                ? 'text-risk-degraded-foreground'
                : 'text-muted-foreground'
            }`}
            data-testid="device-responsibility-summary"
          >
            {responsibilityQuery.isLoading
              ? '责任人数据加载中…'
              : responsibilityQuery.isError
                ? '责任人数据读取失败：无法判断哪些设备未登记责任人（不代表都已登记）'
                : isError
                  ? '设备列表读取失败：无法核对责任人登记情况（不代表都已登记）'
                  : uncoveredDevices > 0
                    ? `未登记责任人的设备 ${uncoveredDevices} 台：这些设备的安灯提醒只能发到角色（点「设置」补齐）`
                    : '当前列表的设备都已登记责任人'}
          </p>
          {/* FE-1：人员名单读失败时，责任人姓名会退化为人员 ID（不是"没有责任人"）。 */}
          {personnelQuery.isError && (
            <p className="mt-1 text-xs text-risk-degraded-foreground" data-testid="device-personnel-error">
              人员名单读取失败（{errorDescription(personnelQuery.error)}
              ）：责任人只能显示人员 ID，无法显示姓名
            </p>
          )}
          {dataUpdatedAt > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {isStale ? (
                <span className="inline-flex items-center gap-1 text-amber-600">
                  <TriangleAlert className="h-3 w-3" />
                  数据已过期，暂未获取到最新设备状态
                </span>
              ) : isFetching ? (
                '正在刷新…'
              ) : (
                `更新于 ${new Date(dataUpdatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* NO-23a：批量恢复入口——同一批设备检修完统一放行，避免逐台开抽屉 */}
          <Button
            variant="outline"
            data-testid="device-batch-restore-open"
            onClick={() => setBatchRestoreOpen(true)}
          >
            <Layers className="w-4 h-4" />
            批量恢复能力
          </Button>
          <Button onClick={handleCreate}>
            <Plus className="w-4 h-4" />
            新增设备
          </Button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="device-keyword" className="block text-xs text-muted-foreground mb-1">
              关键字
            </label>
            <Input
              id="device-keyword"
              placeholder="搜索设备ID/姓名/型号"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="h-9"
            />
          </div>

          <div className="w-[140px]">
            <label className="block text-xs text-muted-foreground mb-1">在线状态</label>
            <Select
              value={onlineFilter}
              onValueChange={(v) => setOnlineFilter(v as OnlineFilter)}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="online">在线</SelectItem>
                <SelectItem value="offline">离线</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-[200px]">
            <label htmlFor="device-battery-min" className="block text-xs text-muted-foreground mb-1">
              电量区间 (%)
            </label>
            <div className="flex items-center gap-1">
              <Input
                id="device-battery-min"
                type="number"
                placeholder="min"
                aria-label="电量下限"
                value={batteryMin}
                onChange={(e) => setBatteryMin(e.target.value)}
                className="h-9"
              />
              <span className="text-xs text-muted-foreground">-</span>
              <Input
                id="device-battery-max"
                type="number"
                placeholder="max"
                aria-label="电量上限"
                value={batteryMax}
                onChange={(e) => setBatteryMax(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="w-[170px]">
            <label className="block text-xs text-muted-foreground mb-1">设备类别</label>
            <Select
              value={categoryFilter}
              onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}
            >
              <SelectTrigger className="h-9 w-full" aria-label="按设备类别过滤">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_FILTER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-[170px]">
            <label className="block text-xs text-muted-foreground mb-1">来源类型</label>
            <Select
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as SourceFilter)}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="real">真机 (real)</SelectItem>
                <SelectItem value="simulated">模拟 (simulated)</SelectItem>
                <SelectItem value="controlled_test">受控测试 (controlled_test)</SelectItem>
                <SelectItem value="replayed">回放 (replayed)</SelectItem>
                <SelectItem value="stale">过期 (stale)</SelectItem>
                <SelectItem value="offline">离线 (offline)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-[180px]">
            <label className="block text-xs text-muted-foreground mb-1">排序</label>
            <Select value={orderby} onValueChange={(v) => setOrderby(v as OrderBy)}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="batteryDesc">电量降序</SelectItem>
                <SelectItem value="battery">电量升序</SelectItem>
                <SelectItem value="lastTelemetryAtDesc">最后通信降序</SelectItem>
                <SelectItem value="deviceId">设备ID升序</SelectItem>
                <SelectItem value="deviceIdDesc">设备ID降序</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* 电量分布图 */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="font-semibold text-foreground mb-4">设备电量分布</h2>
        {batteryData.length > 0 ? (
          <>
            <div
              role="img"
              aria-label="设备电量分布图（柱状图，按设备聚合）"
            >
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={batteryData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="battery" name="电量(%)" radius={[4, 4, 0, 0]}>
                    {batteryData.map((entry) => (
                      <Cell key={entry.name} fill={batteryColor(entry.battery)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table className="sr-only">
              <caption>设备电量分布（文本替代）</caption>
              <thead>
                <tr>
                  <th scope="col">设备</th>
                  <th scope="col">电量(%)</th>
                  <th scope="col">在线</th>
                </tr>
              </thead>
              <tbody>
                {batteryData.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td>{entry.battery}</td>
                    <td>{entry.online ? '在线' : '离线'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : isError ? (
          /* FE-1：电量分布是设备查询的派生物；查询读失败时 batteryData 退化为空，
             绝不能在面板里落回「暂无数据」——那是把"没读到"说成"设备没有电量数据"。 */
          <div
            className="h-[240px] flex items-center justify-center text-sm text-risk-degraded-foreground"
            data-testid="device-battery-error"
          >
            电量数据加载失败：无法获取设备电量（不代表设备没有电量数据）
          </div>
        ) : (
          <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        )}
      </div>

      {/* 设备列表表格 */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-foreground">设备列表</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">设备ID</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">工人姓名</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">设备型号</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">设备类别</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">来源</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">电量</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">在线状态</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">绑定工位</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">绑定人员</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">责任人</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">最后通信</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td
                    colSpan={TABLE_COL_COUNT}
                    className="px-5 py-8 text-center text-sm text-muted-foreground"
                  >
                    加载中...
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={TABLE_COL_COUNT} className="px-5 py-8">
                    <AppErrorState
                      error={error}
                      errorMessage="设备数据加载失败"
                      impact="设备列表与电量分布将无法展示，其余功能可正常使用。"
                      saved={false}
                      onRetry={() => refetch()}
                      onSaveDraft={undefined}
                      backHref="/command-center"
                    />
                  </td>
                </tr>
              ) : devices && devices.length > 0 ? (
                devices.map((d) => {
                  const parentName = d.parentId
                    ? entityNameMap.get(d.parentId) ?? '未知工位'
                    : null;
                  return (
                    <tr
                      key={d.id}
                      className="border-b border-border hover:bg-muted"
                    >
                      <td className="px-5 py-3 text-sm font-medium text-foreground whitespace-nowrap">
                        {d.deviceId}
                      </td>
                      <td className="px-5 py-3 text-sm text-foreground whitespace-nowrap">
                        {/* 2026-08-20：统一显示结构化绑定人员（boundPersonName）；
                            存量 worker_name 文本仅在尚未迁移时兜底显示。 */}
                        {d.boundPersonName || d.workerName || '—'}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground whitespace-nowrap">
                        {d.deviceModel || '—'}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {/* 感知层设备与外骨骼在同一台账里可区分（未知类别显式显示，
                            不落回"外骨骼"或空白） */}
                        <span
                          className="inline-flex items-center rounded border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                          data-testid={`device-category-${d.deviceId}`}
                        >
                          {formatDeviceCategory(d.deviceCategory)}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <DataSourceBadge source={d.sourceType} />
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          {hasBatteryReading(d.batteryPct) ? (
                            <>
                              <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    (d.batteryPct as number) > 50
                                      ? 'bg-green-500'
                                      : (d.batteryPct as number) > 20
                                        ? 'bg-yellow-500'
                                        : 'bg-red-500'
                                  }`}
                                  style={{ width: `${d.batteryPct as number}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {d.batteryPct}%
                              </span>
                            </>
                          ) : (
                            /* 无电池设备（环境传感器/摄像头/定位标签）：显示"不适用"，
                               不渲染低电量红条——把"没有电量概念"伪装成告警是不诚实的。 */
                            <span
                              className="text-xs text-muted-foreground"
                              title="该设备类别没有电量语义（未上报电量）"
                            >
                              不适用
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                            d.online
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${d.online ? 'bg-green-500' : 'bg-gray-400'}`}
                          />
                          {d.online ? '在线' : '离线'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm whitespace-nowrap">
                        {parentName ? (
                          <span className="text-foreground">{parentName}</span>
                        ) : (
                          <span className="text-muted-foreground">未绑定</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm whitespace-nowrap">
                        {d.boundPersonName ? (
                          <span className="text-foreground">{d.boundPersonName}</span>
                        ) : (
                          <span className="text-muted-foreground">未绑定</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm whitespace-nowrap">
                        {/* NO-50a：责任人缺失**显式**呈现（提醒只能发到角色），不留白。 */}
                        {(() => {
                          const view = responsibilityViewOf(d.deviceId);
                          return (
                            <div className="flex items-center gap-2">
                              <span
                                className={view.uncovered ? 'text-muted-foreground' : 'text-foreground'}
                                data-testid={`device-responsibility-${d.deviceId}`}
                              >
                                {view.summaryLabel}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                data-testid={`device-responsibility-set-${d.deviceId}`}
                                onClick={() => setResponsibilityDeviceId(d.deviceId)}
                              >
                                设置
                              </Button>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {d.lastTelemetryAt
                          ? new Date(d.lastTelemetryAt).toLocaleString('zh-CN', {
                              timeZone: 'Asia/Shanghai',
                              hour12: false,
                            })
                          : '—'}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleEdit(d)}
                          >
                            <Pencil className="w-3 h-3" />
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleBind(d)}
                          >
                            <Link2 className="w-3 h-3" />
                            绑定
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={TABLE_COL_COUNT}
                    className="px-5 py-8 text-center text-sm text-muted-foreground"
                  >
                    未找到匹配的设备
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* NO-50a：责任人设置（点名到人的依据） */}
      {responsibilityDeviceId && (
        <ResponsibilityDialog
          deviceId={responsibilityDeviceId}
          onClose={() => setResponsibilityDeviceId(null)}
        />
      )}

      {/* 设备配置抽屉 */}
      <BatchCapabilityRestoreDialog
        open={batchRestoreOpen}
        onOpenChange={setBatchRestoreOpen}
        onApplied={() => queryClient.invalidateQueries({ queryKey: queryKeys.devices() })}
      />

      <DeviceConfigDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        mode={drawerMode}
        device={selectedDevice}
        onSuccess={handleSuccess}
      />
    </div>
  );
};

export default Devices;
