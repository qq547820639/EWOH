#!/usr/bin/env node
/**
 * UX-008「性能工程」— 可重复的轻量基准脚本。
 *
 * 在 node 环境实测纯逻辑（不依赖浏览器）:
 *   - graphLayout：buildGraphLayout 在 500 / 1000 / 2000 / 3000 节点下的布局耗时
 *   - progressiveList：progressiveSlice 在大数组下的分片耗时
 *   - offlineQueue：flushPendingQueue 处理 100 条待同步动作的耗时
 *
 * 结果输出到仓库根 output/perf-bench.json，供 scripts/perf-budget.mjs 判定预算。
 * 用法：node scripts/perf-bench.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const outDir = path.resolve(root, '..', 'output');

/** 将 TS 源码转译为 CommonJS 并加载，返回模块导出。 */
function requireTs(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const tmp = path.join(
    root,
    'scripts',
    `.perf-bench.tmp-${path.basename(filePath).replace(/[^a-zA-Z0-9]+/g, '-')}.cjs`,
  );
  fs.writeFileSync(tmp, output);
  try {
    // eslint-disable-next-line global-require
    return require(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function medianMs(runs, fn) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    runs,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    minMs: Number(samples[0].toFixed(3)),
    maxMs: Number(samples[samples.length - 1].toFixed(3)),
  };
}

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

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

async function main() {
  const graphLayout = requireTs(path.join(root, 'client/src/pages/WorkOrchestration/graphLayout.ts'));
  const progressiveList = requireTs(path.join(root, 'client/src/lib/progressiveList.ts'));
  const offlineQueue = requireTs(path.join(root, 'client/src/lib/offlineQueue.ts'));

  // 1) Work Graph 布局：3000 节点预算阈值项。
  const graphResults = {};
  const graphSizes = [500, 1000, 2000, 3000];
  for (const size of graphSizes) {
    const items = makeItems(size);
    const edges = makeEdges(size);
    const layout = graphLayout.buildGraphLayout(items, edges, 'all');
    if (layout.nodes.length !== size) {
      throw new Error(`graph layout mismatch ${size}: ${layout.nodes.length}`);
    }
    graphResults[`graph-${size}`] = {
      nodes: size,
      edges: edges.length,
      ...medianMs(7, () => graphLayout.buildGraphLayout(items, edges, 'all')),
    };
  }

  // 1b) W3.4 因果控制台交互纯函数：3000 节点规模下的性能基线。
  const graph3000 = graphResults['graph-3000'];
  const items3000 = makeItems(3000);
  const edges3000 = makeEdges(3000);
  const layout3000 = graphLayout.buildGraphLayout(items3000, edges3000, 'all');
  const traceGraph = {
    nodes: layout3000.nodes,
    edges: edges3000,
    items: items3000,
  };
  graphResults['graph-3000-trace-upstream'] = {
    nodes: 3000,
    ...medianMs(7, () => graphLayout.traceUpstream(edges3000, 'W1500')),
  };
  graphResults['graph-3000-trace-downstream'] = {
    nodes: 3000,
    ...medianMs(7, () => graphLayout.traceDownstream(edges3000, 'W1500')),
  };
  graphResults['graph-3000-exception-backflow'] = {
    nodes: 3000,
    ...medianMs(7, () => graphLayout.exceptionBackflowNodes(layout3000.nodes, edges3000)),
  };
  graphResults['graph-3000-stage-collapse'] = {
    nodes: 3000,
    ...medianMs(7, () => graphLayout.groupStagesByWave(items3000, 20)),
  };
  void graph3000;
  void traceGraph;

  // 2) 渐进式列表：大数组分片。
  const bigArray = Array.from({ length: 100000 }, (_, index) => index);
  const progressiveResult = {
    arraySize: bigArray.length,
    slicePerCall: 50,
    ...medianMs(200, () => progressiveList.progressiveSlice(bigArray, 50)),
  };

  // 3) 移动端离线队列 flush：100 条。
  const queueCount = 100;
  const storage = makeMemoryStorage();
  const actions = [];
  for (let i = 0; i < queueCount; i += 1) {
    const action = {
      id: `A-${i}`,
      type: 'transition',
      orderId: `O-${i}`,
      stepId: 'STEP-1',
      action: 'transition',
      body: { stepStatus: 'completed' },
      queuedAt: new Date().toISOString(),
      status: 'local',
    };
    actions.push(action);
    offlineQueue.appendPendingAction(action, storage);
  }
  const syncOne = async () => {};
  const offlineSamples = [];
  const offlineRuns = 5;
  for (let i = 0; i < offlineRuns; i += 1) {
    const t0 = process.hrtime.bigint();
    await offlineQueue.flushPendingQueue(syncOne, actions, storage);
    const t1 = process.hrtime.bigint();
    offlineSamples.push(Number(t1 - t0) / 1e6);
  }
  offlineSamples.sort((a, b) => a - b);
  const offlineResult = {
    queueCount,
    runs: offlineRuns,
    medianMs: Number(offlineSamples[Math.floor(offlineSamples.length / 2)].toFixed(3)),
    minMs: Number(offlineSamples[0].toFixed(3)),
    maxMs: Number(offlineSamples[offlineSamples.length - 1].toFixed(3)),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    results: {
      graphLayout: graphResults,
      progressiveList: progressiveResult,
      offlineQueue: offlineResult,
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'perf-bench.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});