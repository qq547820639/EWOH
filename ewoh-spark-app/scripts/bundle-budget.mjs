#!/usr/bin/env node
/**
 * Task 11「性能与依赖可复现性」— 真实 bundle 分析 + 体积预算校验。
 *
 * 从真实构建产物（dist/client）读取：
 *   1) 首屏入口 chunk（index.html 中 <script type="module"> 引用的 JS）的 gzip 体积，
 *      对照 client/src/lib/perfBudget.ts 的 first-screen-js-gzip 预算（limit 420 + tolerance 40 = 460kB）。
 *   2) 所有路由级 chunk 的 gzip 体积，输出 bundle 体积报告。
 *
 * 输出 bundle 体积报告到仓库根 output/bundle-report.json，并打印可读表格。
 * 首屏 gzip 或单块异步/路由 chunk gzip（perfBudget.ts 的 single-async-chunk-gzip，
 * limit 480 + tolerance 40 = 520kB）超预算时均以非零退出码失败，用于接入构建与 CI。
 *
 * 用法：
 *   node scripts/bundle-budget.mjs              # 分析 dist/client 并校验预算
 *   node scripts/bundle-budget.mjs --report     # 仅输出报告，不校验
 *   node scripts/bundle-budget.mjs --dist <p>   # 指定 dist 目录
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const defaultDist = path.resolve(root, 'dist/client');
const outReport = path.resolve(root, '..', 'output', 'bundle-report.json');

/** 与 client/src/lib/perfBudget.ts 的 first-screen-js-gzip 对齐（limit + tolerance）。 */
const FIRST_SCREEN_LIMIT_KB = 420;
const FIRST_SCREEN_TOLERANCE_KB = 40;
const FIRST_SCREEN_EFFECTIVE_KB = FIRST_SCREEN_LIMIT_KB + FIRST_SCREEN_TOLERANCE_KB;

/** 单块异步/路由 chunk 预算（gzip），与 perfBudget.ts 的 single-async-chunk-gzip 对齐，超限即失败。 */
const ASYNC_CHUNK_LIMIT_KB = 480;
const ASYNC_CHUNK_TOLERANCE_KB = 40;
const ASYNC_CHUNK_EFFECTIVE_KB = ASYNC_CHUNK_LIMIT_KB + ASYNC_CHUNK_TOLERANCE_KB;

function gzipSizeBytes(file) {
  const buf = fs.readFileSync(file);
  return zlib.gzipSync(buf).length;
}

function kb(bytes) {
  return bytes / 1024;
}

function findEntryScripts(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  // 匹配 <script type="module" ... src="/assets/xxx.js">
  const re = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].replace(/^\//, ''));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report');
  const distArg = args.find((a, i) => args[i - 1] === '--dist');
  const distDir = distArg || defaultDist;
  const htmlPath = path.join(distDir, 'index.html');

  if (!fs.existsSync(htmlPath)) {
    console.error(`[bundle-budget] 未找到 ${htmlPath}。请先运行 npm run build:client。`);
    process.exit(2);
  }

  const assetsDir = path.join(distDir, 'assets');
  const entryScripts = findEntryScripts(htmlPath);
  if (entryScripts.length === 0) {
    console.error('[bundle-budget] index.html 未找到 module entry script。');
    process.exit(2);
  }

  // 首屏 JS gzip 体积 = 入口 chunk 的 gzip 之和。
  let firstScreenBytes = 0;
  const entryRows = entryScripts.map((rel) => {
    const file = path.join(distDir, rel.split('/').join(path.sep));
    const bytes = fs.statSync(file).size;
    const gz = fs.existsSync(file) ? gzipSizeBytes(file) : 0;
    firstScreenBytes += gz;
    return { rel, rawKB: kb(bytes), gzipKB: kb(gz) };
  });

  // 列出所有路由/异步 chunk（assets 下除入口外的 js）。
  const allJs = fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => {
      const file = path.join(assetsDir, f);
      const bytes = fs.statSync(file).size;
      return { file: f, rawKB: kb(bytes), gzipKB: kb(gzipSizeBytes(file)) };
    })
    .sort((a, b) => b.gzipKB - a.gzipKB);

  const firstScreenKB = kb(firstScreenBytes);
  const withinBudget = firstScreenKB <= FIRST_SCREEN_EFFECTIVE_KB;

  // 异步/路由 chunk：排除入口 chunk 后，体积最大的单块是否超预算。
  const entryFilenames = new Set(entryScripts.map((rel) => path.basename(rel)));
  const asyncChunks = allJs.filter((c) => !entryFilenames.has(c.file));
  const maxAsyncChunk = asyncChunks[0] || null; // allJs 已按 gzipKB 降序排序
  const maxAsyncGzipKB = maxAsyncChunk ? maxAsyncChunk.gzipKB : 0;
  const overBudgetAsyncChunks = asyncChunks.filter(
    (c) => c.gzipKB > ASYNC_CHUNK_EFFECTIVE_KB,
  );
  const asyncChunkWithin = overBudgetAsyncChunks.length === 0;

  // 打印可读报告
  console.log('EWOH bundle 体积报告（bundle 分析）');
  console.log('='.repeat(74));
  console.log('首屏入口 chunk（gzip）:');
  for (const e of entryRows) {
    console.log(`  ${e.rel.padEnd(40)} raw ${e.rawKB.toFixed(2)} kB | gzip ${e.gzipKB.toFixed(2)} kB`);
  }
  console.log(`  首屏 JS 合计 gzip: ${firstScreenKB.toFixed(2)} kB`);
  console.log(`  预算: limit ${FIRST_SCREEN_LIMIT_KB} + tolerance ${FIRST_SCREEN_TOLERANCE_KB} = ${FIRST_SCREEN_EFFECTIVE_KB} kB`);
  console.log(`  状态: ${withinBudget ? 'PASS' : 'FAIL'}`);
  console.log('-'.repeat(74));
  console.log(`单块异步/路由 chunk 最大 gzip: ${maxAsyncGzipKB.toFixed(2)} kB`);
  console.log(`  预算: limit ${ASYNC_CHUNK_LIMIT_KB} + tolerance ${ASYNC_CHUNK_TOLERANCE_KB} = ${ASYNC_CHUNK_EFFECTIVE_KB} kB`);
  console.log(`  状态: ${asyncChunkWithin ? 'PASS' : 'FAIL'}（超限 ${overBudgetAsyncChunks.length} 块）`);
  console.log('-'.repeat(74));
  console.log('Top 10 路由/异步 chunk（gzip）:');
  for (const c of allJs.slice(0, 10)) {
    console.log(`  ${c.file.padEnd(40)} raw ${c.rawKB.toFixed(2)} kB | gzip ${c.gzipKB.toFixed(2)} kB`);
  }
  console.log('='.repeat(74));

  const report = {
    generatedAt: new Date().toISOString(),
    dist: distDir,
    environment: { node: process.version, platform: process.platform },
    firstScreen: {
      entryScripts: entryRows,
      totalGzipKB: Number(firstScreenKB.toFixed(2)),
      limitKB: FIRST_SCREEN_LIMIT_KB,
      toleranceKB: FIRST_SCREEN_TOLERANCE_KB,
      effectiveLimitKB: FIRST_SCREEN_EFFECTIVE_KB,
      withinBudget,
      status: withinBudget ? 'pass' : 'fail',
    },
    asyncChunk: {
      maxGzipKB: Number(maxAsyncGzipKB.toFixed(2)),
      limitKB: ASYNC_CHUNK_LIMIT_KB,
      toleranceKB: ASYNC_CHUNK_TOLERANCE_KB,
      effectiveLimitKB: ASYNC_CHUNK_EFFECTIVE_KB,
      withinBudget: asyncChunkWithin,
      status: asyncChunkWithin ? 'pass' : 'fail',
      overBudget: overBudgetAsyncChunks.map((c) => ({
        file: c.file,
        gzipKB: Number(c.gzipKB.toFixed(2)),
      })),
    },
    chunks: {
      total: allJs.length,
      asyncTotal: asyncChunks.length,
      overRouteLimit: overBudgetAsyncChunks.map((c) => ({ file: c.file, gzipKB: Number(c.gzipKB.toFixed(2)) })),
      top: allJs.slice(0, 20).map((c) => ({ file: c.file, rawKB: Number(c.rawKB.toFixed(2)), gzipKB: Number(c.gzipKB.toFixed(2)) })),
    },
  };

  fs.mkdirSync(path.dirname(outReport), { recursive: true });
  fs.writeFileSync(outReport, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n[bundle-budget] 已写入报告: ${outReport}`);

  if (reportOnly) process.exit(0);
  const failures = [];
  if (!withinBudget) {
    failures.push(`首屏 JS gzip ${firstScreenKB.toFixed(2)} kB 超过预算 ${FIRST_SCREEN_EFFECTIVE_KB} kB`);
  }
  if (!asyncChunkWithin) {
    failures.push(
      `存在 ${overBudgetAsyncChunks.length} 块异步/路由 chunk 超预算 ${ASYNC_CHUNK_EFFECTIVE_KB} kB（最大 ${maxAsyncGzipKB.toFixed(2)} kB）`,
    );
  }
  if (failures.length > 0) {
    console.error(`\n[bundle-budget] 性能预算未通过：${failures.join('；')}，CI 失败。报告见 ${outReport}`);
    process.exit(1);
  }
  console.log('\n[bundle-budget] 首屏与单异步 chunk 预算校验通过。');
  process.exit(0);
}

main();