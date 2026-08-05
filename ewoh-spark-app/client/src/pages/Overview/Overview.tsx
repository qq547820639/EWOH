import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, Users, Zap, TrendingUp, ArrowRight, Map } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getOverview, getEvents, getDevices } from '../../api/dashboard';
import type { OverviewStats, EventInfo, DeviceInfo } from '@shared/api.interface';
import AppErrorState from '../../components/AppErrorState';
import DataStates from '../../components/DataStates';

function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
  link,
}: {
  title: string;
  value: string | number;
  subtitle: string;
  icon: LucideIcon;
  color: string;
  link?: string;
}) {
  const content = (
    <div className="bg-white rounded-xl p-5 border border-[hsl(220_14%_89%)] hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-[hsl(218_10%_42%)]">{title}</p>
          <p className="text-3xl font-bold mt-2 text-[hsl(220_14%_14%)]">{value}</p>
          <p className="text-xs text-[hsl(218_10%_42%)] mt-1">{subtitle}</p>
        </div>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
      {link && (
        <div className="flex items-center gap-1 mt-3 text-xs text-[hsl(221_83%_53%)] font-medium">
          查看详情 <ArrowRight className="w-3 h-3" />
        </div>
      )}
    </div>
  );
  return link ? <Link to={link}>{content}</Link> : content;
}

const Overview = () => {
  const {
    data: stats,
    isError: statsError,
    error: statsErrorObj,
    refetch: refetchStats,
    isStale: statsStale,
    dataUpdatedAt: statsUpdatedAt,
  } = useQuery<OverviewStats>({
    queryKey: ['overview'],
    queryFn: getOverview,
    refetchInterval: 30000,
  });

  const { data: events } = useQuery<EventInfo[]>({
    queryKey: ['events-recent'],
    queryFn: () => getEvents(8),
    refetchInterval: 30000,
  });

  const { data: devices } = useQuery<DeviceInfo[]>({
    queryKey: ['devices'],
    queryFn: getDevices,
    refetchInterval: 30000,
  });

  const severityColor: Record<string, string> = {
    L1: 'bg-green-100 text-green-700',
    L2: 'bg-orange-100 text-orange-700',
    L3: 'bg-red-100 text-red-700',
  };

  const statusColor: Record<string, string> = {
    open: 'bg-red-100 text-red-700',
    handled: 'bg-yellow-100 text-yellow-700',
    closed: 'bg-green-100 text-green-700',
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">EWOH 具身工厂操作系统</h1>
          <p className="text-sm text-[hsl(218_10%_42%)] mt-1">外骨骼作业健康监测 · 实时态势总览</p>
        </div>
        <Link
          to="/command-map"
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-[hsl(221_83%_53%)] to-[hsl(250_73%_55%)] hover:opacity-90 transition-opacity shadow-sm"
        >
          <Map className="w-4 h-4" />
          进入指挥地图
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {statsError && (
        <AppErrorState
          error={statsErrorObj}
          errorMessage="总览数据加载失败"
          impact="KPI 指标将无法展示，其余功能可正常使用。"
          onRetry={() => refetchStats()}
          backHref="/command-center"
        />
      )}

      {statsStale && stats && !statsError && (
        <DataStates
          health="stale"
          message="总览指标已过期，正在展示上次成功获取的数据。"
          detail={statsUpdatedAt ? `更新于 ${new Date(statsUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : undefined}
          onRetry={() => refetchStats()}
        />
      )}

      {/* 指挥地图能力概览 */}
      <div className="bg-gradient-to-r from-[hsl(221_83%_53%)] to-[hsl(250_73%_55%)] rounded-xl p-5 text-white">
        <div className="flex items-center gap-2 mb-2">
          <Map className="w-5 h-5" />
          <h2 className="font-semibold">指挥地图 · 工厂具身智能操作系统</h2>
        </div>
        <p className="text-sm text-white/80 mb-3">
          9 种地图模式 · L0/L1/L2 分级建模 · 时间轴回放 · 调度方案比较 · 班组长工作台 · 事件中心 · 本地助手
        </p>
        <div className="flex flex-wrap gap-2">
          {['看得见', '看得懂', '能预测', '能建议', '能学习'].map((c) => (
            <span key={c} className="px-2.5 py-1 rounded-full text-xs font-medium bg-white/20 backdrop-blur">
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* KPI 卡片 */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard
          title="在线设备"
          value={stats ? `${stats.deviceOnline}/${stats.deviceTotal}` : '—'}
          subtitle="设备在线/总数"
          icon={Activity}
          color="bg-[hsl(221_83%_53%)]"
          link="/devices"
        />
        <KpiCard
          title="开放事件"
          value={stats?.eventOpen ?? '—'}
          subtitle="待处置风险事件"
          icon={AlertTriangle}
          color="bg-[hsl(2_84%_62%)]"
          link="/events"
        />
        <KpiCard
          title="高危告警"
          value={stats?.eventCritical ?? '—'}
          subtitle="L2+严重度事件"
          icon={Zap}
          color="bg-[hsl(26_90%_49%)]"
          link="/events"
        />
        <KpiCard
          title="在岗人员"
          value={stats?.workerCount ?? '—'}
          subtitle={`平均负荷 ${stats ? (stats.avgLoad * 100).toFixed(1) : '—'}%`}
          icon={Users}
          color="bg-[hsl(130_54%_42%)]"
          link="/workers"
        />
      </div>

      {/* 两栏布局 */}
      <div className="grid grid-cols-3 gap-6">
        {/* 最近事件 */}
        <div className="col-span-2 bg-white rounded-xl border border-[hsl(220_14%_89%)]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[hsl(220_14%_89%)]">
            <h2 className="font-semibold text-[hsl(220_14%_14%)]">最近事件</h2>
            <Link to="/events" className="text-xs text-[hsl(221_83%_53%)] hover:underline">
              查看全部
            </Link>
          </div>
          <div className="divide-y divide-[hsl(220_14%_89%)]">
            {events && events.length > 0 ? (
              events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${severityColor[ev.severity] || 'bg-gray-100 text-gray-700'}`}
                  >
                    {ev.severity}
                  </span>
                  <span className="text-sm text-[hsl(220_14%_14%)] flex-1 truncate">{ev.title}</span>
                  <span className="text-xs text-[hsl(218_10%_42%)]">{ev.deviceId}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[ev.status] || 'bg-gray-100 text-gray-700'}`}
                  >
                    {ev.status}
                  </span>
                  <span className="text-xs text-[hsl(218_10%_42%)] w-32 text-right">
                    {ev.createdAt ? new Date(ev.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                  </span>
                </div>
              ))
            ) : (
              <div className="px-5 py-8 text-center text-sm text-[hsl(218_10%_42%)]">暂无事件</div>
            )}
          </div>
        </div>

        {/* 设备状态 */}
        <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[hsl(220_14%_89%)]">
            <h2 className="font-semibold text-[hsl(220_14%_14%)]">设备状态</h2>
            <Link to="/devices" className="text-xs text-[hsl(221_83%_53%)] hover:underline">
              详情
            </Link>
          </div>
          <div className="p-5 space-y-3">
            {devices && devices.length > 0 ? (
              devices.map((d) => (
                <div key={d.id} className="flex items-center gap-3">
                  <div
                    className={`w-2 h-2 rounded-full ${d.online ? 'bg-green-500' : 'bg-gray-300'}`}
                  />
                  <span className="text-sm font-medium text-[hsl(220_14%_14%)] w-20">{d.deviceId}</span>
                  <span className="text-xs text-[hsl(218_10%_42%)] flex-1 truncate">{d.workerName}</span>
                  <div className="flex items-center gap-1 w-20">
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${d.batteryPct > 50 ? 'bg-green-500' : d.batteryPct > 20 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${d.batteryPct}%` }}
                      />
                    </div>
                    <span className="text-xs text-[hsl(218_10%_42%)]">{d.batteryPct}%</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center text-sm text-[hsl(218_10%_42%)] py-4">暂无设备</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Overview;
