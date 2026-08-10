#!/usr/bin/env node
'use strict';

/**
 * audit-env-inventory — 环境变量清单漂移门禁（Task 17.1）。
 *
 * 以 deploy/.env.example 为部署参数唯一事实源，与生产代码路径中实际读取的
 * 环境变量交叉校验：
 *
 *   1) 代码读取的每个环境变量（process.env.X / os.environ.get(...)）必须在
 *      deploy/.env.example 中文档化，或列入 CODE_ENV_ALLOWLIST
 *      （内部/仅测试用途，每条附原因注释）。
 *   2) deploy/.env.example 中文档化的每个变量必须被代码读取，或列入
 *      DOC_RESERVED_ALLOWLIST（reserved/deprecated，附原因）。
 *
 * 生产代码路径（canonical inventory，Task 17.1 指定范围）：
 *   - ewoh-spark-app/server（递归 *.ts，排除 *.spec.ts 与 __tests__/：测试路径）
 *   - ewoh-feishu-app/server（递归 *.js）
 *   - src/edge_platform（递归 *.py，排除 tests/ 与 test_*.py：测试路径）
 *
 * 用法：
 *   node scripts/audit-env-inventory.js [--strict] [--json]
 *   --strict  任何违规 → 退出码 1（CI 使用）
 *   --json    输出 JSON 报告
 *
 * 退出码：0=通过；1=违规（--strict）；2=脚本自身被阻塞（如 .env.example
 * 缺失 / 代码目录缺失），非违规。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ENV_EXAMPLE_PATH = path.join(root, 'deploy', '.env.example');

// 扫描根：<相对路径> -> { exts, excludes }
const SCAN_ROOTS = [
  { rel: 'ewoh-spark-app/server', exts: ['.ts', '.tsx', '.js'], excludes: [/\.spec\.ts$/, /\.test\.ts$/, /[\\/]__tests__[\\/]/] },
  { rel: 'ewoh-feishu-app/server', exts: ['.js'], excludes: [] },
  { rel: 'src/edge_platform', exts: ['.py'], excludes: [/[\\/]tests[\\/]/, /test_[^\\/]*\.py$/, /__pycache__/] },
];

/**
 * 代码读取但属内部/仅测试/环境注入、无需文档化的变量白名单。
 * 每条附原因：为什么允许不进入 deploy/.env.example。
 */
const CODE_ENV_ALLOWLIST = {
  NODE_ENV: 'Node 生态通用运行约定（development/production/standalone 行为分支），非 EWOH 部署参数；测试与 CI 亦依赖，禁止在生产 .env 中固化。',
  TS_NODE: 'ts-node 开发工具链约定（TS_NODE_*）；仅本地/CI 开发路径使用，非部署参数（防御性保留，当前扫描目录未命中）。',
  CI: 'CI 平台注入（CI=true 等）；非部署参数。',
  GITHUB_SHA: 'GitHub Actions 注入的提交 SHA（truth-manifest/truth-gate 读取）；由 CI 注入，不写入 .env。',
  GITHUB_REF_NAME: 'GitHub Actions 注入的分支名；CI 注入，不写入 .env。',
  GITHUB_ACTOR: 'GitHub Actions 注入的触发人；CI 注入，不写入 .env。',
  GITHUB_RUN_ID: 'GitHub Actions 注入的运行 ID；CI 注入，不写入 .env。',
  GITHUB_WORKSPACE: 'GitHub Actions 注入的工作区路径；CI 注入，不写入 .env。',
  GITHUB_EVENT_PATH: 'GitHub Actions 注入的事件文件路径；CI 注入，不写入 .env。',
};

/**
 * deploy/.env.example 中已文档化、但代码不读取的 reserved/deprecated 变量白名单。
 * 说明：文档化条目若代码未使用且不在本白名单 → 视为漂移（文档必须与代码一致）。
 */
const DOC_RESERVED_ALLOWLIST = {
  // （当前无保留项。若将来需要标记废弃变量，在此追加并附原因，
  //   并在 deploy/.env.example 对应行注释 `# [reserved|deprecated]`。）
};

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// ---------------- 文件遍历 ----------------

function walkFiles(dir, exts, excludes, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludes.some((re) => re.test(entry.name))) continue;
      walkFiles(full, exts, excludes, out);
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      if (excludes.some((re) => re.test(entry.name))) continue;
      out.push(full);
    }
  }
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#');
}

/**
 * 收集单个文件读取的环境变量：{ name -> [lineNo, ...] }。
 * 支持：process.env.X、process.env['X']、envStr('X') / parseEnvInt('X') /
 * env('X') 辅助函数，以及 Python os.environ.get('X') / _get_int('X') /
 * os.environ.get(CONST)（通过同文件常量表解析）。
 */
function collectEnvFromFile(file, rel) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hits = new Map(); // name -> Set(lineNo)
  const constants = new Map(); // 常量名 -> env var 名（Python）
  const isPy = file.endsWith('.py');

  // 行级扫描：常量定义 + 单行引用（跳过注释行）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    if (isPy) {
      // 常量定义：ALLOW_STUB_ENV = "EWOH_ALLOW_STUB"
      const constDef = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*["']([A-Z][A-Z0-9_]*)["']/);
      if (constDef) constants.set(constDef[1], constDef[2]);
    }

    const matchers = isPy
      ? [
          { re: /(?:os\.environ\.(?:get|getenv)|_get_int)\(\s*["']([A-Z][A-Z0-9_]*)["']/g, constRef: false },
          { re: /os\.environ\.(?:get|getenv)\(\s*([A-Z][A-Z0-9_]*)\s*\)/g, constRef: true },
        ]
      : [
          { re: /process\.env\.([A-Z][A-Z0-9_]*)/g, constRef: false },
          { re: /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g, constRef: false },
          { re: /\b(?:envStr|parseEnvInt|env)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, constRef: false },
        ];

    for (const { re, constRef } of matchers) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const captured = m[1];
        let name = captured;
        if (constRef) {
          name = constants.get(captured) || captured;
        }
        if (!ENV_NAME_RE.test(name)) continue;
        if (!hits.has(name)) hits.set(name, new Set());
        hits.get(name).add(i + 1);
      }
    }
  }

  // 文本级扫描：捕获跨行的 os.environ.get(\n "EWOH_X" ...) 引用。
  if (isPy) {
    const textRe = /os\.environ\.(?:get|getenv)\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
    let m;
    while ((m = textRe.exec(text)) !== null) {
      const name = m[1];
      const lineNo = text.slice(0, m.index).split('\n').length;
      if (!hits.has(name)) hits.set(name, new Set());
      hits.get(name).add(lineNo);
    }
  }

  const result = {};
  for (const [name, lineNos] of hits) {
    result[name] = { file: rel, lines: [...lineNos].sort((a, b) => a - b) };
  }
  return result;
}

function collectCanonicalInventory() {
  const inventory = {}; // name -> [{ file, lines }]
  const blocked = [];
  for (const scan of SCAN_ROOTS) {
    const absDir = path.join(root, scan.rel);
    if (!fs.existsSync(absDir)) {
      blocked.push(`代码目录缺失：${scan.rel}`);
      continue;
    }
    const files = [];
    walkFiles(absDir, scan.exts, scan.excludes, files);
    for (const file of files) {
      const rel = path.relative(root, file);
      const found = collectEnvFromFile(file, rel);
      for (const [name, info] of Object.entries(found)) {
        if (!inventory[name]) inventory[name] = [];
        inventory[name].push(info);
      }
    }
  }
  return { inventory, blocked };
}

// ---------------- 文档清单 ----------------

function collectDocumentedVars() {
  const text = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const vars = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) vars.add(m[1]);
  }
  return { vars: [...vars].sort(), text };
}

// ---------------- 主审计 ----------------

function audit() {
  const checks = [];
  const { vars: documented, text } = collectDocumentedVars();
  const { inventory, blocked } = collectCanonicalInventory();

  if (blocked.length > 0) {
    return { blocked, checks };
  }

  const codeNames = Object.keys(inventory).sort();
  const undocumented = [];
  for (const name of codeNames) {
    if (documented.includes(name)) continue;
    if (CODE_ENV_ALLOWLIST[name]) {
      checks.push({
        name,
        ok: true,
        kind: 'allowlisted',
        detail: `代码读取但白名单放行（不要求文档化）：${CODE_ENV_ALLOWLIST[name]} 位置=${inventory[name].map((i) => `${i.file}:${i.lines.join(',')}`).join(' ')}`,
      });
    } else {
      undocumented.push(name);
    }
  }

  const unusedDocs = [];
  for (const name of documented) {
    if (codeNames.includes(name)) continue;
    if (DOC_RESERVED_ALLOWLIST[name]) {
      checks.push({
        name,
        ok: true,
        kind: 'reserved',
        detail: `文档化但标记 reserved/deprecated：${DOC_RESERVED_ALLOWLIST[name]}`,
      });
    } else {
      unusedDocs.push(name);
    }
  }

  return {
    blocked: [],
    checks,
    undocumented,
    unusedDocs,
    codeNames,
    documented,
    inventory,
  };
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const json = args.includes('--json');

  if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
    console.error(`AUDIT-ENV-INVENTORY BLOCKED: deploy/.env.example 不存在（${ENV_EXAMPLE_PATH}）`);
    process.exit(2);
  }

  let report;
  try {
    report = audit();
  } catch (error) {
    console.error(`AUDIT-ENV-INVENTORY BLOCKED: ${error && (error.stack || error.message || error)}`);
    process.exit(2);
  }

  if (report.blocked.length > 0) {
    for (const b of report.blocked) console.error(`  BLOCKED: ${b}`);
    console.error('AUDIT-ENV-INVENTORY BLOCKED: 无法构建完整清单（exit 2）');
    process.exit(2);
  }

  const { checks, undocumented, unusedDocs, codeNames, documented, inventory } = report;

  if (json) {
    console.log(
      JSON.stringify(
        {
          envExample: 'deploy/.env.example',
          documentedCount: documented.length,
          codeEnvCount: codeNames.length,
          undocumented: undocumented.map((n) => ({ name: n, usage: inventory[n] })),
          unusedDocs,
          allowlisted: checks.filter((c) => c.kind === 'allowlisted').map((c) => c.name),
          reserved: checks.filter((c) => c.kind === 'reserved').map((c) => c.name),
          verdict: undocumented.length === 0 && unusedDocs.length === 0 ? 'PASS' : 'FAIL',
        },
        null,
        2,
      ),
    );
  } else {
    console.log('ENV INVENTORY AUDIT');
    console.log(`  documented(env.example)=${documented.length} code(production paths)=${codeNames.length}`);
    console.log('  --- 代码读取（生产路径）---');
    for (const name of codeNames) {
      const usage = inventory[name].map((i) => `${i.file}:${i.lines.join(',')}`).join(' ');
      console.log(`    ${documented.includes(name) ? 'doc ' : 'MISS'} ${name.padEnd(42)} ${usage}`);
    }
    if (checks.length > 0) {
      console.log('  --- 白名单/保留项 ---');
      for (const c of checks) {
        console.log(`    ${c.kind === 'reserved' ? 'reserved' : 'allow '} ${c.name.padEnd(42)} ${c.detail.slice(0, 140)}`);
      }
    }
    if (undocumented.length > 0) {
      console.log('  FAIL: 代码读取但未文档化的环境变量：');
      for (const n of undocumented) {
        console.log(`    - ${n}  ← 请在 deploy/.env.example 文档化，或加入 CODE_ENV_ALLOWLIST`);
      }
    }
    if (unusedDocs.length > 0) {
      console.log('  FAIL: 已文档化但代码未读取的环境变量：');
      for (const n of unusedDocs) {
        console.log(`    - ${n}  ← 请移除，或加入 DOC_RESERVED_ALLOWLIST（reserved/deprecated）`);
      }
    }
    const ok = undocumented.length === 0 && unusedDocs.length === 0;
    console.log(`  summary: ${documented.length} documented, ${codeNames.length} code-env, ${undocumented.length} undocumented, ${unusedDocs.length} unused-docs`);
    console.log(ok ? 'ENV-INVENTORY PASS' : 'ENV-INVENTORY FAIL');
  }

  if ((undocumented.length > 0 || unusedDocs.length > 0) && strict) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = { audit, collectCanonicalInventory, collectDocumentedVars };
