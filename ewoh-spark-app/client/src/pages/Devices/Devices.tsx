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
import { Plus, Pencil, Link2, TriangleAlert } from 'lucide-react';
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
import DeviceConfigDrawer from './DeviceConfigDrawer';

type OnlineFilter = 'all' | 'online' | 'offline';
type SourceFilter = 'all' | 'real' | 'simulated' | 'controlled_test' | 'replayed' | 'stale' | 'offline';
type OrderBy =
  | 'batteryDesc'
  | 'battery'
  | 'lastTelemetryAtDesc'
  | 'deviceId'
  | 'deviceIdDesc';

const TABLE_COL_COUNT = 10;

const Devices = (): React.ReactElement => {
  // ===== 搜索参数 =====
  const [keyword, setKeyword] = useState('');
  const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>('all');
  const [batteryMin, setBatteryMin] = useState<string>('');
  const [batteryMax, setBatteryMax] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [orderby, setOrderby] = useState<OrderBy>('batteryDesc');

  // ===== 抽屉状态 =====
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create');
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const queryClient = useQueryClient();

  const searchQuery: DeviceSearchQuery = useMemo(() => {
    const q: DeviceSearchQuery = { orderby };
    if (keyword.trim()) q.keyword = keyword.trim();
    if (onlineFilter !== 'all') q.online = onlineFilter === 'online';
    if (batteryMin !== '') q.batteryMin = Number(batteryMin);
    if (batteryMax !== '') q.batteryMax = Number(batteryMax);
    if (sourceFilter !== 'all') q.sourceType = sourceFilter;
    return q;
  }, [keyword, onlineFilter, batteryMin, batteryMax, sourceFilter, orderby]);

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

  const entityNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (entities ?? []).forEach((e) => {
      m.set(e.entityId, e.name);
      m.set(e.id, e.name);
    });
    return m;
  }, [entities]);

  const batteryData = (devices || []).map((d) => ({
    name: d.deviceId,
    battery: d.batteryPct,
    online: d.online,
  }));

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
    queryClient.invalidateQueries({ queryKey: ['devices'] });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">设备态势总览</h1>
          <p className="text-sm text-[hsl(218_10%_42%)] mt-1">
            外骨骼设备状态、电量与在线情况
          </p>
          {dataUpdatedAt > 0 && (
            <p className="mt-1 text-xs text-[hsl(218_10%_50%)]">
              {isStale ? (
                <span className="inline-flex items-center gap-1 text-amber-600">
                  <TriangleAlert className="h-3 w-3" />
                  数据已过期，暂未获取到最新设备状态
                </span>
              ) : isFetching ? (
                '正在刷新…'
              ) : (
                `更新于 ${new Date(dataUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
              )}
            </p>
          )}
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4" />
          新增设备
        </Button>
      </div>

      {/* 搜索栏 */}
      <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-[hsl(218_10%_42%)] mb-1">关键字</label>
            <Input
              placeholder="搜索设备ID/姓名/型号"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="h-9"
            />
          </div>

          <div className="w-[140px]">
            <label className="block text-xs text-[hsl(218_10%_42%)] mb-1">在线状态</label>
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
            <label className="block text-xs text-[hsl(218_10%_42%)] mb-1">
              电量区间 (%)
            </label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                placeholder="min"
                value={batteryMin}
                onChange={(e) => setBatteryMin(e.target.value)}
                className="h-9"
              />
              <span className="text-xs text-[hsl(218_10%_42%)]">-</span>
              <Input
                type="number"
                placeholder="max"
                value={batteryMax}
                onChange={(e) => setBatteryMax(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="w-[170px]">
            <label className="block text-xs text-[hsl(218_10%_42%)] mb-1">来源类型</label>
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
            <label className="block text-xs text-[hsl(218_10%_42%)] mb-1">排序</label>
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
      <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)] p-5">
        <h2 className="font-semibold text-[hsl(220_14%_14%)] mb-4">设备电量分布</h2>
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
                    {batteryData.map((entry, index) => (
                      <Cell key={index} fill={batteryColor(entry.battery)} />
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
        ) : (
          <div className="h-[240px] flex items-center justify-center text-sm text-[hsl(218_10%_42%)]">
            暂无数据
          </div>
        )}
      </div>

      {/* 设备列表表格 */}
      <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[hsl(220_14%_89%)]">
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">设备列表</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">设备ID</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">工人姓名</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">设备型号</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">来源</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">电量</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">在线状态</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">绑定工位</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">绑定人员</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">最后通信</th>
                <th className="text-left px-5 py-3 font-medium whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td
                    colSpan={TABLE_COL_COUNT}
                    className="px-5 py-8 text-center text-sm text-[hsl(218_10%_42%)]"
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
                      className="border-b border-[hsl(220_14%_89%)] hover:bg-[hsl(220_14%_96%)]"
                    >
                      <td className="px-5 py-3 text-sm font-medium text-[hsl(220_14%_14%)] whitespace-nowrap">
                        {d.deviceId}
                      </td>
                      <td className="px-5 py-3 text-sm text-[hsl(220_14%_14%)] whitespace-nowrap">
                        {d.workerName || '—'}
                      </td>
                      <td className="px-5 py-3 text-sm text-[hsl(218_10%_42%)] whitespace-nowrap">
                        {d.deviceModel || '—'}
                      </td>
                      <td className="px-5 py-3">
                        <DataSourceBadge source={d.sourceType} />
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                d.batteryPct > 50
                                  ? 'bg-green-500'
                                  : d.batteryPct > 20
                                    ? 'bg-yellow-500'
                                    : 'bg-red-500'
                              }`}
                              style={{ width: `${d.batteryPct}%` }}
                            />
                          </div>
                          <span className="text-xs text-[hsl(218_10%_42%)] tabular-nums">
                            {d.batteryPct}%
                          </span>
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
                          <span className="text-[hsl(220_14%_14%)]">{parentName}</span>
                        ) : (
                          <span className="text-[hsl(218_10%_42%)]">未绑定</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm whitespace-nowrap">
                        {d.boundPersonName ? (
                          <span className="text-[hsl(220_14%_14%)]">{d.boundPersonName}</span>
                        ) : (
                          <span className="text-[hsl(218_10%_42%)]">未绑定</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)] whitespace-nowrap">
                        {d.lastTelemetryAt
                          ? new Date(d.lastTelemetryAt).toLocaleString('zh-CN', {
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
                    className="px-5 py-8 text-center text-sm text-[hsl(218_10%_42%)]"
                  >
                    未找到匹配的设备
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 设备配置抽屉 */}
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
