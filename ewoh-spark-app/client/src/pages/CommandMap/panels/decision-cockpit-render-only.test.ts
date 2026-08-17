/* M05：TaskIntelligencePanel / RejectedCandidateExplain 纯展示约束。
 *
 * 关键不变量（08 §10）：前端只渲染服务端数据，**禁止重算 hard constraints**——
 * 面板不得 import 任何资格/成本/硬约束判定逻辑（EligibilityService 语义、
 * constraint 判定、candidate 生成等）。
 *
 * CLI-724：由「单文件正则匹配 import 路径」升级为**静态依赖图分析**——
 * 沿相对导入（含动态 import()/require 的字符串字面量）做传递闭包，
 * 断言闭包内不存在任何判定模块；计算式（拼接）动态 import 因无法静态
 * 解析，一律视为违规直接判红。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const PANELS_DIR = path.resolve(__dirname);

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const INDEX_FILES = ['index.ts', 'index.tsx'];

/** 从源码提取静态与动态（字符串字面量）导入说明符。 */
function collectImportSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /export\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(src)) !== null) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/** 解析相对导入到磁盘文件（ts/tsx 后缀与 index 文件）；包内导入返回 null。 */
function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    ...MODULE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...INDEX_FILES.map((index) => path.join(base, index)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** 计算以 rootFile 为起点的静态导入传递闭包（含自身）。 */
function importGraphFiles(rootFile: string): string[] {
  const visited = new Set<string>();
  const queue = [rootFile];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    if (!fs.existsSync(file)) continue;
    visited.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const spec of collectImportSpecifiers(src)) {
      const resolved = resolveModule(file, spec);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return [...visited];
}

/** CLI-724：非字符串字面量（拼接/变量）的动态 import 无法静态审计，判红。 */
function hasComputedDynamicImport(src: string): boolean {
  const dynamicImports = src.match(/import\s*\(/g) ?? [];
  const literalDynamicImports = src.match(/import\s*\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
  return dynamicImports.length > literalDynamicImports.length;
}

/** 断言依赖图闭包内不含判定模块（solver 仅放行 solverStatusChainVM 展示映射）。 */
function expectGraphFreeOfDecisionLogic(rootFile: string): void {
  const src = fs.readFileSync(rootFile, 'utf8');
  expect(hasComputedDynamicImport(src)).toBe(false);
  for (const file of importGraphFiles(rootFile)) {
    const rel = path.relative(PANELS_DIR, file);
    if (/eligibility|candidate-engine|constraint|impact/i.test(rel)) {
      throw new Error(`${path.basename(rootFile)} 的依赖图引入判定模块：${rel}`);
    }
    if (/solver/i.test(rel) && !/solverStatusChainVM/.test(rel)) {
      throw new Error(`${path.basename(rootFile)} 的依赖图引入求解模块：${rel}`);
    }
  }
}

describe('M05 Decision Cockpit 纯展示约束', () => {
  it('TaskIntelligencePanel 不 import 任何 hard 判定逻辑', () => {
    const src = fs.readFileSync(
      path.join(PANELS_DIR, 'TaskIntelligencePanel.tsx'),
      'utf8',
    );
    // 只允许消费 VM/类型/实体色；禁止 import 资格/求解/约束判定模块。
    const forbidden = [
      /from ['"].*eligibility[^'"]*['"]/,
      /from ['"].*constraints[^'"]*['"]/,
      /from ['"].*candidate-engine[^'"]*['"]/,
      /from ['"].*solver[^'"]*['"]/,
      /from ['"].*impact[^'"]*['"]/,
      /isEligible|checkHard|computeHard|rejectHard/,
    ];
    for (const re of forbidden) {
      expect(src).not.toMatch(re);
    }
    // CLI-724：整张静态依赖图同样不得引入判定模块。
    expectGraphFreeOfDecisionLogic(path.join(PANELS_DIR, 'TaskIntelligencePanel.tsx'));
  });

  it('RejectedCandidateExplain 不 import 任何 hard 判定逻辑', () => {
    const src = fs.readFileSync(
      path.join(PANELS_DIR, 'RejectedCandidateExplain.tsx'),
      'utf8',
    );
    const forbidden = [
      /from ['"].*eligibility[^'"]*['"]/,
      /from ['"].*constraints[^'"]*['"]/,
      /from ['"].*candidate-engine[^'"]*['"]/,
      /from ['"].*solver[^'"]*['"]/,
      /isEligible|checkHard|computeHard|rejectHard/,
    ];
    for (const re of forbidden) {
      expect(src).not.toMatch(re);
    }
    expectGraphFreeOfDecisionLogic(path.join(PANELS_DIR, 'RejectedCandidateExplain.tsx'));
  });

  it('decisionExplainVM / replanOverlayVM 仅消费 @shared 类型（无判定逻辑）', () => {
    const vmSrc = fs.readFileSync(
      path.join(PANELS_DIR, '..', 'vm', 'decisionExplainVM.ts'),
      'utf8',
    );
    const overlaySrc = fs.readFileSync(
      path.join(PANELS_DIR, '..', 'replanOverlayVM.ts'),
      'utf8',
    );
    for (const src of [vmSrc, overlaySrc]) {
      expect(src).not.toMatch(/from ['"].*eligibility[^'"]*['"]/);
      expect(src).not.toMatch(/from ['"].*constraints[^'"]*['"]/);
      expect(src).not.toMatch(/from ['"].*solver[^'"]*['"]/);
    }
  });

  it('decisionContextVM / taskMoveExplainVM 仅映射服务端字段（不判资格/不重算硬约束）', () => {
    const ctxSrc = fs.readFileSync(
      path.join(PANELS_DIR, '..', 'vm', 'decisionContextVM.ts'),
      'utf8',
    );
    const moveSrc = fs.readFileSync(
      path.join(PANELS_DIR, '..', 'vm', 'taskMoveExplainVM.ts'),
      'utf8',
    );
    for (const src of [ctxSrc, moveSrc]) {
      // 禁止 import 资格/约束/候选引擎模块（08 §10：前端只渲染服务端数据）。
      expect(src).not.toMatch(/from ['"].*eligibility[^'"]*['"]/);
      expect(src).not.toMatch(/from ['"].*constraints[^'"]*['"]/);
      expect(src).not.toMatch(/from ['"].*candidate-engine[^'"]*['"]/);
      expect(src).not.toMatch(/isEligible|checkHard|computeHard|rejectHard/);
      // 允许的 solver 引用仅限纯展示 VM（solverStatusChainVM 只做状态→文案映射，无求解逻辑）。
      const solverImports = src.match(/from ['"][^'"]*solver[^'"]*['"]/g) ?? [];
      for (const imp of solverImports) {
        expect(imp).toMatch(/solverStatusChainVM/);
      }
    }
  });

  it('executionFeedbackVM 仅映射服务端执行记录（状态/偏差文案），不 import 判定逻辑', () => {
    const src = fs.readFileSync(
      path.join(PANELS_DIR, '..', 'vm', 'executionFeedbackVM.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"].*eligibility[^'"]*['"]/);
    expect(src).not.toMatch(/from ['"].*constraints[^'"]*['"]/);
    expect(src).not.toMatch(/from ['"].*candidate-engine[^'"]*['"]/);
    expect(src).not.toMatch(/from ['"].*solver[^'"]*['"]/);
    expect(src).not.toMatch(/isEligible|checkHard|computeHard|rejectHard/);
  });
});
