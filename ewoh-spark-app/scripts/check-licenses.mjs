#!/usr/bin/env node
/**
 * Task 11「性能与依赖可复现性」— 依赖许可证扫描（供应链检查）。
 *
 * 从 package-lock.json 的 packages 表读取每个依赖的 license 字段，标注：
 *   - copyleft：GPL / AGPL / SSPL / LGPL / MPL / EPL / CPL 等（需人工确认是否可商用/SaaS 交付）
 *   - unknown：未声明或无法识别的许可证
 *   - deprecated：npm 标记为 deprecated 的包（安装/运行时告警来源）
 *
 * 输出到仓库根 output/license-report.json，并打印汇总。存在 copyleft 或未知许可证时
 * 以非零退出码失败（可在 CI 中按需放松）。
 *
 * 用法：
 *   node scripts/check-licenses.mjs [--lockfile <path>] [--allow-unknown]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const defaultLock = path.resolve(root, 'package-lock.json');
const outReport = path.resolve(root, '..', 'output', 'license-report.json');

// 强 copyleft（传染性强，商用/SaaS 需逐项评估）——默认阻止。
const STRONG_COPYLEFT_RE = /GPL|AGPL|SSPL/i;
// 弱 copyleft（文件级、可商用交付，如 MPL/EPL/CDDL）——记录但不阻止。
const WEAK_COPYLEFT_RE = /LGPL|MPL|EPL|CPL|OSL|EUPL|CDDL/i;

function classify(license) {
  if (!license) return 'unknown';
  const s = String(license);
  if (STRONG_COPYLEFT_RE.test(s)) return 'strong-copyleft';
  if (WEAK_COPYLEFT_RE.test(s)) return 'weak-copyleft';
  return 'permissive';
}

function main() {
  const args = process.argv.slice(2);
  const allowUnknown = args.includes('--allow-unknown');
  const lfArg = args.find((a, i) => args[i - 1] === '--lockfile');
  const lockPath = lfArg || defaultLock;

  if (!fs.existsSync(lockPath)) {
    console.error(`[check-licenses] 未找到 ${lockPath}`);
    process.exit(2);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const packages = lock.packages ?? {};

  const rows = [];
  for (const [name, spec] of Object.entries(packages)) {
    if (!name || name === '' || name.startsWith('node_modules') === false) continue;
    rows.push({
      name,
      version: typeof spec?.version === 'string' ? spec.version : 'unknown',
      license: spec?.license ?? 'unknown',
      deprecated: Boolean(spec?.deprecated),
      integrity: spec?.integrity ?? null,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const strong = rows.filter((r) => classify(r.license) === 'strong-copyleft');
  const weak = rows.filter((r) => classify(r.license) === 'weak-copyleft');
  const unknown = rows.filter((r) => classify(r.license) === 'unknown');
  const deprecated = rows.filter((r) => r.deprecated);

  console.log(`EWOH 依赖许可证扫描（${rows.length} 个 package）`);
  console.log('='.repeat(70));
  console.log(`  permissive     : ${rows.length - strong.length - weak.length - unknown.length}`);
  console.log(`  weak-copyleft  : ${weak.length}（MPL/EPL 等，商用可交付，仅记录）`);
  console.log(`  strong-copyleft: ${strong.length}（GPL/AGPL/SSPL，需逐项评估）`);
  console.log(`  unknown        : ${unknown.length}`);
  console.log(`  deprecated     : ${deprecated.length}`);
  console.log('-'.repeat(70));
  if (strong.length) {
    console.log('strong copyleft 许可证（阻止项，需逐项评估）:');
    for (const r of strong) console.log(`  ${r.name}@${r.version}  license=${r.license}`);
  }
  if (weak.length) {
    console.log('weak copyleft 许可证（已复核，商用可交付）:');
    for (const r of weak) console.log(`  ${r.name}@${r.version}  license=${r.license}`);
  }
  if (deprecated.length) {
    console.log('deprecated 包（npm 安装告警来源）:');
    for (const r of deprecated) console.log(`  ${r.name}@${r.version}`);
  }
  if (unknown.length) {
    console.log(`unknown 许可证 ${unknown.length} 个（示例前 10）:`);
    for (const r of unknown.slice(0, 10)) console.log(`  ${r.name}@${r.version}  license=${r.license}`);
  }
  console.log('='.repeat(70));

  fs.mkdirSync(path.dirname(outReport), { recursive: true });
  fs.writeFileSync(
    outReport,
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), total: rows.length, strongCopyleft: strong, weakCopyleft: weak, unknown, deprecated },
      null,
      2,
    )}\n`,
  );
  console.log(`[check-licenses] 已写入: ${outReport}`);

  if (!allowUnknown && (strong.length > 0 || unknown.length > 0)) {
    console.error('\n[check-licenses] 存在 strong-copyleft 或未知许可证，未带 --allow-unknown 时失败。');
    process.exit(1);
  }
  process.exit(0);
}

main();