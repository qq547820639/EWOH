/// <reference types="jest" />
/* 门禁决定文件损坏回归：gate-decisions.json / gate-decision-history.json
 * JSON 解析失败时，原实现 catch 后按"空数组"继续，下一次决定写入会把既有
 * 决定集 / 审计历史整份静默覆盖（不可逆丢失，且历史文件是撤销恢复的唯一
 * 事实源）。修复后必须 fail-fast（500），损坏文件保持原样等待运维修复。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InternalServerErrorException } from '@nestjs/common';
import { WorkOrchestrationService } from '../work-orchestration.service';

describe('损坏的 gate 决定文件不得被静默覆盖', () => {
  let artifactsDir: string;
  let service: WorkOrchestrationService;
  const actor = { userId: 'u1', primaryOrgId: 'org-1' };

  const decisionsFile = () => join(artifactsDir, 'work', 'gate-decisions.json');
  const historyFile = () =>
    join(artifactsDir, 'work', 'gate-decision-history.json');

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'ewoh-gate-'));
    process.env.EWOH_WORK_ARTIFACTS_DIR = artifactsDir;
    process.env.EWOH_WORK_WRITABLE = 'true';
    service = new WorkOrchestrationService(undefined);
    // 注入 indexer / gate engine stub：被测对象只是 decision/history 文件语义。
    (service as unknown as { indexerModule: unknown }).indexerModule = {
      findArtifactsDir: () => artifactsDir,
      indexWorkGraph: () => ({
        gates: [],
        items: [],
        edges: [],
        actors: [],
        artifacts: [],
        evidence: [],
        risks: [],
        decisions: [],
        resources: [],
        handoffs: [],
      }),
    };
    (service as unknown as { gateEngineModule: unknown }).gateEngineModule = {
      calculate: () => [
        { gateId: 'G-1', title: 'g', calculatedStatus: 'passed', baseStatus: 'passed' },
      ],
    };
  });

  afterEach(() => {
    delete process.env.EWOH_WORK_ARTIFACTS_DIR;
    delete process.env.EWOH_WORK_WRITABLE;
  });

  it('history 文件损坏：revokeGateDecision 抛 500 且不改写 history', () => {
    mkdirSync(dirname(historyFile()), { recursive: true });
    writeFileSync(
      decisionsFile(),
      JSON.stringify([
        { gateId: 'G-1', decision: 'approved', approver: 'a', decidedAt: 't' },
      ]),
      'utf8',
    );
    const corrupt = '{"not-json"...';
    writeFileSync(historyFile(), corrupt, 'utf8');
    expect(() => service.revokeGateDecision('G-1', {}, actor)).toThrow(
      InternalServerErrorException,
    );
    expect(existsSync(historyFile())).toBe(true);
    expect(readFileSync(historyFile(), 'utf8')).toBe(corrupt);
  });

  it('decisions 文件损坏：recordGateDecision 抛 500 且不改写 decisions', () => {
    mkdirSync(dirname(decisionsFile()), { recursive: true });
    const corrupt = '[{broken';
    writeFileSync(decisionsFile(), corrupt, 'utf8');
    expect(() =>
      service.recordGateDecision('G-1', { decision: 'approved' }, actor),
    ).toThrow(InternalServerErrorException);
    expect(readFileSync(decisionsFile(), 'utf8')).toBe(corrupt);
  });
});
