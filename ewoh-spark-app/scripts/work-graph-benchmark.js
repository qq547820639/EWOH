#!/usr/bin/env node
/**
 * WorkGraph 构建性能基线脚本。
 *
 * 用法：node scripts/work-graph-benchmark.js
 * 实测 buildGraphLayout（纯函数，不依赖浏览器）在 500 / 1000 / 2000 节点下的耗时，
 * 结果输出到 ../output/work-graph-benchmark.json（仓库根 output 目录）。
 *
 * 说明：graphLayout.ts 为 TypeScript 源码，此处用 TypeScript 编译器 API 原地转译为
 * CommonJS 后直接调用，避免引入 ts-node 的配置依赖。
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const graphLayoutPath = path.join(root, 'client/src/pages/WorkOrchestration/graphLayout.ts');
const tmpPath = path.join(root, 'scripts/.graphLayout.benchmark.cjs');

/** 由 main() 在转译后赋值，供 bench 使用。 */
let buildGraphLayout;

function makeItems(n) {
  const items = [];
  for (let i = 0; i < n; i += 1) {
    items.push({
      id: `W${i}`,
      title: `work item ${i}`,
      type: i % 3 === 0 ? 'gate' : 'wave',
      status: i % 4 === 0 ? 'Passed' : 'Pending',
      owner: `AG-${i % 20}`,
    });
  }
  return items;
}

function makeEdges(n) {
  const edges = [];
  for (let i = 1; i < n; i += 1) {
    edges.push({ id: `E-${i}`, from: `W${i - 1}`, to: `W${i}`, edgeType: 'depends' });
  }
  return edges;
}

function bench(size) {
  const items = makeItems(size);
  const edges = makeEdges(size);
  const runs = 7;
  const samples = [];
  for (let r = 0; r < runs; r += 1) {
    const t0 = process.hrtime.bigint();
    const layout = buildGraphLayout(items, edges, 'all');
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
    if (layout.nodes.length !== size) {
      throw new Error(`layout mismatch for size ${size}: ${layout.nodes.length}`);
    }
  }
  samples.sort((a, b) => a - b);
  return {
    nodes: size,
    edges: edges.length,
    runs,
    medianMs: samples[Math.floor(samples.length / 2)],
    minMs: samples[0],
    maxMs: samples[samples.length - 1],
    samplesMs: samples.map((s) => Number(s.toFixed(3))),
  };
}

function main() {
  const source = fs.readFileSync(graphLayoutPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  fs.writeFileSync(tmpPath, output);
  try {
    // eslint-disable-next-line global-require
    buildGraphLayout = require(tmpPath).buildGraphLayout;
    const report = {
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform },
      threshold: { windowThreshold: 300 },
      results: [500, 1000, 2000].map(bench),
    };
    const outDir = path.resolve(root, '..', 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'work-graph-benchmark.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nWrote ${outFile}`);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

main();