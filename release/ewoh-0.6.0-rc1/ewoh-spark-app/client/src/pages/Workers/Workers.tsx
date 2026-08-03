import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { getWorkers } from '../../api/dashboard';
import type { WorkerLoad } from '@shared/api.interface';

const Workers = () => {
  const { data: workers, isLoading } = useQuery<WorkerLoad[]>({
    queryKey: ['workers'],
    queryFn: getWorkers,
    refetchInterval: 30000,
  });

  const loadData = (workers || []).map((w) => ({
    name: w.workerName || w.deviceId,
    avgLoad: Number((w.avgLoad * 100).toFixed(1)),
    maxLoad: Number((w.maxLoad * 100).toFixed(1)),
    fatigue: Number((w.fatigueTrend * 100).toFixed(1)),
  }));

  const loadColor = (pct: number) => (pct > 70 ? '#ef4444' : pct > 40 ? '#f97316' : '#22c55e');

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">人员负荷监测</h1>
        <p className="text-sm text-[hsl(218_10%_42%)] mt-1">外骨骼作业人员负荷、疲劳趋势与设备状态</p>
      </div>

      {/* 负荷柱状图 */}
      <div className="bg-white rounded-xl border border-[hsl(220_14%_89%)] p-5">
        <h2 className="font-semibold text-[hsl(220_14%_14%)] mb-4">人员负荷对比</h2>
        {loadData.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={loadData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="avgLoad" name="平均负荷(%)" radius={[4, 4, 0, 0]}>
                {loadData.map((entry, index) => (
                  <Cell key={index} fill={loadColor(entry.avgLoad)} />
                ))}
              </Bar>
              <Bar dataKey="maxLoad" name="峰值负荷(%)" fill="#94a3b8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[260px] flex items-center justify-center text-sm text-[hsl(218_10%_42%)]">暂无数据</div>
        )}
      </div>

      {/* 人员卡片 */}
      <div className="grid grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-3 text-center py-8 text-sm text-[hsl(218_10%_42%)]">加载中...</div>
        ) : workers && workers.length > 0 ? (
          workers.map((w) => (
            <div key={w.deviceId} className="bg-white rounded-xl border border-[hsl(220_14%_89%)] p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-[hsl(220_14%_14%)]">{w.workerName || '未分配'}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        w.online ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {w.online ? '在线' : '离线'}
                    </span>
                  </div>
                  <p className="text-xs text-[hsl(218_10%_42%)] mt-0.5">{w.deviceId}</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-[hsl(220_14%_14%)]">
                    {(w.avgLoad * 100).toFixed(0)}
                    <span className="text-sm text-[hsl(218_10%_42%)]">%</span>
                  </p>
                  <p className="text-xs text-[hsl(218_10%_42%)]">平均负荷</p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[hsl(218_10%_42%)]">峰值负荷</span>
                  <span className="font-medium text-[hsl(220_14%_14%)]">{(w.maxLoad * 100).toFixed(1)}%</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[hsl(218_10%_42%)]">疲劳趋势</span>
                  <span className="font-medium text-[hsl(220_14%_14%)]">{(w.fatigueTrend * 100).toFixed(1)}%</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[hsl(218_10%_42%)]">电量</span>
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${w.batteryPct > 50 ? 'bg-green-500' : w.batteryPct > 20 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${w.batteryPct}%` }}
                      />
                    </div>
                    <span className="font-medium text-[hsl(220_14%_14%)]">{w.batteryPct}%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[hsl(218_10%_42%)]">遥测帧数（1h）</span>
                  <span className="font-medium text-[hsl(220_14%_14%)]">{w.telemetryCount}</span>
                </div>
              </div>

              {/* 负荷进度条 */}
              <div className="mt-4">
                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(w.avgLoad * 100, 100)}%`,
                      backgroundColor: loadColor(w.avgLoad * 100),
                    }}
                  />
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="col-span-3 text-center py-8 text-sm text-[hsl(218_10%_42%)]">暂无人员数据</div>
        )}
      </div>
    </div>
  );
};

export default Workers;
