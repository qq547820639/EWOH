import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  createWorkbenchExport,
  getRoleWorkbench,
  getWorkbenchExportTask,
  listWorkbenchViews,
  saveWorkbenchView,
  type RoleWorkbenchRole,
  type WorkbenchView,
} from '../../api/operations';
import { getAuthUser } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import QueryState from '../../components/QueryState';
import { getRoleSchema } from './roleSchema';
import {
  canUseWorkbenchDebug,
  resolveAuthorizedWorkbenchRoles,
  resolveDefaultWorkbenchRole,
} from './workbenchAccess';
import { parseSavedView } from './workbenchListLogic';
import {
  createWorkbenchScanner,
  inferInputMode,
  matchShortcut,
  mergeScannedValue,
  touchTargetSize,
  type WorkbenchInputMode,
} from './workbenchInput';
import {
  LEGACY_VIEW_PREFIX,
  PAGE_SIZE,
  ROLES,
  buildFilterParams,
  buildPageParams,
  buildRoleParams,
  buildSortParams,
  defaultListState,
  parseLegacyViewKey,
  readListStates,
  serverViewKey,
} from './roleWorkbenchState';
import {
  exportRecordReducer,
  type ExportState,
} from './workbenchExport';
import { WorkbenchListSection } from './WorkbenchList';
import { SavedViewsPanel } from './SavedViewsPanel';
import { WorkbenchChrome } from './WorkbenchChrome';

/**
 * 角色任务工作台（或者编排器）。
 *
 * 职责收敛为：认证/角色决策、workbench 聚合查询、保存视图状态、导出轮询、
 * 键盘快捷键与 URL 同步。列表/表格渲染见 WorkbenchList，头部/KPI 见
 * WorkbenchChrome，已保存视图见 SavedViewsPanel，查询状态与导出状态机的
 * 纯逻辑见 roleWorkbenchState / workbenchExport。
 */
export default function RoleWorkbench(): React.ReactElement {
  const authRoles = useMemo(() => getAuthUser()?.roles ?? [], []);
  const personId = useMemo(() => getAuthUser()?.userId ?? undefined, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  });

  // TR-9.2: 默认角色来自当前认证用户，普通用户绝不默认 manager。
  // 角色以 URL 为准，刷新/前进后退/复制链接均可恢复。
  const role: RoleWorkbenchRole = useMemo(() => {
    const found = ROLES.find((item) => item.key === searchParams.get('role'));
    return found ? found.key : resolveDefaultWorkbenchRole(authRoles);
  }, [searchParams, authRoles]);

  const [debugMode, setDebugMode] = useState(false);
  // 多输入方式：默认由平台能力推断（触摸/键盘），管理员可切换单手/手套以放大触控目标。
  const [inputMode, setInputMode] = useState<WorkbenchInputMode>(() =>
    inferInputMode({
      hasTouch:
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
      coarsePointer:
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
    }),
  );
  const filterInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const activeListKeyRef = useRef<string | null>(null);

  const workbenchQuery = useQuery({
    queryKey: queryKeys.roleWorkbench(role),
    queryFn: () => getRoleWorkbench(role, role === 'operator' ? personId : undefined),
    staleTime: 30_000,
  });

  const schema = getRoleSchema(role);
  const data = workbenchQuery.data?.data ?? {};
  const generatedAt = workbenchQuery.data?.generatedAt;

  // 服务端判定：调试/模拟权限与可访问角色集（不信任前端 role 参数）。
  const serverAuthorized = workbenchQuery.data?.authorizedRoles;
  const canDebug =
    workbenchQuery.data?.canDebug ?? canUseWorkbenchDebug(authRoles);
  const simulating = Boolean(workbenchQuery.data?.simulating);

  // 客户端镜像在数据到达前先渲染标签；数据到达后以服务端为准。
  const clientAuthorized = useMemo(
    () => resolveAuthorizedWorkbenchRoles(authRoles),
    [authRoles],
  );
  const visibleRoles =
    serverAuthorized && serverAuthorized.length > 0
      ? serverAuthorized
      : clientAuthorized;
  const visibleTabs = useMemo(
    () => ROLES.filter((item) => visibleRoles.includes(item.key)),
    [visibleRoles],
  );

  // 每个列表的查询状态（从 URL 派生，刷新/复制链接可恢复）。
  const listStates = useMemo(
    () => readListStates(searchParams, schema.lists),
    [searchParams, schema],
  );

  // ---- 保存视图：服务端持久化 / 跨设备 / 共享 ----
  const [savedViews, setSavedViews] = useState<WorkbenchView[]>([]);
  const refreshViews = useCallback(() => {
    listWorkbenchViews()
      .then(setSavedViews)
      .catch(() => {
        // 视图加载失败保持静默，不影响主流程。
      });
  }, []);

  useEffect(() => {
    refreshViews();
  }, [refreshViews, role]);

  const savedViewsForRole = useMemo(
    () => savedViews.filter((view) => view.role === role),
    [savedViews, role],
  );

  const saveListView = useCallback(
    async (listKey: string) => {
      const st = listStates[listKey];
      try {
        await saveWorkbenchView(serverViewKey(role, listKey), {
          role,
          listKey,
          filter: st?.filter ?? '',
          sortKey: st?.sort?.key,
          sortDir: st?.sort?.dir,
          limit: PAGE_SIZE,
        });
        refreshViews();
      } catch {
        // 保存失败保持静默，不打断用户操作。
      }
    },
    [role, listStates, refreshViews],
  );

  // 一次性迁移：把旧版 localStorage 视图推送到服务端后移除本地键（幂等）。
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith(LEGACY_VIEW_PREFIX)) {
        keys.push(storageKey);
      }
    }
    for (const storageKey of keys) {
      const parsed = parseLegacyViewKey(storageKey);
      const legacy = parseSavedView(localStorage.getItem(storageKey));
      if (!parsed || !legacy) continue;
      saveWorkbenchView(serverViewKey(parsed.role, parsed.listKey), {
        role: parsed.role,
        listKey: parsed.listKey,
        filter: legacy.filter,
        sortKey: legacy.sortKey,
        sortDir: legacy.sortDir,
        limit: legacy.limit,
      })
        .then(() => localStorage.removeItem(storageKey))
        .catch(() => {
          // 迁移失败保留本地键，下次进入重试。
        });
    }
  }, []);

  // 加载该角色已保存的视图到 URL（仅填充 URL 中未显式给出的列表参数）。
  useEffect(() => {
    let cancelled = false;
    listWorkbenchViews()
      .then((views) => {
        if (cancelled) return;
        const next = new URLSearchParams(searchParamsRef.current);
        let changed = false;
        for (const view of views) {
          if (view.role !== role) continue;
          if (!next.has(`${view.listKey}.filter`) && view.filter) {
            next.set(`${view.listKey}.filter`, view.filter);
            changed = true;
          }
          if (!next.has(`${view.listKey}.sort`) && view.sortKey) {
            next.set(`${view.listKey}.sort`, view.sortKey);
            changed = true;
          }
          if (!next.has(`${view.listKey}.dir`) && view.sortDir) {
            next.set(`${view.listKey}.dir`, view.sortDir);
            changed = true;
          }
        }
        if (changed) setSearchParams(next, { replace: true });
      })
      .catch(() => {
        // 静默。
      });
    return () => {
      cancelled = true;
    };
  }, [role, setSearchParams]);

  // 导出状态：每个列表一个，用导出状态机管理迁移，避免散落 setState。
  const [exportStates, dispatchExport] = useReducer(
    exportRecordReducer,
    {} as Record<string, ExportState>,
  );
  useEffect(() => {
    dispatchExport({ type: 'reset-all' });
  }, [role]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const maybeDownload = useCallback((url?: string) => {
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener';
    anchor.target = '_blank';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, []);

  const pollExport = useCallback(
    (taskId: string, listKey: string) => {
      const tick = async () => {
        if (!mountedRef.current) return;
        try {
          const task = await getWorkbenchExportTask(taskId);
          if (!mountedRef.current) return;
          dispatchExport({
            type: 'tick',
            listKey,
            status: task.status,
            progress: task.progress,
          });
          if (task.status === 'queued' || task.status === 'running') {
            window.setTimeout(tick, 1500);
          } else if (task.status === 'succeeded') {
            maybeDownload(task.downloadUrl);
          }
        } catch {
          if (mountedRef.current) {
            dispatchExport({
              type: 'tick',
              listKey,
              status: 'failed',
              progress: 0,
            });
          }
        }
      };
      void tick();
    },
    [maybeDownload],
  );

  const runExport = useCallback(
    async (listKey: string) => {
      const filter = listStates[listKey]?.filter ?? '';
      dispatchExport({ type: 'start', listKey });
      try {
        const task = await createWorkbenchExport(role, listKey, filter);
        if (!mountedRef.current) return;
        dispatchExport({
          type: 'tick',
          listKey,
          status: task.status,
          progress: task.progress,
        });
        if (task.status === 'queued' || task.status === 'running') {
          pollExport(task.id, listKey);
        } else if (task.status === 'succeeded') {
          maybeDownload(task.downloadUrl);
        }
      } catch {
        if (mountedRef.current) {
          dispatchExport({ type: 'tick', listKey, status: 'failed', progress: 0 });
        }
      }
    },
    [role, listStates, pollExport, maybeDownload],
  );

  // ---- URL 同步的查询参数更新（纯映射收敛于 roleWorkbenchState） ----
  const setListFilter = useCallback(
    (listKey: string, value: string) => {
      setSearchParams((prev) => buildFilterParams(prev, listKey, value));
    },
    [setSearchParams],
  );

  const toggleSort = useCallback(
    (listKey: string, columnKey: string) => {
      setSearchParams((prev) => buildSortParams(prev, listKey, columnKey));
    },
    [setSearchParams],
  );

  const setListPage = useCallback(
    (listKey: string, page: number) => {
      setSearchParams((prev) => buildPageParams(prev, listKey, page));
    },
    [setSearchParams],
  );

  const selectRole = useCallback(
    (next: RoleWorkbenchRole) => {
      setSearchParams((prev) => buildRoleParams(prev, next));
    },
    [setSearchParams],
  );

  // 多输入方式：扫码枪 + 键盘快捷键（Ctrl/Cmd+F 聚焦筛选、Ctrl/Cmd+R 刷新、Ctrl/Cmd+S 保存视图）。
  useEffect(() => {
    const scanner = createWorkbenchScanner({
      onScan: (value) => {
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        if (!key) return;
        setListFilter(key, mergeScannedValue(listStates[key]?.filter ?? '', value));
      },
      onError: () => {
        // 扫码失败/过短：保持静默，用户可手动输入。
      },
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      scanner.handleKeyDown(event);
      const action = matchShortcut(event);
      if (!action) return;
      if (action === 'focus-filter') {
        event.preventDefault();
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        filterInputRefs.current[key ?? '']?.focus();
      } else if (action === 'refresh') {
        event.preventDefault();
        void workbenchQuery.refetch();
      } else if (action === 'save-view') {
        event.preventDefault();
        const key = activeListKeyRef.current ?? schema.lists[0]?.key;
        if (key) void saveListView(key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [schema, listStates, setListFilter, saveListView, workbenchQuery]);

  const kpiCards = useMemo(
    () => schema.kpis.filter((kpi) => data[kpi.key] !== undefined),
    [schema, data],
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <WorkbenchChrome
        schema={schema}
        role={role}
        visibleTabs={visibleTabs}
        canDebug={canDebug}
        debugMode={debugMode}
        onToggleDebug={() => setDebugMode((value) => !value)}
        onRefresh={() => workbenchQuery.refetch()}
        isFetching={workbenchQuery.isFetching}
        simulating={simulating}
        inputMode={inputMode}
        onInputModeChange={setInputMode}
        onSelectRole={selectRole}
        data={data}
        generatedAt={generatedAt}
        kpiCards={kpiCards}
      />

      <QueryState
        isLoading={workbenchQuery.isLoading}
        isFetching={workbenchQuery.isFetching}
        isError={workbenchQuery.isError}
        isEmpty={kpiCards.length === 0 && schema.lists.length === 0}
        onRefresh={() => workbenchQuery.refetch()}
        error={workbenchQuery.error}
        errorMessage={
          workbenchQuery.error instanceof Error
            ? workbenchQuery.error.message
            : '加载失败'
        }
        backHref="/command-center"
        loadingMessage="正在加载工作台"
        emptyMessage="当前角色暂无聚合数据。"
        updatedAt={workbenchQuery.dataUpdatedAt}
      >
        {schema.lists.map((list) => (
          <WorkbenchListSection
            key={list.key}
            list={list}
            role={role}
            personId={personId}
            state={listStates[list.key] ?? defaultListState()}
            targetSize={touchTargetSize(inputMode)}
            exportState={exportStates[list.key] ?? { status: 'idle', progress: 0 }}
            filterInputRef={(element) => {
              filterInputRefs.current[list.key] = element;
            }}
            onFilterFocus={() => {
              activeListKeyRef.current = list.key;
            }}
            onFilter={(value) => setListFilter(list.key, value)}
            onToggleSort={(columnKey) => toggleSort(list.key, columnKey)}
            onLoadMore={() =>
              setListPage(list.key, (listStates[list.key]?.page ?? 1) + 1)
            }
            onSaveView={() => {
              void saveListView(list.key);
            }}
            onExport={() => {
              void runExport(list.key);
            }}
          />
        ))}

        <SavedViewsPanel
          role={role}
          views={savedViewsForRole}
          onViewsChanged={refreshViews}
        />
      </QueryState>
    </div>
  );
}