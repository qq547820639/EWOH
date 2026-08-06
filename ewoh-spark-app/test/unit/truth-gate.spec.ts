import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  STATUS,
  computeProductionReady,
  isPass,
  isStale,
} from '../../../scripts/truth-status';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'truth-gate.js');
const nodeBin = process.execPath;

function runCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const cp = spawn(nodeBin, [GATE_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    cp.on('exit', (code: number) => resolve(code));
    cp.on('error', () => resolve(-1));
  });
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function gate(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, status, ...overrides };
}

describe('truth-status (four-state machine-verifiable release status)', () => {
  it('exposes exactly the four distinct statuses', () => {
    expect(STATUS).toEqual({
      NOT_RUN: 'NOT_RUN',
      FAILED: 'FAILED',
      BLOCKED_BY_ENVIRONMENT: 'BLOCKED_BY_ENVIRONMENT',
      SUCCEEDED: 'SUCCEEDED',
    });
  });

  it('BLOCKED_BY_ENVIRONMENT is NOT counted as PASS (only SUCCEEDED is)', () => {
    expect(isPass(STATUS.SUCCEEDED)).toBe(true);
    expect(isPass(STATUS.NOT_RUN)).toBe(false);
    expect(isPass(STATUS.FAILED)).toBe(false);
    expect(isPass(STATUS.BLOCKED_BY_ENVIRONMENT)).toBe(false);
  });

  it('(a) STALE when evidence SHA != current SHA', () => {
    const evidence = { evaluatedCommitSha: SHA_A, gates: [gate('x', STATUS.SUCCEEDED)] };
    expect(isStale(evidence, SHA_B)).toBe(true);
    expect(isStale(evidence, SHA_A)).toBe(false);

    const r = computeProductionReady(evidence, SHA_B);
    expect(r.ready).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.reasons.some((reason) => reason.includes('STALE'))).toBe(true);
  });

  it('(b) BLOCKED_BY_ENVIRONMENT gate keeps Production Ready false', () => {
    const evidence = {
      evaluatedCommitSha: SHA_A,
      gates: [gate('api-tests', STATUS.SUCCEEDED), gate('container-image-scan', STATUS.BLOCKED_BY_ENVIRONMENT)],
    };
    const r = computeProductionReady(evidence, SHA_A);
    expect(r.ready).toBe(false);
    expect(
      r.reasons.some(
        (reason) => reason.includes('container-image-scan') && reason.includes('BLOCKED_BY_ENVIRONMENT'),
      ),
    ).toBe(true);
  });

  it('(c) Production Ready false when any mandatory gate is NOT_RUN', () => {
    const evidence = {
      evaluatedCommitSha: SHA_A,
      gates: [gate('unit-tests', STATUS.SUCCEEDED), gate('e2e', STATUS.NOT_RUN)],
    };
    const r = computeProductionReady(evidence, SHA_A);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((reason) => reason.includes('e2e') && reason.includes('NOT_RUN'))).toBe(true);
  });

  it('Production Ready true only when every mandatory gate SUCCEEDED on current SHA', () => {
    const evidence = {
      evaluatedCommitSha: SHA_A,
      gates: [gate('unit-tests', STATUS.SUCCEEDED), gate('container-image-scan', STATUS.SUCCEEDED)],
    };
    const r = computeProductionReady(evidence, SHA_A);
    expect(r.ready).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('non-mandatory gates do not block Production Ready', () => {
    const evidence = {
      evaluatedCommitSha: SHA_A,
      gates: [
        gate('unit-tests', STATUS.SUCCEEDED),
        gate('optional-nice-to-have', STATUS.NOT_RUN, { mandatory: false }),
      ],
    };
    expect(computeProductionReady(evidence, SHA_A).ready).toBe(true);
  });

  it('no gate results recorded => Production Ready is false (honest default)', () => {
    const evidence = { evaluatedCommitSha: SHA_A, gates: [] };
    const r = computeProductionReady(evidence, SHA_A);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((reason) => reason.includes('no mandatory gate results'))).toBe(true);
  });
});

describe('truth-gate (release drift gate CLI)', () => {
  it('(d) drift gate fails when the manifest claims Production Ready but a gate failed', async () => {
    const fs = require('node:fs');
    const dir = path.join(REPO_ROOT, 'output', '_truth-gate-test');
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'evidence-manifest.json');

    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          evaluatedCommitSha: SHA_A,
          gates: [gate('unit-tests', STATUS.FAILED), gate('container-image-scan', STATUS.BLOCKED_BY_ENVIRONMENT)],
          productionReady: true,
        },
        null,
        2,
      ) + '\n',
    );

    const code = await runCli(['--manifest', manifestPath, '--sha', SHA_A]);
    expect(code).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drift gate blocks when the manifest claims Production Ready but the evidence is STALE', async () => {
    const fs = require('node:fs');
    const dir = path.join(REPO_ROOT, 'output', '_truth-gate-test-stale');
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'evidence-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        { evaluatedCommitSha: SHA_A, gates: [gate('unit-tests', STATUS.SUCCEEDED)], productionReady: true },
        null,
        2,
      ) + '\n',
    );
    const code = await runCli(['--manifest', manifestPath, '--sha', SHA_B]);
    expect(code).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drift gate passes when the manifest claims Production Ready and all gates SUCCEEDED on current SHA', async () => {
    const fs = require('node:fs');
    const dir = path.join(REPO_ROOT, 'output', '_truth-gate-test-ok');
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'evidence-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          evaluatedCommitSha: SHA_A,
          gates: [gate('unit-tests', STATUS.SUCCEEDED), gate('container-image-scan', STATUS.SUCCEEDED)],
          productionReady: true,
        },
        null,
        2,
      ) + '\n',
    );
    const code = await runCli(['--manifest', manifestPath, '--sha', SHA_A]);
    expect(code).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});