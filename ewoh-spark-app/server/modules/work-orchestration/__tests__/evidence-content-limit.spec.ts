/// <reference types="jest" />
/* 证据内容读取 limit 回归：?limit=abc → NaN 必须按缺省 200 处理。
 * 原实现 NaN 一路穿透 Math.min/Math.max，slice(0, NaN) 返回空数组——
 * 证据内容被静默伪造成"空文件"。 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkOrchestrationService } from '../work-orchestration.service';

describe('getEvidenceContent：非法 limit 不得把内容静默变空', () => {
  let artifactsDir: string;
  let service: WorkOrchestrationService;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'ewoh-evidence-'));
    const evidenceFile = join(artifactsDir, 'work', 'evidence', 'e1.txt');
    mkdirSync(dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, 'line-1\nline-2\nline-3\n', 'utf8');
    process.env.EWOH_WORK_ARTIFACTS_DIR = artifactsDir;
    service = new WorkOrchestrationService(undefined);
    // 注入 indexer stub：getEvidenceContent 只消费 graph.evidence。
    (service as unknown as { indexerModule: unknown }).indexerModule = {
      findArtifactsDir: () => artifactsDir,
      indexWorkGraph: () => ({
        evidence: [
          {
            evidenceId: 'EVD-1',
            workItemId: 'T-1',
            kind: 'output',
            path: '.codex/artifacts/work/evidence/e1.txt',
            checksum: 'x',
          },
        ],
      }),
    };
  });

  afterEach(() => {
    delete process.env.EWOH_WORK_ARTIFACTS_DIR;
  });

  it('limit=NaN（如 ?limit=abc）→ 按缺省 200 返回全部内容', () => {
    const result = service.getEvidenceContent('EVD-1', Number('abc'));
    expect(result.content).toContain('line-1');
    expect(result.content).toContain('line-3');
    expect(result.lines).toBe(4); // 3 行 + 尾换行
    expect(result.truncated).toBe(false);
  });

  it('合法 limit 仍按原语义截断', () => {
    const result = service.getEvidenceContent('EVD-1', 2);
    expect(result.content).toBe('line-1\nline-2');
    expect(result.truncated).toBe(true);
  });
});
