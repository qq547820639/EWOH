#!/usr/bin/env node
/**
 * EWOH 语义设计 Token 静态检查
 * 阻止业务页面新增未经批准的硬编码样式值（颜色字面量 hsl/rgb/#hex、
 * Tailwind 任意值颜色、具名颜色工具类），强制引用 semantic design tokens。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const clientRoot = path.join(root, 'client', 'src');
const allowlistPath = path.join(root, 'client', '.design-token-allowlist.json');

const SKIP_DIRS = new Set(['ui', 'business-ui']);
const APPROVED_HUE = [130, 115, 26, 33, 2, 0, 221, 230, 199, 120];

const COLOR_LITERAL_RE = /(?:#[0-9a-fA-F]{3,8}\b|hsl\([^)]*\)|rgb\([^)]*\))/g;
const ARBITRARY_COLOR_RE = /(?:bg|text|border|ring|from|to|via|outline)-\[(?:#|hsl|rgb)[^\]]*\]/g;
const NAMED_COLOR_RE = /(?:bg|text|border|ring|from|to|via|outline)-(?:red|green|blue|gray|grey|slate|zinc|neutral|stone|amber|yellow|orange|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|black|white)-[0-9]{1,3}/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isApprovedHsl(value) {
  const m = /hsl\((\d+)/.exec(value);
  if (!m) return false;
  return APPROVED_HUE.includes(parseInt(m[1], 10));
}

function scanFile(file) {
  const rel = path.relative(clientRoot, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const violations = [];
  const collect = (regex, kind) => {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let m;
      regex.lastIndex = 0;
      while ((m = regex.exec(line)) !== null) {
        const value = m[0];
        if (kind === 'color-literal' && value.startsWith('hsl(') && isApprovedHsl(value)) continue;
        violations.push({ file: rel, line: i + 1, kind, value });
        if (regex.lastIndex === m.index) regex.lastIndex += value.length;
      }
    }
  };
  collect(COLOR_LITERAL_RE, 'color-literal');
  collect(ARBITRARY_COLOR_RE, 'arbitrary-color');
  collect(NAMED_COLOR_RE, 'named-color');
  return violations;
}

function loadAllowlist() {
  if (!fs.existsSync(allowlistPath)) return [];
  try { return JSON.parse(fs.readFileSync(allowlistPath, 'utf8')); } catch { return []; }
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const reportOnly = args.includes('--report');
  const files = walk(path.join(clientRoot, 'pages')).concat(walk(path.join(clientRoot, 'components')));
  if (files.length === 0) { console.error('[lint-design-tokens] 未扫描到任何业务文件。'); process.exit(2); }

  const allViolations = [];
  for (const file of files) allViolations.push(...scanFile(file));

  const allowlist = new Set(loadAllowlist());
  const blocked = strict ? allViolations : allViolations.filter((v) => !allowlist.has(v.file));

  console.log('EWOH 语义设计 Token 静态检查');
  console.log('='.repeat(70));
  console.log(`扫描文件数: ${files.length}`);
  console.log(`违规总数: ${allViolations.length}`);
  console.log(`未放行违规: ${blocked.length}${strict ? '（--strict）' : ''}`);
  console.log('-'.repeat(70));

  const byFile = new Map();
  for (const v of allViolations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(v);
  }
  for (const [file, list] of [...byFile.entries()].sort()) {
    const marker = blocked.some((b) => b.file === file) ? 'BLOCK' : 'allow';
    console.log(`  [${marker}] ${file} (${list.length})`);
    for (const v of list.slice(0, 5)) console.log(`      L${v.line}  ${v.kind}: ${v.value}`);
    if (list.length > 5) console.log(`      ... 共 ${list.length} 处`);
  }
  console.log('='.repeat(70));

  if (reportOnly) process.exit(0);
  if (blocked.length > 0) {
    console.error(`\n[lint-design-tokens] 发现 ${blocked.length} 处未放行的硬编码样式值，业务页面应改用 semantic design tokens。`);
    process.exit(1);
  }
  console.log('\n[lint-design-tokens] 通过：业务页面未新增未经批准的硬编码样式值。');
  process.exit(0);
}

main();
