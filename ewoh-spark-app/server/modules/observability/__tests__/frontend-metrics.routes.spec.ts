/* FrontendMetrics 路由声明与限流窗口回归
 * （R2-SNZ-005 / NEST-616，2026-08-17 审计整改）。
 *
 * R2-SNZ-005：全局 RolesGuard default-deny 下，无 @Roles 的 POST ingest
 * 对一切调用者恒 403（前端指标摄取死端点）——断言 ingest 显式声明
 * ANY_AUTHENTICATED_ROLES（登录即可写），query 维持限角色。
 * NEST-616：rateLimit 的 windowStart 原先 readonly 且从不重置——窗口
 * 过期后每次请求都 clear counts（限流恒放行）；断言窗口滚动恢复配额
 * 且窗口内配额守恒。
 */
/// <reference types="jest" />
import { Reflector } from '@nestjs/core';
import { FrontendMetricsController } from '../frontend-metrics.controller';
import { FrontendMetricsService } from '../frontend-metrics.service';
import { ANY_AUTHENTICATED_ROLES, ROLES_KEY } from '../../shared/roles.decorator';

describe('FrontendMetricsController 路由角色声明（R2-SNZ-005）', () => {
  const reflector = new Reflector();

  it('POST ingest：显式 @Roles(ANY_AUTHENTICATED_ROLES)——RolesGuard default-deny 不再误伤', () => {
    const handler = FrontendMetricsController.prototype.ingest;
    expect(handler).toBeDefined();
    const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      handler,
      FrontendMetricsController,
    ]);
    expect(Array.isArray(roles)).toBe(true);
    expect(roles).toHaveLength(ANY_AUTHENTICATED_ROLES.length);
    for (const role of ANY_AUTHENTICATED_ROLES) {
      expect(roles).toContain(role);
    }
  });

  it('GET query：维持限角色（非任意登录可读）', () => {
    const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      FrontendMetricsController.prototype.query,
      FrontendMetricsController,
    ]);
    expect(roles).toEqual(
      expect.arrayContaining(['global_admin', 'safety_admin', 'dispatcher', 'workshop_lead']),
    );
    expect(roles).not.toContain('worker');
  });
});

describe('FrontendMetricsService.rateLimit 窗口滚动（NEST-616）', () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('窗口内配额守恒：max 次 allowed 后拒绝', () => {
    const service = new FrontendMetricsService({ rateLimitWindowMs: 60_000, rateLimitMax: 2 });
    expect(service.rateLimit('subject-1')).toEqual({ allowed: true, remaining: 1 });
    expect(service.rateLimit('subject-1')).toEqual({ allowed: true, remaining: 0 });
    expect(service.rateLimit('subject-1')).toEqual({ allowed: false, remaining: 0 });
  });

  it('窗口过期后滚动：新窗口配额独立计数（原 bug：每次请求都 clear）', () => {
    const service = new FrontendMetricsService({ rateLimitWindowMs: 60_000, rateLimitMax: 2 });
    // 第一个窗口用尽配额。
    service.rateLimit('subject-1');
    service.rateLimit('subject-1');
    expect(service.rateLimit('subject-1').allowed).toBe(false);
    // 时间前进 61s：窗口滚动，新窗口从 0 计数。
    nowMs += 61_000;
    expect(service.rateLimit('subject-1')).toEqual({ allowed: true, remaining: 1 });
    expect(service.rateLimit('subject-1')).toEqual({ allowed: true, remaining: 0 });
    // 同一新窗口内的第 3 次必须拒绝——原 bug（windowStart 不重置）下
    // 每次请求都 clear counts，此处恒 allowed 且 remaining=1。
    expect(service.rateLimit('subject-1').allowed).toBe(false);
  });
});
