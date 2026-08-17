/**
 * 门禁脚本自测（审计 §4 主线 6 / SCR-001 + SCR-010，防「门禁自伤」回归）。
 *
 * 1. canonical ID 正则族：scripts/audit-domain-contracts.js 内全部 canonical
 *    ID 正则（canon 与 DEC、EXC 常量家族，SCR-001 修复后的 `[^\s]+` 形态）以
 *    测试向量钉死语义——含空白字符的 ID 必须 FAIL、合法含 `s` 的 ID 必须
 *    PASS、冒号后为空或纯空白必须 FAIL。若有人把正则改回自伤形态或删减正则
 *    数量，本测试爆红。
 * 2. truth-manifest --check 缺失 baseline 必须 exit≠0（SCR-010：不得自动生成
 *    后假成功）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GATE_SRC = path.join(REPO_ROOT, 'scripts/audit-domain-contracts.js');

/** 从门禁脚本源码提取 canonical ID 正则族字面量（`/^...:[^\s]+$/` 形态）。 */
function extractCanonicalIdRegexes(): { body: string; line: number }[] {
  const src = fs.readFileSync(GATE_SRC, 'utf8');
  const lines = src.split('\n');
  const found: { body: string; line: number }[] = [];
  // 匹配源码中的正则字面量文本：/^…:[^\s]+$/ （SCR-001 修复后的形态）
  const literalRe = /\/\^[^/\n]*:\[\^\\s\]\+\$\//g;
  lines.forEach((l, i) => {
    literalRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = literalRe.exec(l)) !== null) {
      const body = m[0].slice(1, -1); // 去首尾斜杠
      found.push({ body, line: i + 1 });
    }
  });
  return found;
}

describe('audit-domain-contracts canonical ID 正则自测（SCR-001 防回归）', () => {
  const regexes = extractCanonicalIdRegexes();

  it('正则族存在且数量未缩水（当前基线 ≥ 20 处）', () => {
    expect(regexes.length).toBeGreaterThanOrEqual(20);
  });

  it('每条正则：合法 ID（含 s）PASS', () => {
    for (const { body, line } of regexes) {
      const re = new RegExp(body);
      const bare = body.replace(/^\^/, '');
      const prefix = bare.startsWith('decision:')
        ? 'decision'
        : bare.startsWith('exo-config:')
          ? 'exo-config'
          : bare.startsWith('device:')
            ? 'device'
            : bare.startsWith('person:')
              ? 'person'
              : 'person';
      const sample = `${prefix}:s`; // 合法且含字母 s
      expect({ line, ok: re.test(sample) }).toEqual({ line, ok: true });
    }
  });

  it('每条正则：冒号后含空白的 ID FAIL（SCR-001 原始缺陷形态）', () => {
    for (const { body, line } of regexes) {
      const re = new RegExp(body);
      for (const bad of ['person:a b', 'person: x', 'person:x ', ' person:x', 'person:']) {
        expect({ line, bad, ok: re.test(bad) }).toEqual({ line, bad, ok: false });
      }
    }
  });

  it('每条正则：纯空白值 FAIL（\\s 拒绝形态）', () => {
    for (const { body, line } of regexes) {
      const re = new RegExp(body);
      expect({ line, ok: re.test('person: \t') }).toEqual({ line, ok: false });
    }
  });
});

describe('truth-manifest --check 缺失 baseline 必须 fail（SCR-010 防回归）', () => {
  it('缺失 baseline → 非零退出（不得自动生成后 exit 0）', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-gate-selftest-'));
    const missing = path.join(tmpDir, 'nonexistent-manifest.json');
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/truth-manifest.js'), '--check', '--out', missing],
      { encoding: 'utf8', timeout: 60_000 },
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(null);
  });

  it('truth-manifest 脚本可执行（回归面健全性）', () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/truth-manifest.js'), '--help'], {
        stdio: 'ignore',
      }),
    ).not.toThrow();
  });
});
