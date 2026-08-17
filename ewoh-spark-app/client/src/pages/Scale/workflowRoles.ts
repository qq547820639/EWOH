/**
 * R2-CP2-006：Scale 页工作流角色输入解析（纯函数，供组件与测试共用）。
 *
 * 原实现 useState('dispatcher') 预填角色，任何登录用户未改动即点“推进”
 * 会以硬编码 dispatcher 身份语义推进工作流实例（与 CLI-201 同型冒充）。
 * 修复：默认空串 + 提交前显式非空校验（workflowRolesReady），角色必须由
 * 操作者主动输入。
 */

/** 解析逗号分隔的角色输入 → 去空白后的非空角色数组。 */
export function parseWorkflowRoles(input: string): string[] {
  return input
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

/** R2-CP2-006：提交前校验——未显式选择角色（解析结果为空）时禁止推进。 */
export function workflowRolesReady(input: string): boolean {
  return parseWorkflowRoles(input).length > 0;
}
