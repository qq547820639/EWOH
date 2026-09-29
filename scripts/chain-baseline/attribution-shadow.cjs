#!/usr/bin/env node
/**
 * V186 影子判据：修法位点的「小节归属」两档并排对账（只读数，不改判据、不切默认、不动豁免清单）。
 *   loose（V186 之前的默认）：§5.1→§5.4 之间任何 `### ` 小节，正文**或**标题含该编号，整段并入该项"修法文本"
 *   strict（V143 起的选装）：只认**标题行**含该编号的小节
 *   entry（V186 起的默认）：只认登记条目自己的正文
 * 两档跑同一个真判据（fix-sites.cjs --json），唯一变量是归属档。
 *
 * 立问：把归属判据收紧成"标题点名才算这项的修法文本"，今天会红几项、凭空多出又会消掉几处假位点？
 * 动因（V185 实测）：A 档会吸邻节正文 ⇒ 在 §5.4 前新增一节、正文一旦点名某 CHAIN_SPECS 的 spec 名，
 * 就给同区共处的无关声明性豁免项凭空造出一处「A3 常驻 spec」活位点，主线23 判红。
 *
 * 退出码 0 有读数且逐点对齐成立 / 2 读数作废（行集或位点集不对齐、语料为空）/ 3 不可用（依赖缺失、判据自测不过）。
 * 用法：node scripts/chain-baseline/attribution-shadow.cjs [--self-test]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const JUDGE = path.join(__dirname, 'fix-sites.cjs');
const ARMS = { loose: { V186_SECTION_ATTRIBUTION: 'loose' }, strict: { V186_SECTION_ATTRIBUTION: 'strict' }, entry: {} };
const STRICT = ARMS.strict;   // 兼容 V143 老开关：V143_STRICT_SECTION=1 也是 strict 档
const key = (s) => `${s.type.split('（')[0]}:${s.what}`;

/** 跑一档判据：先删掉它写死的 tmp/fix-sites.json，**绝不读陈旧产物**（V186 自测就是这么抓到假读数的）。
 *  rc 1 = 判据红，是常态，照常取读数；rc≥2 或产物缺失 = 崩了，硬失败。 */
function judgeArm(args, env) {
  const arm = (env && env.V186_SECTION_ATTRIBUTION) || 'entry(默认)';
  const out = path.join(ROOT, 'tmp/fix-sites.json');
  fs.rmSync(out, { force: true });
  let res;
  try {
    res = { stdout: execFileSync(process.execPath, [JUDGE, '--json', ...args],
      { cwd: ROOT, env: { ...process.env, ...(env || {}) }, encoding: 'utf8', maxBuffer: 64 << 20 }), rc: 0 };
  } catch (e) { res = { stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), msg: e.message, rc: typeof e.status === 'number' ? e.status : 3 }; }
  if (res.rc >= 2) throw new Error(`判据异常退出 rc=${res.rc}：${(res.stderr || res.stdout || res.msg).split('\n').slice(-3).join(' / ')}`);
  if (!fs.existsSync(out)) throw new Error('判据未产出 tmp/fix-sites.json ⇒ 不可用（拒绝沿用旧产物）');
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

/** 逐点对齐：B 的归属集结构性 ⊆ A；任一侧多出、或行集不同，即读数作废 */
function align(A, B) {
  const problems = [];
  const a = new Map(A.map((r) => [r.id, r]));
  const b = new Map(B.map((r) => [r.id, r]));
  if (!A.length) problems.push('A 行清单为空 ⇒ 语料没吃到，本轮不出数');
  if (A.length !== B.length) problems.push(`A ${A.length} 行 ≠ B ${B.length} 行 ⇒ 两档吃到不同行集`);
  for (const id of a.keys()) if (!b.has(id)) problems.push(`项 ${id} 在 B 无读数 ⇒ 逐点对齐失败`);
  for (const id of b.keys()) if (!a.has(id)) problems.push(`项 ${id} 只在 B 出现 ⇒ 逐点对齐失败`);
  const lost = [], gained = [], flips = [];
  for (const [id, ra] of a) {
    const rb = b.get(id); if (!rb) continue;
    const ka = new Set(ra.sites.map(key)), kb = new Set(rb.sites.map(key));
    for (const k of ka) if (!kb.has(k)) lost.push({ id, k });
    for (const k of kb) if (!ka.has(k)) gained.push({ id, k });
    if (ra.verdict !== rb.verdict) flips.push({ id, from: ra.verdict, to: rb.verdict });
  }
  if (gained.length) problems.push(`${gained.length} 处位点只在 B 出现（B ⊆ A 不成立）⇒ 两套枚举器不一致`);
  return { problems, lost, gained, flips, a, b };
}

/** 合成语料工厂：一份登记册 + 一条本身无位点的项 UIX-90 + 一条位点写在条目正文里的真修法项 SH-01；
 *  neighborMention 控制「SH-01 的小节」正文里是否点名 UIX-90（这是两档唯一分歧的形状） */
function fixturePair(neighborMention) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attrib-fx-'));
  const w = (p, c) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  w('e2e/shadow-sample.e2e.spec.ts', "describe('S', () => {\n  it('SH-01 链上回执边界', () => { expect(1).toBe(1); });\n});\n");
  w('Makefile', '## 主线1\nchain-baseline-fix-sites:\n\tnode x\n');
  w('verify.sh', '#!/bin/sh\nCHAIN_SPECS="shadow-sample"\n');
  w('state.json', JSON.stringify({
    findings: {
      fixed: ['UIX-90 已修：只改注释、行为零变化（V9 实测）', 'SH-01 已修：由 shadow-sample.e2e.spec.ts 钉住'],
      open: [],
    },
  }));
  w('reg.md', [
    '### 5.1 口径', '正文。', '',
    '### 5.3zz SH-01 修法小节',
    '位点 shadow-sample.e2e.spec.ts 钉住 SH-01。' + (neighborMention ? ' 顺带在这里讨论 UIX-90。' : ''),
    '', '### 5.4 开放缺陷登记表', '',
    '| 编号 | 级别 | 现象 | 状态与入口 |', '| --- | --- | --- | --- |',
    '| UIX-90 | P2 | 注释与数字不符 | 已修复（只改注释） |',
    '| SH-01 | P2 | 边界 | 已修复 |', '',
  ].join('\n'));
  const args = ['--state', `${root}/state.json`, '--doc', `${root}/reg.md`, '--verify', `${root}/verify.sh`,
    '--makefile', `${root}/Makefile`, '--specs', `${root}/e2e`, '--unitdir', `${root}/nu`,
    '--servetests', `${root}/ns`, '--edgetests', `${root}/ne`, '--scripts', `${root}/nsc`,
    '--workflows', `${root}/nw`, '--mention', `${root}/nm`];
  const out = { A: judgeArm(args, ARMS.loose), B: judgeArm(args, ARMS.entry) };
  fs.rmSync(root, { recursive: true, force: true });
  return out;
}

function selfTest() {
  const cases = [];
  let fx;
  try { fx = fixturePair(true); } catch (e) { console.log(`  ✕ 夹具构造失败：${e.message}`); process.exitCode = 3; return; }
  const q = align(fx.A, fx.B);
  const hit = q.lost.find((x) => x.id === 'UIX-90' && x.k.startsWith('A3'));
  console.log(`  夹具读数：A=${fx.A.map((r) => `${r.id}:${r.verdict}(${r.sites.length})`).join(' ')}｜B=${fx.B.map((r) => `${r.id}:${r.verdict}(${r.sites.length})`).join(' ')}`);
  cases.push({ label: '正向·邻节正文点名他项 ⇒ 旧档凭空多一处 A3 位点，量具必须报为失位点',
    ok: !!hit, why: hit ? `UIX-90 在旧档有、新档无：${hit.k}` : '量具未开火：邻节文本没被吸进旧档（形状或是判据已改）' });
  cases.push({ label: '正向·误伤面结构性为 0，出现即作废',
    ok: q.gained.length === 0 && q.problems.length === 0,
    why: q.gained.length ? `误伤面 ${q.gained.length} 处` : q.problems.length ? `对齐问题：${q.problems[0]}` : 'B 位点集是 A 的子集，逐点对齐成立' });
  cases.push({ label: '正向·标题点名该号的小节两档必须同判（严格档不能连自己该认的不认）',
    ok: !q.flips.some((x) => x.id === 'SH-01'),
    why: q.flips.some((x) => x.id === 'SH-01') ? 'SH-01 被翻转 ⇒ 严格档把真修法位点也丢了' : 'SH-01 两档同判' });
  let fx2;
  try { fx2 = fixturePair(false); } catch (e) { console.log(`  ✕ 反向夹具构造失败：${e.message}`); process.exitCode = 3; return; }
  const q2 = align(fx2.A, fx2.B);
  cases.push({ label: '反向对照·邻节不再点名 ⇒ 失位点面必须归零（开火的只有"点名"这一个变量）',
    ok: q2.lost.length === 0 && q2.problems.length === 0,
    why: q2.lost.length ? `仍报 ${q2.lost.length} 处（${q2.lost.map((x) => x.id).join(' ')}）` : '两档位点集完全一致' });
  fs.rmSync(path.join(ROOT, 'tmp/fix-sites.json'), { force: true });
  let bad = 0;
  for (const c of cases) { if (!c.ok) { bad++; console.log(`  ✕ ${c.label}\n      ↳ ${c.why}`); } else console.log(`  ✓ ${c.label}\n      ↳ ${c.why}`); }
  console.log(bad ? `  归属影子判据自测：不通过（${bad}/${cases.length}）` : `  归属影子判据自测：通过（${cases.length} 项）`);
  process.exitCode = bad ? 3 : 0;
}

function main() {
  if (process.argv.slice(2).includes('--self-test')) { selfTest(); return; }
  for (const f of [JUDGE, path.join(ROOT, 'Makefile'), path.join(ROOT, 'scripts/chain-baseline/verify.sh'),
    path.join(ROOT, '.codex/artifacts/chain-behavior-baseline-state.json'),
    path.join(ROOT, 'docs/audit/current/chain-behavior-baseline.md')]) {
    if (!fs.existsSync(f)) { console.log(`不可用：缺少 ${path.relative(ROOT, f)}`); process.exitCode = 3; return; }
  }
  try { execFileSync(process.execPath, [JUDGE, '--self-test'], { cwd: ROOT, encoding: 'utf8' }); }
  catch { console.log('不可用：fix-sites 判据自测不通过 ⇒ 尺子不能红，本轮不出对比读数'); process.exitCode = 3; return; }
  try { execFileSync(process.execPath, [path.join(__dirname, 'attribution-shadow.cjs'), '--self-test'],
    { cwd: ROOT, encoding: 'utf8' }); }
  catch { console.log('不可用：本量具自测不通过 ⇒ 不出读数'); process.exitCode = 3; return; }

  let A, B, C;
  try {
    A = judgeArm([], ARMS.loose); B = judgeArm([], ARMS.entry); C = judgeArm([], ARMS.strict);
  }
  catch (e) { console.log(`不可用：${e.message}`); process.exitCode = 3; return; }
  const rc = (rows) => rows; void rc;
  console.log(`归属影子对账（真实语料，同一判据、唯一变量是归属档）：loose ${A.length} 项｜entry ${B.length} 项｜strict ${C.length} 项`);
  console.log(`  位点面：loose ${A.reduce((n,x)=>n+x.sites.length,0)} 处｜strict ${C.reduce((n,x)=>n+x.sites.length,0)} 处｜entry ${B.reduce((n,x)=>n+x.sites.length,0)} 处`);
  const r = align(A, B);
  const rStrict = align(A, C);
  console.log(`  对照 loose↔strict：判决翻转 ${rStrict.flips.length} 项（${rStrict.flips.map((x)=>x.id).join(' ') || '无'}）`);
  for (const row of A) {
    const rb = r.b.get(row.id);
    const drop = new Set(r.lost.filter((x) => x.id === row.id).map((x) => x.k));
    if (!row.sites.some((s) => drop.has(key(s))) && (!rb || rb.verdict === row.verdict)) continue;
    console.log(`  ${row.id}  旧档=${row.verdict} → 新档=${rb ? rb.verdict : '（无读数）'}`);
    for (const s of row.sites) console.log(`      ${key(s)}  ${(s.where || []).join(' ')}${drop.has(key(s)) ? '（B 失）' : ''}`);
  }
  console.log(`  位点面：A ${A.reduce((n, x) => n + x.sites.length, 0)} 处｜B ${B.reduce((n, x) => n + x.sites.length, 0)} 处｜失位点 ${r.lost.length} 处（分布在 ${new Set(r.lost.map((x) => x.id)).size} 项）｜误伤面 ${r.gained.length} 处`);
  console.log(`  判决翻转 ${r.flips.length} 项：${r.flips.map((x) => `${x.id}(${x.from}→${x.to})`).join(' ') || '（无）'}`);
  if (r.problems.length) {
    console.log('  ✕ 读数作废：');
    r.problems.forEach((p) => console.log('     ·', p));
  } else {
    console.log(`  ✅ 逐点对齐成立 ⇒ 从旧默认 loose 换成现默认 entry：消掉 ${r.lost.length} 处归属位点、判决翻转 ${r.flips.length} 项（已由 E 类常驻位点与条目全路径引用补齐）。本量具只读数，不改判据。`);
  }
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tmp/attribution-shadow.json'),
    JSON.stringify({ arms: { loose_items: A.length, entry_items: B.length, strict_items: C.length },
      sites: { loose: A.reduce((n,x)=>n+x.sites.length,0), strict: C.reduce((n,x)=>n+x.sites.length,0), entry: B.reduce((n,x)=>n+x.sites.length,0) },
      flips_vs_loose: { entry: r.flips, strict: rStrict.flips },
      lost: r.lost, gained: r.gained, problems: [...r.problems, ...rStrict.problems] }, null, 1));
  process.exitCode = r.problems.length ? 2 : 0;
}
main();
