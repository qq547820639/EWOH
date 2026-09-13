import { buildExecutionReceiptRequest } from './executionReceiptLogic';

jest.mock('../../api/scheduler', () => ({ listExecutions: jest.fn(), updateExecution: jest.fn() }));
jest.mock('../../lib/auth', () => ({ getAuthUser: jest.fn() }));

describe('buildExecutionReceiptRequest', () => {
  const occurredAt = '2026-09-10T01:02:03.000Z';

  it('starts with an explicit receipt time and provenance', () => {
    expect(buildExecutionReceiptRequest('STARTED', 'manual_report', occurredAt)).toEqual({
      status: 'STARTED', reportedSource: 'manual_report', triggerReplan: false, actualStartAt: occurredAt,
    });
  });

  it('completes with only the explicit end time and never invents a start', () => {
    expect(buildExecutionReceiptRequest('COMPLETED', 'simulated', occurredAt)).toEqual({
      status: 'COMPLETED', reportedSource: 'simulated', triggerReplan: false, actualEndAt: occurredAt,
    });
  });

  it('requires and preserves a failure explanation', () => {
    expect(buildExecutionReceiptRequest('FAILED', 'manual_report', occurredAt, '设备故障')).toEqual({
      status: 'FAILED', reportedSource: 'manual_report', triggerReplan: false, actualEndAt: occurredAt,
      deviationType: 'MANUAL_OVERRIDE', deviationReason: '设备故障',
    });
  });
});
