/* 任务能力要求编辑器纯逻辑（NO-16a）。 */
/// <reference types="jest" />
import {
  buildRelaxationApprovalSubject,
  errorText,
  isCapabilityRelaxationApprovalRequired,
  relaxedHighRiskForSave,
  describeCapabilityRequirements,
  describeRelaxationSuggestions,
  formatCapabilityInput,
  hasCapabilityRequirements,
  parseCapabilityInput,
} from './taskRequirementsVM';

describe('parseCapabilityInput（与后端同一套规范化）', () => {
  it('支持逗号/顿号/空白/换行分隔，去重保序', () => {
    expect(parseCapabilityInput('exo-lift、vacuum, crane\nexo-lift').names).toEqual([
      'exo-lift',
      'vacuum',
      'crane',
    ]);
  });

  it('空输入 → 空列表（= 清空要求，语义显式）', () => {
    expect(parseCapabilityInput('   ').names).toEqual([]);
    expect(parseCapabilityInput('').errors).toEqual([]);
  });

  it('超长名称在前端就报错（不等到 400 才发现）', () => {
    expect(parseCapabilityInput('x'.repeat(80)).errors[0]).toContain('字符');
  });

  it('超过条数上限报错（与后端同口径）', () => {
    const many = Array.from({ length: 33 }, (_, i) => `cap-${i}`).join(',');
    expect(parseCapabilityInput(many).errors[0]).toContain('最多');
  });
});

describe('展示口径', () => {
  it('formatCapabilityInput 可读且可再编辑', () => {
    expect(formatCapabilityInput(['exo-lift', 'vacuum'])).toBe('exo-lift、vacuum');
    expect(formatCapabilityInput(null)).toBe('');
  });

  it('无要求时显式说明（不显示空白）', () => {
    expect(hasCapabilityRequirements({ requiredDeviceCapabilities: [], requiredStationCapabilities: [] })).toBe(false);
    expect(
      describeCapabilityRequirements({ requiredDeviceCapabilities: [], requiredStationCapabilities: [] }),
    ).toContain('未设置能力要求');
  });

  it('有要求时按设备/工位分组展示', () => {
    expect(
      describeCapabilityRequirements({
        requiredDeviceCapabilities: ['exo-lift'],
        requiredStationCapabilities: ['workstation'],
      }),
    ).toBe('设备：exo-lift · 工位：workstation');
  });
});

describe('放宽建议文案（NO-17a / NO-18b）', () => {
  it('单项建议：放宽「X」可多出 N 个候选，并列出设备实际能力', () => {
    const lines = describeRelaxationSuggestions({
      capabilityRelaxationSuggestions: [
        {
          capabilities: ['exo-lift'],
          label: 'exo-lift',
          kind: 'single',
          capability: 'exo-lift',
          addedEligibleCount: 5,
          sampleDeviceCapabilities: ['interact.assist'],
          note: '仅建议（不会自动放宽）…',
        },
      ],
    } as never);
    expect(lines[0]).toContain('放宽「exo-lift」可多出 5 个合格候选');
    expect(lines[0]).toContain('interact.assist');
  });

  it('组合建议：文案必须写明"需同时放宽"（避免现场只放宽一项）', () => {
    const lines = describeRelaxationSuggestions({
      capabilityRelaxationSuggestions: [
        {
          capabilities: ['exo-lift', 'crane'],
          label: 'exo-lift + crane',
          kind: 'combination',
          capability: 'exo-lift + crane',
          addedEligibleCount: 2,
          sampleDeviceCapabilities: [],
          note: '仅建议（不会自动放宽）…需要同时放宽这 2 项才有效…',
        },
      ],
    } as never);
    expect(lines[0]).toContain('需同时放宽「exo-lift + crane」');
    expect(lines[0]).toContain('同时放宽');
  });

  it('高风险建议：行首即标注"需安全负责人确认"（不能埋在长文案里）', () => {
    const lines = describeRelaxationSuggestions({
      capabilityRelaxationSuggestions: [
        {
          capabilities: ['crane'],
          label: 'crane',
          kind: 'single',
          capability: 'crane',
          risk: 'high',
          requiresSafetyReview: true,
          addedEligibleCount: 4,
          sampleDeviceCapabilities: [],
          note: '仅建议（不会自动放宽）…',
        },
      ],
    } as never);
    expect(lines[0].startsWith('⚠ 高风险 · 需安全负责人确认：')).toBe(true);
  });

  it('低风险建议：不加风险前缀（避免假警报）', () => {
    const lines = describeRelaxationSuggestions({
      capabilityRelaxationSuggestions: [
        {
          capabilities: ['observe.temperature'],
          label: 'observe.temperature',
          kind: 'single',
          capability: 'observe.temperature',
          risk: 'low',
          requiresSafetyReview: false,
          addedEligibleCount: 2,
          sampleDeviceCapabilities: [],
          note: '仅建议（不会自动放宽）…',
        },
      ],
    } as never);
    expect(lines[0].startsWith('放宽「observe.temperature」')).toBe(true);
  });

  it('无建议 → 空列表（不产生噪音）', () => {
    expect(describeRelaxationSuggestions({ capabilityRelaxationSuggestions: [] } as never)).toEqual([]);
  });
});

describe('高风险放宽的审批闸门（NO-20a，前端识别与发起）', () => {
  it('识别"需审批"的 409（含服务端原因提取）', () => {
    const gateError = {
      response: {
        data: {
          error: {
            code: 'CONFLICT',
            message: 'HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL：放宽高风险能力（crane）需安全管理员审批',
          },
        },
      },
    };
    expect(isCapabilityRelaxationApprovalRequired(gateError)).toBe(true);
    expect(errorText(gateError)).toContain('安全管理员审批');
    // 其它错误不误判为闸门
    expect(isCapabilityRelaxationApprovalRequired({ response: { data: { message: '形状非法' } } })).toBe(false);
  });

  it('计算本次保存会放宽哪些高风险能力（用于提示与发起审批）', () => {
    const candidates = { requiredDeviceCapabilities: ['crane', 'observe.temperature'] } as never;
    expect(relaxedHighRiskForSave(candidates, [])).toEqual(['crane']);
    expect(relaxedHighRiskForSave(candidates, ['observe.temperature'])).toEqual(['crane']);
    expect(relaxedHighRiskForSave(candidates, ['crane', 'vacuum'])).toEqual([]);
    expect(relaxedHighRiskForSave(null, [])).toEqual([]);
  });

  it('审批对象指纹与后端落地校验口径一致（同一 shared 实现）', () => {
    const subject = buildRelaxationApprovalSubject({
      taskId: 'T-9',
      taskTitle: '吊装任务',
      relaxedHighRisk: ['crane'],
      nextDeviceCapabilities: [],
      nextStationCapabilities: ['workstation'],
    });
    expect(subject.objectType).toBe('task_capability_change');
    expect(subject.metrics).toEqual({
      relaxedHighRiskCapabilities: 'crane',
      resultingDeviceCapabilities: '',
      resultingStationCapabilities: 'workstation',
    });
  });
});
