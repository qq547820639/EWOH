import { evaluateTrainingSample } from '../training-sample-eligibility';

/**
 * 训练样本资格判定回归。
 *
 * 这是"哪些数据可以训练生产模型"的唯一判定点，直接影响排程预测。以下用例把
 * 边界钉死：**人工上报与模拟回执永远无法训练生产模型**，即使行级标记被写成
 * eligible=true、provenance 也已写入——只有独立设备回执证据才能通过。
 */
describe('evaluateTrainingSample（训练样本资格，单一事实源）', () => {
  const START = new Date('2026-09-10T08:00:00.000Z');
  const END = new Date('2026-09-10T08:30:00.000Z');

  /** 一条完全合格的独立设备回执行。 */
  function deviceRow(overrides: Record<string, unknown> = {}) {
    return {
      receiptSource: 'real',
      productionTrainingEligible: true,
      actualStart: START,
      actualEnd: END,
      provenanceJson: {
        policy: 'receipt-provenance-v1',
        source: 'real',
        independentReceipt: {
          policy: 'persisted-device-receipt-v1',
          source: 'device_receipt',
          actualStartAt: START.toISOString(),
          actualEndAt: END.toISOString(),
          executionId: 'EXEC-1',
          assignmentId: 'ASG-1',
          planId: 'PLAN-1',
          taskId: 'TASK-1',
          deviceId: 'DEV-1',
        },
      },
      ...overrides,
    } as never;
  }

  it('独立设备回执 + 行级标记齐备 → 可训练，并给出时长', () => {
    const verdict = evaluateTrainingSample(deviceRow());
    expect(verdict.trainable).toBe(true);
    expect(verdict.durationMs).toBe(30 * 60 * 1000);
  });

  it('模拟回执：即使被标成 eligible=true 且有 provenance，也不可训练', () => {
    const row = deviceRow({ receiptSource: 'simulated' });
    expect(evaluateTrainingSample(row)).toEqual({ trainable: false, reason: 'not_real_source' });
  });

  it('来源未知（unknown）：不可训练', () => {
    expect(evaluateTrainingSample(deviceRow({ receiptSource: 'unknown' })).reason).toBe('not_real_source');
  });

  it('真实来源但资格标记为 false → flags_not_eligible', () => {
    expect(evaluateTrainingSample(deviceRow({ productionTrainingEligible: false })).reason)
      .toBe('flags_not_eligible');
  });

  it('真实来源且标记为 true，但缺 provenance → missing_provenance', () => {
    expect(evaluateTrainingSample(deviceRow({ provenanceJson: null })).reason).toBe('missing_provenance');
  });

  it('provenance 策略不符（伪造/旧写入方）→ provenance_policy_mismatch', () => {
    const row = deviceRow();
    (row as { provenanceJson: Record<string, unknown> }).provenanceJson = {
      policy: 'something-else',
      source: 'real',
      independentReceipt: { policy: 'persisted-device-receipt-v1', source: 'device_receipt' },
    };
    expect(evaluateTrainingSample(row).reason).toBe('provenance_policy_mismatch');
  });

  it('provenance.source 非 real → provenance_policy_mismatch', () => {
    const row = deviceRow();
    (row as { provenanceJson: Record<string, unknown> }).provenanceJson = {
      policy: 'receipt-provenance-v1',
      source: 'simulated',
    };
    expect(evaluateTrainingSample(row).reason).toBe('provenance_policy_mismatch');
  });

  it('缺独立设备回执证据（人工上报路径）→ missing_independent_device_receipt', () => {
    const row = deviceRow();
    (row as { provenanceJson: Record<string, unknown> }).provenanceJson = {
      policy: 'receipt-provenance-v1',
      source: 'real',
    };
    expect(evaluateTrainingSample(row).reason).toBe('missing_independent_device_receipt');
  });

  it('设备证据时间与执行事实不一致 → receipt_evidence_mismatch', () => {
    const row = deviceRow();
    const prov = (row as { provenanceJson: Record<string, unknown> }).provenanceJson;
    (prov.independentReceipt as Record<string, unknown>).actualEndAt = '2026-09-10T09:00:00.000Z';
    expect(evaluateTrainingSample(row).reason).toBe('receipt_evidence_mismatch');
  });

  it('设备证据缺 executionId/assignmentId/planId/taskId/deviceId 任一 → 拒绝', () => {
    for (const field of ['executionId', 'assignmentId', 'planId', 'taskId', 'deviceId']) {
      const row = deviceRow();
      const prov = (row as { provenanceJson: Record<string, unknown> }).provenanceJson;
      delete (prov.independentReceipt as Record<string, unknown>)[field];
      expect(evaluateTrainingSample(row).reason).toBe('receipt_evidence_mismatch');
    }
  });

  it('缺实际开始或结束时间 → missing_actual_times', () => {
    expect(evaluateTrainingSample(deviceRow({ actualEnd: null })).reason).toBe('missing_actual_times');
  });

  it('时长为负（结束早于开始）→ invalid_duration', () => {
    const row = deviceRow({ actualEnd: START, actualStart: END });
    const prov = (row as { provenanceJson: Record<string, unknown> }).provenanceJson;
    (prov.independentReceipt as Record<string, unknown>).actualStartAt = END.toISOString();
    (prov.independentReceipt as Record<string, unknown>).actualEndAt = START.toISOString();
    expect(evaluateTrainingSample(row).reason).toBe('invalid_duration');
  });

  it('provenanceJson 是数组/字符串等非对象值 → 视为缺失证明', () => {
    expect(evaluateTrainingSample(deviceRow({ provenanceJson: [] })).reason).toBe('missing_provenance');
    expect(evaluateTrainingSample(deviceRow({ provenanceJson: 'x' })).reason).toBe('missing_provenance');
  });
});
