import fs from 'node:fs';
import path from 'node:path';
import { buildManifest } from '../../../scripts/truth-manifest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'truth-manifest.js');
const nodeBin = process.execPath;
const spawn = require('node:child_process').spawn;

function runCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const cp = spawn(nodeBin, [SCRIPT, ...args], { cwd: REPO_ROOT, stdio: 'ignore' });
    cp.on('exit', (code: number) => resolve(code));
    cp.on('error', () => resolve(-1));
  });
}

describe('truth-manifest (single source of truth)', () => {
  it('builds an evidence manifest with all required fields', () => {
    const m = buildManifest();
    expect(m.evaluatedCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof m.branch).toBe('string');
    expect(m.buildVersion).toBeTruthy();
    expect(m.environmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof m.dependencyVersions.node).toBe('string');
    expect(typeof m.testStartedAt).toBe('string');
    expect(typeof m.testFinishedAt).toBe('string');
    expect(typeof m.verifier).toBe('string');
    expect(m.workflowRunId).toBeNull();
    expect(m.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(m.expiration.policy).toBeTruthy();
  });

  it(
    'fails --check when the manifest drifts (version tampered)',
    async () => {
    const dir = path.join(REPO_ROOT, 'output', '_truth-manifest-drift');
    const outPath = path.join(dir, 'evidence-manifest.json');
    fs.mkdirSync(dir, { recursive: true });

    // Baseline via CLI write, then CLI check must be clean.
    const writeCode = await runCli(['--out', outPath]);
    expect(writeCode).toBe(0);
    const okCode = await runCli(['--check', '--out', outPath]);
    expect(okCode).toBe(0);

    // Drift: tamper the buildVersion — CLI --check must now fail.
    const json = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    json.buildVersion = '9.9.9-drifted';
    fs.writeFileSync(outPath, JSON.stringify(json, null, 2) + '\n');
    const failCode = await runCli(['--check', '--out', outPath]);
    expect(failCode).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
    },
    120000,
  );
});
