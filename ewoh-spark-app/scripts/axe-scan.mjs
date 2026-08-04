#!/usr/bin/env node
/**
 * UX-007 6「自动化 axe 检查」— 无障碍扫描脚本。
 *
 * 两种模式：
 * 1. 真实浏览器模式（优先）：若安装了 `@axe-core/playwright`，则启动浏览器
 *    对核心页面运行 axe-core 注入扫描，输出 Critical/Serious 问题清单。
 * 2. 静态启发式模式（回退）：若未安装 `@axe-core/playwright`（离线/无网络权限），
 *    则对 client/src 核心页面源码执行与 client/src/lib/a11yAudit.ts 一致的
 *    静态规则扫描，并明确标注「待真实浏览器运行」——不伪造「通过」结果。
 *
 * 用法：
 *   node scripts/axe-scan.mjs                 # 静态模式（默认）
 *   node scripts/axe-scan.mjs --real urls     # 真实浏览器模式（需 @axe-core/playwright）
 *   node scripts/axe-scan.mjs --json          # 输出 JSON 到 stdout
 *   node scripts/axe-scan.mjs --strict        # 存在 Critical/Serious 时以非零退出
 *
 * 说明：静态扫描是「近似」检测，不能替代真实浏览器 axe 运行；真实结论以
 * --real 模式输出为准。见 docs/reviews/ux007-a11y-exceptions.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const clientSrc = path.resolve(root, 'client', 'src');

/** 核心页面（与 UX-007 重点覆盖范围一致）。 */
const CORE_PAGES = [
  'pages/CommandCenter/CommandCenter.tsx',
  'pages/WorkOrchestration/WorkOrchestration.tsx',
  'pages/WorkOrchestration/WorkGraphPanel.tsx',
  'pages/RoleWorkbench/RoleWorkbench.tsx',
  'pages/MobileWorkbench/MobileWorkbench.tsx',
  'pages/Scheduling/Scheduling.tsx',
  'pages/Alerts/Alerts.tsx',
  'pages/Devices/Devices.tsx',
  'pages/Personnel/Personnel.tsx',
  'components/Layout.tsx',
];

/**
 * 静态启发式规则（与 client/src/lib/a11yAudit.ts 的 STATIC_RULES 保持一致、
 * 以便单测与扫描脚本结论一致）。`detect` 返回 true 表示「命中」潜在问题。
 */
const STATIC_RULES = [
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

/** 扫描单个文件源码，返回命中的静态问题。 */
function scanFile(source, filePath) {
  return STATIC_RULES.filter((rule) => rule.detect(source)).map((rule) => ({
    ruleId: rule.id,
    wcag: rule.wcag,
    severity: rule.severity,
    filePath,
    description: rule.description,
  }));
}

function summarize(findings) {
  const bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return { total: findings.length, bySeverity };
}

function hasCriticalOrSerious(findings) {
  return findings.some(
    (finding) => finding.severity === 'critical' || finding.severity === 'serious',
  );
}

/** 静态扫描核心页面源码。 */
function runStaticScan() {
  const findings = [];
  const missing = [];
  for (const rel of CORE_PAGES) {
    const abs = path.resolve(clientSrc, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const source = fs.readFileSync(abs, 'utf8');
    findings.push(...scanFile(source, rel));
  }
  return { findings, missing };
}

/** 真实浏览器模式：用 @axe-core/playwright 扫描给定 URL。 */
async function runRealScan(urls) {
  let axePlaywright;
  try {
    axePlaywright = await import('@axe-core/playwright');
  } catch {
    console.error(
      '未安装 @axe-core/playwright。请先 `npm i -D @axe-core/playwright` 后重试，' +
        '或省略 --real 以使用静态模式。',
    );
    process.exit(2);
  }
  const { chromium } = await import('playwright');
  const { AxeBuilder } = axePlaywright;
  const browser = await chromium.launch();
  const findings = [];
  for (const url of urls) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    const results = await new AxeBuilder({ page }).analyze();
    for (const violation of results.violations) {
      if (violation.impact === 'critical' || violation.impact === 'serious') {
        findings.push({
          ruleId: violation.id,
          wcag: (violation.tags ?? []).filter((t) => t.startsWith('wcag')).join(', '),
          severity: violation.impact,
          filePath: url,
          description: `${violation.help}（${violation.nodes.length} 个节点）`,
        });
      }
    }
    await page.close();
  }
  await browser.close();
  return findings;
}

function renderTable(findings) {
  const sorted = [...findings].sort((a, b) => {
    const rank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    return rank[a.severity] - rank[b.severity];
  });
  console.log('UX-007 无障碍扫描结果');
  console.log('='.repeat(100));
  if (sorted.length === 0) {
    console.log('（无命中）');
  } else {
    console.log(
      `${'严重度'.padEnd(9)}${'规则'.padEnd(28)}${'WCAG'.padEnd(16)}${'文件'.padEnd(28)}${'说明'}`,
    );
    console.log('-'.repeat(100));
    for (const f of sorted) {
      console.log(
        `${f.severity.padEnd(9)}${f.ruleId.padEnd(28)}${f.wcag.padEnd(16)}${f.filePath.padEnd(28)}${f.description}`,
      );
    }
  }
  console.log('='.repeat(100));
  const summary = summarize(findings);
  console.log(
    `汇总：total ${summary.total}，critical ${summary.bySeverity.critical}，` +
      `serious ${summary.bySeverity.serious}，moderate ${summary.bySeverity.moderate}，minor ${summary.bySeverity.minor}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const real = args.includes('--real');
  const json = args.includes('--json');
  const strict = args.includes('--strict');

  // 取 --real 之后的 URL；无则回退默认本地开发地址。
  const realIndex = args.indexOf('--real');
  let urls = realIndex >= 0 ? args.slice(realIndex + 1) : [];
  if (urls.length === 0) urls = ['http://localhost:5173/command-center'];

  const mode = real ? 'real' : 'static';
  let findings;
  let missing = [];
  let note = null;

  if (mode === 'real') {
    findings = await runRealScan(urls);
    note = '真实浏览器 axe-core 运行结果。';
  } else {
    const result = runStaticScan();
    findings = result.findings;
    missing = result.missing;
    note =
      '静态启发式扫描（近似，未在真实浏览器运行 axe-core）。' +
      '真实结论须以浏览器运行 `node scripts/axe-scan.mjs --real <urls>` 为准。';
  }

  if (json) {
    const report = {
      mode,
      note,
      missing,
      total: findings.length,
      bySeverity: summarize(findings).bySeverity,
      findings,
      generatedAt: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`模式：${mode}（${note}）`);
    if (missing.length > 0) {
      console.log(`提示：以下核心页面未找到，已跳过：${missing.join(', ')}`);
    }
    renderTable(findings);
  }

  const cs = hasCriticalOrSerious(findings);
  if (strict && cs) {
    console.error('\n检测到 Critical/Serious 级问题，CI 失败。');
    process.exit(1);
  }
  process.exit(0);
}

main();