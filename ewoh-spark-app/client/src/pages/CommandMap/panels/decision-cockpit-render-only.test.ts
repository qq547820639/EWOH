/* M05：TaskIntelligencePanel / RejectedCandidateExplain 纯展示约束。
 *
 * 关键不变量（08 §10）：前端只渲染服务端数据，**禁止重算 hard constraints**——
 * 面板不得 import 任何资格/成本/硬约束判定逻辑（EligibilityService 语义、
 * constraint 判定、candidate 生成等）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const PANELS_DIR = path.resolve(__dirname);

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
});
