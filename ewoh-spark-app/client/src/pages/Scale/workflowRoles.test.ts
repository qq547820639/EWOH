/* R2-CP2-006：Scale 页工作流角色输入解析（默认空 + 显式非空校验）。 */
import { parseWorkflowRoles, workflowRolesReady } from './workflowRoles';

describe('Scale workflowRoles（R2-CP2-006）', () => {
  it('解析逗号分隔角色（trim + 去空项）', () => {
    expect(parseWorkflowRoles('dispatcher, supervisor ,, planner ')).toEqual([
      'dispatcher',
      'supervisor',
      'planner',
    ]);
  });

  it('空串/纯空白/仅逗号 → 解析为空数组（无硬编码预填兜底）', () => {
    expect(parseWorkflowRoles('')).toEqual([]);
    expect(parseWorkflowRoles('   ')).toEqual([]);
    expect(parseWorkflowRoles(' , , ')).toEqual([]);
  });

  it('workflowRolesReady：未显式选择角色 → false（禁止推进提交）', () => {
    expect(workflowRolesReady('')).toBe(false);
    expect(workflowRolesReady('  ,  ')).toBe(false);
  });

  it('workflowRolesReady：显式输入至少一个角色 → true', () => {
    expect(workflowRolesReady('dispatcher')).toBe(true);
    expect(workflowRolesReady(' operator , ')).toBe(true);
  });
});
