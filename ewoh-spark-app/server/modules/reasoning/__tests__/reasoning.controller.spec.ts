import 'reflect-metadata';
import { ReasoningController } from '../reasoning.controller';
import { ROLES_KEY } from '../../shared/roles.decorator';

describe('ReasoningController governance roles', () => {
  it('hand-supplied facts are restricted to global_admin, while live/read surfaces stay authenticated', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ReasoningController.prototype.evaluate)).toEqual(['global_admin']);
    expect(Reflect.getMetadata(ROLES_KEY, ReasoningController.prototype.evaluateLive)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, ReasoningController.prototype.liveFacts)).toBeUndefined();
  });

  it('delegates evaluate with the authenticated tenant', async () => {
    const service = { evaluate: jest.fn().mockResolvedValue({ trace: {}, inferenceIds: [], ledgerFailures: [] }) };
    const controller = new ReasoningController(service as never);
    const request = { userContext: { userId: 'admin-1', primaryOrgId: ' org-1 ' } } as never;
    await controller.evaluate({ snapshotVersion: 1, facts: [] } as never, request);
    expect(service.evaluate).toHaveBeenCalledWith({ snapshotVersion: 1, facts: [] }, 'org-1');
  });
});
