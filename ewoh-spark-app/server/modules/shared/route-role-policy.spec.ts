/* v0.7 修复回归：route-role.policy FALLBACK 角色映射测试
 * 背景：SchedulerMetricsController 无 @Roles 且不在 FALLBACK 表 → RolesGuard 默认拒绝
 * → /api/scheduler/metrics* 全部 403（Prometheus 指标端点不可用）。
 * 本测试守护：所有暴露端点的 controller 必须在 FALLBACK 表有角色映射或声明 @Roles。
 */
import { FALLBACK_CONTROLLER_ROLES } from './route-role.policy';

describe('route-role.policy: FALLBACK 角色映射完整性', () => {
  it('SchedulerMetricsController 有角色映射（metrics 端点可用）', () => {
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerMetricsController).toBeDefined();
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerMetricsController.length).toBeGreaterThan(0);
    // 观测端点应至少允许 global_admin 读取
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerMetricsController).toContain('global_admin');
  });

  it('FALLBACK 表所有映射非空且含有效角色', () => {
    for (const [controller, roles] of Object.entries(FALLBACK_CONTROLLER_ROLES)) {
      expect(roles.length, `${controller} 应有角色`).toBeGreaterThan(0);
    }
  });

  it('核心 controller 均有映射（不因缺映射被默认拒绝）', () => {
    expect(FALLBACK_CONTROLLER_ROLES.SchedulerController).toBeDefined();
    expect(FALLBACK_CONTROLLER_ROLES.TaskController).toBeDefined();
    expect(FALLBACK_CONTROLLER_ROLES.AlertController).toBeDefined();
  });
});
