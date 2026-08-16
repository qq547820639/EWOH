/* SimulationRunList.render.test.tsx — 仿真运行台账纯展示列表渲染 smoke（NO-13s / ADR-068）。
 *
 * 数据型页面渲染 smoke 推广（R-87 模式）：行模型注入 → 契约字段透出
 * （runId/kind 标签/状态标签+语调/结果摘要头条/失败原因）+ 选中态
 * aria-pressed。纯展示组件零网络。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { SimulationRunList } from './SimulationRunList';
import type { RunListRow } from './simulationConsoleLogic';

const COMPLETED: RunListRow = {
  runId: 'sim:run-1',
  kind: 'capacity',
  kindLabel: '产能评估',
  status: 'completed',
  statusLabel: '已完成',
  tone: 'positive',
  headline: '瓶颈工位 ST-1 · 线产能（件/时） 30 · 利用率 75% · 过载 否',
  failureReason: null,
};

const FAILED: RunListRow = {
  runId: 'sim:run-2',
  kind: 'what_if',
  kindLabel: 'What-if 方案推演',
  status: 'failed',
  statusLabel: '失败',
  tone: 'negative',
  headline: 'parameters_invalid（服务端 fail-closed）',
  failureReason: 'parameters_invalid（服务端 fail-closed）',
};

describe('SimulationRunList 渲染 smoke（NO-13s / ADR-068）', () => {
  it('数据行：契约字段透出（runId/kind 标签/状态标签/结果摘要头条）', () => {
    const markup = renderToStaticMarkup(
      <SimulationRunList rows={[COMPLETED]} selectedRunId={null} onSelectRun={jest.fn()} />,
    );
    expect(markup).toContain('sim:run-1');
    expect(markup).toContain('产能评估');
    expect(markup).toContain('已完成');
    expect(markup).toContain('瓶颈工位 ST-1');
    expect(markup).toContain('simulation-run-list');
  });

  it('失败行：failureReason 作为头条显式透出（§33 不静默）+ 选中态 aria-pressed', () => {
    const markup = renderToStaticMarkup(
      <SimulationRunList rows={[FAILED]} selectedRunId="sim:run-2" onSelectRun={jest.fn()} />,
    );
    expect(markup).toContain('parameters_invalid（服务端 fail-closed）');
    expect(markup).toContain('失败');
    expect(markup).toContain('aria-pressed="true"');
  });
});
