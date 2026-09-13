/* OutcomeAnnotationController 身份来源测试（B5 同族：判定人不可由请求体声明）。
 *
 * 回归背景（2026-09-11 修复）：create 此前把请求体原样透传给 service，
 * judgedBy 是客户端断言——标注作为学习回路的真值来源，判定人可被冒名伪造。
 * 修复后判定人一律取服务端 userContext.userId（与 learning-proposal.proposedBy
 * 同一标准），缺失即 400 fail-closed；请求体携带的 judgedBy 被忽略并覆盖。
 * service 行为本身由 outcome-annotation.service.spec.ts 覆盖，此处只锁
 * controller 的身份来源与透传语义。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { OutcomeAnnotationController } from '../outcome-annotation.controller';
import type { OrgContext } from '../../shared/org-context.interceptor';

function makeContext(userId: string | undefined, orgId = 'org-a'): { userContext?: OrgContext } {
  return {
    userContext: {
      userId,
      primaryOrgId: orgId,
    } as unknown as OrgContext,
  };
}

describe('OutcomeAnnotationController 判定人身份来源', () => {
  function makeService() {
    return { create: jest.fn(async (input: unknown, orgId: string) => ({ input, orgId })) };
  }

  it('判定人取服务端会话身份，忽略请求体中的 judgedBy', () => {
    const service = makeService();
    const controller = new OutcomeAnnotationController(service as never);
    const ctx = makeContext('user-admin');

    controller.create(
      { targetType: 'plan', targetId: 'PLAN-1', outcomeKind: 'success', judgedBy: 'person: impostor' },
      ctx,
    );

    expect(service.create).toHaveBeenCalledTimes(1);
    const input = (service.create as jest.Mock).mock.calls[0][0] as { judgedBy: string };
    expect(input.judgedBy).toBe('user-admin');
  });

  it('会话无 userId 时 400 fail-closed，不落任何标注', () => {
    const service = makeService();
    const controller = new OutcomeAnnotationController(service as never);
    const ctx = makeContext(undefined);

    expect(() =>
      controller.create(
        { targetType: 'plan', targetId: 'PLAN-1', outcomeKind: 'success', judgedBy: 'person:op1' },
        ctx,
      ),
    ).toThrow(BadRequestException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('读路径仍走租户上下文：recent / byTarget 传递 orgId', () => {
    const service = {
      create: jest.fn(),
      listRecent: jest.fn(async (orgId: string) => ({ orgId })),
      listByTarget: jest.fn(async (orgId: string, t: string, i: string) => ({ orgId, t, i })),
    };
    const controller = new OutcomeAnnotationController(service as never);
    const ctx = makeContext('user-admin');

    controller.recent('failure', ctx);
    expect(service.listRecent).toHaveBeenCalledWith('org-a', { outcomeKind: 'failure' });

    controller.byTarget('plan', 'PLAN-1', ctx);
    expect(service.listByTarget).toHaveBeenCalledWith('org-a', 'plan', 'PLAN-1');

    expect(() => controller.byTarget('plan', undefined, ctx)).toThrow(BadRequestException);
    expect(() => controller.byTarget(undefined, 'PLAN-1', ctx)).toThrow(BadRequestException);
  });
});
