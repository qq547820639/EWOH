#!/usr/bin/env node
/**
 * 契约触达面审计（NO-84b）——防止"契约演进漏改非链目录测试"再度发生。
 *
 * 背景（第 76 轮真实事故）：`SparkBridge._post_batch` 的返回契约从 bool 演进为
 * verdict 字符串（"ok"/"retry"/"dead_letter"），但顶层 `tests/`（当时不在标准验证链）
 * 的测试桩仍返回 `True` → 成功被误判为 retry → 退避挂死。教训：**桩的返回值也属于
 * 契约面**，必须有机器可执行的检查。
 *
 * 本脚本维护一份**契约桩注册表**：每个受治理的契约列出
 *   · 桩形态（正则，匹配测试文件里的 stub 行）
 *   · 合法返回值集合（与生产实现同源的词表）
 * 任一桩命中正则但返回值不在合法集合 → FAIL 并给修正指引。
 *
 * 注册表是**可扩展的**：下次契约演进时，在这里加一行注册即可让同类事故被门禁拦截。
 *
 * 用法：node scripts/audit-contract-touchpoints.js            （root 运行）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 契约桩注册表（按需扩展；每条 = 一个真实演进过的契约） */
const REGISTRY = [
  {
    id: 'spark_bridge_post_batch_verdict',
    description: 'SparkBridge._post_batch 的返回契约（verdict 字符串）',
    productionFile: 'src/edge_platform/edge/bridge/edge_to_spark.py',
    validReturns: ['ok', 'retry', 'dead_letter'],
    // 桩形态：lambda 桩（返回表达式在行内）
    stubPattern: /_post_batch\s*=\s*(?:lambda[^\n]*)/g,
    scanGlobs: [path.join(root, 'tests')],
    fileTest: (f) => f.endsWith('.py'),
    // 从桩行提取"可能的返回字面量"（字符串/True/False）
    extractReturns: (line) => {
      const values = [];
      for (const m of line.matchAll(/['"]([a-z_]+)['"]/g)) values.push(m[1]);
      for (const m of line.matchAll(/\b(True|False)\b/g)) values.push(m[1] === 'True' ? 'true' : 'false');
      return values;
    },
    fixHint: '桩应返回生产词表之一（如 "ok"）；返回 True/False 是 bool 时代的过期契约。',
  },
];

function* walk(dir, predicate) {
  if (!fs.existsSync(dir)) return;
  if (!fs.statSync(dir).isDirectory()) {
    if (predicate(dir)) yield dir;
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue;
      yield* walk(full, predicate);
    } else if (predicate(full)) {
      yield full;
    }
  }
}

function main() {
  const violations = [];
  let checkedContracts = 0;
  let checkedFiles = 0;

  for (const contract of REGISTRY) {
    checkedContracts += 1;
    for (const dir of contract.scanGlobs) {
      for (const file of walk(dir, contract.fileTest)) {
        checkedFiles += 1;
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (const line of lines) {
          contract.stubPattern.lastIndex = 0;
          if (!contract.stubPattern.test(line)) continue;
          const returns = contract.extractReturns(line);
          const valid = returns.filter((v) => contract.validReturns.includes(v));
          if (returns.length > 0 && valid.length === 0) {
            violations.push({
              contract: contract.id,
              file: path.relative(root, file),
              line: line.trim().slice(0, 140),
              validReturns: contract.validReturns,
              hint: contract.fixHint,
            });
          }
        }
      }
    }
  }

  console.log('契约触达面审计（NO-84b）');
  console.log('='.repeat(70));
  console.log(`治理契约数: ${checkedContracts}；扫描测试文件数: ${checkedFiles}`);

  if (violations.length > 0) {
    console.error(`\n过期契约桩: ${violations.length} 处`);
    for (const v of violations) {
      console.error(`  [${v.contract}] ${v.file}`);
      console.error(`      ${v.line}`);
      console.error(`      合法返回: ${v.validReturns.join(' | ')}`);
      console.error(`      ${v.hint}`);
    }
    process.exit(1);
  }
  console.log('\n[audit-contract-touchpoints] 通过：所有受治理契约的测试桩与现行词表一致。');
  process.exit(0);
}

main();
