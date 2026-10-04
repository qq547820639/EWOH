// CSTR-02（V357）：客户端"约束解释"节门槛收窄的常驻位点。
// 用行注释而不是块注释：正文里的目录通配写法 `server/**/...` 含 `*/`，会提前终止块注释
// （本轮就是这么红的第一次：TS 报 Cannot find name + Unterminated template literal）。
//
// 为什么位点写在后端单测目录里：fix-sites 的 A 类只扫四个目录（链级 e2e、test/unit、
// 服务端 __tests__、边缘 pytest），client/src 不在其中 ⇒ 前端渲染用例（同目录
// panels/TaskIntelligencePanel.test.tsx 三支）能被 jest 跑到、却不被位点尺看见。
// 这里用文本面把两条接线钉进 A 类可见面，并钉住那三支行为用例的存在与编号，
// 使"行为面在扫描面之外"这件事本身变成会被发现的条件，而不是静默前提。
/// <reference types="jest" />
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const PANEL = resolve(
  __dirname,
  '../../../client/src/pages/CommandMap/panels/TaskIntelligencePanel.tsx',
);
const VM = resolve(
  __dirname,
  '../../../client/src/pages/CommandMap/vm/decisionExplainVM.ts',
);
const PANEL_SPEC = resolve(
  __dirname,
  '../../../client/src/pages/CommandMap/panels/TaskIntelligencePanel.test.tsx',
);

describe('CSTR-02 约束解释节门槛', () => {
  it('CSTR-02 面板不再单独以"有没有拒绝候选"作为整节门槛', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toContain('decision.rejectedHard.length > 0\n        || decision.hardConstraints.length > 0');
    expect(src).toContain('|| decision.hardConstraintsIgnored.length > 0) && (');
    // 反向对照：旧形状（整块挂在 rejectedHard 上）不得复活
    expect(src).not.toContain('{decision && decision.rejectedHard.length > 0 && (');
  });

  it('CSTR-02 解释层把维度档透传给面板，缺字段给空数组', () => {
    const src = readFileSync(VM, 'utf8');
    expect(src).toContain('hardConstraintsIgnored: trace.hardConstraintsIgnored ?? [],');
  });

  it('CSTR-02 行为面配对：前端渲染用例在位点尺扫描面之外，必须原地可点数', () => {
    expect(existsSync(PANEL_SPEC)).toBe(true);
    const src = readFileSync(PANEL_SPEC, 'utf8');
    const titled = (src.match(/\bit\(\s*'[^']*CSTR-02/g) || []).length;
    expect(titled).toBe(0); // 行为用例按 describe 归族，编号不逐条重复
    expect((src.match(/\bit\(/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("describe('CSTR-02 约束解释节的渲染门槛'");
  });
});
