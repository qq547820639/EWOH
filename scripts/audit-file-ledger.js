#!/usr/bin/env node
/**
 * audit-file-ledger.js — 二轮审计文件覆盖账本工具
 *
 * 用法:
 *   node scripts/audit-file-ledger.js generate   # 生成/重建 docs/audit/current/file-ledger.jsonl（保留已 review 条目的回填字段）
 *   node scripts/audit-file-ledger.js merge <partial.jsonl|dir>  # 合并回填条目（按 path 覆盖 reviewed/reviewed_ranges/metadata）
 *   node scripts/audit-file-ledger.js report     # 生成 docs/audit/current/coverage-report.md；存在未读文件时 exit 1
 *   node scripts/audit-file-ledger.js stats      # 输出简要统计
 *
 * 账本字段: path classification language line_count reviewed reviewed_ranges domain runtime
 *           entry_points imports exported_symbols reads writes database_tables events_consumed
 *           events_emitted contracts security_boundaries tenant_boundaries failure_paths tests findings
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'docs', 'audit', 'current');
const LEDGER = path.join(AUDIT_DIR, 'file-ledger.jsonl');

// ---- 范围定义（活跃工程文件） ----
const INCLUDED_ROOTS = [
  'src',
  'ewoh-spark-app/server',
  'ewoh-spark-app/client/src',
  'ewoh-spark-app/client/public',
  'ewoh-spark-app/client/jest.config.cjs',
  'ewoh-spark-app/client/jest.config.js',
  'ewoh-spark-app/client/tsconfig.jest.json',
  'ewoh-spark-app/client/tsconfig.spec.json',
  'ewoh-spark-app/client/index.html',
  'ewoh-spark-app/shared',
  'ewoh-spark-app/test',
  'ewoh-spark-app/scripts',
  'ewoh-spark-app/.githooks',
  'ewoh-feishu-app/server',
  'ewoh-feishu-app/public',
  'ewoh-feishu-app/test',
  'contracts',
  'openapi',
  'db',
  'scripts',
  'tools',
  'tests',
  'deploy',
  'security',
  '.github',
  'catalog',
];
const INCLUDED_FILES = [
  'Makefile',
  'pyproject.toml',
  'package.json',
  'feature-status.yaml',
  'version.json',
  'requirements-dev.txt',
  'run.py',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  '.gitignore',
  'ewoh-spark-app/package.json',
  'ewoh-spark-app/tsconfig.json',
  'ewoh-spark-app/tsconfig.app.json',
  'ewoh-spark-app/tsconfig.node.json',
  'ewoh-spark-app/tsconfig.spec.json',
  'ewoh-spark-app/tsconfig.playwright.json',
  'ewoh-spark-app/eslint.config.js',
  'ewoh-spark-app/nest-cli.json',
  'ewoh-spark-app/vite.config.ts',
  'ewoh-spark-app/vite.standalone.config.ts',
  'ewoh-spark-app/tailwind.config.ts',
  'ewoh-spark-app/postcss.config.js',
  'ewoh-spark-app/playwright.config.ts',
  'ewoh-spark-app/components.json',
  'ewoh-spark-app/pnpm-workspace.yaml',
  'ewoh-spark-app/.prettierrc',
  'ewoh-spark-app/.stylelintrc.js',
  'ewoh-spark-app/.npmrc',
  'ewoh-spark-app/.env.standalone.example',
  'ewoh-feishu-app/package.json',
];

const EXCLUDE_DIR_PATTERNS = [
  'node_modules',
  '__pycache__',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  'release',
  'delivery',
  'output',
  '.trae',
  '.codex',
  '.trae-html-share-packages',
  '.spark',
];
const EXCLUDE_FILE_PATTERNS = [
  /\.lock$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /\.min\.(js|css)$/i,
  /\.(png|jpg|jpeg|gif|ico|svg|webp|woff2?|ttf|eot|mp4|mp3|zip|tar|gz|whl|bin|dylib|so|exe|pdf|wasm)$/i,
  /\.py[co]$/i,
  /openapi\.d\.ts$/i, // 生成产物（codegen），由 openapi:no-drift 门禁保障
];

const LANG_BY_EXT = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json',
  '.html': 'html', '.css': 'css', '.md': 'markdown', '.sh': 'shell',
  '.toml': 'toml', '.rego': 'rego', '.svg': 'svg', '.example': 'env',
};
const LANG_BY_NAME = {
  'Makefile': 'makefile', 'Dockerfile': 'dockerfile', 'CODEOWNERS': 'text',
  '.gitignore': 'gitignore', '.npmrc': 'ini', '.prettierrc': 'json',
  '.env.example': 'env', '.env.standalone.example': 'env', '.env.compose.example': 'env',
};

function classify(rel, ext) {
  if (/(^|\/)(tests?|__tests__|spec)\//.test(rel) || /\.(spec|test)\.[jt]sx?$/.test(rel) || /(^|\/)test_.*\.py$/.test(rel) || /\.spec\./.test(rel)) return 'test';
  if (rel.startsWith('db/migrations')) return 'migration';
  if (rel.startsWith('db/seed')) return 'seed';
  if (rel.startsWith('db/verify')) return 'verify';
  if (rel.startsWith('contracts/') || rel.startsWith('openapi/')) return 'contract';
  if (rel.startsWith('.github/')) return 'ci';
  if (rel.startsWith('deploy/')) return 'deploy';
  if (rel.startsWith('security/')) return 'security-config';
  if (ext === '.md') return 'doc';
  if (['.yaml', '.yml', '.json', '.toml', '.example', ''].includes(ext) || LANG_BY_NAME[path.basename(rel)]) return 'config';
  if (rel.startsWith('scripts/') || rel.startsWith('tools/') || rel.startsWith('ewoh-spark-app/scripts/')) return 'script';
  return 'source';
}

function domainOf(rel) {
  if (rel.startsWith('src/')) return 'edge';
  if (rel.startsWith('ewoh-spark-app/server/')) return 'server';
  if (rel.startsWith('ewoh-spark-app/client/')) return 'client';
  if (rel.startsWith('ewoh-spark-app/shared/')) return 'shared';
  if (rel.startsWith('ewoh-spark-app/')) return 'app-config';
  if (rel.startsWith('ewoh-feishu-app/')) return 'feishu';
  if (rel.startsWith('db/')) return 'database';
  if (rel.startsWith('scripts/')) return 'scripts';
  if (rel.startsWith('tools/')) return 'tools';
  if (rel.startsWith('tests/')) return 'py-contracts';
  if (rel.startsWith('deploy/')) return 'deploy';
  if (rel.startsWith('security/')) return 'security';
  if (rel.startsWith('.github/')) return 'ci';
  if (rel.startsWith('contracts/')) return 'contracts';
  if (rel.startsWith('openapi/')) return 'openapi';
  if (rel.startsWith('catalog/')) return 'catalog';
  return 'root';
}

function runtimeOf(rel, lang) {
  if (lang === 'python') return 'python';
  if (rel.startsWith('ewoh-spark-app/client/')) return 'browser';
  if (['typescript', 'javascript'].includes(lang)) return 'node';
  if (lang === 'sql') return 'postgres';
  return 'none';
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIR_PATTERNS.includes(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      if (EXCLUDE_FILE_PATTERNS.some((re) => re.test(e.name))) continue;
      out.push(path.join(dir, e.name));
    }
  }
}

function collectActiveFiles() {
  const abs = [];
  for (const r of INCLUDED_ROOTS) {
    const p = path.join(ROOT, r);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, abs);
    else abs.push(p);
  }
  for (const f of INCLUDED_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) abs.push(p);
  }
  return abs.map((p) => path.relative(ROOT, p)).sort();
}

function countLines(p) {
  try {
    const buf = fs.readFileSync(p);
    let s = 0;
    for (const b of buf) if (b === 10) s++;
    if (buf.length && buf[buf.length - 1] !== 10) s++;
    return s;
  } catch { return 0; }
}

function readLedger() {
  const map = new Map();
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); map.set(j.path, j); } catch { /* skip bad line */ }
    }
  }
  return map;
}

function cmdGenerate() {
  const prev = readLedger();
  const files = collectActiveFiles();
  const rows = files.map((rel) => {
    const ext = path.extname(rel).toLowerCase();
    const lang = LANG_BY_EXT[ext] || LANG_BY_NAME[path.basename(rel)] || 'text';
    const base = {
      path: rel,
      classification: classify(rel, ext),
      language: lang,
      line_count: countLines(path.join(ROOT, rel)),
      domain: domainOf(rel),
      runtime: runtimeOf(rel, LANG_BY_EXT[ext] || LANG_BY_NAME[path.basename(rel)] || 'text'),
      reviewed: false,
      reviewed_ranges: [],
      entry_points: false,
      imports: 0,
      exported_symbols: [],
      reads: [],
      writes: [],
      database_tables: [],
      events_consumed: [],
      events_emitted: [],
      contracts: [],
      security_boundaries: [],
      tenant_boundaries: [],
      failure_paths: [],
      tests: [],
      findings: [],
    };
    const old = prev.get(rel);
    if (old && old.reviewed === true) {
      // 保留已回填的审计字段，但刷新行数/分类
      return { ...old, line_count: base.line_count, classification: base.classification, language: base.language, domain: base.domain, runtime: base.runtime };
    }
    return base;
  });
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`ledger: ${rows.length} files -> ${path.relative(ROOT, LEDGER)}`);
  const unreviewed = rows.filter((r) => !r.reviewed).length;
  console.log(`reviewed=${rows.length - unreviewed} unreviewed=${unreviewed}`);
}

function cmdMerge(input) {
  const p = path.resolve(input);
  let files = [];
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    walk(p, files);
    files = files.filter((f) => f.endsWith('.jsonl'));
  } else files = [p];
  const ledger = readLedger();
  let merged = 0, unknown = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (!j.path) continue;
      j.path = j.path.replace(/^\.\//, '');
      if (!ledger.has(j.path) && ledger.has('ewoh-spark-app/' + j.path)) j.path = 'ewoh-spark-app/' + j.path;
      if (!ledger.has(j.path)) { unknown++; continue; }
      const cur = ledger.get(j.path);
      ledger.set(j.path, { ...cur, ...j, line_count: cur.line_count, classification: cur.classification, language: cur.language, domain: cur.domain, runtime: cur.runtime });
      merged++;
    }
  }
  fs.writeFileSync(LEDGER, [...ledger.values()].sort((a, b) => (a.path < b.path ? -1 : 1)).map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`merge: ${merged} entries updated, ${unknown} unknown paths skipped`);
}

function cmdReport() {
  const ledger = readLedger();
  const rows = [...ledger.values()];
  const unreviewed = rows.filter((r) => !r.reviewed);
  const partial = rows.filter((r) => r.reviewed && (!Array.isArray(r.reviewed_ranges) || r.reviewed_ranges.length === 0));
  const byDomain = {};
  for (const r of rows) {
    byDomain[r.domain] = byDomain[r.domain] || { total: 0, reviewed: 0, lines: 0 };
    byDomain[r.domain].total++;
    if (r.reviewed) byDomain[r.domain].reviewed++;
    byDomain[r.domain].lines += r.line_count || 0;
  }
  const totalLines = rows.reduce((s, r) => s + (r.line_count || 0), 0);
  const md = [
    '# Coverage Report — 二轮审计文件覆盖账本',
    '',
    `- 生成时间: ${new Date().toISOString()}`,
    `- 活跃文件总数: ${rows.length}`,
    `- 已逐行复审 (reviewed=true): ${rows.length - unreviewed.length}`,
    `- active_unread_files: ${unreviewed.length}`,
    `- partial_review_files (reviewed 但无 ranges): ${partial.length}`,
    `- 总行数: ${totalLines}`,
    '',
    '## 排除项声明',
    '',
    '- release/、delivery/、output/：打包副本与生成产物，不逐行重复审计；生产引用与版本边界核查见 final-assessment.md。',
    '- node_modules、lock 文件、二进制资产、*.min.* bundle、openapi.d.ts（codegen 产物，由 openapi:no-drift 门禁保障）。',
    '- docs/（本审计体系自身输出与历史报告，非工程代码）；.codex/、.trae/（流程制品）。',
    '',
    '## 域分布',
    '',
    '| domain | files | reviewed | lines |',
    '| --- | --- | --- | --- |',
    ...Object.entries(byDomain).sort().map(([d, v]) => `| ${d} | ${v.total} | ${v.reviewed} | ${v.lines} |`),
    '',
    unreviewed.length ? '## 未读文件\n' : '## 终态断言\n',
    unreviewed.length ? unreviewed.map((r) => `- ${r.path}`).join('\n') : '- active_unread_files = 0 ✓\n- partial_review_files = 0 ✓',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(AUDIT_DIR, 'coverage-report.md'), md);
  console.log(`report: ${rows.length - unreviewed.length}/${rows.length} reviewed; active_unread_files=${unreviewed.length}; partial_review_files=${partial.length}`);
  if (unreviewed.length || partial.length) process.exit(1);
}

function cmdStats() {
  const ledger = readLedger();
  const rows = [...ledger.values()];
  const unreviewed = rows.filter((r) => !r.reviewed);
  const byDomain = {};
  for (const r of rows) byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;
  console.log('files by domain:', JSON.stringify(byDomain, null, 0));
  console.log(`total=${rows.length} reviewed=${rows.length - unreviewed.length} unreviewed=${unreviewed.length}`);
}

const cmd = process.argv[2];
if (cmd === 'generate') cmdGenerate();
else if (cmd === 'merge') cmdMerge(process.argv[3]);
else if (cmd === 'report') cmdReport();
else if (cmd === 'stats') cmdStats();
else { console.error('usage: audit-file-ledger.js generate|merge <input>|report|stats'); process.exit(2); }
