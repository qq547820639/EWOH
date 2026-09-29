#!/usr/bin/env node
/**
 * CI 侧 e2e 覆盖面与"预检镜像"漂移核对（V111 常驻入口）。
 *
 * 背景（本轮实测，不是假想）：链级 20 个 spec 的"跑了才算过"判据在试点自己的重放里（D3 档，V110），
 * 而 **CI 走的是另一条路**：`npm run test:e2e`（jest `testMatch` 是 `test/e2e/` 下全部 `.e2e.spec.ts`，今天 28 个文件）
 * 前面挂一步 `scripts/e2e-preflight.mjs`。那个 preflight 的注释自己写明它**复刻** `resolveE2EConfig()` 的语义
 * （"同语义"在文件里出现三次），而两份实现之间**没有任何测试断言它们一致**。
 * 于是危险方向很具体：只要 helper 将来改判定（新增必需变量、换探测端口、加格式校验），
 * 镜像仍可能 exit 0，而 28 个 spec 的 `if (!e2eConfig) describe.skip(…)` 全部触发 ⇒
 * jest 汇总 `Tests: 0 total`、退出码 0 ⇒ **CI 绿、边界用例一条没跑**（GATE-01 的同一形状，换了道 seam）。
 *
 * 本脚本只做静态核对（不连库、不跑用例、不改 CI），四条判据：
 *  C1 每个 e2e spec：静态用例数 ≥1；`describe.skip` 必须有 if 守卫，且守卫引用 `resolveE2EConfig`；不得有 it.skip/todo。
 *  C2 helper 与 preflight 镜像的**决策标识符集合**必须相等（运行时/owner 的 env 名、探测端口）。
 *     这是词法级跳线：能抓"改了一边没改另一边"，不声称证明两次运行等价（覆盖面见 --help 末尾）。
 *  C3 CI 调用面：确有 workflow 调 `npm run test:e2e`；preflight 步骤在它**之前**；这两步都没有 continue-on-error；
 *     `make audit-regression-gates` 的调用点存在且不带 continue-on-error；步骤名里若写了"N 条主线"必须等于真实条数。
 *  C4 差集透明账：CI 跑而试点清单没跑的 spec（数量与用例数）、以及试点清单里但磁盘不存在的（必须为 0）。
 *
 * 退出码：0 全通过；1 有偏差；3 输入不可判（文件缺失/解析不出结构 ⇒ 不拿"读不到"冒充"没问题"）。
 * 用法：node scripts/chain-baseline/ci-e2e-surface.cjs [--self-test] [--json] [--quiet]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const DEFAULTS = {
  specs: 'ewoh-spark-app/test/e2e',
  helper: 'ewoh-spark-app/test/helpers/e2e-config.ts',
  preflight: 'scripts/e2e-preflight.mjs',
  verify: 'scripts/chain-baseline/verify.sh',
  makefile: 'Makefile',
  workflows: '.github/workflows',
};
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
// 中文数词 → 整数（CI 步骤名里写的是「十三条主线」这种，只认 \d+ 就漏掉了真实的那一类）
function cn2int(t) {
  if (/^[0-9]+$/.test(t)) return Number(t);
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === '十') return 10;
  const i = t.indexOf('十');
  if (i === -1) return d[t] || NaN;
  const tens = i === 0 ? 1 : (d[t.slice(0, i)] || NaN);
  const ones = i === t.length - 1 ? 0 : (d[t.slice(i + 1)] || NaN);
  return tens * 10 + ones;
}
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function readList(verifyPath) {
  const txt = fs.readFileSync(verifyPath, 'utf8');
  const hits = [...txt.matchAll(/CHAIN_SPECS="([\s\S]*?)"/g)];
  if (!hits.length) throw new Error(`${verifyPath} 没有 CHAIN_SPECS`);
  const best = hits.map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  const list = best.replace(/\\\s*\n/g, ' ').split(/\s+/).filter(Boolean);
  if (list.length < 5) throw new Error(`CHAIN_SPECS 只有 ${list.length} 项，疑似截断`);
  return list;
}

/** 守卫是否"由 resolveE2EConfig() 的返回值决定"（直接调用，或调用它得到的变量取反）。
 *  V111 自测逼出来的必需一步：真实写法是 `const e2eConfig = resolveE2EConfig(); if (!e2eConfig) {…}`，
 *  守卫行里只有变量名——只看守卫行会把 4 个合法占位全判成漂移（假阳性），并让别的注入"因为别的原因"变红。*/
function guardResolvesToPredicate(clean, guardLine) {
  if (/resolveE2EConfig\s*\(/.test(guardLine)) return true;
  const ids = (guardLine.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || [])
    .filter((x) => !['if', '!', 'not', 'process', 'env', 'else', 'return'].includes(x));
  return ids.some((id) => {
    const re = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*resolveE2EConfig\\s*\\(`);
    return re.test(clean);
  });
}

/** C1：单个 spec 的跳过结构与用例数。 */
function analyzeSpec(name, src) {
  const clean = stripComments(src);
  const lines = clean.split('\n');
  const itRe = /^\s*(?:it|test)\s*\(\s*['"`]/;
  const problems = [];
  let total = 0; let inSkipBlock = 0;
  const guards = [];
  lines.forEach((l, i) => { if (itRe.test(l)) total += 1; });
  // 自保：本判据按"行首 it("数用例。若某条 it( 不在行首（同行并排写法），静态数会少算 ⇒
  // 与其悄悄少算，不如红出来让人改判据（V107/V108 两次同类失效的教训固化成一条断言）。
  const inline = (clean.match(/\b(?:it|test)\s*\(\s*['"`]/g) || []).length;
  if (inline !== total) {
    problems.push(`${name}: 行首用例 ${total} 条与全文用例 ${inline} 条不等 ⇒ `
      + '本判据的静态计数对这份文件不可信（同行并排写法），先加深判据再谈结论');
  }
  lines.forEach((l, i) => {
    if (!/\bdescribe\.(skip|todo)\s*\(/.test(l)) return;
    const ind = indentOf(l);
    let guardLine = null;
    for (let j = i - 1; j >= Math.max(0, i - 14); j -= 1) {
      const p = lines[j];
      if (!p.trim()) continue;
      if (indentOf(p) <= ind && /^\s*(\}\s*)?if\s*\(/.test(p)) { guardLine = p.trim(); break; }
      if (indentOf(p) < ind && !/^\s*[})\]]/.test(p)) break;
    }
    // 块内用例数（跳过块遮住了几条）
    let depth = 0; let end = i;
    for (let k = i; k < lines.length; k += 1) {
      depth += (lines[k].match(/\{/g) || []).length - (lines[k].match(/\}/g) || []).length;
      if (depth <= 0 && k > i) { end = k; break; }
      end = k;
    }
    let hidden = 0;
    for (let k = i; k <= end; k += 1) if (itRe.test(lines[k])) hidden += 1;
    inSkipBlock += hidden;
    guards.push({ line: i + 1, guard: guardLine, hidden });
    if (!guardLine) problems.push(`${name}:${i + 1} describe.skip 没有 if 守卫 ⇒ 永久跳过，jest 汇总行不报 skipped`);
    else if (!guardResolvesToPredicate(clean, guardLine)) {
      problems.push(`${name}:${i + 1} 的跳过守卫是「${guardLine}」——既不直接调用 resolveE2EConfig()，`
        + '也不是它的返回值的真假判断 ⇒ CI 的 preflight 只保证「e2eConfig 解析得出」，保不住这个条件（漂移点）');
    }
  });
  const loud = (clean.match(/\b(?:it|test)\.(?:skip|todo)\b/g) || []).length
    + (clean.match(/\b(?:xdescribe|xit|xtest)\b/g) || []).length;
  if (loud) problems.push(`${name}: 有 ${loud} 处 it.skip/todo/x describe（响亮跳过，必须显式登记并说明）`);
  if (total === 0) problems.push(`${name}: 静态 0 条用例（一个不注册任何用例的 spec 文件在 CI 里等于不存在）`);
  return { name, total, hidden: inSkipBlock, runnable: total - inSkipBlock, guards: guards.length, loud, problems };
}

/** C2：两边"决策标识符"集合。 */
function decisionTokens(text, kind) {
  const envs = new Set([...text.matchAll(/\b(EWOH_E2E_[A-Z0-9_]+)\b/g)].map((m) => m[1]));
  const ports = new Set([...text.matchAll(/\b(?:iTCP:|port\s*|:)(3\d{3})\b/g)].map((m) => m[1]));
  const symbols = kind === 'helper'
    ? new Set(['resolveE2EConfig'])
    : new Set([...text.matchAll(/resolveE2EConfig/g)].map(() => 'resolveE2EConfig'));
  return { envs, ports, symbols };
}

/** C3：workflow 步骤顺序与 continue-on-error。 */
function analyzeWorkflows(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const out = { callers: [], preflightBefore: null, gateCallers: [], problems: [], notes: [] };
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = raw.split('\n');
    // 逐 job 扫步骤：记录 name/run 与 continue-on-error 的归属
    let job = null;
    const steps = [];
    lines.forEach((l, i) => {
      const jm = l.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
      if (jm) { job = jm[1]; }
      const sm = l.match(/^\s*-\s+name:\s*(.+)$/);
      if (sm) steps.push({ job, idx: i, name: sm[1].trim(), coe: false, run: null });
      if (!steps.length) return;
      const last = steps[steps.length - 1];
      if (/\bcontinue-on-error:\s*true/.test(l) && last.job === job) last.coe = true;
      const rm = l.match(/^\s*run:\s*(.+)$/);
      if (rm && last.run === null) last.run = rm[1].trim();
    });
    const e2e = steps.filter((s) => s.run && /npm run test:e2e\b/.test(s.run));
    const pre = steps.filter((s) => s.run && /e2e-preflight/.test(s.run));
    const gates = steps.filter((s) => s.run && /make audit-regression-gates/.test(s.run));
    if (e2e.length) {
      out.callers.push(`${f}:${e2e.map((s) => s.job).join(',')}`);
      e2e.forEach((s) => {
        if (s.coe) out.problems.push(`${f} 的 test:e2e 步骤带 continue-on-error ⇒ 红了也不挡（${s.name}）`);
        const before = pre.filter((p) => p.job === s.job && p.idx < s.idx);
        if (!before.length) {
          out.problems.push(`${f}:${s.job} 的 test:e2e 之前没有 e2e-preflight 步骤 ⇒ 整包自跳过无人挡`);
        } else {
          out.preflightBefore = `${f}:${s.job}（pre-flight 在步骤 #${before.length}，先于 test:e2e）`;
          if (before.some((p) => p.coe)) out.problems.push(`${f}:${s.job} 的 preflight 带 continue-on-error ⇒ 前提检查被吞`);
        }
      });
    }
    gates.forEach((s) => {
      out.gateCallers.push(`${f}:${s.job}`);
      if (s.coe) out.problems.push(`${f} 的 audit-regression-gates 带 continue-on-error（19 条红线在 CI 里不挡）`);
      const m = s.name.match(/([0-9]+|[一二三四五六七八九十]{1,3})\s*条主线/);
      if (!m) return;
      out.notes.push(`${f} 的步骤名写着「${m[1]} 条主线」`);
      out.stepNameCount = cn2int(m[1]);
      out.stepNameRaw = m[1];
      out.stepNameFile = f;
    });
  }
  return out;
}

function run(opts) {
  const problems = []; const notes = []; let data = null;
  let chain;
  try {
    chain = readList(opts.verify);
  } catch (e) {
    return { rc: 3, problems: [`输入不可判：${e.message}`], notes, data: null };
  }
  if (!fs.existsSync(opts.specs) || !fs.existsSync(opts.helper) || !fs.existsSync(opts.preflight)
    || !fs.existsSync(opts.workflows)) {
    return { rc: 3, problems: ['输入不可判：e2e 目录 / helper / preflight / workflows 有缺失'], notes, data: null };
  }

  const files = fs.readdirSync(opts.specs).filter((f) => f.endsWith('.e2e.spec.ts'))
    .map((f) => f.replace(/\.e2e\.spec\.ts$/, ''));
  const rows = files.map((n) => analyzeSpec(n, fs.readFileSync(path.join(opts.specs, `${n}.e2e.spec.ts`), 'utf8')));
  rows.forEach((r) => problems.push(...r.problems));

  // CI 用 testMatch 全量 glob ⇒ 清单外的 spec 也在 CI 里跑；反向缺失才是问题
  const missing = chain.filter((n) => !files.includes(n));
  missing.forEach((n) => problems.push(`CHAIN_SPECS 里的 ${n} 在磁盘上不存在 ⇒ CI 与试点都跑不到它`));
  const notInPilot = files.filter((n) => !chain.includes(n));
  const ciOnlyCases = notInPilot.reduce((a, n) => a + (rows.find((r) => r.name === n) || { runnable: 0 }).runnable, 0);
  notes.push(`CI 面（test:e2e 全量 glob）：${files.length} 个 spec / 可注册 ${rows.reduce((a, r) => a + r.runnable, 0)} 条；`
    + `试点清单 ${chain.length} 个 ⇒ 清单外但 CI 在跑 ${notInPilot.length} 个 / ${ciOnlyCases} 条（${notInPilot.join(' ') || '—'}）`);

  // C2 镜像一致性
  const helperRaw = fs.readFileSync(opts.helper, 'utf8');
  const preRaw = fs.readFileSync(opts.preflight, 'utf8');
  const decideSegment = (src) => {
    // 只取"决定要不要跑"的那段：resolveE2EConfig 函数体 / preflight 的 main+探测函数
    const m = src.match(/(?:export )?function resolveE2EConfig[\s\S]*?\n}\n/);
    if (m) return m[0];
    return src;
  };
  const H = decisionTokens(decideSegment(helperRaw), 'helper');
  const P = decisionTokens(preRaw, 'preflight');
  // 方向要判定清楚（V108 的教训：一个"哪个方向会失败"的断言本身是另一条断言，必须单独测）：
  //   helper 有而 preflight 没读 = 真漂移（镜像漏跟新条件 ⇒ 前提过了但整包自跳过）⇒ 报；
  //   preflight 多读的 = 更严的额外检查（真实情况就是它连 owner 也探一次）⇒ 只作说明，不是问题。
  const onlyH = [...H.envs].filter((x) => !P.envs.has(x));
  const onlyP = [...P.envs].filter((x) => !H.envs.has(x));
  if (onlyH.length) {
    problems.push(`预检镜像落后于 helper：helper 的 resolveE2EConfig 决策路径读 [${onlyH.join(', ')}]，`
      + 'preflight 没读 ⇒ 前提检查可能通过而 spec 的 `if (!e2eConfig)` 仍然为真（整包自跳过、jest 退 0）');
  }
  if (onlyP.length) {
    notes.push(`preflight 比 helper 多探 [${onlyP.join(', ')}]（更严方向，不是漂移）`);
  }
  const portsH = [...H.ports].sort().join(',');
  const portsP = [...P.ports].sort().join(',');
  if (!H.ports.size) problems.push('helper 里没解析出探测端口 ⇒ 本判据读不到东西（判"不可判"）');
  else if (portsH !== portsP) problems.push(`探测端口不一致：helper ${portsH || '∅'} vs preflight ${portsP || '∅'}`);
  if (!/resolveE2EConfig/.test(preRaw) && !/e2e-config/.test(preRaw)) {
    problems.push('preflight 里没有对 resolveE2EConfig/e2e-config 的任何引用 ⇒ 它不是镜像，本判据的前提不成立');
  }
  notes.push(`镜像核对：helper env {${[...H.envs].sort().join(', ')}} 端口 {${portsH || '∅'}} ｜ `
    + `preflight env {${[...P.envs].sort().join(', ')}} 端口 {${portsP || '∅'}}`);

  // C3 CI 调用面
  const w = analyzeWorkflows(opts.workflows);
  problems.push(...w.problems);
  if (!w.callers.length) problems.push('没有任何 workflow 调 `npm run test:e2e` ⇒ 链级 spec 在 CI 里根本没跑（试点文档若声称"常驻"要改述）');
  else notes.push(`test:e2e 调用点：${w.callers.join(' ; ') || '—'}｜pre-flight 位置：${w.preflightBefore || '（无）'}`);
  const mk = fs.readFileSync(opts.makefile, 'utf8');
  const realCount = Math.max(0, ...[...mk.matchAll(/── 主线(\d+)/g)].map((x) => Number(x[1])));
  if (!w.gateCallers.length) notes.push('（没有任何 workflow 调 make audit-regression-gates）');
  else notes.push(`audit-regression-gates 调用点：${w.gateCallers.join(' ; ')}｜Makefile 真实条数 ${realCount}`);
  if (w.stepNameCount !== undefined && w.stepNameCount !== realCount) {
    problems.push(`${w.stepNameFile} 的步骤名写「${w.stepNameRaw} 条主线」而 Makefile 实际 ${realCount} 条 `
      + '⇒ CI 页面上的这句话一直在说一件已经不成立的事（改名是无害的字面修正，但那是 CI 文件，按纪律只报不改）');
  }
  data = { specs: files.length, cases: rows.reduce((a, r) => a + r.total, 0), runnable: rows.reduce((a, r) => a + r.runnable, 0), chain: chain.length, ciOnly: notInPilot.length, ciOnlyCases, rows };
  return { rc: problems.length ? 1 : 0, problems, notes, data };
}

/** 判据自测：全部用夹具，绝不读真产物。 */
function selfTest() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-e2e-surface-'));
  const specDir = path.join(root, 'e2e');
  fs.mkdirSync(specDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'wf'), { recursive: true });
  const goodSpec = `
const e2eConfig = resolveE2EConfig();
if (!e2eConfig) {
  describe.skip('缺配置', () => {
    it('requires config', () => { expect(1).toBe(1); });
  });
} else {
  describe('真身', () => {
    it('甲', () => { expect(1).toBe(1); });
    it('乙', () => { expect(2).toBe(2); });
  });
}
`;
  // 夹具按真实写法给端口前缀（`-iTCP:3101`）——本判据读的是「端口出现在什么调用里」，写成 probe(3101) 会让端口解析落空（正向控制第一次失败就是这个原因）
  const goodHelper = 'function resolveE2EConfig(){ const a=process.env.EWOH_E2E_RUNTIME_DATABASE_URL; execFileSync("lsof", ["-iTCP:3101"]); const b=process.env.EWOH_E2E_OWNER_DATABASE_URL; return a||b }\n';
  const goodPre = '// 复用 resolveE2EConfig() 语义\nconst u=process.env.EWOH_E2E_RUNTIME_DATABASE_URL; const o=process.env.EWOH_E2E_OWNER_DATABASE_URL; lsof("iTCP:3101");\n';
  const goodVerify = 'CHAIN_SPECS="alpha beta gamma delta epsilon"\n';
  const goodMake = 'echo ── 主线1 x\necho ── 主线2 x\n';
  const goodWf = `jobs:
  e2e:
    steps:
      - name: E2E preflight
        run: node scripts/e2e-preflight.mjs
      - name: E2E HTTP + PostgreSQL
        run: npm run test:e2e
  gates:
    steps:
      - name: audit-regression-gates（2 条主线）
        run: make audit-regression-gates
`;
  const write = (rel, s) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s);
  };
  const base = (mut) => {
    write('e2e/alpha.e2e.spec.ts', goodSpec);
    ['beta', 'gamma', 'delta', 'epsilon'].forEach((n) => write(`e2e/${n}.e2e.spec.ts`, goodSpec));
    write('helper.ts', goodHelper);
    write('pre.mjs', goodPre);
    write('verify.sh', goodVerify);
    write('Makefile', goodMake);
    write('wf/ci.yml', goodWf);
    const opts = {
      specs: specDir, helper: path.join(root, 'helper.ts'), preflight: path.join(root, 'pre.mjs'),
      verify: path.join(root, 'verify.sh'), makefile: path.join(root, 'Makefile'), workflows: path.join(root, 'wf'),
    };
    if (mut) mut(opts);
    return opts;
  };
  const cases = [];
  const snap = () => ['wf/ci.yml', 'helper.ts', 'pre.mjs', 'verify.sh', 'Makefile', 'e2e/alpha.e2e.spec.ts']
    .map((rel) => fs.readFileSync(path.join(root, rel), 'utf8')).join('\u0000');
  const t = (label, mut, want, wantContains = null) => {
    const opts = base();
    const before = snap();
    if (mut) mut();
    const after = snap();
    if (want !== 0 && before === after) {
      cases.push({ label, ok: false, want, got: 'n/a', note: '注入没有改变任何输入（这条注入是摆设）' });
      return;
    }
    if (want === 0 && mut === null && before !== after) {
      cases.push({ label, ok: false, want, got: 'n/a', note: '正向控制本应不改动输入，却改动了' });
      return;
    }
    const got = run(opts);
    if (want === 0 && got.rc !== 0) {
      console.log('【正向控制被挡住】');
      got.problems.forEach((x) => console.log('      ✕ ' + x));
      got.notes.forEach((x) => console.log('      · ' + x));
    }
    // 不只看 rc：还必须由**这条注入该抓的那一项**造成——否则是"因为别的原因红了"的假通过
    const hit = wantContains === null || got.problems.some((x) => x.includes(wantContains));
    cases.push({
      label, ok: got.rc === want && hit,
      note: hit ? (got.problems.find((x) => wantContains && x.includes(wantContains)) || got.notes[0] || '—')
        : `没有命中预期判据「${wantContains}」；实际全部报语：\n        · ${got.problems.join('\n        · ') || '（无）'}`,
      want, got: got.rc,
    });
  };
  t('正向：守卫齐全、镜像一致、CI 顺序对、条数对上 ⇒ 通过', null, 0);
  t('注入①：describe.skip 没有 if 守卫（永久跳过）',
    () => write('e2e/alpha.e2e.spec.ts', goodSpec.replace('if (!e2eConfig) {\n', '').replace('  describe.skip', 'describe.skip')), 1, '没有 if 守卫');
  t('注入②：跳过守卫换成别的谓词（preflight 保不住它）',
    () => write('e2e/alpha.e2e.spec.ts', goodSpec.replace('if (!e2eConfig) {', 'if (!process.env.SOMETHING_ELSE) {')), 1, '既不直接调用');
  t('注入③：helper 新增一个决策 env，preflight 没跟（镜像漂移）',
    () => write('helper.ts', goodHelper.replace('const b=', 'const c=process.env.EWOH_E2E_TENANT_MODE; const b=')), 1, '预检镜像落后于 helper');
  t('注入④：preflight 步骤被挪到 test:e2e 之后（顺序失效）',
    () => write('wf/ci.yml', goodWf.replace('      - name: E2E preflight\n        run: node scripts/e2e-preflight.mjs\n', '')
      .replace('run: npm run test:e2e', 'run: npm run test:e2e\n      - name: E2E preflight\n        run: node scripts/e2e-preflight.mjs')), 1, '之前没有 e2e-preflight');
  t('注入⑤：CI 步骤名里的"主线条数"与 Makefile 不符（页面上说过期的话）',
    () => write('wf/ci.yml', goodWf.replace('（2 条主线）', '（十三 条主线）')), 1, '条主线」而 Makefile 实际');
  t('注入⑦（方向对照）：preflight 比 helper 多读一个 env ⇒ 更严，必须仍然通过',
    () => write('pre.mjs', goodPre + 'const extra=process.env.EWOH_E2E_EXTRA_PROBE;\n'), 0);
  t('注入⑥：test:e2e 步骤带 continue-on-error（前提挡不住红）',
    () => write('wf/ci.yml', goodWf.replace('        run: npm run test:e2e', '        continue-on-error: true\n        run: npm run test:e2e')), 1, 'continue-on-error');
  fs.rmSync(root, { recursive: true, force: true });
  let bad = 0;
  cases.forEach((c) => {
    if (!c.ok) { bad += 1; console.log(`  ✕ ${c.label}（期望 rc=${c.want} 实得 rc=${c.got}）${c.note}`); }
    else console.log(`  ✓ ${c.label}\n      ↳ ${c.note}`);
  });
  if (bad) { console.log(`CI e2e 跳线自测：不通过（${bad} 项）`); process.exitCode = 3; return; }
  console.log(`CI e2e 跳线自测：通过（1 正向 + ${cases.length - 1} 注入，注入均改变判决）`);
}

function main() {
  if (flag('--self-test')) { selfTest(); return; }
  const opts = {};
  Object.keys(DEFAULTS).forEach((k) => { opts[k] = opt(k) || path.join(ROOT, DEFAULTS[k]); });
  const r = run(opts);
  if (!flag('--quiet')) {
    console.log(`CI e2e 覆盖面：spec ${r.data ? r.data.specs : '?'} 个｜静态用例 ${r.data ? r.data.cases : '?'}`
      + `｜可注册 ${r.data ? r.data.runnable : '?'}｜试点清单 ${r.data ? r.data.chain : '?'}`);
    r.notes.forEach((n) => console.log('  ·', n));
    r.problems.forEach((p) => console.log('  ✕', p));
    console.log(r.rc === 0 ? '  ✅ CI 侧 e2e 前提链与镜像一致，调用面成立' : `  ❌ ${r.problems.length} 项偏差`);
  }
  if (flag('--json') && r.data) {
    fs.writeFileSync(path.join(ROOT, 'tmp/ci-e2e-surface.json'), JSON.stringify(r.data, null, 1));
  }
  process.exitCode = r.rc;
}

main();
