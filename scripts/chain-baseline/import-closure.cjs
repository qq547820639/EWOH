#!/usr/bin/env node
/**
 * import-closure.cjs —— 只回答一个问题：**某个文件有没有被测试代码经 import/require 链间接载入**。
 *
 * 动因（V340，ENTAX-01 的第二问）：`chain-baseline-change-amplification` 的「链外机器入口」原先四面
 * （Makefile 配方／package.json 脚本／CI workflow／shell 脚本／tests/*.py／jest 档／仓内量具读取）
 * 都只认"这份文件被直接点名"，于是 `client/src/**` 那批非测试源文件明明被常驻测试经 import 图载入并执行，
 * 读数里仍算「已扫面内无入口」。一次性探针给的量级：594 个测试入口的闭包拉到 718 个文件
 * （其中 `client/src/**` 300 个、资源类 0 个），而现行闭包把非相对说明符整批静默跳过。
 *
 * 三条设计前提（都由本轮实测挑定，见《基线》§5.3n48）：
 *  1) 解析交给 TypeScript 自己的 `ts.resolveModuleName`，不重抄一张别名表：别名权威在
 *     `ewoh-spark-app/tsconfig.app.json` 的 `paths`（`@client/*`→`client/*`、`@/*`→`./client/src/*`、
 *     `@shared/*`→`shared/*`；实测仓内 `@shared/api.interface` 127 处、`@client/src/...` 49 处）。
 *  2) **不能**用 `ts.parseJsonConfigFileContent` 吐出来的 options：本机实测它把 baseUrl/paths 丢了
 *     （`extends` 指向 `@lark-apaas/fullstack-presets/...`，解析不出也不报错）⇒ 用它所有别名一律 null，
 *     正是这一族假阴的机械成因。这里自己读原始 JSON（容尾逗号）再把 baseUrl 指到 `ewoh-spark-app/`。
 *  3) 非相对说明符分两档：命中 paths 的算一条边；**没命中的点名进 `unresolved`，绝不静默跳过**
 *     （现行 `replay-freshness.parseSpecDepClosure` 的 `if (!s.startsWith('.')) continue;` 就是静默那一支）。
 *
 * 限度（不许读成"覆盖面已穷尽"）：
 *  - 只看静态说明符字面量：`require(varName)`、`await import(表达式)` 读不到 ⇒ 下界；
 *  - 包说明符（node_modules）一律不计，本尺只关心仓内文件；
 *  - 入口清单由调用方给（`--entries <file.json>`）。`--entries-from-jest` 才去跑 jest 的 `--listTests`
 *    取权威档 ⇒ **默认不 spawn jest**（判据自测与注入档都不碰真语料）。
 *  - 取不到 typescript 解析件 ⇒ rc=3 不可判，不读成"没有闭包"。
 */
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const { moduleSpecifiers } = require('./replay-freshness.cjs');

const SUF = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '/index.ts', '/index.tsx', '/index.js'];
const RESOURCE = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|eot)$/i;

function loadTs() {
  const p = path.join(REPO, 'ewoh-spark-app', 'node_modules', 'typescript');
  try { return { ts: require(p) }; } catch (e) { return { ts: null, error: e.message.split('\n')[0] }; }
}

/** 别名权威表：原始 tsconfig 的 baseUrl＋paths（尾逗号容错），baseUrl 缺省时按 tsconfig 所在目录。 */
function aliasOptions(root, tsconfigRel, ts) {
  const abs = path.join(root, tsconfigRel);
  if (!fs.existsSync(abs)) return { error: `取不到 ${tsconfigRel}` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/,\s*([\]}])/g, '$1')); }
  catch (e) { return { error: `${tsconfigRel} 解析失败：${e.message.split('\n')[0]}` }; }
  const co = (raw && raw.compilerOptions) || {};
  const baseAbs = path.join(path.dirname(abs), co.baseUrl || '.');
  // moduleResolution 必须显式给：实测不给时 ts.resolveModuleName 对 paths 别名一律返回空
  // （TS 缺省走 Classic，不看 node 的目录布局），这一档漏掉就等于别名面整件隐身。
  const options = { baseUrl: baseAbs, paths: co.paths || {}, allowJs: true, resolveJsonModule: true,
    moduleResolution: ts && ts.ModuleResolutionKind ? ts.ModuleResolutionKind.NodeJs : 2 };
  return { options, from: tsconfigRel };
}

/** paths 里是否存在能接住这个说明符的前缀（只用于判"别名没命中"还是"外部包"）。 */
function matchesPathPrefix(spec, paths) {
  for (const key of Object.keys(paths || {})) {
    if (key.endsWith('*') ? spec.startsWith(key.slice(0, -1)) : spec === key) return true;
  }
  return false;
}

function makeHost(ts, root) {
  return {
    fileExists: (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } },
    readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } },
    directoryExists: (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } },
    realpath: (p) => fs.realpathSync(p),
    getCurrentDirectory: () => root,
    getDirectories: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
  };
}

/** 一个说明符 → 仓内相对路径｜{package:true}｜{unresolved:原因}。 */
function resolveSpec(ts, root, fromRel, spec, options, host) {
  // 绝对路径判定必须整条锚定：写成 /^[a-zA-Z]:|[\\/]/ 时第二个候选没有 ^，
  // '@app/page' 这种带斜杠的别名会被当成"绝对路径"而整批误判（判据自测的第一支就是这么抓到它的）。
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(spec) && !spec.startsWith('.')) return { unresolved: `绝对路径说明符：${spec}` };
  const fromAbs = path.join(root, fromRel);
  const r = ts.resolveModuleName(spec, fromAbs, options, host);
  if (r && r.resolvedModule && r.resolvedModule.resolvedFileName) {
    const abs = r.resolvedModule.resolvedFileName;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel.startsWith('..') || rel.includes('/node_modules/')) return { package: true };
    if (r.resolvedModule.isExternalLibraryImport) return { package: true };
    return { rel };
  }
  // 兜底：手写后缀表只用于相对说明符（ts 认不出的怪形状）；非相对说明符不拿它硬凑，
  // 否则 '@app/x' 会被拼成 't/@app/x' 这种与实现无关的路径。
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const s of SUF) {
      const cand = base + s;
      try { if (fs.statSync(path.join(root, cand)).isFile()) {
        if (cand.includes('/node_modules/')) return { package: true };
        return { rel: cand };
      } } catch { /* 继续下一个候选 */ }
    }
    return { unresolved: `相对说明符解析不到：${spec}` };
  }
  // 非相对：paths 里有前缀却解析不到＝别名没命中，必须点名；根本没有那个前缀＝外部包，只计数。
  if (matchesPathPrefix(spec, options.paths)) return { unresolved: `paths 前缀命中但解析不到：${spec}` };
  return { package: true };
}

/** BFS：entries 必须是仓内相对路径数组。返回 deps（不含 entries 自身）与两张点名清单。 */
function closure(root, entries, opts) {
  const { ts, error } = loadTs();
  if (!ts) return { error: `取不到 typescript 解析件（${error}）⇒ 不可判，不读成零闭包` };
  const ao = opts && opts.options ? opts.options : aliasOptions(root, (opts && opts.tsconfig) || 'ewoh-spark-app/tsconfig.app.json', ts);
  if (ao.error) return { error: ao.error };
  const options = ao.options || ao;
  const host = makeHost(ts, root);
  const entrySet = new Set(entries);
  const deps = new Map();      // rel → { depth, by }
  const unresolved = [];
  const packages = new Map();  // spec → 出现处数
  // 入口清单里"盘上没有"的那些必须点名，不能静默过滤掉：V340 实测一次枚举器把子目录拼丢，
  // 533/593 个入口不存在，而闭包读数只是"少得看起来正常"——静默过滤会让这种错一路绿到底。
  const missingEntries = [];
  const queue = entries.filter((e) => {
    try { if (fs.statSync(path.join(root, e)).isFile()) return true; } catch { /* 落到点名 */ }
    missingEntries.push(e);
    return false;
  });
  const seen = new Set(queue);
  let parsed = 0, parseErrors = 0;
  while (queue.length) {
    const f = queue.shift();
    const depth = deps.has(f) ? deps.get(f).depth : 0;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    let specs;
    try { specs = moduleSpecifiers(ts, text, f); parsed += 1; }
    catch (e) { parseErrors += 1; unresolved.push({ from: f, spec: `(解析异常：${String(e.message).split('\n')[0].slice(0, 60)})` }); continue; }
    for (const s of specs) {
      const r = resolveSpec(ts, root, f, s, options, host);
      if (r.package) { packages.set(s, (packages.get(s) || 0) + 1); continue; }
      if (r.unresolved) { unresolved.push({ from: f, spec: s, why: r.unresolved }); continue; }
      if (entrySet.has(r.rel) || deps.has(r.rel)) continue;
      deps.set(r.rel, { depth: depth + 1, by: f });
      if (!seen.has(r.rel) && !RESOURCE.test(r.rel)) { seen.add(r.rel); queue.push(r.rel); }
    }
  }
  return { deps, unresolved, packages, parsed, parseErrors, missingEntries,
    aliasFrom: ao.from || (opts && opts.options ? '注入档' : '未知') };
}

function byDir(deps) {
  const c = {};
  for (const rel of deps.keys()) {
    const k = rel.startsWith('ewoh-spark-app/') ? rel.split('/')[1] : rel.split('/')[0];
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function run(argv) {
  const selfTest = argv.includes('--self-test');
  if (selfTest) return selftest();
  const ei = argv.indexOf('--entries');
  if (!argv.includes('--entries-from-jest') && ei < 0) {
    console.log('[import-closure] 不可判：没给入口清单（--entries <file.json>，或显式 --entries-from-jest 去问 jest 权威档）');
    return 3;
  }
  let entries;
  if (ei >= 0) entries = JSON.parse(fs.readFileSync(argv[ei + 1], 'utf8'));
  else {
    const amp = require('./change-amplification.cjs');
    if (typeof amp.jestEntryFiles !== 'function') {
      console.log('[import-closure] 不可判：change-amplification 没导出 jestEntryFiles（入口清单的家搬了，不猜路径）');
      return 3;
    }
    entries = amp.jestEntryFiles();
    if (!entries) { console.log('[import-closure] 不可判：拿不到 jest 权威入口清单（jest 跑不起来或一份测试文件都没列到）'); return 3; }
  }
  const r = closure(REPO, entries);
  if (r.error) { console.log(`[import-closure] 不可判：${r.error}`); return 3; }
  const deps = [...r.deps.keys()].sort();
  const res = deps.filter((d) => RESOURCE.test(d));
  console.log(`[import-closure] 入口 ${entries.length} 个（别名表取自 ${r.aliasFrom}）｜闭包拉到 ${deps.length} 个仓内文件` +
    `（资源类 ${res.length} 个）｜解析 ${r.parsed} 个、解析异常 ${r.parseErrors} 个`);
  console.log(`  分布：${JSON.stringify(byDir(r.deps))}`);
  console.log(`  未命中的说明符点名 ${r.unresolved.length} 处（不静默跳过）；包说明符 ${r.packages.size} 种不计`);
  console.log(`  入口清单里盘上不存在的 ${r.missingEntries.length} 个（单列，不与"没拉到边"混成一格）`);
  for (const m of (r.missingEntries || []).slice(0, 5)) console.log(`    · 入口不存在：${m}`);
  if (r.missingEntries.length > 5) console.log(`    …另 ${r.missingEntries.length - 5} 个`);
  for (const u of r.unresolved.slice(0, 12)) console.log(`    · ${u.from} → ${u.spec}｜${u.why || ''}`);
  if (r.unresolved.length > 12) console.log(`    …另 ${r.unresolved.length - 12} 处`);
  if (argv.includes('--json')) {
    fs.writeFileSync(path.join(REPO, 'tmp/import-closure.json'),
      JSON.stringify({ entries: entries.length, deps: deps.map((d) => ({ rel: d, depth: r.deps.get(d).depth, by: r.deps.get(d).by })),
        unresolved: r.unresolved, packages: [...r.packages.entries()] }, null, 0));
  }
  return 0;
}

/** 判据自测：正向开火三支（相对／.d.ts／别名 @），不开火三支（包／盘上没有／资源不再往下带），点名一支。 */
function selftest() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imcl-'));
  const w = (rel, txt) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
  w('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@app/*': ['./src/*'] } } }));
  w('src/lib.ts', 'export const a=1;\n');
  w('src/types.d.ts', 'export interface T{x:number}\n');
  w('src/ui.css', '.a{color:red}\n');
  w('src/page.tsx', "import './ui.css';\nexport const P=1;\n");
  w('t/one.test.ts', "import { a } from '../src/lib';\nimport '../src/types';\nimport 'react';\nimport { P } from '@app/page';\n");
  w('t/two.test.ts', "import { nope } from '../src/does-not-exist';\nimport '@app/nothing-here';\n");
  const entries = ['t/one.test.ts', 't/two.test.ts', 't/ghost.test.ts'];
  const r = closure(root, entries, { tsconfig: 'tsconfig.json' });
  const got = [...r.deps.keys()].sort();
  const checks = [];
  const A = (name, ok, detail) => checks.push({ name, ok, detail });
  A('相对说明符必须成边', got.includes('src/lib.ts'), got.join(','));
  A('.d.ts 必须成边（现行手写后缀表读不到这一档）', got.includes('src/types.d.ts'), got.join(','));
  A('paths 别名必须成边', got.includes('src/page.tsx'), got.join(','));
  A('资源文件算一条边但不再往下带（没有以它为 by 的下级）',
    got.includes('src/ui.css') && ![...r.deps.values()].some((v) => v.by === 'src/ui.css'),
    `ui.css=${r.deps.get('src/ui.css') ? r.deps.get('src/ui.css').by : '缺'}`);
  A('包说明符不得计成仓内文件、但要被数进 packages', !got.some((g) => g.includes('react')) && r.packages.has('react'),
    `packages=${[...r.packages.keys()].join('|')}`);
  A('盘上不存在的相对说明符不得凭空造边', !got.some((g) => /does-not-exist|nothing-here/.test(g)), got.join(','));
  A('没命中的说明符只点名两类各一支（相对解析不到＋paths 前缀命中却找不到）',
    r.unresolved.length === 2 && r.unresolved.every((u) => u.spec && u.why) &&
    r.unresolved.some((u) => /^\.\./.test(u.spec)) && r.unresolved.some((u) => u.spec.startsWith('@app/')),
    JSON.stringify(r.unresolved.map((u) => `${u.spec}|${u.why}`)));
  A('入口清单里盘上不存在的入口必须单列点名（不静默过滤）', r.missingEntries.length === 1 && r.missingEntries[0] === 't/ghost.test.ts',
    JSON.stringify(r.missingEntries));
  const bad = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log(`  ${c.ok ? '✔' : '✗'} ${c.name}${c.ok ? '' : `（实得 ${c.detail}）`}`));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`[import-closure] 判据自测 ${checks.length - bad.length}/${checks.length} 通过`);
  return bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { closure, resolveSpec, aliasOptions, REPO };
