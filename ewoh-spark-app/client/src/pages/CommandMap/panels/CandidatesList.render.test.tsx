/* 候选面板的能力要求区块（NO-16a）：现场必须能"看到要求 → 就地修改"。
 *
 * 背景：能力要求写错会让任务永远匹配不到资源；候选面板正是解释"为什么没有候选"的地方，
 * 因此修改入口必须在这里（而不是让调度员去找接口/改库）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidatesList } from './IntelligenceLayers';
import type { TaskCandidatesResponse } from '@shared/scheduler';

function makeCandidates(overrides: Partial<TaskCandidatesResponse> = {}): TaskCandidatesResponse {
  return {
    taskId: 'T-1',
    taskTitle: '装配任务',
    taskStatus: 'pending_dispatch',
    assigned: false,
    lockedAssigneeId: null,
    lockedDeviceId: null,
    solverVersion: 'heuristic-v2',
    candidates: [],
    generatedAt: new Date().toISOString(),
    requiredDeviceCapabilities: [],
    requiredStationCapabilities: [],
    ...overrides,
  } as unknown as TaskCandidatesResponse;
}

describe('CandidatesList · 任务能力要求', () => {
  it('未设置要求时显式说明（不显示空白），并提供修改入口', () => {
    const html = renderToStaticMarkup(
      <CandidatesList candidates={makeCandidates()} selectedTaskId="T-1" onSaveRequirements={() => {}} />,
    );
    expect(html).toContain('能力要求');
    expect(html).toContain('未设置能力要求');
    expect(html).toContain('task-capability-edit');
  });

  it('已设置要求时按设备/工位分组展示', () => {
    const html = renderToStaticMarkup(
      <CandidatesList
        candidates={makeCandidates({
          requiredDeviceCapabilities: ['exo-lift'],
          requiredStationCapabilities: ['workstation'],
        })}
        selectedTaskId="T-1"
        onSaveRequirements={() => {}}
      />,
    );
    expect(html).toContain('设备：exo-lift');
    expect(html).toContain('工位：workstation');
  });

  it('保存后返回的"当前无法匹配"提示必须可见（不静默）', () => {
    const html = renderToStaticMarkup(
      <CandidatesList
        candidates={makeCandidates({
          requiredDeviceCapabilities: ['custom.magic_lift'],
          requiredStationCapabilities: [],
        })}
        selectedTaskId="T-1"
        onSaveRequirements={() => {}}
        requirementWarnings={['设备能力「custom.magic_lift」不在能力词表内（开放词表允许自定义，但需由设备显式声明才能匹配）']}
      />,
    );
    expect(html).toContain('task-capability-warnings');
    expect(html).toContain('custom.magic_lift');
  });

  it('零候选且因能力被挡 → 展示"放宽哪一项会得到什么"的建议（含边界说明）', () => {
    const html = renderToStaticMarkup(
      <CandidatesList
        candidates={makeCandidates({
          requiredDeviceCapabilities: ['exo-lift'],
          capabilityRelaxationSuggestions: [
            {
              capabilities: ['exo-lift'],
              label: 'exo-lift',
              kind: 'single',
              capability: 'exo-lift',
              addedEligibleCount: 3,
              sampleDeviceCapabilities: ['interact.assist'],
              note: '仅建议（不会自动放宽）：去掉要求「exo-lift」后可多出 3 个合格候选（涉及 2 台设备）。是否可替代需现场确认；确认后请修改能力要求并重新生成方案。',
            },
          ],
        })}
        selectedTaskId="T-1"
        onSaveRequirements={() => {}}
      />,
    );
    expect(html).toContain('task-capability-relaxation');
    expect(html).toContain('放宽「exo-lift」可多出 3 个合格候选');
    expect(html).toContain('interact.assist');
    // 边界说明必须随建议一起出现（不把建议伪装成结论）
    expect(html).toContain('仅建议');
    expect(html).toContain('需现场确认');
  });

  it('未选中任务时不渲染要求区块（避免误导）', () => {
    const html = renderToStaticMarkup(
      <CandidatesList candidates={null} selectedTaskId={null} onSaveRequirements={() => {}} />,
    );
    expect(html).not.toContain('task-capability-requirements');
  });
});
