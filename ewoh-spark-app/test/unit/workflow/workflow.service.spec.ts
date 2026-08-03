import { WorkflowService } from '@server/modules/workflow/workflow.service';

describe('WorkflowService', () => {
  it('loads the MES execution example', () => {
    const service = new WorkflowService();
    const example = service.getExample();
    expect(example.workflowId).toBe('mes-execution');
    expect(example.steps).toHaveLength(8);
    expect(example.start).toBe('create');
  });

  it('returns role-aware next steps', () => {
    const service = new WorkflowService();
    const example = service.getExample();
    const result = service.advance(example, 'report', ['quality']);

    expect(result.currentActionAllowed).toBe(false);
    expect(result.allowedNextSteps).toEqual([
      { name: 'inspect', action: 'inspect' },
    ]);
  });

  it('blocks next steps the caller cannot perform', () => {
    const service = new WorkflowService();
    const example = service.getExample();
    const result = service.advance(example, 'report', ['worker']);

    expect(result.currentActionAllowed).toBe(true);
    expect(result.allowedNextSteps).toEqual([]);
  });

  it('rejects invalid workflows and unknown steps', () => {
    const service = new WorkflowService();
    expect(() => service.advance({ broken: true }, 'create', ['dispatcher'])).toThrow(
      'does not conform',
    );
    expect(() =>
      service.advance(service.getExample(), 'missing', ['dispatcher']),
    ).toThrow('not found');
  });
});
