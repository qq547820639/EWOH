/* MapViewport 页面级渲染 smoke（NO-13e / ADR-054：工厂操作台渲染测试补强）。
 *
 * - react-zoom-pan-pinch 以受控替身 mock（其行为不在本测试范围）；
 * - 以 renderToStaticMarkup 断言（与既有 client 测试同技术栈）：
 *   - 非调度模式：渲染地图 svg（FactoryMap），不渲染调度叠加层；
 *   - scheduling 模式：叠加层容器出现（模式分支确定性）；
 *   - 实体渲染分支（culling 生产接线不破坏默认渲染面）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import MapViewport from './MapViewport';

jest.mock('react-zoom-pan-pinch', () => ({
  TransformWrapper: ({ children }: { children: (api: Record<string, unknown>) => React.ReactNode }) =>
    children({ zoomIn: jest.fn(), zoomOut: jest.fn(), resetTransform: jest.fn(), zoomToElement: jest.fn() }),
  TransformComponent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// 工作台面板含重依赖链（api/http 等），渲染 smoke 以受控替身隔离（其行为不在本测试范围）。
jest.mock('./IntelligenceWorkspace', () => ({ __esModule: true, default: () => null }));
jest.mock('./PlanCompareWorkspace', () => ({ __esModule: true, default: () => null }));

const baseProps = {
  entities: [],
  worldState: { snapshotVersion: 'v1', ts: '', worldVersion: 1, entityVersions: {}, reservations: [], persons: [], tasks: [], devices: [], stations: [], backlog: [], events: [] } as never,
  environmentReadings: [],
  mode: 'default' as never,
  level: 'L0' as never,
  selectedEntityId: null,
  onSelectEntity: jest.fn(),
  replayMode: false,
  replayTime: null,
  focusPlanPersons: [],
  onFocusPlanPersonsConsumed: jest.fn(),
  planOverlay: { plan: null, routeGraph: null },
  candidates: null,
  selectedTaskId: null,
  visibleBounds: null,
  schedulerState: { persons: [], tasks: [], stations: [], ui: { activeLayers: [] }, updateUi: jest.fn() } as never,
  selectedPlanId: null,
  showCompare: false,
  compareVm: null,
  compareUi: null,
  compareUnchangedPoints: [],
  compareResult: null,
  onFocusCompareTask: jest.fn(),
  onCompareUiChange: jest.fn(),
  onToggleCompare: jest.fn(),
  onCloseDiff: jest.fn(),
  previewConflict: null,
  previewDiffVm: null,
  replanPreview: null,
  activePlan: null,
  showIntelligence: false,
  showWorkspace: false,
  onToggleIntelligence: jest.fn(),
  onToggleWorkspace: jest.fn(),
  onSelectTask: jest.fn(),
  onCloseIntelligence: jest.fn(),
  setMode: jest.fn(),
  onLevelSelect: jest.fn(),
};

describe('MapViewport 页面级渲染 smoke（NO-13e / ADR-054）', () => {
  it('非调度模式：渲染地图 svg（FactoryMap），不渲染调度叠加层', () => {
    const markup = renderToStaticMarkup(<MapViewport {...baseProps} />);
    expect(markup).toContain('<svg');
    // 审计 A1（2026-08-19）：叠加层移入 FactoryMap 基础 svg 内（不再有独立
    // 绝对定位 svg 容器）；调度叠加层以 data-scheduler-overlay 标识。
    expect(markup).not.toContain('data-scheduler-overlay');
  });

  it('scheduling 模式：叠加层渲染进基础 svg（同 viewBox/变换）', () => {
    const markup = renderToStaticMarkup(<MapViewport {...baseProps} mode={'scheduling' as never} />);
    expect(markup).toContain('data-scheduler-overlay');
    // 叠加层不再以独立绝对定位 svg 存在（旧实现缩放/平移错位的根源）。
    expect(markup).not.toContain('<svg class="absolute inset-0');
  });

  it('visibleBounds 接线不破坏渲染（culling 边界透传面）', () => {
    const markup = renderToStaticMarkup(
      <MapViewport {...baseProps} visibleBounds={{ minX: -10, minY: -10, maxX: 10, maxY: 10 }} />,
    );
    expect(markup).toContain('<svg');
  });
});
