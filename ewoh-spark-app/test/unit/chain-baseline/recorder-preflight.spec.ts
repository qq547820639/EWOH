/**
 * 记账前置校验器（recorder-preflight）的常驻位点。
 *
 * 存在理由：V296–V304 里我七次犯同一族错——速览/状态件里被 `artifact-consistency` 读的自述写成
 * "语义对但字形不对"（漏「共」字、把 `fixed n 条 / open m 条` 写成"条不变"、整格漏写），
 * 每次都是落盘后被门禁报红才发现。这个工具把那次红提前到写盘之前。
 *
 * 两极怎么在**单元测试环境里**做到确定：不要求"未篡改必绿"（判据会读真仓库的重放日志与事实文件，
 * 环境缺件时报的是"不可判"而不是绿，拿它当断言就是把用例绑在机器状态上）；
 * 改成**差分**：同一台机器、同一份未篡改候选先跑一次取 ✗ 集合，再篡改一格跑第二次，
 * 断言"新出现的那条 ✗ 正是被篡改正对应的那条判据"。这样既有反证（不能恒红）又有开火（不能恒绿）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = 'scripts/chain-baseline/recorder-preflight.sh';

function runPreflight(dir: string): { status: number; out: string } {
  // maxBuffer 必须显式放大：一致性尺的 stdout＋stderr 在全量并行跑时会超出 spawnSync 默认 1MB，
  // 被截断后 status 变 null（隔离跑却全绿）——这是 V306 全量单测里实际踩到的一次。
  const r = spawnSync('bash', [SCRIPT, dir],
    { cwd: REPO, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function fails(out: string): string[] {
  return out.split('\n').filter((l) => l.trimStart().startsWith('✗')).map((l) => l.trim());
}

function makeCandidate(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-pf-'));
  execFileSync('bash', ['-c', `
    cd ${JSON.stringify(REPO)}
    cp docs/audit/current/chain-behavior-baseline.md ${JSON.stringify(dir)}/chain-behavior-baseline.md
    cp .codex/artifacts/chain-behavior-baseline-state.json ${JSON.stringify(dir)}/state.json
    cp docs/audit/current/pilot-promotion-verdict.md ${JSON.stringify(dir)}/verdict.md`], { encoding: 'utf8' });
  return dir;
}

describe('记账前置校验器的两极（PF-01）', () => {
  it('PF-01 抹掉候选件速览里的一格自述，必须新出现"未写"这一条判据红', () => {
    const dir = makeCandidate();
    const base = runPreflight(dir);
    const baseFails = fails(base.out);
    const docPath = path.join(dir, 'chain-behavior-baseline.md');
    const text = fs.readFileSync(docPath, 'utf8');
    const re = /防回归门禁 \*\*[^*]*条主线\*\*/g;
    const hits = text.match(re) ?? [];
    expect(hits.length).toBeGreaterThan(0);   // 前提：这一格在真产物里确实存在
    // 抹掉**全部**出现处，而不是只抹第一段：速览区是滚动区，历史轮次各留一段自述，
    // 只抹一段时判据仍能在别的段落里读到该格 ⇒ "未写"不会报，本用例就成了假绿（V306 全量跑实测到这点）。
    fs.writeFileSync(docPath, text.replace(re, '（这一格被本用例抹掉）'));
    expect((fs.readFileSync(docPath, 'utf8').match(re) ?? []).length).toBe(0);
    const tampered = runPreflight(dir);
    const newFails = fails(tampered.out).filter((l) => !baseFails.includes(l));
    expect(tampered.status).not.toBe(-1);   // -1＝子进程没跑起来/输出溢出，不能当"红"
    expect(tampered.status).not.toBe(0);
    expect(newFails.some((l) => l.includes('速览未写') && l.includes('防回归门禁'))).toBe(true);
    // 反证：未篡改那次不能有这条红（否则"新出现"是恒真）
    expect(baseFails.some((l) => l.includes('速览未写') && l.includes('防回归门禁'))).toBe(false);
  });

  it('PF-01 用法守卫：候选件不齐时必须退 2 且不跑判据（不能把"没输入"读成"通过"）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-pf-empty-'));
    const r = runPreflight(dir);
    expect(r.status).toBe(2);
    expect(r.out).toContain('候选件缺失');
    expect(fails(r.out).length).toBe(0);      // 没跑判据 ⇒ 不该出现任何 ✗
    const noArg = spawnSync('bash', [SCRIPT],
      { cwd: REPO, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    expect(noArg.status).toBe(2);
    expect(`${noArg.stdout}${noArg.stderr}`).toContain('用法');
  });
});
