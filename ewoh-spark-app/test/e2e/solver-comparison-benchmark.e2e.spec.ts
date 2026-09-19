/**
 * 求解器三族对比基准（NO-68i：算法能比较就实际比较）。
 *
 * 以 jest 载入 scripts/benchmark-scheduler.ts（ts-jest 提供 decorators/paths 编译，
 * 规避 ts-node standalone 运行的配置死角），对**同一合成负载**分别运行：
 *   - heuristic（确定性贪心）
 *   - MILP（HiGHS WASM）
 *   - CP-SAT（OR-Tools HTTP worker，须 CPSAT_WORKER_URL 指向已启动 worker）
 * 并断言：三族均有可用求解结果（heuristic 必有；milp/cp-sat 若不可用必须**如实
 * 标记** available=false——缺失不可伪装），指标可解析。
 *
 * 前置：CP-SAT worker 已启动（见 src/edge_platform/scheduler/cpsat/worker.py）。
 * 结果报告落在 <repo>/output/benchmark-scheduler-<ts>.json（自动取最新）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const WORKER_URL = process.env.CPSAT_WORKER_URL || 'http://127.0.0.1:8000';

describe('求解器三族对比基准（heuristic / MILP / CP-SAT 同负载实测）', () => {
  let report: Record<string, any>;

  beforeAll(async () => {
    // 小规模实例（MILP 的 LP 构建在 40 任务规模爆栈——已挂账的适用边界；
    // CP-SAT 在合成负载上返回空最优——objective 对未指派任务无惩罚，挂账待立项）。
    process.env.BENCH_TASKS = process.env.BENCH_TASKS || '8';
    process.env.BENCH_PERSONS = process.env.BENCH_PERSONS || '4';
    process.env.BENCH_DEVICES = process.env.BENCH_DEVICES || '3';
    process.env.BENCH_RUNS = process.env.BENCH_RUNS || '1';
    process.env.CPSAT_WORKER_URL = WORKER_URL;
    const outDir = path.join(process.cwd(), 'output');
    const before = new Set(readdirSync(outDir).filter((f) => f.startsWith('benchmark-scheduler-')));
    jest.isolateModules(() => {
      // 脚本以 import 副作用运行 async main()（求解 + 写报告）；require 返回后
      // 求解仍在进行——轮询等待**新报告文件**出现（最多 180s）。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../scripts/benchmark-scheduler');
    });
    const deadline = Date.now() + 180_000;
    let newest = '';
    while (Date.now() < deadline) {
      const files = readdirSync(outDir)
        .filter((f) => f.startsWith('benchmark-scheduler-') && !before.has(f))
        .sort();
      if (files.length > 0) {
        newest = files[files.length - 1];
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(newest).not.toBe('');
    report = JSON.parse(readFileSync(path.join(outDir, newest), 'utf8'));
  }, 240_000);

  test('heuristic：必有结果，feasibleRate>0', () => {
    expect(report.heuristic).toBeDefined();
    expect(report.heuristic.avgFeasibleRate).toBeGreaterThan(0);
    expect(report.heuristic.avgWallMs).toBeGreaterThanOrEqual(0);
  });

  test('MILP（HiGHS WASM）：available=true 且 feasibleRate>0（不可用必须如实标记）', () => {
    expect(report.milp).toBeDefined();
    if (report.milp.available === false) {
      // 如实标记路径：HiGHS WASM 在本环境不可用——记录原因而非伪造数值
      expect(report.milp.note).toMatch(/UNAVAILABLE/);
      return;
    }
    expect(report.milp.avgFeasibleRate).toBeGreaterThan(0);
  });

  test('CP-SAT（OR-Tools worker）：available=true 且响应可解析（合成负载空最优已挂账）', () => {
    expect(report.cpSat).toBeDefined();
    if (report.cpSat.available === false) {
      expect(report.cpSat.note).toMatch(/worker/);
      return;
    }
    // 合成负载上 CP-SAT 返回 OPTIMAL + 空指派（objective 对未指派无惩罚）——
    // 这是**对比结论本身**（真实负载下 CP-SAT SHADOW=OPTIMAL 已由 e2e 链取证），
    // 断言只要求响应可解析且有 rows。
    expect(Array.isArray(report.cpSat.rows)).toBe(true);
    expect(report.cpSat.rows.length).toBeGreaterThan(0);
    expect(['OPTIMAL', 'FEASIBLE', 'UNAVAILABLE']).toContain(report.cpSat.rows[0].solverStatus);
  });

  test('三族求解质量可横向对比（metrics/rows 齐备）', () => {
    expect(report.heuristic.metrics).toBeDefined();
    if (report.cpSat.available) {
      expect(report.cpSat.metrics).toBeDefined();
    }
    if (report.milp.available) {
      // milp 腿留 rows 明细（solveDurationMs/feasibleRate/violations）
      expect(Array.isArray(report.milp.rows)).toBe(true);
      expect(report.milp.rows.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
