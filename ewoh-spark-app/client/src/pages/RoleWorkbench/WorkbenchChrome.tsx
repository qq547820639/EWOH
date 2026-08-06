import { Link } from 'react-router-dom';
import {
  CloudOff,
  Eye,
  EyeOff,
  FilterX,
  RefreshCw,
  TriangleAlert,
  Users,
} from 'lucide-react';
import type { RoleWorkbenchRole } from '../../api/operations';
import { Button } from '@client/src/components/ui/button';
import {
  formatValue,
  type KpiDefinition,
  type RoleSchema,
} from './roleSchema';
import { ROLES } from './roleWorkbenchState';
import { touchTargetSize, type WorkbenchInputMode } from './workbenchInput';
import type { PageDataHealth } from './workbenchDataStates';

/**
 * 角色工作台「页面骨架」：头部、输入方式切换、模拟提示、角色页签、快捷跳转、
 * KPI 指标卡与诊断数据区。纯展示组件，由 RoleWorkbenchOrchestrator 注入数据。
 */
export interface WorkbenchChromeProps {
  schema: RoleSchema;
  role: RoleWorkbenchRole;
  visibleTabs: Array<{ key: RoleWorkbenchRole; label: string }>;
  canDebug: boolean;
  debugMode: boolean;
  onToggleDebug: () => void;
  onRefresh: () => void;
  isFetching: boolean;
  simulating: boolean;
  inputMode: WorkbenchInputMode;
  onInputModeChange: (mode: WorkbenchInputMode) => void;
  onSelectRole: (role: RoleWorkbenchRole) => void;
  data: Record<string, unknown>;
  generatedAt?: string;
  kpiCards: KpiDefinition[];
  /** 页面级数据健康度（由 availability 派生）。 */
  pageHealth?: PageDataHealth;
  /** 当前开启筛选的列表数。 */
  activeFilterCount?: number;
  /** 清除所有列表筛选/排序/页码并关闭已打开视图。 */
  onClearFilters?: () => void;
}

const INPUT_MODES: Array<[WorkbenchInputMode, string]> = [
  ['keyboard', '键盘'],
  ['touch', '触摸'],
  ['scan', '扫码'],
  ['singlehand', '单手'],
  ['glove', '手套'],
];

const PAGE_HEALTH_LABEL: Record<PageDataHealth, string> = {
  ok: '数据完整',
  partial: '部分数据缺失',
  degraded: '数据源降级',
};

export function WorkbenchChrome({
  schema,
  role,
  visibleTabs,
  canDebug,
  debugMode,
  onToggleDebug,
  onRefresh,
  isFetching,
  simulating,
  inputMode,
  onInputModeChange,
  onSelectRole,
  data,
  generatedAt,
  kpiCards,
  pageHealth = 'ok',
  activeFilterCount = 0,
  onClearFilters,
}: WorkbenchChromeProps): React.ReactElement {
  const targetSize = touchTargetSize(inputMode);

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">角色任务工作台</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            {schema.description}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canDebug && (
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleDebug}
            >
              {debugMode ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              {debugMode ? '关闭诊断' : '诊断'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
          >
            <RefreshCw className="size-3" />
            刷新
          </Button>
        </div>
      </header>

      {/* 页面元数据条：更新时间 / 缓存状态 / 数据健康度 / 筛选摘要 + 清除 */}
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-4 py-2 text-xs text-[hsl(218_10%_42%)]"
      >
        <span className="inline-flex items-center gap-1.5">
          <RefreshCw className="size-3" />
          {generatedAt
            ? `更新于 ${new Date(generatedAt).toLocaleTimeString('zh-CN', {
                hour12: false,
              })}`
            : '尚未加载'}
        </span>
        {pageHealth !== 'ok' && (
          <span
            className={
              pageHealth === 'degraded'
                ? 'inline-flex items-center gap-1.5 font-medium text-orange-600'
                : 'inline-flex items-center gap-1.5 font-medium text-amber-600'
            }
          >
            {pageHealth === 'degraded' ? (
              <CloudOff className="size-3" />
            ) : (
              <TriangleAlert className="size-3" />
            )}
            {PAGE_HEALTH_LABEL[pageHealth]}
          </span>
        )}
        {activeFilterCount > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span>
              已启用 {activeFilterCount} 个列表的筛选
            </span>
            <button
              type="button"
              onClick={onClearFilters}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[hsl(221_83%_53%)] hover:underline"
            >
              <FilterX className="size-3" />
              清除
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <FilterX className="size-3" />
            无筛选
          </span>
        )}
      </div>

      {/* 输入方式切换：键盘 / 触摸 / 扫码 / 单手 / 手套（放大触控目标） */}
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="输入方式"
      >
        <span className="text-xs text-[hsl(218_10%_42%)]">输入方式：</span>
        {INPUT_MODES.map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onInputModeChange(mode)}
            aria-pressed={inputMode === mode}
            className={`rounded-md px-3 py-2 text-xs font-medium ${
              inputMode === mode
                ? 'bg-[hsl(221_83%_53%)] text-white'
                : 'text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
            }`}
            style={{ minHeight: targetSize }}
          >
            {label}
          </button>
        ))}
      </div>

      {simulating && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800"
        >
          <Users className="size-4 shrink-0" />
          <span>
            您正在以「{ROLES.find((item) => item.key === role)?.label ?? role}」角色
            模拟查看（管理员）。此视图不代表您的真实权限，仅用于诊断与演示。
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-1 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-1">
        {visibleTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelectRole(item.key)}
            aria-pressed={role === item.key}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
              role === item.key
                ? 'bg-[hsl(221_83%_53%)] text-white'
                : 'text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
            }`}
          >
            <Users className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      {schema.quickActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[hsl(218_10%_42%)]">快捷跳转：</span>
          {schema.quickActions.map((action) => (
            <Button
              key={action.to}
              asChild
              variant="outline"
              size="sm"
              className="h-8 text-xs"
            >
              <Link to={action.to}>{action.label}</Link>
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpiCards.map((kpi) => (
          <div
            key={kpi.key}
            className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-[hsl(218_10%_42%)]">{kpi.label}</p>
              {kpi.unit && (
                <span className="text-xs text-[hsl(218_10%_42%)]">{kpi.unit}</span>
              )}
            </div>
            <p className="mt-1 text-2xl font-semibold text-[hsl(220_14%_14%)]">
              {formatValue(kpi.format, data[kpi.key])}
            </p>
            <p className="mt-2 text-xs text-[hsl(218_10%_42%)]">
              来源：{kpi.source}
            </p>
            <p className="mt-0.5 text-xs text-[hsl(218_10%_42%)]">
              更新：{kpi.refreshHint}
              {generatedAt
                ? ` · ${new Date(generatedAt).toLocaleTimeString('zh-CN', {
                    hour12: false,
                  })}`
                : ''}
            </p>
          </div>
        ))}
      </div>

      {debugMode && canDebug && (
        <section className="rounded-lg border border-dashed border-[hsl(220_14%_89%)] bg-slate-50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-[hsl(220_14%_14%)]">
            原始诊断数据（服务端鉴权，仅管理员可见）
          </h2>
          <pre className="overflow-x-auto text-xs text-[hsl(218_10%_42%)]">
            {JSON.stringify(data, null, 2)}
          </pre>
        </section>
      )}
    </>
  );
}