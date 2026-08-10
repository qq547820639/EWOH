/* Task 1 / P0：benchmark-scheduler.ts --matrix 单元验证（快速：仅 sizes 10/100）。
 *
 * 断言 matrix 模式对每个 size 报告 wallMs / peakHeapMb / candidateCount /
 * assignmentRate / solverStatus，且候选数与 (tasks × persons × devices) 一致
 * （验证 staged pipeline 的 candidateCount 语义在 benchmark 负载下保持可比）。
 * 通过子进程运行脚本（真实 CLI 路径），OOM 时如实报告 solverStatus=OOM。
 */
/// <reference types="jest" />
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.setTimeout(180_000);

describe('benchmark-scheduler.ts --matrix', () => {
  it('sizes [10,100] 运行并报告 wallMs/peakHeapMb/candidateCount/assignmentRate/solverStatus', () => {
    const outFile = path.join(os.tmpdir(), `sched-bench-${process.pid}-${Date.now()}.json`);
    const script = path.resolve(__dirname, '../../../../scripts/benchmark-scheduler.ts');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: '{"module":"CommonJS","moduleResolution":"node"}',
    };
    const stdout = execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        script,
        '--matrix',
        '--sizes',
        '10,100',
        '--seed',
        '20260810',
        '--out',
        outFile,
      ],
      { env, stdio: 'pipe', cwd: path.resolve(__dirname, '../../../../') },
    );
    expect(fs.existsSync(outFile)).toBe(true);
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      mode?: string;
      results?: Array<{
        tasks: number;
        persons: number;
        devices: number;
        wallMs: number;
        peakHeapMb: number;
        candidateCount: number;
        assignmentRate: number;
        solverStatus: string;
      }>;
    };
    fs.rmSync(outFile, { force: true });
    expect(stdout.length).toBeGreaterThan(0);
    expect(report.mode).toBe('matrix');
    expect(Array.isArray(report.results)).toBe(true);
    const tasksSeen = (report.results ?? []).map((r) => r.tasks);
    expect(tasksSeen).toContain(10);
    expect(tasksSeen).toContain(100);
    for (const r of report.results ?? []) {
      expect(typeof r.wallMs).toBe('number');
      expect(r.wallMs).toBeGreaterThan(0);
      expect(typeof r.peakHeapMb).toBe('number');
      expect(r.peakHeapMb).toBeGreaterThan(0);
      expect(typeof r.candidateCount).toBe('number');
      expect(r.candidateCount).toBeGreaterThan(0);
      expect(typeof r.assignmentRate).toBe('number');
      expect(r.assignmentRate).toBeGreaterThan(0);
      expect(typeof r.solverStatus).toBe('string');
      expect(r.solverStatus).not.toBe('OOM');
      // benchmark 负载下 stationOptions=1（task.stationId），候选数 = 任务×人员×设备。
      expect(r.candidateCount).toBe(r.tasks * r.persons * r.devices);
    }
  });
});
