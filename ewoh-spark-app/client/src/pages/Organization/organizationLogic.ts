/**
 * organizationLogic.ts — Organization 数据页纯逻辑层（ADR-084，§17/§33）。
 *
 * 从 Organization.tsx 提取，不含 React/Query/DOM 依赖，node 测试成立。
 */

// ── 类型 ─────────────────────────────────────────────────────────────────

export interface OrgNode {
  id: string;
  name: string;
  orgType: string;
  description?: string | null;
  children: OrgNode[];
}

export interface ParentOption {
  id: string;
  label: string;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

export const ORG_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'group', label: '集团' },
  { value: 'factory', label: '工厂 / 基地' },
  { value: 'workshop', label: '车间' },
];

export const ORG_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ORG_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 组织类型中文标签（未知类型回退原始值）。 */
export function orgTypeLabel(orgType: string): string {
  return ORG_TYPE_LABEL[orgType] ?? orgType;
}

/** 树扁平化为"上级组织"下拉候选（带层级缩进前缀）。 */
export function flattenTree(
  nodes: OrgNode[],
  depth = 0,
  acc: ParentOption[] = [],
): ParentOption[] {
  for (const node of nodes) {
    acc.push({
      id: node.id,
      label: `${'　'.repeat(depth)}${node.name}（${orgTypeLabel(node.orgType)}）`,
    });
    if (node.children.length > 0) flattenTree(node.children, depth + 1, acc);
  }
  return acc;
}

/** 创建表单提交前置校验。 */
export function canSubmitOrg(name: string, orgType: string, isPending: boolean): boolean {
  return name.trim().length > 0 && orgType.trim().length > 0 && !isPending;
}
