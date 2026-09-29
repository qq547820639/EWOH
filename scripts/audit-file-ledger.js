#!/usr/bin/env node
/**
 * audit-file-ledger.js — 二轮审计文件覆盖账本工具
 *
 * 用法:
 *   node scripts/audit-file-ledger.js generate   # 刷新内容哈希，保留理解记录，使过期审阅失效
 *   node scripts/audit-file-ledger.js merge <partial.jsonl|dir>  # 校验当前哈希和阅读区间后原子合并
 *   node scripts/audit-file-ledger.js report     # 现场扫描并验证覆盖，未通过时 exit 1
 *   node scripts/audit-file-ledger.js stats      # 输出简要统计
 *
 * 账本字段: path classification language line_count content_sha256 reviewed reviewed_sha256 reviewed_ranges domain runtime
 *           entry_points imports exported_symbols reads writes database_tables events_consumed
 *           events_emitted contracts security_boundaries tenant_boundaries failure_paths tests findings
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
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
  const realDirectory = fs.realpathSync(dir);
  if (fs.statSync(realDirectory).isFile()) {
    if (!EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(realDirectory)))) out.push(realDirectory);
    return;
  }
  for (const entry of fs.readdirSync(realDirectory, { withFileTypes: true })) {
    const entryPath = path.join(realDirectory, entry.name);
    const entryStat = fs.lstatSync(entryPath);
    if (entryStat.isSymbolicLink()) {
      walk(resolveWithinRoot(entryPath), out);
    } else if (entryStat.isDirectory()) {
      if (EXCLUDE_DIR_PATTERNS.includes(entry.name)) continue;
      walk(entryPath, out);
    } else if (entryStat.isFile()) {
      if (EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
      out.push(entryPath);
    }
  }
}

function resolveWithinRoot(absolutePath) {
  let current = absolutePath;
  while (fs.lstatSync(current).isSymbolicLink()) {
    current = fs.realpathSync(current);
    const relativeTarget = path.relative(ROOT, current);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error(`Audit symlink escapes repository: ${path.relative(ROOT, absolutePath)}`);
    }
  }
  return current;
}

function collectActiveFiles() {
  const absolutePaths = [];
  for (const relativePath of [...INCLUDED_ROOTS, ...INCLUDED_FILES]) {
    const absolutePath = path.join(ROOT, relativePath);
    let stat;
    try { stat = fs.lstatSync(absolutePath); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const realPath = resolveWithinRoot(absolutePath);
    stat = fs.statSync(realPath);
    if (stat.isDirectory()) walk(realPath, absolutePaths);
    else if (stat.isFile()) absolutePaths.push(realPath);
    else throw new Error(`Unsupported file type in audit scope: ${relativePath}`);
  }
  return [...new Set(absolutePaths.map((absolutePath) => path.relative(ROOT, absolutePath)))].sort();
}

function readSnapshot(relativePath) {
  const bytes = fs.readFileSync(path.join(ROOT, relativePath));
  let lineCount = 0;
  for (const byte of bytes) if (byte === 10) lineCount++;
  if (bytes.length && bytes[bytes.length - 1] !== 10) lineCount++;
  return { content_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), line_count: lineCount };
}

function readJsonLines(file) {
  const rows = [];
  for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch {
      throw new Error(`${file}:${index + 1}: invalid JSON`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.path !== 'string') {
      throw new Error(`${file}:${index + 1}: expected an object with a path`);
    }
    rows.push(row);
  }
  return rows;
}

function validatePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || /[\\\r\n]/.test(relativePath)
      || relativePath.startsWith('../') || path.posix.normalize(relativePath) !== relativePath) {
    throw new Error(`Invalid ledger path: ${JSON.stringify(relativePath)}`);
  }
}

function readLedger() {
  const ledger = new Map();
  if (fs.existsSync(LEDGER)) {
    for (const row of readJsonLines(LEDGER)) {
      validatePath(row.path);
      if (ledger.has(row.path)) throw new Error(`Duplicate ledger path: ${row.path}`);
      ledger.set(row.path, row);
    }
  }
  return ledger;
}

function validateRanges(ranges, lineCount) {
  if (!Array.isArray(ranges)) return { valid: false, complete: false, covered: 0 };
  const normalized = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return { valid: false, complete: false, covered: 0 };
    const endpoints = range.map((value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value);
    const [start, end] = endpoints;
    if (!endpoints.every(Number.isSafeInteger) || start < 1 || start > end || end > lineCount) {
      return { valid: false, complete: false, covered: 0 };
    }
    normalized.push([start, end]);
  }
  normalized.sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let previousEnd = 0;
  for (const [start, end] of normalized) {
    covered += Math.max(0, end - Math.max(previousEnd, start - 1));
    previousEnd = Math.max(previousEnd, end);
  }
  return { valid: true, complete: covered === lineCount, covered };
}

function validateReview(row, snapshot) {
  const reasons = [];
  const ranges = validateRanges(row?.reviewed_ranges, snapshot.line_count);
  if (!row) reasons.push('new_file_missing_from_ledger');
  if (row?.reviewed !== true) reasons.push('not_reviewed');
  if (!/^[a-f0-9]{64}$/.test(row?.reviewed_sha256 || '')) reasons.push('missing_review_hash');
  else if (row.reviewed_sha256 !== snapshot.content_sha256) reasons.push('stale_review_hash');
  if (row?.content_sha256 !== snapshot.content_sha256) reasons.push('stale_inventory_hash');
  if (row?.line_count !== snapshot.line_count) reasons.push('stale_line_count');
  if (!ranges.valid) reasons.push('invalid_review_ranges');
  else if (!ranges.complete) reasons.push('incomplete_review_ranges');
  return { verified: reasons.length === 0, reasons, ranges };
}

function atomicWrite(destination, content) {
  const temporaryPath = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { flag: 'wx' });
    fs.renameSync(temporaryPath, destination);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function writeLedger(rows) {
  const sortedRows = [...rows].sort((left, right) => left.path.localeCompare(right.path));
  atomicWrite(LEDGER, sortedRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function withLedgerLock(operation) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const lockPath = `${LEDGER}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Audit ledger locked by another writer: ${lockPath}`);
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`);
    return operation();
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockPath);
  }
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
      ...readSnapshot(rel),
      domain: domainOf(rel),
      runtime: runtimeOf(rel, LANG_BY_EXT[ext] || LANG_BY_NAME[path.basename(rel)] || 'text'),
      reviewed: false,
      reviewed_sha256: null,
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
    if (!old) return base;
    return {
      ...base, ...old,
      line_count: base.line_count, content_sha256: base.content_sha256,
      classification: base.classification, language: base.language, domain: base.domain, runtime: base.runtime,
      reviewed: validateReview(old, base).verified,
    };
  });
  writeLedger(rows);
  console.log(`ledger: ${rows.length} files -> ${path.relative(ROOT, LEDGER)}`);
  const unreviewed = rows.filter((r) => !r.reviewed).length;
  console.log(`reviewed=${rows.length - unreviewed} unreviewed=${unreviewed}`);
}

function cmdMerge(input) {
  if (!input) throw new Error('merge requires an input JSONL file or directory');
  const inputPath = path.resolve(input);
  let files = [];
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    walk(inputPath, files);
    files = files.filter((file) => file.endsWith('.jsonl')).sort();
  } else files = [inputPath];
  if (!files.length) throw new Error('No JSONL input files found');
  const ledger = readLedger();
  const activeFiles = new Set(collectActiveFiles());
  const mergedPaths = new Set();
  for (const file of files) {
    for (const incoming of readJsonLines(file)) {
      incoming.path = incoming.path.replace(/^\.\//, '');
      validatePath(incoming.path);
      if (!ledger.has(incoming.path) && ledger.has(`ewoh-spark-app/${incoming.path}`)) {
        incoming.path = `ewoh-spark-app/${incoming.path}`;
      }
      if (!ledger.has(incoming.path) || !activeFiles.has(incoming.path)) throw new Error(`Unknown or missing active path: ${incoming.path}`);
      if (mergedPaths.has(incoming.path)) throw new Error(`Duplicate merge path: ${incoming.path}`);
      const current = ledger.get(incoming.path);
      const snapshot = readSnapshot(incoming.path);
      if (Object.hasOwn(incoming, 'reviewed') && typeof incoming.reviewed !== 'boolean') {
        throw new Error(`${incoming.path}: reviewed must be boolean`);
      }
      if (Object.hasOwn(incoming, 'content_sha256') && incoming.content_sha256 !== snapshot.content_sha256) {
        throw new Error(`${incoming.path}: stale content_sha256`);
      }
      if (Object.hasOwn(incoming, 'line_count') && incoming.line_count !== snapshot.line_count) {
        throw new Error(`${incoming.path}: stale line_count`);
      }
      const changesReview = incoming.reviewed === true || Object.hasOwn(incoming, 'reviewed_ranges') || Object.hasOwn(incoming, 'reviewed_sha256');
      if (changesReview) {
        if (incoming.reviewed_sha256 !== snapshot.content_sha256) throw new Error(`${incoming.path}: missing or stale reviewed_sha256`);
        const ranges = validateRanges(incoming.reviewed_ranges, snapshot.line_count);
        if (!ranges.valid) throw new Error(`${incoming.path}: invalid reviewed_ranges`);
        if ((incoming.reviewed ?? current.reviewed) === true && !ranges.complete) {
          throw new Error(`${incoming.path}: reviewed_ranges do not cover every current line`);
        }
      }
      const merged = {
        ...current, ...incoming, ...snapshot,
        classification: current.classification, language: current.language, domain: current.domain, runtime: current.runtime,
      };
      if (!changesReview && !validateReview(current, snapshot).verified) merged.reviewed = false;
      ledger.set(incoming.path, merged);
      mergedPaths.add(incoming.path);
    }
  }
  if (!mergedPaths.size) throw new Error('No merge entries found');
  for (const relativePath of mergedPaths) {
    if (ledger.get(relativePath).content_sha256 !== readSnapshot(relativePath).content_sha256) {
      throw new Error(`${relativePath}: content changed during merge`);
    }
  }
  writeLedger(ledger.values());
  console.log(`merge: ${mergedPaths.size} entries updated`);
}

function cmdPaths() {
  // 只读子命令：把「现扫总体」原样交出去，供外部对账量具复用同一条枚举器
  // （另写一份目录遍历会让两套读数不可比，本次读数即作废）。
  const files = collectActiveFiles();
  const ledger = readLedger();
  console.log(JSON.stringify({ active: files.length, ledger: ledger.size, files }));
}

function inspectCoverage() {
  const ledger = readLedger();
  const files = collectActiveFiles();
  const activeFiles = new Set(files);
  const rows = files.map((relativePath) => {
    const snapshot = readSnapshot(relativePath);
    const row = ledger.get(relativePath);
    return { path: relativePath, domain: domainOf(relativePath), ...snapshot, ...validateReview(row, snapshot), claimed: row?.reviewed === true };
  });
  const missing = [...ledger.keys()].filter((relativePath) => !activeFiles.has(relativePath));
  const unreviewed = rows.filter((row) => !row.verified);
  const partial = rows.filter((row) => row.claimed && !row.ranges.complete);
  const stale = rows.filter((row) => row.claimed && row.reasons.some((reason) => reason.startsWith('stale_')));
  const byDomain = {};
  for (const row of rows) {
    byDomain[row.domain] ??= { total: 0, reviewed: 0, lines: 0 };
    byDomain[row.domain].total++;
    if (row.verified) byDomain[row.domain].reviewed++;
    byDomain[row.domain].lines += row.line_count;
  }
  return { rows, missing, unreviewed, partial, stale, byDomain };
}

function cmdReport() {
  const { rows, missing, unreviewed, partial, stale, byDomain } = inspectCoverage();
  const totalLines = rows.reduce((total, row) => total + row.line_count, 0);
  const verifiedLines = rows.reduce((total, row) => total + (row.verified ? row.line_count : 0), 0);
  const passed = rows.length > 0 && !unreviewed.length && !missing.length;
  const md = [
    '# Coverage Report — 二轮审计文件覆盖账本',
    '',
    `- 生成时间: ${new Date().toISOString()}`,
    `- 活跃文件总数: ${rows.length}`,
    `- 当前内容与完整阅读区间均已验证: ${rows.length - unreviewed.length}`,
    `- active_unread_files: ${unreviewed.length}`,
    `- partial_review_files: ${partial.length}`,
    `- stale_review_files: ${stale.length}`,
    `- missing_or_out_of_scope_files: ${missing.length}`,
    `- 总行数: ${totalLines}`,
    `- 已验证行数: ${verifiedLines}`,
    `- gate_result: ${passed ? 'PASS' : 'FAIL'}`,
    '- 验证依据：现场文件清单、原始字节 SHA-256、审阅 SHA-256、合法行区间的完整并集；自动扫描本身不构成阅读证据。',
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
    '## 未验证文件',
    '',
    ...unreviewed.map((row) => `- ${row.path}: ${row.reasons.join(', ')}`),
    '',
    '## 缺失或已离开活跃范围的账本路径',
    '',
    ...missing.map((relativePath) => `- ${relativePath}`),
    '',
    passed ? '- active_unread_files = 0 ✓\n- partial_review_files = 0 ✓' : '- 门禁未通过；旧 reviewed 标记不能作为当前完整阅读的证明。',
    '',
  ].join('\n');
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  atomicWrite(path.join(AUDIT_DIR, 'coverage-report.md'), md);
  console.log(`report: ${rows.length - unreviewed.length}/${rows.length} reviewed; active_unread_files=${unreviewed.length}; partial_review_files=${partial.length}; stale_review_files=${stale.length}; missing_files=${missing.length}`);
  if (!passed) process.exitCode = 1;
}

function cmdStats() {
  const { rows, missing, unreviewed, byDomain } = inspectCoverage();
  console.log('files by domain:', JSON.stringify(byDomain, null, 0));
  console.log(`total=${rows.length} reviewed=${rows.length - unreviewed.length} unreviewed=${unreviewed.length} missing=${missing.length}`);
}

const cmd = process.argv[2];
try {
  if (cmd === 'generate') withLedgerLock(cmdGenerate);
  else if (cmd === 'merge') withLedgerLock(() => cmdMerge(process.argv[3]));
  else if (cmd === 'report') cmdReport();
  else if (cmd === 'stats') cmdStats();
  else if (cmd === 'paths') cmdPaths();
  else { console.error('usage: audit-file-ledger.js generate|merge <input>|report|stats|paths'); process.exitCode = 2; }
} catch (error) {
  console.error(`audit ledger: ${error.message}`);
  process.exitCode = 1;
}
