/* Agent Tool 注册表（ADR-016 / NO-06b，云侧运行时）。
 *
 * Tool 是 Agent 的正式能力接口：Manifest.allowedTools 必须 ⊆ 本注册表
 * （未注册 Tool 注册/执行时 fail-closed 拒绝）。v1 为内置只读/受控写/
 * 审计工具集；扩展走注册表版本演进（契约纪律）。
 */

export const BUILTIN_AGENT_TOOLS = [
  'tool:world-snapshot',
  'tool:world-replay',
  'tool:reserve-resource',
  'tool:dispatch-task',
  'tool:create-work-order',
  'tool:notify-personnel',
  'tool:run-simulation',
  'tool:record-evidence',
  'tool:knowledge-search',
  'tool:knowledge-register',
] as const;

export type BuiltinAgentTool = (typeof BUILTIN_AGENT_TOOLS)[number];

const TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_AGENT_TOOLS);

/** Tool 是否已注册（未注册 → 注册/执行 fail-closed 拒绝）。 */
export function isRegisteredAgentTool(tool: unknown): tool is BuiltinAgentTool {
  return typeof tool === 'string' && TOOL_SET.has(tool);
}
