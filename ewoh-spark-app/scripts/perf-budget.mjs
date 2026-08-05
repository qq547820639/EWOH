#!/usr/bin/env node
/**
 * UX-008「性能工程」— 性能预算表与 CI 校验脚本。
 *
 * 定义 EWOH 前端性能预算（覆盖 spec UX-008 十个维度），从 output/perf-bench.json
 * （由 scripts/perf-bench.mjs 产出）读取可实测项，超出预算时以非零退出码失败，
 * 便于接入 CI。
 *
 * 用法：
 *   node scripts/perf-budget.mjs                 # 读取默认 output/perf-bench.json
 *   node scripts/perf-budget.mjs --measured <p>  # 指定测量结果文件
 *   node scripts/perf-budget.mjs --table         # 仅输出预算表，不做校验
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const defaultMeasured = path.resolve(root, '..', 'output', 'perf-bench.json');

/** 预算表（与 client/src/lib/perfBudget.ts 语义保持一致）。 */
const BUDGETS = [
  { key: 'first-screen-js-gzip', category: '首屏资源', label: 'JS 首屏体积 gzip', unit: 'kb', limit: 420, tolerance: 40 },
  { key: 'single-async-chunk-gzip', category: '首屏资源', label: '单异步 chunk gzip', unit: 'kb', limit: 480, tolerance: 40 },
  { key: 'first-interactive-time', category: '首屏资源', label: '首屏交互 TTI', unit: 'ms', limit: 3500, tolerance: 500 },
  { key: 'route-switch-interactive', category: '路由切换', label: '路由切换至可交互', unit: 'ms', limit: 300, tolerance: 80 },
  { key: 'large-table-5000-render', category: '大表格', label: '5000 行首屏渲染', unit: 'ms', limit: 500, tolerance: 100 },
  { key: 'work-graph-3000-layout', category: 'Work Graph', label: '3000 节点布局', unit: 'ms', limit: 450, tolerance: 80 },
  { key: 'world-replay-frame', category: '世界回放', label: '单帧渲染', unit: 'ms', limit: 16.7, tolerance: 3 },
  { key: 'offline-queue-flush-100', category: '离线队列', label: 'flush 100 条', unit: 'ms', limit: 200, tolerance: 50 },
  { key: 'image-attachment-process', category: '图片处理', label: '附件处理', unit: 'ms', limit: 300, tolerance: 80 },
  { key: 'api-p95', category: 'API', label: 'p95 响应', unit: 'ms', limit: 800, tolerance: 200 },
  { key: 'slow-query', category: '慢查询', label: '慢查询耗时', unit: 'ms', limit: 1000, tolerance: 200 },
  { key: 'low-end-tablet-frame', category: '低端平板', label: '单帧预算', unit: 'ms', limit: 50, tolerance: 10 },
  { key: 'low-end-tablet-memory-peak', category: '低端平板', label: '内存峰值', unit: 'mb', limit: 400, tolerance: 50 },
];

/** 从 perf-bench.json 提取可实测项，键与 BUDGETS.key 对齐。 */
function extractMeasured(data) {
  const measured = {};
  const graph = data?.results?.graphLayout?.['graph-3000'];
  if (graph && typeof graph.medianMs === 'number') {
    measured['work-graph-3000-layout'] = graph.medianMs;
  }
  if (data?.results?.offlineQueue && typeof data.results.offlineQueue.medianMs === 'number') {
    measured['offline-queue-flush-100'] = data.results.offlineQueue.medianMs;
  }
  return measured;
}

function evaluate(budget, measured) {
  if (measured === undefined || measured === null || !Number.isFinite(measured)) {
    return { ...budget, measured: null, status: 'pending', delta: null };
  }
  const within = measured <= budget.limit + budget.tolerance;
  return {
    ...budget,
    measured,
    delta: measured - budget.limit,
    status: within ? 'pass' : 'fail',
  };
}

function printTable(rows) {
  const fmt = (v) =>
    v === null || v === undefined ? '—' : String(Number(Number(v).toFixed(3)));
  console.log('性能预算表（UX-008）');
  console.log('='.repeat(88));
  console.log(
    `${'类别'.padEnd(10)}${'预算项'.padEnd(16)}${'上限'.padStart(8)}${'容差'.padStart(6)}${'实测'.padStart(10)}${'状态'.padEnd(8)}`,
  );
  console.log('-'.repeat(88));
  for (const row of rows) {
    const statusLabel =
      row.status === 'pass' ? 'PASS' : row.status === 'fail' ? 'FAIL' : 'pending';
    console.log(
      `${row.category.padEnd(10)}${row.label.padEnd(16)}${String(row.limit).padStart(8)}${String(row.tolerance).padStart(6)}${fmt(row.measured).padStart(10)} ${statusLabel.padEnd(8)}`,
    );
  }
  console.log('='.repeat(88));
}

function main() {
  const args = process.argv.slice(2);
  // 无法真实校验的维度（需浏览器/服务/真实设备）在表中标注 pending。
  const tableOnly = args.includes('--table');

  let measured = {};
  if (!tableOnly) {
    const measuredArg = args.find((arg, i) => args[i - 1] === '--measured');
    const measuredPath = measuredArg || defaultMeasured;
    if (fs.existsSync(measuredPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(measuredPath, 'utf8'));
        measured = extractMeasured(data);
      } catch (error) {
        console.error(`无法解析测量文件 ${measuredPath}: ${error.message}`);
        process.exit(2);
      }
    } else if (!measuredArg) {
      console.warn(`未找到 ${measuredPath}，可先运行 node scripts/perf-bench.mjs 生成。`);
    }
  }

  const rows = BUDGETS.map((budget) => evaluate(budget, measured[budget.key]));
  printTable(rows);

  const fail = rows.filter((row) => row.status === 'fail');
  const pass = rows.filter((row) => row.status === 'pass');
  const pending = rows.filter((row) => row.status === 'pending');

  console.log(
    `\n汇总：${rows.length} 项，PASS ${pass.length}，FAIL ${fail.length}，pending ${pending.length}（待真实环境/真实浏览器）。`,
  );

  if (tableOnly) {
    process.exit(0);
  }
  if (fail.length > 0) {
    console.error('\n存在超出预算的项，CI 失败。');
    process.exit(1);
  }
  process.exit(0);
}

main();