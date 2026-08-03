import { WorkflowInstanceService } from '@server/modules/workflow/workflow-instance.service';
import { WorkflowService } from '@server/modules/workflow/workflow.service';

describe('WorkflowInstanceService', () => {
  const workflowService = new WorkflowService();
  const example = workflowService.getExample();

  it('starts a persisted workflow instance', async () => {
    const row = {
      configKey: 'workflow.mes-execution.T-1',
      configValue: {
        workflow: example,
        workflowId: 'mes-execution',
        entityId: 'T-1',
        currentStep: 'create',
        status: 'active',
        history: [{ step: 'create', at: '2026-08-03T00:00:00Z', actor: 'user-1' }],
      },
      updatedBy: 'user-1',
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const returning = jest.fn().mockResolvedValue([row]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new WorkflowInstanceService(
      workflowService,
      { insert } as never,
      audit as never,
    );

    const result = await service.start(
      { workflow: example, entityId: 'T-1' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.currentStep).toBe('create');
    expect(result.status).toBe('active');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.instance.start' }),
    );
  });

  it('lists persisted workflow instances', async () => {
    const rows = [
      {
        configKey: 'workflow.mes-execution.T-1',
        configValue: {
          workflowId: 'mes-execution',
          entityId: 'T-1',
          currentStep: 'create',
          status: 'active',
          history: [],
        },
        updatedBy: 'user-1',
        updatedAt: new Date('2026-08-03T00:00:00Z'),
      },
    ];
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn().mockResolvedValue(rows),
        })),
      })),
    }));
    const service = new WorkflowInstanceService(
      workflowService,
      { select } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const result = await service.list();

    expect(result).toHaveLength(1);
    expect(result[0].workflowId).toBe('mes-execution');
  });

  it('advances a persisted workflow instance with role gating', async () => {
    const row = {
      configKey: 'workflow.mes-execution.T-1',
      configValue: {
        workflow: example,
        workflowId: 'mes-execution',
        entityId: 'T-1',
        currentStep: 'create',
        status: 'active',
        history: [{ step: 'create', at: '2026-08-03T00:00:00Z', actor: 'dispatcher' }],
      },
      updatedBy: 'user-1',
      updatedAt: new Date('2026-08-03T00:00:00Z'),
    };
    const updatedRow = {
      ...row,
      configValue: {
        ...row.configValue,
        currentStep: 'release',
        history: [
          ...row.configValue.history,
          { step: 'release', action: 'release', at: '2026-08-03T00:01:00Z', actor: 'user-1' },
        ],
      },
    };
    const selectWhere = jest.fn().mockResolvedValue([row]);
    const updateReturning = jest.fn().mockResolvedValue([updatedRow]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new WorkflowInstanceService(
      workflowService,
      db as never,
      audit as never,
    );

    const result = await service.advance(
      'workflow.mes-execution.T-1',
      { roles: ['dispatcher'], toStep: 'release' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.currentStep).toBe('release');
    expect(result.history).toHaveLength(2);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.instance.advance' }),
    );
  });
});
