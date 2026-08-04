/**
 * UX-007 无障碍审计：可审计的检查清单与静态启发式规则。
 *
 * 用途：
 * - 提供 WCAG 2.2 AA 核心页面检查清单（UX-007 子项 7.1–7.8 映射）。
 * - 提供无 DOM 的静态启发式扫描器，供 axe 扫描脚本（scripts/axe-scan.mjs）
 *   与人工复核复用。静态扫描是「近似」检测，不能替代真实浏览器 axe 运行；
 *   真实浏览器运行结果以 scripts/axe-scan.mjs 输出的报告为准。
 */

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export type RequirementStatus =
  | 'implemented'
  | 'partial'
  | 'needs-review'
  | 'documented-exception';

export interface A11yRequirement {
  id: string;
  title: string;
  wcag: string;
  level: 'A' | 'AA';
  checks: string[];
  status: RequirementStatus;
}

/** UX-007 子项（7.1–7.8）到 WCAG 2.2 AA 的映射清单。 */
export const UX007_A11Y_REQUIREMENTS: A11yRequirement[] = [
  {
    id: '7.1',
    title: '完整键盘操作 / 清晰焦点 / 跳转主内容',
    wcag: '2.1.1 / 2.4.7 / 2.4.1',
    level: 'AA',
    checks: [
      '所有交互控件可用键盘触达（Tab 顺序自然）',
      '焦点可见（focus ring 对比度 ≥ 3:1）',
      '页面顶部提供「跳到主内容」链接（#main-content）',
      '移除 outline 时提供可见的 focus 替代',
    ],
    status: 'implemented',
  },
  {
    id: '7.2',
    title: '不只靠颜色表达状态',
    wcag: '1.4.1',
    level: 'AA',
    checks: [
      '状态（在线/离线、通过/失败、风险等级）同时以文本或图标表达',
      '颜色差异不作为唯一信息信道',
    ],
    status: 'implemented',
  },
  {
    id: '7.3',
    title: '屏幕阅读器语义 / 对话框焦点管理',
    wcag: '1.3.1 / 4.1.2 / 2.1.2',
    level: 'AA',
    checks: [
      '图片、SVG、图标按钮具备可访问名称',
      '输入框具备可访问名称（label / aria-label / aria-labelledby）',
      '对话框（dialog）具备 aria-modal 与初始/返回焦点管理',
    ],
    status: 'implemented',
  },
  {
    id: '7.4',
    title: '图表与 DAG 文本替代视图',
    wcag: '1.1.1 / 1.3.1',
    level: 'AA',
    checks: [
      'Work Graph 提供「文本视图」切换，输出节点/边/关键路径文本',
      '图表（电量分布等）提供可访问的文本描述或表格替代',
    ],
    status: 'implemented',
  },
  {
    id: '7.5',
    title: '高对比度 / 触控目标尺寸',
    wcag: '1.4.3 / 2.5.8 / 2.5.5',
    level: 'AA',
    checks: [
      '正文对比度 ≥ 4.5:1，非文本对比度 ≥ 3:1',
      '移动/触控场景触控目标不小于工业可接受尺寸（≥ 44px 启发式）',
    ],
    status: 'partial',
  },
  {
    id: '7.6',
    title: '自动化 axe 检查',
    wcag: '—',
    level: 'AA',
    checks: [
      'scripts/axe-scan.mjs 输出 Critical/Serious 问题清单',
      '核心流程无 Critical/Serious 级问题',
    ],
    status: 'needs-review',
  },
  {
    id: '7.7',
    title: '中文优先 + 预留 i18n 结构',
    wcag: '—',
    level: 'AA',
    checks: [
      '界面文案中文优先',
      '提供 i18n 文案抽取的纯函数与初始词典（lib/i18n.ts）',
    ],
    status: 'implemented',
  },
  {
    id: '7.8',
    title: '核心流程无 Critical/Serious；无法修复项形成批准例外记录',
    wcag: '—',
    level: 'AA',
    checks: [
      '核心流程无 Critical/Serious 级无障碍问题',
      '无法修复项写入 docs/reviews/ux007-a11y-exceptions.md 并取得批准',
    ],
    status: 'documented-exception',
  },
];

export interface StaticRule {
  id: string;
  wcag: string;
  severity: Severity;
  description: string;
  /** 静态启发式判定：返回 true 表示「命中」潜在问题。 */
  detect: (source: string) => boolean;
}

/** 无 DOM 的静态启发式规则（近似检测，需真实浏览器复核）。 */
export const STATIC_RULES: StaticRule[] = [
  {
    id: 'img-without-alt',
    wcag: '1.1.1',
    severity: 'critical',
    description: '图片缺少 alt 文本',
    detect: (source) => /<img\b/i.test(source) && !/\balt\s*=/i.test(source),
  },
  {
    id: 'svg-without-accessible-name',
    wcag: '1.1.1',
    severity: 'serious',
    description: 'SVG 缺少 role="img" 或 aria-label/aria-labelledby',
    detect: (source) =>
      /<svg\b/i.test(source) &&
      !/aria-label\s*=/i.test(source) &&
      !/aria-labelledby\s*=/i.test(source) &&
      !/role\s*=\s*["']img["']/i.test(source),
  },
  {
    id: 'input-without-label',
    wcag: '1.3.1 / 4.1.2',
    severity: 'serious',
    description: '输入框缺少可访问名称（aria-label / aria-labelledby / label）',
    detect: (source) => {
      const inputs = [...source.matchAll(/<input\b([^>]*)>/gi)];
      if (inputs.length === 0) return false;
      return inputs.some((match) => {
        const attrs = match[1];
        if (/type\s*=\s*["']?(hidden|file|submit|button)["']?/i.test(attrs)) return false;
        return (
          !/aria-label\s*=/i.test(attrs) &&
          !/aria-labelledby\s*=/i.test(attrs) &&
          !/\bid\s*=/i.test(attrs)
        );
      });
    },
  },
  {
    id: 'button-without-name',
    wcag: '4.1.2',
    severity: 'serious',
    description: '按钮既无可见文本也无 aria-label / title',
    detect: (source) => {
      const buttons = [...source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
      if (buttons.length === 0) return false;
      return buttons.some((match) => {
        const attrs = match[1];
        const inner = match[2];
        if (/aria-label\s*=/i.test(attrs) || /title\s*=/i.test(attrs)) return false;
        const text = inner.replace(/<[^>]+>/g, '').trim();
        return text.length === 0;
      });
    },
  },
  {
    id: 'outline-none-without-focus',
    wcag: '2.4.7',
    severity: 'serious',
    description: '移除 outline 但未提供可见焦点替代（focus:ring/border/outline）',
    detect: (source) =>
      /\boutline-none\b/.test(source) && !/focus:(ring|border|outline)/.test(source),
  },
  {
    id: 'negative-tabindex-on-interactive',
    wcag: '2.1.1',
    severity: 'moderate',
    description: '交互元素使用 tabIndex={-1}（需确认可通过其他方式聚焦）',
    detect: (source) => /tabIndex\s*=\s*\{?\s*-1\s*\}?/.test(source),
  },
];

export interface A11yFinding {
  ruleId: string;
  wcag: string;
  severity: Severity;
  filePath: string;
  description: string;
}

/**
 * 扫描单个文件源码，返回命中的静态问题。
 * 仅用于启发式预检；真实无障碍结论须以浏览器 axe 运行结果为准。
 */
export function scanFile(source: string, filePath: string): A11yFinding[] {
  return STATIC_RULES.filter((rule) => rule.detect(source)).map((rule) => ({
    ruleId: rule.id,
    wcag: rule.wcag,
    severity: rule.severity,
    filePath,
    description: rule.description,
  }));
}

export interface SeveritySummary {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

export function summarize(findings: A11yFinding[]): {
  total: number;
  bySeverity: SeveritySummary;
} {
  const bySeverity: SeveritySummary = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }
  return { total: findings.length, bySeverity };
}

/** 判断是否存在 Critical/Serious 级问题（核心流程红线）。 */
export function hasCriticalOrSerious(findings: A11yFinding[]): boolean {
  return findings.some(
    (finding) => finding.severity === 'critical' || finding.severity === 'serious',
  );
}