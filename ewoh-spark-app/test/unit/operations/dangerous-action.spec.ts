import { DangerousActionService } from '../../../server/modules/operations/dangerous-action.service';
import {
  buildCompensation,
  dangerousIdempotencyKey,
  isIrreversible,
  previewDangerousImpact,
} from '../../../server/modules/operations/dangerous-action';
import { IdempotencyService } from '../../../server/modules/shared/idempotency.service';

const actor = { userId: 'P-1', primaryOrgId: 'org-1', roles: ['worker'] };

describe('dangerous-action (危险操作影响预览/幂等确认/撤销补偿)', () => {
  describe('pure preview', () => {
    it('builds an impact summary, marks irreversible actions', () => {
      const impact = previewDangerousImpact({
        action: 'delete',
        targetType: 'workOrder',
        targetId: 'WO-1',
        affectedCount: 3,
      });
      expect(impact.requiresConfirmation).toBe(true);
      expect(impact.irreversible).toBe(true);
      expect(impact.affectedCount).toBe(3);
      expect(impact.summary).toContain('删除');
      expect(isIrreversible('delete')).toBe(true);
    });

    it('transfer is reversible and has an undo plan', () => {
      expect(isIrreversible('transfer')).toBe(false);
      expect(buildCompensation('transfer').kind).toBe('undo');
      expect(buildCompensation('delete').kind).toBe('noop');
    });

    it('derives a deterministic idempotency key', () => {
      expect(dangerousIdempotencyKey('approve', 'workOrder', 'WO-1')).toBe(
        'dangerous:approve:workOrder:WO-1',
      );
    });
  });

  describe('service confirm / undo', () => {
    it('confirms idempotently: same key+payload returns the same actionId', async () => {
      const idempotency = new IdempotencyService();
      const service = new DangerousActionService(idempotency);
      const input = { action: 'transfer' as const, targetType: 'step', targetId: 'S1', idempotencyKey: 'k1' };

      const first = await service.confirm(actor, input);
      const second = await service.confirm(actor, input);
      expect(second.actionId).toBe(first.actionId);
      expect(second.compensation.kind).toBe('undo');
    });

    it('rejects a replay that changes the payload (409)', async () => {
      const idempotency = new IdempotencyService();
      const service = new DangerousActionService(idempotency);
      await service.confirm(actor, {
        action: 'delete',
        targetType: 'step',
        targetId: 'S9',
        reason: '正式确认',
        idempotencyKey: 'k2',
      });
      await expect(
        service.confirm(actor, {
          action: 'delete',
          targetType: 'step',
          targetId: 'S9',
          reason: '被篡改的理由', // mutated payload
          idempotencyKey: 'k2',
        }),
      ).rejects.toThrow('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    });

    it('records an undo/compensation entry', async () => {
      const idempotency = new IdempotencyService();
      const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
      const service = new DangerousActionService(idempotency, audit as never);
      const result = await service.undo(actor, 'act-1', 'step', 'S1', '误操作退回');
      expect(result.undo).toBe(true);
      expect(audit.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'workbench.dangerous.undo' }),
      );
    });
  });
});