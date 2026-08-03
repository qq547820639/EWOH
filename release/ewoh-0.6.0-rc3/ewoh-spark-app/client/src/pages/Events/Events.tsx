import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PieChart, Pie, Cell as ReCell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { getEvents, getEventStats } from '../../api/dashboard';
import type { EventInfo, EventStats as EventStatsType } from '@shared/api.interface';

const SEVERITY_COLORS: Record<string, string> = {
  L1: '#22c55e',
  L2: '#f97316',
  L3: '#ef4444',
};

const STATUS_LABELS: Record<string, string> = {
  open: '待处置',
  handled: '处理中',
  closed: '已关闭',
};

const Events = () => {
  const [statusFilter, setStatusFilter] = useState<string>('');

  const { data: events, isLoading } = useQuery<EventInfo[]>({
    queryKey: ['events', statusFilter],
    queryFn: () => getEvents(50, statusFilter || undefined),
    refetchInterval: 30000,
  });

  const { data: stats } = useQuery<EventStatsType>({
    queryKey: ['event-stats'],
    queryFn: getEventStats,
    refetchInterval: 30000,
  });

  const severityData = stats
    ? Object.entries(stats.bySeverity).map(([name, value]) => ({ name, value }))
    : [];

  const trendData = stats?.trend || [];

  const statusButtons = [
    { label: '全部', value: '' },
    { label: '待处置', value: 'open' },
    { label: '处理中', value: 'handled' },
    { label: '已关闭', value: 'closed' },
  ];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">事件与风险看板</h1>
        <p className="text-sm text-[hsl(218_10%_42%)] mt-1">风险事件监控、严重度分布与趋势分析</p>
      </div>

      {/* 图表区 */}
      <div className="grid grid-cols-2 gap-6">
        {/* 严重度饼图 */}
        <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)] p-5">
          <h2 className="font-semibold text-[hsl(220_14%_14%)] mb-4">严重度分布</h2>
          {severityData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={severityData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {severityData.map((entry, index) => (
                    <ReCell key={index} fill={SEVERITY_COLORS[entry.name] || '#94a3b8'} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-[hsl(218_10%_42%)]">暂无数据</div>
          )}
        </div>

        {/* 趋势折线图 */}
        <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)] p-5">
          <h2 className="font-semibold text-[hsl(220_14%_14%)] mb-4">事件趋势（24小时）</h2>
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="count"
                  name="事件数"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-[hsl(218_10%_42%)]">暂无数据</div>
          )}
        </div>
      </div>

      {/* 事件列表 */}
      <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[hsl(220_14%_89%)]">
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">事件列表</h2>
          <div className="flex gap-1">
            {statusButtons.map((btn) => (
              <button
                key={btn.value}
                onClick={() => setStatusFilter(btn.value)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === btn.value
                    ? 'bg-[hsl(221_83%_53%)] text-white'
                    : 'bg-[hsl(220_14%_96%)] text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_89%)]'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <th className="text-left px-5 py-3 font-medium">事件ID</th>
              <th className="text-left px-5 py-3 font-medium">严重度</th>
              <th className="text-left px-5 py-3 font-medium">标题</th>
              <th className="text-left px-5 py-3 font-medium">设备</th>
              <th className="text-left px-5 py-3 font-medium">状态</th>
              <th className="text-left px-5 py-3 font-medium">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-sm text-[hsl(218_10%_42%)]">
                  加载中...
                </td>
              </tr>
            ) : events && events.length > 0 ? (
              events.map((ev) => (
                <tr key={ev.id} className="border-b border-[hsl(220_14%_89%)] hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3 text-xs font-mono text-[hsl(218_10%_42%)]">{ev.eventId}</td>
                  <td className="px-5 py-3">
                    <span
                      className="px-2 py-0.5 rounded text-xs font-medium text-white"
                      style={{ backgroundColor: SEVERITY_COLORS[ev.severity] || '#94a3b8' }}
                    >
                      {ev.severity}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm text-[hsl(220_14%_14%)]">{ev.title}</td>
                  <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">{ev.deviceId}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        ev.status === 'open'
                          ? 'bg-red-100 text-red-700'
                          : ev.status === 'handled'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {STATUS_LABELS[ev.status] || ev.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                    {ev.createdAt ? new Date(ev.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-sm text-[hsl(218_10%_42%)]">
                  暂无事件
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Events;
