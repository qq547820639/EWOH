import {
  STATIC_RULES,
  UX007_A11Y_REQUIREMENTS,
  hasCriticalOrSerious,
  scanFile,
  summarize,
} from './a11yAudit';

describe('UX007_A11Y_REQUIREMENTS', () => {
  it('covers UX-007 sub-items 7.1 through 7.8', () => {
    const ids = UX007_A11Y_REQUIREMENTS.map((req) => req.id);
    expect(ids).toEqual(['7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.8']);
  });

  it('every requirement exposes non-empty checks and an AA/A level', () => {
    for (const req of UX007_A11Y_REQUIREMENTS) {
      expect(req.checks.length).toBeGreaterThan(0);
      expect(['A', 'AA']).toContain(req.level);
    }
  });
});

describe('STATIC_RULES', () => {
  it('exposes unique rule ids', () => {
    const ids = STATIC_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flags an <img> without alt', () => {
    const findings = scanFile('<img src="x.png" />', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'img-without-alt')).toBe(true);
  });

  it('does not flag an <img> with alt', () => {
    const findings = scanFile('<img src="x.png" alt="设备照片" />', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'img-without-alt')).toBe(false);
  });

  it('flags an <svg> without accessible name', () => {
    const findings = scanFile('<svg><path /></svg>', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'svg-without-accessible-name')).toBe(true);
  });

  it('accepts an <svg> with role="img" and aria-label', () => {
    const findings = scanFile(
      '<svg role="img" aria-label="因果图"><path /></svg>',
      'a.tsx',
    );
    expect(findings.some((f) => f.ruleId === 'svg-without-accessible-name')).toBe(false);
  });

  it('flags a text <input> without accessible name', () => {
    const findings = scanFile('<input placeholder="搜索" />', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'input-without-label')).toBe(true);
  });

  it('accepts an <input> with aria-label', () => {
    const findings = scanFile('<input aria-label="搜索" />', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'input-without-label')).toBe(false);
  });

  it('ignores hidden/file inputs', () => {
    const findings = scanFile(
      '<input type="hidden" /><input type="file" aria-label="照片" />',
      'a.tsx',
    );
    expect(findings.some((f) => f.ruleId === 'input-without-label')).toBe(false);
  });

  it('flags an icon-only button without aria-label', () => {
    const findings = scanFile('<button type="button"><Menu /></button>', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'button-without-name')).toBe(true);
  });

  it('accepts a button with visible text', () => {
    const findings = scanFile('<button type="button">保存</button>', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'button-without-name')).toBe(false);
  });

  it('accepts a button with aria-label', () => {
    const findings = scanFile(
      '<button type="button" aria-label="关闭导航"><X /></button>',
      'a.tsx',
    );
    expect(findings.some((f) => f.ruleId === 'button-without-name')).toBe(false);
  });

  it('flags outline-none without a focus fallback', () => {
    const findings = scanFile('className="outline-none"', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'outline-none-without-focus')).toBe(true);
  });

  it('accepts outline-none with focus:border fallback', () => {
    const findings = scanFile('className="outline-none focus:border-blue-500"', 'a.tsx');
    expect(findings.some((f) => f.ruleId === 'outline-none-without-focus')).toBe(false);
  });
});

describe('summarize / hasCriticalOrSerious', () => {
  it('counts findings by severity', () => {
    const findings = [
      { ruleId: 'a', wcag: '1.1.1', severity: 'critical', filePath: 'x', description: '' },
      { ruleId: 'b', wcag: '1.3.1', severity: 'serious', filePath: 'x', description: '' },
      { ruleId: 'c', wcag: '2.1.1', severity: 'moderate', filePath: 'x', description: '' },
    ] as const;
    const summary = summarize(findings as never);
    expect(summary.total).toBe(3);
    expect(summary.bySeverity.critical).toBe(1);
    expect(summary.bySeverity.serious).toBe(1);
    expect(summary.bySeverity.moderate).toBe(1);
    expect(hasCriticalOrSerious(findings as never)).toBe(true);
  });

  it('returns false when there are no critical/serious findings', () => {
    const findings = [
      { ruleId: 'c', wcag: '2.1.1', severity: 'moderate', filePath: 'x', description: '' },
    ] as const;
    expect(hasCriticalOrSerious(findings as never)).toBe(false);
  });
});