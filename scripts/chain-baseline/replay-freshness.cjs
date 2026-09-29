#!/usr/bin/env node
/**
 * replay-freshness —— 只回答一个问题：
 *   「今天的工作树，被最近一次全量链级重放覆盖吗？」
 *
 * 为什么需要它：V156 之后各轮一直引用同一次重放的读数，而「产品代码没改」这件事
 * 此前只能靠人手敲 find -newer 来判断（V181 第一次就是这么做的）。人做的判断不会腐烂才怪。
 *
 * 口径：
 *   - 覆盖范围（in-scope）不写死清单，而是从 harness 自身解析：
 *       CHAIN_SPECS（verify.sh）→ 22 个常驻 spec 文件
 *       SCENARIOS 默认清单（verify.sh）→ 经 ewoh-spark-app/package.json 的 e2e:<name> 解析成场景脚本文件
 *       外加六个重放真正读的目录桶（服务端/共享契约/边缘/数据库/契约/工具链）
 *       外加 spec-dep 桶：从 CHAIN_SPECS 的 33 支 spec 与 SCENARIOS 解析出的场景脚本出发，
 *         沿 TypeScript Compiler API 解析出的 **相对 import 闭包**（COVSET-01／V321）
 *   - 明确不覆盖：前端 client、飞书侧车、docs —— 重放不跑它们，它们变了不算基线失效。
 *   - 闭包只沿**说明符可解析到磁盘文件**的边扩展；解析不到的相对说明符逐条点名打印，
 *     既不折算成漂移、也不静默丢弃（分母少了比红了危险）。
 *   - 证据优先由重放自己铸造的 stamp（内容 sha256）给出；没有 stamp 时退回日志 mtime，
 *     并如实标注 proxy —— mtime 看不见保时间戳的内容改写。
 *
 * 用法：
 *   node scripts/chain-baseline/replay-freshness.cjs                # 核对
 *   node scripts/chain-baseline/replay-freshness.cjs --mint         # 重放跑绿后铸造 stamp
 *   node scripts/chain-baseline/replay-freshness.cjs --self-test    # 判据自测（正向 + 注入）
 *   node scripts/chain-baseline/replay-freshness.cjs --explain-scope # 逐桶给数，并列出 spec-dep 是谁拉进来的
 *
 * 退出码：0 覆盖内无漂移 / 1 覆盖内有漂移（基线读数不可引用）/ 3 无证据或证据不完整（不可判，绝不当通过）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { createRequire } = require('module');

const REPO = path.resolve(__dirname, '..', '..');
const STAMP = path.join('tmp', 'chain-baseline', 'replay-stamp.json');
const EVIDENCE_LOGS = [
  path.join('tmp', 'chain-baseline', 'e2e-logs', 'chain-specs-requiretx.log'),
  path.join('tmp', 'chain-baseline', 'e2e-logs', 'chain-specs.log'),
  path.join('tmp', 'chain-baseline', 'e2e-logs', 'edge-shutdown.log'),
];
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.yaml', '.yml', '.json', '.sql']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage', '.turbo']);

// 目录桶：键 = 桶名，值 = {dir 相对路径, 排除前缀}
const DIR_BUCKETS = [
  ['server', 'ewoh-spark-app/server'],
  ['shared', 'ewoh-spark-app/shared'],
  ['edge', 'src/edge_platform'],
  ['db', 'db'],
  ['contracts', 'contracts'],
  ['openapi', 'openapi'],
  ['harness', 'scripts/chain-baseline'],
];
const OUT_OF_SCOPE = [
  'ewoh-spark-app/client',
  'ewoh-feishu-app',
  'docs',
  'deliverables',
  'delivery',
  'release',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function walk(absDir, relDir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, rel, acc);
    else if (ent.isFile() && EXTS.has(path.extname(ent.name))) acc.push(rel);
  }
  return acc;
}
function readIfExists(root, rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

// ---- harness 解析：范围分母必须来自重放脚本本身，不然后面改清单时这里会悄悄少算 ----
function parseChainSpecs(root) {
  const sh = readIfExists(root, 'scripts/chain-baseline/verify.sh');
  if (sh === null) return { specs: null, error: 'verify.sh 缺失' };
  const m = sh.match(/CHAIN_SPECS="([\s\S]*?)"/);
  if (!m) return { specs: null, error: '解析不到 CHAIN_SPECS' };
  const names = m[1]
    .replace(/\\\n/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (names.length < 5) return { specs: null, error: `CHAIN_SPECS 只解析到 ${names.length} 个，判据不完整` };
  return {
    specs: names.map((n) => ({ bucket: 'chain-spec', rel: `ewoh-spark-app/test/e2e/${n}.e2e.spec.ts` })),
    names,
  };
}
function parseScenarioScripts(root) {
  const sh = readIfExists(root, 'scripts/chain-baseline/verify.sh');
  if (sh === null) return { files: null, error: 'verify.sh 缺失' };
  // 权威默认清单在 `[ -n … ] || SCENARIOS="golden wave …"` 这一行：行首锚定只会抓到空的初始化式
  // （matrix-check 在 V109 为同一件事踩过坑），所以这里不限定行首，只取"最长的非空右值"。
  let best = '';
  for (const m of sh.matchAll(/SCENARIOS="([^"]*)"/g)) {
    if (m[1].trim().length > best.trim().length) best = m[1];
  }
  const names = best.split(/\s+/).filter(Boolean);
  if (names.length < 5) return { files: null, error: `SCENARIOS 只解析到 ${names.length} 个，判据不完整` };
  let pkg = null;
  try {
    pkg = JSON.parse(readIfExists(root, 'ewoh-spark-app/package.json')).scripts;
  } catch (e) {
    return { files: null, error: 'package.json 不可解析' };
  }
  const files = [];
  const unresolved = [];
  for (const n of names) {
    const cmd = pkg[`e2e:${n}`];
    if (!cmd) {
      unresolved.push(n);
      continue;
    }
    for (const tok of cmd.split(/\s+/)) {
      if (/^(test|src|scripts)\//.test(tok) && EXTS.has(path.extname(tok))) {
        files.push({ bucket: 'scenario', rel: `ewoh-spark-app/${tok}` });
      }
    }
  }
  if (unresolved.length) return { files: null, error: `场景脚本无法解析：${unresolved.join(', ')}` };
  return { files, names };
}

// ---- spec-dep 桶：重放「真正载入的文件」必须进覆盖集（COVSET-01／V321）----
// 为什么要有这个桶：七个目录桶里没有 ewoh-spark-app/test 的非 spec 文件，而 chain-spec 桶只按
// CHAIN_SPECS 名单收 spec 本身 ⇒ 常驻 spec 运行时 import 的共用件（test/helpers/*.ts、
// test/e2e/helpers/*.mjs）被改坏时，stamp 仍对着一份"看不见它"的树判新鲜。
// 为什么沿闭包而不是补一个 test/ 目录：test/helpers/ 里只有部分文件被链级 spec 载入，其余只被
// test/unit 与 test/browser 消费 ⇒ 按目录补会为"改了单测夹具"判红链级重放（假红面，V320 实测 6 个）。
// 解析件沿用仓内既有形状（TypeScript Compiler API，先例 status-target-states.cjs:27）⇒ 不新增依赖。
const SPEC_DEP_BUCKET = 'spec-dep';
const DEP_CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.js', '/index.mjs'];

function loadTsLib() {
  // 自测跑在临时 fixture 根上，而解析件是**宿主工具链**、不属于被分析的那棵树 ⇒ 一律从真仓库取。
  if (process.env.EWOH_FRESHNESS_NO_TS === '1') {
    return { ts: null, error: '取不到 typescript 解析件（注入档）⇒ 覆盖集的 import 闭包解析不了，不缩分母' };
  }
  try {
    return { ts: createRequire(path.join(REPO, 'ewoh-spark-app/package.json'))('typescript'), error: null };
  } catch (e) {
    return { ts: null, error: `取不到 typescript 解析件（${e.message.split('\n')[0]}）⇒ 覆盖集的 import 闭包解析不了，不缩分母` };
  }
}

/** 一个文件里的全部模块说明符：静态 import/export-from、require(...)、动态 import(...)。 */
function moduleSpecifiers(ts, text, file) {
  const out = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const strOf = (n) => (n && ts.isStringLiteral(n) ? n.text : n && ts.isNoSubstitutionTemplateLiteral && ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null);
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const s = strOf(n.moduleSpecifier);
      if (s) out.push(s);
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const viaRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const viaDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((viaRequire || viaDynamicImport) && n.arguments.length) {
        const s = strOf(n.arguments[0]);
        if (s) out.push(s);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** 只认相对说明符：外部包与 node_modules 不是本量的问题（那属依赖清单，另行裁决）。 */
function resolveRelativeDep(root, fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const suffix of DEP_CANDIDATE_SUFFIXES) {
    const cand = base + suffix;
    const abs = path.join(root, cand);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { rel: cand };
  }
  return { unresolved: { from: fromRel, spec } };
}

/**
 * 从入口（常驻链级 spec ＋ 场景脚本）做 BFS，返回「被重放载入、但不在既有桶里」的文件清单。
 * 解析不到的相对说明符一律点名（既不折算成漂移，也不静默丢）。
 */
function parseSpecDepClosure(root, entryRels) {
  const { ts, error } = loadTsLib();
  if (!ts) return { error };
  const entries = new Set(entryRels);
  const pulledBy = new Map();
  const unresolved = [];
  const queue = [...entries].filter((r) => fs.existsSync(path.join(root, r)));
  const visited = new Set(queue);
  let parsed = 0;
  while (queue.length) {
    const f = queue.shift();
    const text = readIfExists(root, f);
    if (text === null) continue;
    let specs;
    try {
      specs = moduleSpecifiers(ts, text, f);
      parsed += 1;
    } catch (e) {
      unresolved.push({ from: f, spec: `(解析异常：${e.message.split('\n')[0].slice(0, 60)})` });
      continue;
    }
    for (const s of specs) {
      if (!s.startsWith('.')) continue;
      const r = resolveRelativeDep(root, f, s);
      if (r.unresolved) { unresolved.push(r.unresolved); continue; }
      if (entries.has(r.rel)) continue;
      if (!pulledBy.has(r.rel)) {
        pulledBy.set(r.rel, f);
        if (!visited.has(r.rel)) { visited.add(r.rel); queue.push(r.rel); }
      }
    }
  }
  return {
    deps: [...pulledBy.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([rel, by]) => ({ rel, bucket: SPEC_DEP_BUCKET, pulledBy: by })),
    unresolved,
    visitedCount: visited.size,
    parsedCount: parsed,
  };
}

function collectScope(root) {
  const specs = parseChainSpecs(root);
  const scen = parseScenarioScripts(root);
  if (specs.error) return { error: specs.error };
  if (scen.error) return { error: scen.error };
  const list = [];
  for (const s of specs.specs) list.push(s);
  for (const s of scen.files) list.push(s);
  for (const [bucket, relDir] of DIR_BUCKETS) {
    for (const rel of walk(path.join(root, relDir), relDir, [])) list.push({ bucket, rel });
  }
  for (const extra of ['Makefile', 'scripts/chain-baseline/verify.sh']) {
    if (fs.existsSync(path.join(root, extra))) list.push({ bucket: 'harness', rel: extra });
  }
  const seen = new Map();
  for (const it of list) seen.set(it.rel, it.bucket);
  // spec-dep 必须在既有桶之后登记：闭包会大量穿过 server/shared 的文件，那些早已按目录桶在集内，
  // 这一桶只收"既有桶没盖住"的那批（读数分两半报，别把 377 说成 7）。
  const entryRels = [...list].filter((it) => it.bucket === 'chain-spec' || it.bucket === 'scenario').map((it) => it.rel);
  const closure = parseSpecDepClosure(root, entryRels);
  if (closure.error) return { error: closure.error };
  const newDeps = closure.deps.filter((d) => !seen.has(d.rel));
  for (const d of newDeps) seen.set(d.rel, SPEC_DEP_BUCKET);
  const missing = [...seen.keys()].filter((rel) => !fs.existsSync(path.join(root, rel)));
  return {
    files: [...seen.keys()].sort().map((rel) => ({ rel, bucket: seen.get(rel) })),
    missing,
    specDeps: newDeps,
    depsCoveredElsewhere: closure.deps.length - newDeps.length,
    unresolved: closure.unresolved,
    closureVisited: closure.visitedCount,
    closureParsed: closure.parsedCount,
  };
}

function digestOf(root, files) {
  const out = {};
  for (const f of files) {
    const abs = path.join(root, f.rel);
    if (fs.existsSync(abs)) out[f.rel] = sha256(abs);
  }
  return out;
}
function gitInfo(root) {
  if (path.resolve(root) !== REPO) return { git_head: null, dirty_files: null };
  const run = (args) => {
    try {
      return cp.execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().trim();
    } catch (e) {
      return null;
    }
  };
  const head = run(['rev-parse', 'HEAD']);
  const st = run(['status', '--porcelain']);
  return { git_head: head, dirty_files: st === null ? null : st.split('\n').filter(Boolean).length };
}

function newestEvidence(root) {
  let best = null;
  for (const rel of EVIDENCE_LOGS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (!best || st.mtimeMs > best.mtimeMs) best = { rel, mtimeMs: st.mtimeMs };
  }
  return best;
}

function decide(scopeFiles, stamp, opts) {
  const bucketOf = new Map(scopeFiles.map((f) => [f.rel, f.bucket]));
  const cur = opts.currentDigest;
  const changed = [];
  const added = [];
  const removed = [];
  const keys = new Set([...Object.keys(cur), ...Object.keys(stamp.digest)]);
  for (const rel of [...keys].sort()) {
    if (rel.startsWith('tmp/')) continue;
    const a = cur[rel];
    const b = stamp.digest[rel];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) removed.push(rel);
    else if (b === undefined) added.push(rel);
    else if (a !== b) changed.push(rel);
  }
  const drift = { changed, added, removed };
  const byBucket = {};
  for (const rel of [...changed, ...added, ...removed]) {
    const b = bucketOf.get(rel) || 'other';
    byBucket[b] = (byBucket[b] || 0) + 1;
  }
  return { drift, byBucket };
}

function proxyCheck(root, scopeFiles, evidence) {
  const bad = [];
  for (const f of scopeFiles) {
    const abs = path.join(root, f.rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).mtimeMs > evidence.mtimeMs) bad.push(f.rel);
  }
  return bad;
}

function runCheck(root, stampPath, io) {
  const scope = collectScope(root);
  if (scope.error) {
    io.log(`❌ 覆盖范围解析失败：${scope.error} —— 判据不完整时不出结论`);
    return 3;
  }
  if (scope.missing.length) {
    io.log(`❌ 范围分母里有 ${scope.missing.length} 个不存在的文件（首个：${scope.missing[0]}）—— 不可判，绝不折算成「无漂移」`);
    scope.missing.slice(0, 5).forEach((r) => io.log(`   · ${r}`));
    return 3;
  }
  const bucketCount = {};
  for (const f of scope.files) bucketCount[f.bucket] = (bucketCount[f.bucket] || 0) + 1;
  io.log(`覆盖范围（现算）：${scope.files.length} 个文件 · ${Object.keys(bucketCount).length} 桶`);
  io.log('  ' + Object.entries(bucketCount).map(([k, v]) => `${k}=${v}`).join(' · '));
  const sd = scope.specDeps || [];
  const un = scope.unresolved || [];
  io.log(`  spec-dep 桶＝经 import 闭包载入、既有桶没盖住的文件 ${sd.length} 个（另有 ${scope.depsCoveredElsewhere || 0} 个被闭包穿过但已在 server/shared 等桶里的文件，不重复计入；闭包可达 ${scope.closureVisited}／解析 ${scope.closureParsed}）；解析不到的相对说明符 ${un.length} 处`);
  sd.slice(0, 8).forEach((d) => io.log(`     · ${d.rel} ← ${d.pulledBy}`));
  if (sd.length > 8) io.log(`     … 其余 ${sd.length - 8} 个略（全量见 --explain-scope）`);
  un.slice(0, 5).forEach((u) => io.log(`     ! 解析不到：${u.from} → ${u.spec}（点名，不折算成漂移、不静默丢）`));

  const stampRaw = readIfExists(root, stampPath);
  if (!stampRaw) {
    const evidence = newestEvidence(root);
    if (!evidence) {
      io.log('❌ 既无重放 stamp 也无任何重放日志 ⇒ 不可判（不是「干净」）');
      return 3;
    }
    io.log(`⚠ 无 stamp，退回 mtime proxy（证据：${evidence.rel}）。proxy 看不见保时间戳的内容改写。`);
    io.log(`  证据时间：${new Date(evidence.mtimeMs).toISOString()}`);
    const bad = proxyCheck(root, scope.files, evidence);
    if (!bad.length) {
      io.log('✅ proxy 口径：覆盖范围内无更新文件（要内容级判定，请在重放跑绿后 --mint）');
      return 0;
    }
    io.log(`❌ proxy 口径：覆盖范围内有 ${bad.length} 个文件晚于该证据 ⇒ 基线读数不可引用，需重跑：`);
    bad.slice(0, 20).forEach((r) => io.log(`   · ${r}`));
    if (bad.length > 20) io.log(`   … 其余 ${bad.length - 20} 个略`);
    return 1;
  }
  let stamp;
  try {
    stamp = JSON.parse(stampRaw);
    if (!stamp || typeof stamp.digest !== 'object' || !Object.keys(stamp.digest).length) throw new Error('digest 为空');
  } catch (e) {
    io.log(`❌ stamp 不可用（${e.message}）⇒ 不可判`);
    return 3;
  }
  const current = digestOf(root, scope.files);
  const { drift, byBucket } = decide(scope.files, stamp, { currentDigest: current });
  io.log(`stamp：${stampPath}（重放完成于 ${stamp.completed_at || '?'}，HEAD ${(stamp.git_head || '?').slice(0, 8)}，脏文件 ${stamp.dirty_files}）`);
  const total = drift.changed.length + drift.added.length + drift.removed.length;
  if (!total) {
    io.log(`✅ 新鲜：最近一次全量重放覆盖今日工作树（覆盖范围内 ${scope.files.length} 个文件内容逐一相同；范围外的前端/侧车/文档改动不影响该结论）`);
    return 0;
  }
  io.log(`❌ 覆盖内有漂移 ${total} 处 ⇒ 登记册引用的重放读数不可引用，需重跑：`);
  for (const [b, n] of Object.entries(byBucket)) io.log(`   · ${b}: ${n}`);
  const show = (title, arr) => {
    if (!arr.length) return;
    io.log(`  ${title}（${arr.length}）：`);
    arr.slice(0, 15).forEach((r) => io.log(`     - ${r}`));
    if (arr.length > 15) io.log(`     … 其余 ${arr.length - 15} 个略`);
  };
  show('内容有改动', drift.changed);
  show('新增', drift.added);
  show('消失', drift.removed);
  return 1;
}

function runMint(root, stampPath) {
  const scope = collectScope(root);
  if (scope.error) {
    console.log(`❌ 覆盖范围解析失败：${scope.error}`);
    return 3;
  }
  if (scope.missing.length) {
    console.log(`❌ 范围里有 ${scope.missing.length} 个不存在的文件，拒绝铸造`);
    return 3;
  }
  const digest = digestOf(root, scope.files);
  const git = gitInfo(root);
  const payload = {
    completed_at: new Date().toISOString(),
    git_head: git.git_head,
    dirty_files: git.dirty_files,
    evidence_logs: EVIDENCE_LOGS.filter((r) => fs.existsSync(path.join(root, r))),
    files: scope.files.length,
    digest,
  };
  const abs = path.join(root, stampPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(payload, null, 0) + '\n');
  console.log(`✅ 已铸造 stamp：${stampPath}（${scope.files.length} 个文件，HEAD ${(payload.git_head || '?').slice(0, 8)}）`);
  return 0;
}

// ---------------- 判据自测 ----------------
function makeFixture(root) {
  const w = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  w(
    'scripts/chain-baseline/verify.sh',
    [
      'SCENARIOS=""',
      '[ -n "${SCENARIOS// /}" ] || SCENARIOS="golden wave control-actuator receipt edge"',
      'CHAIN_SPECS="alpha-beta \\',
      'gamma-delta epsilon-zeta \\',
      'eta-theta iota-kappa"',
    ].join('\n') + '\n',
  );
  w('ewoh-spark-app/package.json', JSON.stringify({ scripts: { 'e2e:golden': 'node test/e2e/golden-path-verify.mjs', 'e2e:wave': 'node test/e2e/wave.mjs', 'e2e:control-actuator': 'node test/e2e/loop.mjs', 'e2e:receipt': 'node test/e2e/rc.mjs', 'e2e:edge': 'node test/e2e/edge.mjs' } }));
  w('ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts', 'it("a",()=>{});\n');
  w('ewoh-spark-app/test/e2e/gamma-delta.e2e.spec.ts', 'it("g",()=>{});\n');
  w('ewoh-spark-app/test/e2e/epsilon-zeta.e2e.spec.ts', 'it("e",()=>{});\n');
  w('ewoh-spark-app/test/e2e/eta-theta.e2e.spec.ts', 'it("t",()=>{});\n');
  w('ewoh-spark-app/test/e2e/iota-kappa.e2e.spec.ts', 'it("i",()=>{});\n');
  w('ewoh-spark-app/test/e2e/golden-path-verify.mjs', 'console.log(1);\n');
  w('ewoh-spark-app/test/e2e/wave.mjs', 'console.log(2);\n');
  w('ewoh-spark-app/test/e2e/loop.mjs', 'console.log(3);\n');
  w('ewoh-spark-app/test/e2e/rc.mjs', 'console.log(4);\n');
  w('ewoh-spark-app/test/e2e/edge.mjs', 'console.log(5);\n');
  w('ewoh-spark-app/server/main.ts', 'export const x=1;\n');
  w('db/migrations/001.sql', 'CREATE TABLE t(a int);\n');
  w('src/edge_platform/run.py', 'print(1)\n');
  w('contracts/state-machines/plan.yaml', 'states: [a]\n');
  w('Makefile', 'chain-baseline-verify:\n\tbash x\n');
  w('docs/notes.md', '范围外\n');
}
function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function selfTest(io) {
  const base = path.join(REPO, 'tmp', 'v181-fixture');
  rmrf(base);
  const cases = [];
  const build = (name) => {
    const root = path.join(base, name);
    makeFixture(root);
    return root;
  };
  const quiet = [];
  const capture = { log: (s) => quiet.push(s) };

  const fresh = build('fresh');
  let rc = runMint(fresh, STAMP);
  cases.push(['正向：先铸 stamp 再核对必须判新鲜（能开火的量具）', rc === 0 && runCheck(fresh, STAMP, capture) === 0]);

  const content = build('content');
  runMint(content, STAMP);
  const baseRc = runCheck(content, STAMP, capture);
  fs.appendFileSync(path.join(content, 'db/migrations/001.sql'), '-- injected\n');
  cases.push(['注入：范围内容有改动 ⇒ 判漂移（与干净对照不同）', baseRc === 0 && runCheck(content, STAMP, capture) === 1]);

  const added = build('added');
  runMint(added, STAMP);
  fs.writeFileSync(path.join(added, 'ewoh-spark-app/server/extra.ts'), 'export const y=2;\n');
  cases.push(['注入：范围内新增文件 ⇒ 判漂移', runCheck(added, STAMP, capture) === 1]);

  const removed = build('removed');
  runMint(removed, STAMP);
  fs.rmSync(path.join(removed, 'src/edge_platform/run.py'));
  cases.push(['注入：范围内文件消失 ⇒ 判漂移', runCheck(removed, STAMP, capture) === 1]);

  const outside = build('outside');
  runMint(outside, STAMP);
  fs.appendFileSync(path.join(outside, 'docs/notes.md'), '范围外也改了\n');
  cases.push(['对照：范围外文件改动 ⇒ 仍判新鲜（证明范围过滤不是摆设）', runCheck(outside, STAMP, capture) === 0]);

  const corrupt = build('corrupt');
  runMint(corrupt, STAMP);
  fs.writeFileSync(path.join(corrupt, STAMP), '{ not json');
  cases.push(['注入：stamp 损坏 ⇒ 不可判（3），不得读成通过', runCheck(corrupt, STAMP, capture) === 3]);

  const nosupport = build('nosupport');
  cases.push(['对照：无 stamp 且无重放日志 ⇒ 不可判（3）', runCheck(nosupport, STAMP, capture) === 3]);

  const proxy = build('proxy');
  const logDir = path.join(proxy, 'tmp', 'chain-baseline', 'e2e-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const lg = path.join(logDir, 'chain-specs.log');
  fs.writeFileSync(lg, 'Tests: 70 passed\n');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lg, old, old);
  cases.push(['proxy：日志比范围文件新 ⇒ 判漂移', runCheck(proxy, STAMP, capture) === 1]);
  for (const f of collectScope(proxy).files) {
    const abs = path.join(proxy, f.rel);
    fs.utimesSync(abs, old, old);
  }
  cases.push(['proxy：全部范围文件都比证据旧 ⇒ 判新鲜', runCheck(proxy, STAMP, capture) === 0]);

  const broken = build('broken');
  runMint(broken, STAMP);
  fs.rmSync(path.join(broken, 'ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts'));
  cases.push(['注入：清单指向不存在的 spec ⇒ 不可判（3），不缩分母', runCheck(broken, STAMP, capture) === 3]);

  const empty = build('empty');
  fs.writeFileSync(path.join(empty, 'scripts/chain-baseline/verify.sh'), 'SCENARIOS=""\nCHAIN_SPECS=""\n');
  cases.push(['注入：解析不到 CHAIN_SPECS ⇒ 不可判（3）', runCheck(empty, STAMP, capture) === 3]);

  // ── spec-dep 桶（COVSET-01／V321）：闭包内的必须进集、闭包外的不许进集、解析不到的只点名 ──
  const wf = (root, rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const withDeps = (name) => {
    const root = build(name);
    wf(root, 'ewoh-spark-app/test/helpers/e2e-app.ts', 'export const h = 1;\n');
    wf(root, 'ewoh-spark-app/test/helpers/deep-second.ts', 'export const d = 2;\n');
    wf(root, 'ewoh-spark-app/test/helpers/unused-fixture.ts', 'export const u = 3;\n');
    fs.appendFileSync(path.join(root, 'ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts'),
      "import { h } from '../helpers/e2e-app';\n");
    fs.appendFileSync(path.join(root, 'ewoh-spark-app/test/helpers/e2e-app.ts'),
      "export * from './deep-second';\n");
    return root;
  };
  const probe = withDeps('dep-probe');
  const probeScope = collectScope(probe);
  const depRels = probeScope.specDeps.map((d) => d.rel);
  cases.push(['闭包·正向：spec 直接 import 的 helper 进 spec-dep 桶（且记着是谁拉进来的）',
    depRels.includes('ewoh-spark-app/test/helpers/e2e-app.ts')
      && (probeScope.specDeps.find((d) => d.rel.endsWith('e2e-app.ts')) || {}).pulledBy
        === 'ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts']);
  cases.push(['闭包·传递：helper 再 export-from 的第二层也进桶（两跳，不是只看一层）',
    depRels.includes('ewoh-spark-app/test/helpers/deep-second.ts')]);
  cases.push(['闭包·假红面对照：同目录里没人 import 的文件不得进桶（"按目录补"那一档必须被拒）',
    !depRels.includes('ewoh-spark-app/test/helpers/unused-fixture.ts')]);

  const dup = withDeps('dep-dup');
  fs.appendFileSync(path.join(dup, 'ewoh-spark-app/test/e2e/epsilon-zeta.e2e.spec.ts'),
    "import { x } from '../../server/main';\n");
  const dupScope = collectScope(dup);
  cases.push(['闭包·去重：穿过的文件已在 server 桶里 ⇒ 记为"被别的桶盖住"，不虚增 spec-dep 分母',
    dupScope.depsCoveredElsewhere >= 1
      && !dupScope.specDeps.some((d) => d.rel.startsWith('ewoh-spark-app/server/'))
      && dupScope.files.some((f2) => f2.rel === 'ewoh-spark-app/server/main.ts' && f2.bucket === 'server')]);

  const injDep = withDeps('dep-inject');
  runMint(injDep, STAMP);
  fs.appendFileSync(path.join(injDep, 'ewoh-spark-app/test/helpers/e2e-app.ts'), '// injected\n');
  cases.push(['注入·闭包内：改被载入的 helper ⇒ 判漂移（这把尺现在真看得见共用件）',
    runCheck(injDep, STAMP, capture) === 1]);

  const safeDep = withDeps('dep-safe');
  runMint(safeDep, STAMP);
  fs.appendFileSync(path.join(safeDep, 'ewoh-spark-app/test/helpers/unused-fixture.ts'), '// 只被单测消费\n');
  cases.push(['对照·闭包外：改同目录但无人 import 的夹具 ⇒ 仍判新鲜（不替单测夹具判红链级重放）',
    runCheck(safeDep, STAMP, capture) === 0]);

  const badSpec = withDeps('dep-unresolved');
  fs.appendFileSync(path.join(badSpec, 'ewoh-spark-app/test/e2e/gamma-delta.e2e.spec.ts'),
    "import oops from './nope-not-here';\n");
  const badScope = collectScope(badSpec);
  runMint(badSpec, STAMP);
  cases.push(['注入·解析不到：相对说明符落不到磁盘文件 ⇒ 逐条点名且不折算成漂移（仍判新鲜）',
    badScope.unresolved.length === 1 && badScope.unresolved[0].spec === './nope-not-here'
      && runCheck(badSpec, STAMP, capture) === 0]);

  const savedNoTs = process.env.EWOH_FRESHNESS_NO_TS;
  process.env.EWOH_FRESHNESS_NO_TS = '1';
  const noTsRc = runCheck(withDeps('dep-nots'), STAMP, capture);
  if (savedNoTs === undefined) delete process.env.EWOH_FRESHNESS_NO_TS;
  else process.env.EWOH_FRESHNESS_NO_TS = savedNoTs;
  cases.push(['注入·解析件缺失：取不到 typescript ⇒ 不可判（3），绝不把闭包那批静默缩出分母',
    noTsRc === 3]);

  rmrf(base);
  let ok = true;
  for (const [name, pass] of cases) {
    console.log(`${pass ? '  ✅' : '  ❌'} ${name}`);
    if (!pass) ok = false;
  }
  console.log(`${ok ? '✅' : '❌'} replay-freshness 判据自测 ${cases.length} 项（条数由本脚本自报：1 正向铸造 + 范围注入/对照 + 证据缺失 + proxy 双向 + 分母完整性 + spec-dep 闭包五支〔桶内/两跳传递/同目录不开火/穿过的不重复计入/改它判红〕+ 解析不到只点名 + 解析件缺失判不可判）`);
  return ok ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest(console));
  if (argv.includes('--scope-count')) {
    const scope = collectScope(REPO);
    if (scope.error) { console.log(`0 # ${scope.error}`); process.exit(3); }
    console.log(String(scope.files.length));
    process.exit(0);
  }
  if (argv.includes('--explain-scope')) {
    const scope = collectScope(REPO);
    if (scope.error) { console.log(`❌ 不可判：${scope.error}`); process.exit(3); }
    const bc = {};
    for (const f of scope.files) bc[f.bucket] = (bc[f.bucket] || 0) + 1;
    console.log(`覆盖范围（现算）：${scope.files.length} 个文件 · ${Object.keys(bc).length} 桶`);
    console.log('  ' + Object.entries(bc).map(([k, v]) => `${k}=${v}`).join(' · '));
    console.log(`闭包：入口可达 ${scope.closureVisited} 个文件、解析 ${scope.closureParsed} 个，`
      + `穿过且已被 server/shared 等桶盖住 ${scope.depsCoveredElsewhere} 个（不重复计入）；`
      + `spec-dep 桶新入集 ${scope.specDeps.length} 个；解析不到的相对说明符 ${scope.unresolved.length} 处`);
    scope.specDeps.forEach((d) => console.log(`   · ${d.rel}  ← 由 ${d.pulledBy} 载入`));
    scope.unresolved.forEach((u) => console.log(`   ! 解析不到：${u.from} → ${u.spec}`));
    process.exit(0);
  }
  const io = console;
  if (argv.includes('--mint')) process.exit(runMint(REPO, STAMP, io));
  process.exit(runCheck(REPO, STAMP, io));
}
if (require.main === module) main();
module.exports = { collectScope, runCheck, runMint, parseSpecDepClosure, moduleSpecifiers };
