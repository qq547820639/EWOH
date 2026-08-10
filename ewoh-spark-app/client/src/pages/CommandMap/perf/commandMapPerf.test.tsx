/* Task 11 / 11.2：Command Map 性能基准（jest 运行，node 环境）。
 *
 * 用 renderToString（node 无 DOM，SSR 路径即 React 组件渲染路径）挂载
 * CommandMapShell（内部 Provider 已 mock，避免 import.meta 的 CJS 限制），
 * React Query 缓存预置 1000 任务大 fixture —— 等价「大 fixture 下 Shell 首绘」。
 * 同时测量长列表虚拟化行为与 SSE 高频事件批处理削减。
 *
 * 输出：output/benchmark-command-map.json（output/ 已 gitignore，不入库）。
 * 本测试只做结构性断言（报告形状/保序/虚拟化生效）；硬预算由 CI
 * （.github/workflows/perf.yml → command-map-perf-gate）读取 JSON 强制执行，
 * 避免开发机性能波动导致套件假失败。
 *
 * 运行：npm run benchmark:command-map（= jest --config client/jest.config.cjs src/pages/CommandMap/perf）
 */
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@client/src/hooks/queryKeys';

// SchedulerRealtimeProvider 依赖 useSchedulerStream（内部有 import.meta.env，node/CJS 不可执行）。
// 与 useCommandMapController.test.tsx 相同的 mock 策略。
jest.mock('@client/src/scheduler/SchedulerRealtimeProvider', () => ({
  SchedulerRealtimeProvider: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
  useSchedulerRealtime: () => ({
    status: 'live',
    statusV2: 'CONNECTED',
    lastEventTime: Date.now(),
    snapshotVersion: 'WS-20260810-0001',
    lastSequence: 0,
    triggerResync: jest.fn(),
  }),
}));

// lib/http 顶层含 Vite 专属 import.meta.env（CJS 无法解析）——mock 掉 axios 工厂，
// 使全部 api/* 模块可在 node 环境加载（与 api/operations.test.ts 同策略）。
jest.mock('@client/src/lib/http', () => ({
  axiosForBackend: jest.fn(),
}));

import CommandMapShell from '../CommandMapShell';
import {
  buildLargeFixture,
  buildReport,
  measureShellRender,
  measureSseBatching,
  measureVirtualization,
  printSummary,
  writeReport,
  type LargeFixture,
} from './commandMapPerf';

function seedQueryCache(qc: QueryClient, fixture: LargeFixture): void {
  qc.setQueryData(queryKeys.spatialEntities, fixture.entities);
  qc.setQueryData(queryKeys.worldState, fixture.worldState);
  qc.setQueryData(queryKeys.overview, fixture.overview);
  qc.setQueryData(queryKeys.events(), fixture.events);
  qc.setQueryData(queryKeys.replaySnapshots, fixture.replaySnapshots);
  qc.setQueryData(queryKeys.environmentSummary, fixture.environmentReadings);
  qc.setQueryData(queryKeys.organizations, fixture.organizations);
  qc.setQueryData(queryKeys.personnel(), fixture.personnel);
  qc.setQueryData(queryKeys.devices({ pageSize: 200 }), fixture.devices);
  qc.setQueryData(['schedule-route-graph'], fixture.routeGraph);
  qc.setQueryData(queryKeys.schedulerSnapshot, fixture.snapshot);
  qc.setQueryData(queryKeys.schedulerContext, {
    snapshotVersion: 'WS-20260810-0001',
    resourceVersion: 1,
    routeGraphVersion: 1,
    policyVersion: 1,
    sourceTimestamp: '2026-08-10T08:00:00.000Z',
  });
  qc.setQueryData(queryKeys.schedulerResourceState, fixture.resources);
  qc.setQueryData(queryKeys.schedulerActivePlans, fixture.plans);
  qc.setQueryData(queryKeys.schedulerConflicts(), { conflicts: fixture.conflicts });
  qc.setQueryData(['scheduler-routes'], fixture.routeGraph);
}

describe('command-map perf benchmark（Task 11/11.2）', () => {
  it('挂载大 fixture 的 CommandMapShell 并产出性能报告', () => {
    const fixture = buildLargeFixture({
      tasks: 1000,
      resources: 300,
      conflicts: 120,
      events: 200,
    });
    expect(fixture.plans[0].assignments.length).toBe(1000);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    seedQueryCache(qc, fixture);

    // 渲染函数注入（SSR = React 组件渲染路径，等价 Shell 首绘成本）。
    // 静默 React dev 模式对地图 SVG NaN 属性的 console.error 噪音，保证基准输出干净。
    const renderShell = () => {
      const originalError = console.error;
      console.error = () => undefined;
      try {
        return renderToString(
          <QueryClientProvider client={qc}>
            <CommandMapShell />
          </QueryClientProvider>,
        );
      } finally {
        console.error = originalError;
      }
    };

    const shell = measureShellRender(renderShell, 3);

    // 虚拟化：1000 行列表在 400px 视口只渲染可视窗口。
    const virtualizationSamples = [
      measureVirtualization({ total: 1000, viewport: 400, itemHeight: 40, scrollTop: 0 }),
      measureVirtualization({ total: 1000, viewport: 400, itemHeight: 40, scrollTop: 20_000 }),
      measureVirtualization({ total: 5000, viewport: 400, itemHeight: 40, scrollTop: 100_000 }),
    ];

    // SSE 批处理：10k 遥测突发合并。
    const sse = measureSseBatching(10_000);

    const report = buildReport({ fixture, shell, virtualizationSamples, sse });
    writeReport(report);
    printSummary(report);

    // 结构性断言（硬预算由 CI gate 执行）。
    expect(report.meta.fixture.tasks).toBe(1000);
    expect(shell.mean).toBeGreaterThan(0);
    expect(shell.mean).toBeLessThan(30_000); // 宽松上界：Shell 首绘可运行
    // 虚拟化生效：1000 行只渲染可视窗口行数（远小于 total）。
    for (const v of virtualizationSamples) {
      expect(v.renderedRows).toBeLessThan(v.total);
      expect(v.renderedRows).toBeLessThanOrEqual(100);
    }
    // SSE 合并生效：写出事件数远小于原始事件数。
    expect(sse.storeWrites).toBeLessThan(sse.rawEvents);
    expect(sse.writeReductionPct).toBeGreaterThanOrEqual(90);
    // 单调守卫与结构性事件保序不被合并破坏。
    expect(sse.seqGuardPreserved).toBe(true);
    expect(sse.structuralEventsAppliedInOrder).toBe(true);
  }, 120_000);
});
