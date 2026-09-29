#!/usr/bin/env node
/**
 * alias-table-sync.cjs —— 只回答一个问题：**同一张路径别名表在几个面之间是不是同步的，
 * 以及每个常驻跑测入口能不能解析它自己语料里真正出现的那些别名。**
 *
 * 动因（V341）：别名在仓里不是一张表，而是**两类面各抄一份**——`tsconfig*.json` 的
 * `compilerOptions.paths`（tsc／vite／ts-jest 编译期解析靠它）与 jest 的 `moduleNameMapper`
 * （jest **运行期**解析只靠它：ts-jest 只按 tsconfig 编译，不会把 paths 变成 mapper）。
 * V340 只核了「`tsconfig.app.json` 与 `client/jest.config.cjs` 两处同值」，其余几面没人核过，
 * 而"以后只改一边"正是这一族唯一会发生的错法。本尺把全部面（tsconfig 若干份＋每一份 jest 配置，
 * **含没被任何配方接入的那些**＋`package.json#jest` 默认档）一次摆平。
 *
 * 三条设计前提（都由本轮实测挑定，见《基线》§5.3n49）：
 *  1) **比解析结果，不比字面**。tsconfig 的目标相对该文件自己声明的 `baseUrl`，jest 的目标相对该配置的
 *     `rootDir`（缺省＝配置所在**目录**）；两侧根不同，于是 `@/*`→`./client/src/*` 与
 *     `^@/(.*)$`→`<rootDir>/src/$1`（rootDir=client/）字面不等而目录相等。一律归一到绝对目录再比：
 *     拿字面比会凭空造红（夹具里第一支必须判红的控制正是靠这条区分才留得住）。
 *  2) **欠映射只按"该 runner 的语料真的走到"判**，不按集合差集判（差集会让每个 runner 都欠一片 `@client/*`）。
 *     闭包取自 `import-closure.cjs`，入口清单取自 jest 权威档 `--listTests`（V338），别名解析注入**该
 *     runner 的 ts-jest 自己指向的那份 tsconfig 的有效 paths**（否则 server 侧 `@server/*` 会被当成外部包、
 *     闭包直接读空）；那份 tsconfig 按 jest 语义相对 **rootDir** 解析，不是相对配置文件所在目录。
 *  3) mapper 里没有也不一定是缺陷：包作用域的别名（如 `@lark-apaas/client-toolkit/tools/*`）可能由包自己解得出。
 *     不靠猜——用 `require.resolve` 拿**真正写了那条说明符的文件**去解**那条说明符本身**：解得出＝交包解析
 *     （不判），解不出且 mapper 没有＝红。两个分支都是实测，不是语义推定。
 *
 * 限度（不许读成"别名面已穷尽"）：
 *  - `extends` 指向外部包（`@lark-apaas/fullstack-presets/...`）时**不展开**：那份在 node_modules 里，
 *     不带依赖的克隆读不到，展开它会让同一棵树在两种环境下给出不同读数。本仓三份带 paths 的 tsconfig
 *     都在自己文件里声明了 baseUrl＋paths，所以今天不减少读数；哪天有文件只靠继承拿 paths，它标
 *     `inheritedOnly` 并写明"只作参考"，不读成"这份文件没有别名"。
 *  - 只认 `paths` 的 `prefix/*`→`dir/*` 形状与 mapper 的 `^prefix(.*)$`→`dir/$1` 形状；别的形状逐条点名不可判。
 *  - mapper 的值若是函数调用（已按 `pathsToModuleNameMapper` 改成生成档）⇒ 该面记「生成档」：没有第二份
 *     抄本可比，覆盖判定转不可判（这一条是为了修法落地后这把尺不变成假红）。
 *  - 语料闭包本身是下界（`import-closure` 只认静态字面量说明符）。
 *  - 默认**不 spawn jest**：`--with-corpus` 才问权威档；拿不到就点名"覆盖判定未启用"，绝不折成"没有欠映射"。
 *  - `require.resolve` 用的是 node 的解析规则，不等同于 jest 的 resolver（jest 还看 `moduleFileExtensions`
 *     与自己的 mapper）：这一支只在"mapper 没有"时用作第二档兜底，探得出那一侧一律**不判**而不是判过。
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const REPO = path.resolve(__dirname, '..', '..');
const PKG = 'ewoh-spark-app';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'output', 'tmp', 'coverage', 'build', 'playwright-report']);

function loadTs() {
  const p = path.join(REPO, PKG, 'node_modules', 'typescript');
  try { return { ts: require(p) }; } catch (e) { return { ts: null, error: e.message.split('\n')[0] }; }
}
function walkFiles(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(abs, acc); }
    else acc.push(abs);
    if (acc.length > 200000) return acc;
  }
  return acc;
}
const isDirPath = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** 容注释与尾逗号的 JSON 读法（本仓 `tsconfig.app.json` 就带尾逗号，标准 JSON.parse 会抛）。 */
function readJsonish(abs) {
  const raw = fs.readFileSync(abs, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(raw);
}

/** tsconfig 面：只认本文件**自己声明**的 baseUrl＋paths。 */
function tsSurfaceFrom(root, rel) {
  const abs = path.join(root, rel);
  const s = { rel, kind: 'tsconfig', prefixDirs: new Map(), dirs: new Map(), notes: [] };
  let raw;
  try { raw = readJsonish(abs); } catch (e) { return { rel, kind: 'tsconfig', error: `读不到或解析失败：${String(e.message).split('\n')[0].slice(0, 60)}` }; }
  // include 要在"有没有 paths"之前就取：R-3 问的是这份档**管哪些文件**，与它声明不声明别名无关。
  s.include = Array.isArray(raw.include) ? raw.include.map(String) : null;
  const co = (raw && raw.compilerOptions) || {};
  if (typeof raw.extends === 'string' && !raw.extends.startsWith('.')) s.notes.push(`extends 指向外部包未展开：${raw.extends}`);
  if (!co.paths) {
    s.inheritedOnly = !!raw.extends;
    if (raw.extends) s.notes.push('本文件不声明 paths（只可能从继承来）⇒ 该面只作参考，不参与判决');
    return s;
  }
  const baseAbs = path.resolve(path.dirname(abs), co.baseUrl === undefined ? '.' : co.baseUrl);
  for (const [key, targets] of Object.entries(co.paths)) {
    if (!key.endsWith('*')) { s.notes.push(`键不是 prefix/* 形状，不可判：${key}`); continue; }
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) { s.notes.push(`paths 条目没有候选：${key}`); continue; }
    const first = String(list[0]);
    const star = first.indexOf('*');
    if (star < 0) { s.notes.push(`候选里没有 *，不可判：${key}→${first}`); continue; }
    if (first.slice(star + 1)) { s.notes.push(`候选的 * 不在末尾（尾部还有 ${first.slice(star + 1)}），不可判：${key}→${first}`); continue; }
    const prefix = key.slice(0, -1);
    const dir = path.resolve(baseAbs, first.slice(0, star));
    s.prefixDirs.set(prefix, dir);
    s.dirs.set(prefix, { dir, raw: first, candidates: list.length });
  }
  return s;
}

/** R-3 的原子判据：一份 tsconfig 的 `include` 里，哪些 glob 相对**该文件自己的目录**根本落不到地上。
 *  判据只看 glob 的第一段（目录名或 `..`）解出来在不在——`tsc` 报 `TS18003: No inputs were found`
 *  的充要条件就是"每一项都解不到"（V343 实测：`ewoh-spark-app/scripts/tsconfig.benchmark.json`
 *  把三条 glob 按包根写、文件住在 `scripts/` 下 ⇒ 整批失效；把它改成相对自身目录后 `tsc` 退 0）。
 *  `**\/*` 开头（就是本目录）与 `.` 开头的显式相对写法都不算失效候选，直接放过。 */
function deadIncludeGlobs(configDirAbs, include, exists) {
  const have = exists || ((p) => { try { return fs.statSync(p) !== undefined; } catch { return false; } });
  if (!Array.isArray(include)) return [];
  const dead = [];
  for (const g of include.map(String)) {
    if (!g || g.startsWith('**') || g.startsWith('.')) continue;
    const head = g.split('/')[0];
    if (!head || head === '**') continue;
    if (!have(path.resolve(configDirAbs, head))) dead.push(g);
  }
  return dead;
}

/** R-3：逐面判 include。三档判决——整批落空＝红（有 TS18003 作实证）；部分落空＝点名但不判红
 *  （"某条 glob 暂时没文件"在真实工程里合法，判红会造假红）；没有 include 这一项＝不判。 */
function judgeIncludes(surfaces, configDirOf, exists) {
  const rows = [];
  for (const s of surfaces) {
    if (s.kind !== 'tsconfig' || s.error) continue;
    const dir = configDirOf(s.rel);
    if (s.include === undefined) { rows.push({ rel: s.rel, verdict: '不可判', why: '该面没读到 include 字段（旧版夹具或读档失败）' }); continue; }
    if (!s.include || !s.include.length) { rows.push({ rel: s.rel, verdict: '不判（无 include）', why: '输入集由 tsc 默认规则决定，本尺不猜' }); continue; }
    const dead = deadIncludeGlobs(dir, s.include, exists);
    if (!dead.length) rows.push({ rel: s.rel, verdict: '已核对', why: `${s.include.length} 项 glob 相对自身目录都在` });
    else if (dead.length === s.include.length) {
      rows.push({ rel: s.rel, verdict: '红：include 整批落空', why: `作为 project 消费时输入集为空（TS18003 的形状）：${dead.join('、')}` });
    } else {
      rows.push({ rel: s.rel, verdict: '点名（不判红）', why: `${dead.length}/${s.include.length} 项落空：${dead.join('、')}` });
    }
  }
  return rows;
}

/** R-4（V349 建，V350 换成整条解析链）：把「include 的第一段落不落在地上」换成**编译器自己的输入集**。
 *  V349 那一版喂的是这份档**自己声明**的 raw JSON（`parseJsonConfigFileContent`），于是留下一层新的看不见：
 *  真实树里 `ewoh-spark-app/client/tsconfig.jest.json` 与 `ewoh-spark-app/tsconfig.json` 都不声明 `include`，
 *  全靠 `extends` 继承（V350 探针实测有效 `include` 各 2 条、`fileNames` 各 804）——那一版把它们读成「不判」，
 *  而 tsc 实际拿到的是继承来的那一套。
 *  现在改调 `ts.getParsedCommandLineOfConfigFile`：这是 tsc 自己的入口，一条调用就把 `extends` 链、
 *  include 相对**声明它的那一档**重锚、exclude、默认扩展名集全算对（V345 实测过手写 extends 解析只会覆盖 paths）。
 *  不起 `tsc -p` 子进程（不带 `--noEmit` 会在源码旁落产物、污染重放覆盖集）。
 *  三张脸必须分开：链断裂（父档读不到，错误码 5083/6053）＝不可判；有效解析集为空＝红；
 *  自身与继承都没有 include／files＝不判（默认规则是整目录递归，本尺不猜）。 */
const BROKEN_CHAIN = new Set([5083, 6053]);
function configHost(tsLib) {
  const sys = tsLib.sys;
  return {
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
    readDirectory: sys.readDirectory,
    readFile: (f) => sys.readFile(f),
    fileExists: (f) => sys.fileExists(f),
    getCurrentDirectory: () => sys.getCurrentDirectory(),
    getDirectories: (f) => (sys.getDirectories ? sys.getDirectories(f) : []),
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(tsLib.flattenDiagnosticMessageText(d.messageText, ' '));
    },
  };
}

function resolvedInputs(tsLib, rootDir, rel) {
  const abs = path.resolve(rootDir, rel);
  if (!fs.existsSync(abs)) return { verdict: '不可判', files: null, why: '读不到这份 tsconfig（' + rel + '）' };
  let out;
  try { out = tsLib.getParsedCommandLineOfConfigFile(abs, {}, configHost(tsLib)); }
  catch (error) { return { verdict: '不可判', files: null, why: '整条 config 解析链抛错：' + error.message }; }
  if (!out) return { verdict: '不可判', files: null, why: '解析链没返回结果' };
  const codes = (out.errors || []).map((e) => e.code);
  const broken = codes.filter((c) => BROKEN_CHAIN.has(c));
  const n = (out.fileNames || []).length;
  const raw = out.raw || {};
  let own = {};
  try { own = tsLib.readConfigFile(abs, tsLib.sys.readFile).config || {}; } catch { own = {}; }
  const ownDecl = (Array.isArray(own.include) && own.include.length) || (Array.isArray(own.files) && own.files.length);
  const effDecl = (Array.isArray(raw.include) && raw.include.length) || (Array.isArray(raw.files) && raw.files.length);
  const inherited = !!effDecl && !ownDecl;
  const base = { files: n, codes, inherited, extends: own.extends || null };
  if (broken.length) {
    return Object.assign({ verdict: '不可判', why: 'extends 链断裂（错误码 ' + broken.join() + '）⇒ 输入集取决于读不到的父档，'
      + '既不折成红也不折成绿（干净克隆未装依赖时就是这个形状）' }, base);
  }
  if (!effDecl) {
    return Object.assign({ verdict: '不判（无 include 也无 files）', why: '自身与继承都没声明输入集，默认规则是整目录递归，本尺不猜' }, base);
  }
  if (!n) {
    return Object.assign({ verdict: '红：解析集为空', why: '有效 include=' + JSON.stringify(raw.include || [])
      + ' exclude=' + JSON.stringify(raw.exclude || []) + ' files=' + JSON.stringify(raw.files || [])
      + ' ⇒ tsc 侧拿到 0 个输入（错误码 ' + (codes.join() || '（无码，即目录在但里面没有可编译文件）') + '）' }, base);
  }
  return Object.assign({ verdict: '已核对', why: 'tsc 侧拿到 ' + n + ' 个输入'
    + (inherited ? '（这一面自己不声明，输入集全部继承自 ' + JSON.stringify(own.extends) + '）' : '') }, base);
}

function judgeResolutions(surfaces, rootDir, tsLib) {
  const rows = [];
  for (const s of surfaces) {
    if (s.kind !== 'tsconfig' || s.error) continue;
    rows.push(Object.assign({ rel: s.rel }, resolvedInputs(tsLib, rootDir, s.rel)));
  }
  return rows;
}
/** 按 AST 从一个 CommonJS/ESM 配置源码里取某个属性。
 *  返回值分四种形状，**标量与对象都必须能读到**：
 *  `{kind:'object',props,spreads}`／`{kind:'string',string}`／`{kind:'call',callText}`／`{kind:'other'}`，
 *  找不到属性给 `{kind:'missing'}`。
 *  两代自伤都钉在这里：第一版用文本窗口 `moduleNameMapper:\s*\{…\n\s*\}`，单行写法读成"没有 mapper"
 *  （静默空读与"真的没有"同形）；第二版只认对象字面量，于是 `rootDir: '../..'` 与埋在
 *  `transform` 数组里的 `tsconfig: '…'` 都返回空 ⇒ e2e 那个 runner 被归一到配置目录，
 *  凭空造出两条"目录不一致"（真语料第一遍实测）。 */
function objectPropFromSource(ts, text, file, propName) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let out = null;
  const readPairs = (node) => {
    const props = []; let spreads = 0;
    for (const p of node.properties) {
      if (p.kind !== ts.SyntaxKind.PropertyAssignment) { spreads += 1; continue; }
      const kn = p.name;
      const key = kn.kind === ts.SyntaxKind.StringLiteral ? kn.text
        : (kn.kind === ts.SyntaxKind.Identifier ? kn.getText(sf) : null);
      const v = p.initializer && p.initializer.kind === ts.SyntaxKind.StringLiteral ? p.initializer.text : undefined;
      if (key === null || v === undefined) { spreads += 1; continue; }
      props.push([key, v]);
    }
    return { props, spreads };
  };
  const visit = (node) => {
    if (out) return;
    if (ts.isPropertyAssignment(node) && node.name && node.name.getText(sf).replace(/^['"]|['"]$/g, '') === propName) {
      const init = node.initializer;
      if (ts.isObjectLiteralExpression(init)) {
        const r = readPairs(init);
        out = { kind: 'object', props: r.props, spreads: r.spreads, found: true };
        return;
      }
      if (ts.isStringLiteral(init)) { out = { kind: 'string', string: init.text, props: [], spreads: 0, found: true }; return; }
      if (ts.isCallExpression(init)) { out = { kind: 'call', callText: init.expression.getText(sf), props: [], spreads: 0, found: true }; return; }
      out = { kind: 'other', props: [], spreads: 0, callText: init && init.getText ? init.getText(sf).slice(0, 40) : '?', found: true };
      return;
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return out || { kind: 'missing', props: [], spreads: 0 };
}

/** jest 跑测档面：`moduleNameMapper` 每条 `^p(.*)$`→`dir/$1`，按该配置自己的 rootDir 归一。
 *  opts.requireGenerated（默认真语料开、夹具自测按需开）：**生成档**（值是函数调用）静态读不出表，
 *  就真把这份配置 require 出来读它算出的那个对象——V342 之后四份跑测档全是生成档，
 *  若只记"生成档⇒不可判"，这把尺对着一改就漂的东西会一个字都说不出来。代价照实写：这一臂**会执行配置文件代码**，
 *  所以只用于本仓自己的配置面；require 失败仍退回不可判并点名原因。 */
function jestSurfaceFrom(root, rel, text, ts, opts) {
  const abs = path.join(root, rel);
  const s = { rel, kind: 'jest', prefixDirs: new Map(), dirs: new Map(), notes: [], cfgDirRel: path.posix.dirname(rel) };
  let mapper, rootDirDecl, tsDecl;
  if (/(^|\/)package\.json$/.test(rel)) {
    let j;
    try { j = (readJsonish(abs) || {}).jest; } catch (e) { return { rel, kind: 'jest', error: `解析失败：${String(e.message).split('\n')[0].slice(0, 60)}` }; }
    if (!j) return { rel, kind: 'jest', noRunner: true };   // 没有 jest 键＝这不是跑测档（V342 迁走之后就成了常态），不算面也不记"读不到"
    mapper = { kind: 'object', props: Object.entries(j.moduleNameMapper || {}), spreads: 0, found: true };
    rootDirDecl = typeof j.rootDir === 'string' ? j.rootDir : undefined;
    tsDecl = (j.transform && Object.values(j.transform)[0] && Object.values(j.transform)[0][1] && Object.values(j.transform)[0][1].tsconfig) || null;
    s.defaultConfig = true;
  } else {
    mapper = objectPropFromSource(ts, text, rel, 'moduleNameMapper');
    if (mapper.kind === 'missing') return { rel, kind: 'jest', error: '读不到 moduleNameMapper' };
    const rd = objectPropFromSource(ts, text, rel, 'rootDir');
    rootDirDecl = rd.kind === 'string' ? rd.string : undefined;
    const tc = objectPropFromSource(ts, text, rel, 'tsconfig');
    tsDecl = tc.kind === 'string' ? tc.string : undefined;
    if (mapper.kind === 'other') {
      s.unparsedMapper = true;
      s.notes.push(`mapper 不是对象字面量也不是函数调用（读作 ${mapper.callText}）⇒ 覆盖判定转不可判，不读成"这个面没有映射"`);
      return s;
    }
  }
  const cfgDirAbs = path.dirname(abs);
  const rootAbsFor = (decl) => (!decl || String(decl).startsWith('<rootDir>'))
    ? cfgDirAbs : path.resolve(cfgDirAbs, String(decl).replace(/\/$/, ''));
  let rootAbs = rootAbsFor(rootDirDecl);
  if (mapper.kind === 'call') {
    s.generated = true;
    if (opts && opts.requireGenerated === false) {
      s.notes.push(`mapper 是 ${mapper.callText}(…)（生成档）⇒ 静态读不出表；这一臂被 --no-require 关掉了，本面按不可判算`);
      return s;
    }
    let cfg;
    const rq = createRequire(path.join(root, 'noop.js'));
    try {
      // 必须先摘 require 缓存：同一进程里第二次枚举同一份配置时，Node 会把**第一次**那个模块对象
      // 原样端回来——于是"改了生成函数再跑一遍"读到的还是旧表（两支必须开火的控制就是这么抓到我自己的）。
      try { delete rq.cache[rq.resolve(abs)]; } catch { /* 没进过缓存就不用摘 */ }
      cfg = rq(abs);
    }
    catch (e) {
      s.notes.push(`生成档 require 失败（${String(e.message).split('\n')[0].slice(0, 70)}）⇒ 整面不可判，不折成"没有映射"`);
      return s;
    }
    const mm = cfg && cfg.moduleNameMapper;
    if (!mm || typeof mm !== 'object') { s.notes.push('生成档 require 出来的 moduleNameMapper 不是对象 ⇒ 不可判'); return s; }
    s.valueFrom = 'require 档（执行配置件取 jest 将实际使用的对象）';
    if (typeof cfg.rootDir === 'string') rootAbs = rootAbsFor(cfg.rootDir);
    mapper = { kind: 'object', props: Object.entries(mm), spreads: 0 };
  }
  if (mapper.spreads) s.notes.push(`对象里有 ${mapper.spreads} 处展开／非字符串值，未参与比对（下界）`);
  s.rootAbs = rootAbs;
  s.tsconfigRel = resolveTsconfigDecl(root, rootAbs, rel, tsDecl);
  for (const [key, val] of mapper.props) {
    const km = key.match(/^\^([\s\S]*?)\(\.\*\)\$$/);
    if (!km) { s.notes.push(`键不是 ^prefix(.*)$ 形状，不可判：${key}`); continue; }
    const vm = String(val).match(/^([\s\S]*)\$1([\s\S]*)$/);
    if (!vm) { s.notes.push(`值里没有 $1，不可判：${key}→${val}`); continue; }
    if (vm[2]) { s.notes.push(`$1 不在末尾（尾部还有 ${vm[2]}），不可判：${key}→${val}`); continue; }
    if (/\$\{/.test(vm[1])) { s.notes.push(`值含模板引用，不可判：${key}→${val}`); continue; }
    // 前缀要从正则面还原成词面：ts-jest 的生成形状带转义（`@lark\-apaas/`），不还原就永远匹配不到真实说明符
    const prefix = km[1].replace(/\\([^A-Za-z0-9_])/g, '$1');
    if (/[.?*+(){}[\]|^]/.test(prefix)) { s.notes.push(`键不是纯前缀（含正则元字符），不可判：${key}`); continue; }
    const dir = path.resolve(vm[1].replace(/<rootDir>/g, rootAbs));
    s.prefixDirs.set(prefix, dir);
    s.dirs.set(prefix, { dir, raw: String(val), key });
  }
  return s;
}

/** ts-jest 的 `tsconfig` 按 jest 语义相对 **rootDir** 解析（相对配置文件目录会读错档：
 *  e2e 那份写的是 `'tsconfig.spec.json'`，rootDir 在 `../..`，按配置目录拼会指向不存在的路径）。 */
function resolveTsconfigDecl(root, rootAbs, rel, decl) {
  if (!decl || typeof decl !== 'string') return null;
  const bare = decl.replace(/^<rootDir>\/?/, '').replace(/\\/g, '/');
  if (/\$\{/.test(bare)) return null;
  const joined = path.posix.normalize(path.posix.join(path.relative(root, rootAbs).split(path.sep).join('/'), bare));
  if (joined.startsWith('..')) return null;
  return fs.existsSync(path.join(root, joined)) ? joined : null;
}

/** 该 runner 的**有效** paths：沿仓内 `extends` 链找到最近一份自己声明 paths 的文件。
 *  TS 的语义是 `paths` **整体覆盖**（不是与父档合并），所以"最近声明者说了算"；
 *  链上第一个声明者之外的一律不并进来。找不到（一路继承到外部包）就给 error ⇒ 那一路判不可判，
 *  绝不回退到别档——本轮第一版就是把 `tsconfig.spec.json`（自己不声明 paths）直接交给闭包，
 *  `@server/*` 整批被当成外部包，语料从 857 个文件缩水到"只看见入口自己 import 的那一层"。 */
function effectivePaths(root, rel, ts) {
  const chain = [];
  let cur = rel;
  for (let hop = 0; hop < 8; hop += 1) {
    const abs = path.join(root, cur);
    let raw;
    try { raw = readJsonish(abs); } catch (e) { return { error: `读不到 ${cur}：${String(e.message).split('\n')[0].slice(0, 50)}`, chain }; }
    chain.push(cur);
    const co = (raw && raw.compilerOptions) || {};
    if (co.paths) {
      const baseAbs = path.resolve(path.dirname(abs), co.baseUrl === undefined ? '.' : co.baseUrl);
      const paths = {}; let dropped = 0;
      for (const [k, v] of Object.entries(co.paths)) {
        const first = Array.isArray(v) && v.length ? String(v[0]) : '';
        if (k.endsWith('*') && first.endsWith('*') && first.indexOf('*') === first.length - 1 && first.slice(0, -1)) paths[k] = v;
        else dropped += 1;
      }
      if (!Object.keys(paths).length) return { error: `${cur} 声明了 paths 但没有一条是 prefix/*→dir/* 形状`, chain };
      return {
        options: { baseUrl: baseAbs, paths, allowJs: true, resolveJsonModule: true,
          moduleResolution: ts && ts.ModuleResolutionKind ? ts.ModuleResolutionKind.NodeJs : 2 },
        from: cur, chain, dropped,
      };
    }
    const ex = raw && raw.extends;
    if (typeof ex !== 'string') return { error: `链到 ${cur} 都没声明 paths（也没有 extends）`, chain };
    if (!ex.startsWith('.')) return { error: `链到 ${cur} 都没声明 paths，而 extends 指向外部包（${ex}）⇒ 不展开，判不可判`, chain };
    cur = path.posix.normalize(path.posix.join(path.posix.dirname(cur), ex));
  }
  return { error: 'extends 链超过 8 层', chain };
}

/** 面枚举（分母自证）：全仓按文件名枚举 tsconfig 与 jest.config.*，`package.json#jest` 单列一面。 */
function collectSurfaces(root, ts, opts) {
  root = root || REPO;
  opts = opts || {};
  const files = walkFiles(path.join(root, PKG), []);
  const relLocal = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const tsRels = files.filter((a) => /(^|\/)tsconfig[^/]*\.json$/.test(relLocal(a))).map(relLocal).sort();
  const jestRels = files.filter((a) => /(^|\/)jest\.config\.(js|cjs|mjs|json)$/.test(relLocal(a))).map(relLocal).sort();
  const surfaces = []; const unreadable = []; const nonFaces = [];
  for (const rel of tsRels) {
    const s = tsSurfaceFrom(root, rel);
    if (s.error) unreadable.push(`${rel}｜${s.error}`); else surfaces.push(s);
  }
  for (const rel of [...jestRels, `${PKG}/package.json`]) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { unreadable.push(`${rel}｜读不到`); continue; }
    const s = jestSurfaceFrom(root, rel, text, ts, opts);
    if (s.error) unreadable.push(`${rel}｜${s.error}`);
    else if (s.noRunner) nonFaces.push(rel);
    else surfaces.push(s);
  }
  return { surfaces, unreadable, nonFaces, tsRels, jestRels };
}

/** R-1：同一前缀在各面归一后落到不同绝对目录 ⇒ 红；jest 侧映射指向盘上没有的目录 ⇒ 红。 */
function judgeTargets(surfaces, exists) {
  const byPrefix = new Map();
  for (const s of surfaces) {
    if (s.error || s.inheritedOnly || s.unparsedMapper) continue;
    // 生成档只要那一臂读到了值就必须参与比对；读不到值才跳过（拿空表冒充"没声明"是假绿）
    if (s.generated && s.prefixDirs.size === 0) continue;
    for (const [prefix, dir] of s.prefixDirs) {
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push({ rel: s.rel, kind: s.kind, dir, generated: !!s.generated });
    }
  }
  const rows = []; let hasGen = 0;
  for (const [prefix, list] of [...byPrefix.entries()].sort()) {
    const dirs = [...new Set(list.map((l) => l.dir))];
    const stale = list.filter((l) => l.kind === 'jest' && !exists(l.dir)).map((l) => l.rel);
    hasGen += list.filter((l) => l.generated).length;
    rows.push({ prefix, surfaces: list, dirs, conflict: dirs.length > 1, staleTargets: stale });
  }
  return { rows, hasGenerated: hasGen };
}

/** R-2：runner 语料真用到的每个前缀，要么该 runner 的 mapper 覆盖且目录在盘上，要么包自己解得出。 */
function judgeCoverage(runners, surfaces, probe, exists) {
  const rows = [];
  for (const r of runners) {
    const s = surfaces.find((x) => x.rel === r.surfaceRel);
    if (!s) { rows.push({ runner: r.surfaceRel, prefix: '(整面)', verdict: '不可判', why: '面本身没收到' }); continue; }
    if (s.unparsedMapper || (s.generated && s.prefixDirs.size === 0)) {
      rows.push({ runner: r.surfaceRel, prefix: '(整面)', verdict: '不可判',
        why: s.unparsedMapper ? 'mapper 形状读不到（不是对象字面量）' : '生成档且 require 臂没读到值' });
      continue;
    }
    if (!r.used || !r.used.size) { rows.push({ runner: r.surfaceRel, prefix: '(整面)', verdict: '不可判', why: r.corpusNote || '语料未启用' }); continue; }
    for (const [prefix, info] of [...r.used.entries()].sort()) {
      const mapped = s.prefixDirs.get(prefix);
      if (mapped) {
        rows.push({ runner: r.surfaceRel, prefix, usedBy: info.files.size, sample: info.file, spec: info.spec, where: mapped,
          verdict: exists(mapped) ? '已覆盖' : '红：映射指向盘上没有的目录' });
        continue;
      }
      const resolvable = probe(info.file, info.spec);
      rows.push({ runner: r.surfaceRel, prefix, usedBy: info.files.size, sample: info.file, spec: info.spec,
        verdict: resolvable ? '不判（包自己解得出）' : '红：欠映射',
        why: resolvable ? `require.resolve 从 ${info.file} 解 ${info.spec} 解得出` : `mapper 无此条，且 require.resolve 从 ${info.file} 解 ${info.spec} 解不出` });
    }
  }
  return rows;
}

/** 语料里出现的前缀（取最长匹配，免得 `@/` 抢走 `@client/` 的说明符）。 */
function prefixesUsed(specsByFile, allPrefixes) {
  const used = new Map();
  const list = [...allPrefixes].sort((a, b) => b.length - a.length);
  for (const [file, specs] of specsByFile) {
    for (const spec of specs) {
      const hit = list.find((p) => spec.startsWith(p));
      if (!hit) continue;
      if (!used.has(hit)) used.set(hit, { files: new Set(), file, spec });
      used.get(hit).files.add(file);
    }
  }
  return used;
}

function run(argv) {
  if (argv.includes('--self-test')) return selftest();
  const { ts, error } = loadTs();
  if (!ts) { console.log(`[alias-sync] 不可判：取不到 typescript 解析件（${error}）⇒ 不读成"各面一致"`); return 3; }
  const reqOff = argv.includes('--no-require');
  const { surfaces, unreadable, nonFaces, tsRels, jestRels } = collectSurfaces(REPO, ts, { requireGenerated: !reqOff });
  const short = (p) => String(p).replace(REPO + '/', '');
  console.log(`[alias-sync] 面枚举：tsconfig ${tsRels.length} 份｜jest 配置 ${jestRels.length} 份`
    + `｜package.json 不是跑测档的 ${nonFaces.length} 份（没有 jest 键，不算面也不记读不到）`
    + `｜读不到 ${unreadable.length} 份｜生成档取实际值那一臂＝${reqOff ? '关掉（--no-require）' : '开（会执行配置件）'}`);
  for (const u of unreadable) console.log(`    · 不可判面：${u}`);
  let nameToRel = new Map();
  try {
    const amp = require('./change-amplification.cjs');
    const roster = amp.JEST_CONFIGS || [];
    nameToRel = new Map(roster.map((c) => [c.rel, c.name]));
    const offRoster = jestRels.filter((r) => !roster.some((c) => c.rel === r));
    if (offRoster.length) console.log(`    · 未接入 change-amplification 跑测档名册的 jest 配置 ${offRoster.length} 份：${offRoster.join(' ')}（这些面参与 R-1，但不参与 R-2——没有配方会跑它们）`);
  } catch (e) { console.log(`    · 名册求差未启用：取不到 change-amplification（${String(e.message).slice(0, 40)}）`); }
  const judged = judgeTargets(surfaces, isDirPath);
  const rows = judged.rows;
  const conflicted = rows.filter((r) => r.conflict);
  const stale = rows.filter((r) => r.staleTargets.length);
  console.log(`  R-1 目标一致：前缀 ${rows.length} 个（生成档真值面贡献的读数＝${judged.hasGenerated} 条面·前缀对）`
    + `｜归一后目录不一致 ${conflicted.length} 个｜jest 映射指向盘上没有的目录 ${stale.length} 个`);
  for (const r of conflicted) console.log(`    ✗ ${r.prefix} → ${r.dirs.map(short).join(' ≠ ')}`);
  for (const r of stale) console.log(`    ✗ ${r.prefix}：${r.staleTargets.join(', ')} 指向 ${short(r.surfaces.find((x) => r.staleTargets.includes(x.rel)).dir)}，盘上没有`);
  for (const s of surfaces) for (const n of s.notes) console.log(`    · ${s.rel}｜${n}`);
  // R-3：include 是否相对**自身目录**落得到地上。存在性判据必须"文件或目录都算"——
  // playwright 那份的 `playwright.config.ts` 是个文件，用"必须是目录"会把合规档读成红。
  const existsAny = (q) => { try { fs.statSync(q); return true; } catch { return false; } };
  const incRows = judgeIncludes(surfaces, (rel) => path.dirname(path.join(REPO, rel)), existsAny);
  const incReds = incRows.filter((r) => r.verdict.startsWith('红'));
  const incNamed = incRows.filter((r) => r.verdict === '点名（不判红）');
  const incQuiet = incRows.filter((r) => r.verdict === '不判（无 include）' || r.verdict === '不可判').length;
  console.log(`  R-3 include 相对自身目录：tsconfig 面 ${incRows.length}｜整批落空（红）${incReds.length}｜部分落空（点名不判红）${incNamed.length}｜没有 include 这项／不可判 ${incQuiet}`);
  for (const r of incReds) console.log(`    ✗ ${r.rel}｜${r.why}`);
  for (const r of incNamed) console.log(`    · ${r.rel}｜${r.why}`);
  // R-4：编译器侧输入集（V349）。这是 R-3 的上界——首段目录在、include 也写了，仍可一个输入都拿不到。
  const resRows = judgeResolutions(surfaces, REPO, ts);
  const resReds = resRows.filter((r) => r.verdict.startsWith('红'));
  const resQuiet = resRows.filter((r) => r.verdict === '不判（无 include 也无 files）' || r.verdict === '不可判').length;
  const onlyR4 = resReds.filter((r) => {
    const i = incRows.find((x) => x.rel === r.rel);
    return i && !i.verdict.startsWith('红');
  });
  const inhFaces = resRows.filter((r) => r.inherited);
  const brokenChain = resRows.filter((r) => r.verdict === '不可判' && /链断裂/.test(r.why || ''));
  console.log(`  R-4 编译器侧输入集：tsconfig 面 ${resRows.length}｜解析集为空（红）${resReds.length}`
    + `｜不判／不可判 ${resQuiet}｜其中只有 R-4 看得见（R-3 判「在」而输入集为空）${onlyR4.length}`
    + `｜自身不声明、输入集全靠 extends ${inhFaces.length}｜extends 链断裂（不可判）${brokenChain.length}`);
  for (const r of resReds) console.log(`    ✗ ${r.rel}｜${r.why}`);
  for (const r of resRows.filter((x) => x.verdict === '不可判')) console.log(`    · ${r.rel}｜${r.why}`);
  for (const r of inhFaces) console.log(`    · ${r.rel}｜${r.why}`);

  let covRows = [];
  if (!argv.includes('--with-corpus')) {
    console.log('  R-2 覆盖判定：**未启用**（默认不 spawn jest；加 --with-corpus 才问权威档）⇒ 不读成"没有欠映射"');
  } else {
    const amp = require('./change-amplification.cjs');
    const closureMod = require('./import-closure.cjs');
    const rf = require('./replay-freshness.cjs');
    const cfgs = amp.jestConfigs(new Map());
    const auth = amp.jestAuthority(cfgs.cfgs, 'auto');
    if (!auth) console.log('  R-2 覆盖判定：**未启用**：拿不到 jest 权威入口清单 ⇒ 不折成"没有欠映射"');
    else {
      const allPrefixes = new Set();
      for (const s of surfaces) if (s.prefixDirs) for (const p of s.prefixDirs.keys()) allPrefixes.add(p);
      const specCache = new Map();
      const runners = [];
      for (const c of cfgs.cfgs) {
        const surfaceRel = [...nameToRel.entries()].find(([, n]) => n === c.name);
        const rel = surfaceRel ? surfaceRel[0] : null;
        const a = auth.get(c.name);
        if (!rel) { runners.push({ surfaceRel: '(未知面)', used: null, corpusNote: `名册里对不上配置名 ${c.name}` }); continue; }
        if (!a || a.failed) { runners.push({ surfaceRel: rel, used: null, corpusNote: `权威档失败：${a && a.failed}` }); continue; }
        const entries = [...a.files];
        const face = surfaces.find((x) => x.rel === rel);
        const declared = face && face.tsconfigRel;
        if (!declared) { runners.push({ surfaceRel: rel, used: null, corpusNote: '不可判：读不到该 runner 的 ts-jest tsconfig 声明（不猜别档）' }); continue; }
        const eff = effectivePaths(REPO, declared, ts);
        if (eff.error) { runners.push({ surfaceRel: rel, used: null, corpusNote: `不可判：${eff.error}` }); continue; }
        const rr = closureMod.closure(REPO, entries, { options: eff.options });
        if (rr.error) { runners.push({ surfaceRel: rel, used: null, corpusNote: `闭包不可判：${rr.error}` }); continue; }
        const files = new Set([...entries, ...rr.deps.keys()]);
        const specsByFile = new Map();
        for (const f of files) {
          if (!specCache.has(f)) {
            let list = [];
            try { list = rf.moduleSpecifiers(ts, fs.readFileSync(path.join(REPO, f), 'utf8'), f); } catch { list = []; }
            specCache.set(f, list);
          }
          specsByFile.set(f, specCache.get(f));
        }
        const used = prefixesUsed(specsByFile, allPrefixes);
        runners.push({ surfaceRel: rel, used, corpusNote: `入口 ${entries.length}＋闭包 ${rr.deps.size}`, aliasFrom: eff.from,
          aliasChain: eff.chain.join('→') + (eff.dropped ? `（另有 ${eff.dropped} 条非 prefix/*→dir/* 形状未参与）` : '') });
        console.log(`    · ${c.name}：语料 ${files.size} 个文件（入口 ${entries.length}、闭包 ${rr.deps.size}、别名有效档 ${runners[runners.length - 1].aliasFrom}，链 ${runners[runners.length - 1].aliasChain}）、未命中 ${rr.unresolved.length} 处｜用到前缀 ${used.size} 个：${[...used.keys()].join(' ')}`);
      }
      covRows = judgeCoverage(runners, surfaces, (fromFile, spec) => {
        try { createRequire(path.join(REPO, fromFile))(spec); return true; } catch { return false; }
      }, isDirPath);
      const buckets = new Map();
      for (const r of covRows) buckets.set(r.verdict, (buckets.get(r.verdict) || 0) + 1);
      const reds = covRows.filter((r) => r.verdict.startsWith('红'));
      console.log(`  R-2 覆盖判定：格 ${covRows.length}｜分档 ${[...buckets.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
      for (const r of reds) console.log(`    ✗ ${r.runner}｜${r.prefix} 被 ${r.usedBy} 个文件用到（例 ${r.sample} → ${r.spec}）｜${r.why || r.where}`);
      for (const r of covRows.filter((x) => x.verdict === '不判（包自己解得出）')) console.log(`    · ${r.runner}｜mapper 没有 ${r.prefix}，但 ${r.sample} 里 require.resolve 解得出 ${r.spec} ⇒ 交包解析，不判`);
      for (const r of covRows.filter((x) => x.verdict === '不可判')) console.log(`    · ${r.runner}｜${r.prefix}｜${r.why}`);
    }
  }
  const covReds = covRows.filter((r) => r.verdict.startsWith('红')).length;
  const fail = conflicted.length + stale.length + covReds + incReds.length + resReds.length;
  console.log(`[alias-sync] 判决：${fail ? `✗ ${fail} 项不同步（R-1 ${conflicted.length + stale.length}／R-2 ${covReds}／R-3 ${incReds.length}／R-4 ${resReds.length}）` : '✅ 已核的面与 runner 全部同步'}`);
  if (argv.includes('--json')) {
    fs.writeFileSync(path.join(REPO, 'tmp/alias-sync.json'), JSON.stringify({
      surfaces: surfaces.map((s) => ({ rel: s.rel, kind: s.kind, generated: !!s.generated, inheritedOnly: !!s.inheritedOnly, tsconfigRel: s.tsconfigRel || null, prefixes: [...s.prefixDirs.entries()].map(([p, d]) => ({ prefix: p, dir: short(d) })) })),
      targetRows: rows.map((r) => ({ prefix: r.prefix, dirs: r.dirs.map(short), conflict: r.conflict, stale: r.staleTargets })),
      coverage: covRows.map((r) => Object.assign({}, r, { where: r.where ? short(r.where) : undefined })),
      includeRows: incRows,
      resolutionRows: resRows.map((r) => ({ rel: r.rel, verdict: r.verdict, files: r.files == null ? null : r.files, codes: r.codes || [], why: r.why })),
    }, null, 0));
  }
  return fail ? 1 : 0;
}

/** 判据自测：只用临时目录夹具，不碰真语料、不 spawn jest。三族各一支以上——
 *  必须开火（R-1 目录分叉／R-1 之外的"映射指向盘上没有"／R-2 欠映射且包解不出），
 *  必须不开火（字面不同而目录相同／包作用域别名／mapper 已覆盖／语料未启用／生成档），
 *  必须点名（单行写法的 mapper 要读得到、rootDir 归一按目录、非 prefix/* 形状、坏 JSON 整面、
 *  只靠继承的面、带转义的键、跨 rootDir／baseUrl 的同目录），外加夹具树上的分母自证两支。
 *  条数由脚本最后一行自报，别处不许抄。 */
function selftest() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alysync-'));
  const w = (rel, txt) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
  const { ts, error } = loadTs();
  const checks = [];
  const A = (name, ok, detail) => checks.push({ name, ok, detail: detail == null ? '' : String(detail) });
  if (!ts) { console.log(`  ✗ 夹具前提：取不到 typescript 解析件（${error}）`); console.log('[alias-sync] 判据自测 0/1 通过'); return 1; }
  fs.mkdirSync(path.join(root, 'sub/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub/other'), { recursive: true });
  w('sub/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@/*': ['./src/*'], '@x/*': ['./x/*'] } } }));
  w('sub/a/jest.config.cjs', "module.exports = { moduleNameMapper: { '^@/(.*)$': '<rootDir>/../src/$1', '^@x/(.*)$': '<rootDir>/../other/$1', '^@nope/(.*)$': '<rootDir>/../ghost/$1' } };\n");
  const sa = tsSurfaceFrom(root, 'sub/tsconfig.json');
  const ja = jestSurfaceFrom(root, 'sub/a/jest.config.cjs', fs.readFileSync(path.join(root, 'sub/a/jest.config.cjs'), 'utf8'), ts);
  const rows = judgeTargets([sa, ja], (p) => fs.existsSync(p)).rows;
  const at = (p) => rows.find((r) => r.prefix === p);

  A('单行写法的 mapper 必须被读到（文本窗口档在这里读成"没有 mapper"＝静默空读）',
    ja.prefixDirs.size === 3 && !ja.error, `读到 ${ja.prefixDirs.size} 条${ja.error ? '｜' + ja.error : ''}`);
  A('rootDir 缺省必须按配置所在**目录**归一（按文件路径归一会让整面错位、把分叉读成一致）',
    ja.rootAbs === path.join(root, 'sub/a'), String(ja.rootAbs));
  // 标量属性必须读得到：这一支钉的是第二版自伤（只认对象字面量 ⇒ rootDir/tsconfig 静默读空）
  w('sub/root/jest.config.js', "module.exports = {\n  rootDir: '../..',\n  transform: { '^.+\\\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },\n  moduleNameMapper: { '^@s/(.*)$': '<rootDir>/server/$1' },\n};\n");
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.spec.json'), JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@s/*': ['server/*'] } } }));
  const jr = jestSurfaceFrom(root, 'sub/root/jest.config.js', fs.readFileSync(path.join(root, 'sub/root/jest.config.js'), 'utf8'), ts);
  A('配置里声明的 `rootDir: ../..` 必须读到并按它归一（读空会把该 runner 归到配置目录，凭空造出"目录不一致"）',
    jr.rootAbs === path.join(root), `${String(jr.rootAbs).replace(root, '') || '(=夹具根)'}`);
  A('埋在 transform 数组里的 `tsconfig: …` 必须读到，并按 rootDir 解析到真实文件',
    jr.tsconfigRel === 'tsconfig.spec.json', JSON.stringify(jr.tsconfigRel));
  A('同一前缀在"rootDir 在上一层"的配置里归一后必须与 tsconfig 面同目录（这条一错整面就全错位）',
    judgeTargets([tsSurfaceFrom(root, 'tsconfig.spec.json'), jr], (p) => fs.existsSync(p)).rows.every((r) => !r.conflict),
    JSON.stringify(judgeTargets([tsSurfaceFrom(root, 'tsconfig.spec.json'), jr], (p) => fs.existsSync(p)).rows.map((r) => `${r.prefix}:${r.dirs.length}`)));
  w('sub/var/jest.config.cjs', "const MAP = { '^@v/(.*)$': '<rootDir>/v/$1' };\nmodule.exports = { moduleNameMapper: MAP };\n");
  const jv = jestSurfaceFrom(root, 'sub/var/jest.config.cjs', fs.readFileSync(path.join(root, 'sub/var/jest.config.cjs'), 'utf8'), ts);
  A('mapper 写成变量引用必须记"形状读不到⇒不可判"，不得读成"这个面没有映射"（静默空读＝假绿）',
    jv.unparsedMapper === true && jv.prefixDirs.size === 0, JSON.stringify(jv.notes));
  // 有效 paths 的继承链：本仓 tsconfig.spec.json／client/tsconfig.jest.json 都不自己声明 paths，
  // 直接把这种文件交给闭包 ⇒ paths 读成空 ⇒ `@server/*` 整批当外部包，语料静默缩水。
  w('inh/tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@p/*': ['p/*'] } } }));
  w('inh/tsconfig.child.json', JSON.stringify({ extends: './tsconfig.base.json' }));
  w('inh/tsconfig.override.json', JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { baseUrl: './', paths: { '@o/*': ['o/*'] } } }));
  w('inh/tsconfig.extpkg.json', JSON.stringify({ extends: 'some-preset/lib/tsconfig.base.json' }));
  const eChild = effectivePaths(root, 'inh/tsconfig.child.json', ts);
  const eOver = effectivePaths(root, 'inh/tsconfig.override.json', ts);
  const ePkg = effectivePaths(root, 'inh/tsconfig.extpkg.json', ts);
  A('子档不声明、父档声明 ⇒ 有效 paths 必须取到父档（取不到就会把别名整批当外部包）',
    !eChild.error && eChild.from === 'inh/tsconfig.base.json' && Object.keys(eChild.options.paths).join() === '@p/*',
    JSON.stringify(eChild.error || eChild.from));
  A('子档自己声明 paths ⇒ 必须是**整体覆盖**而不是与父档合并（TS 语义，读成合并会凭空多出面）',
    !eOver.error && Object.keys(eOver.options.paths).join() === '@o/*', JSON.stringify(eOver.options.paths && Object.keys(eOver.options.paths)));
  A('一路继承到外部包而没声明 paths ⇒ 必须报错判不可判，不得回退到别档或读成零别名',
    !!ePkg.error && /外部包/.test(ePkg.error), JSON.stringify(ePkg.error));
  /* R-3（V344，TSCINC-01 的形状）：include 相对**该文件自己的目录**是否落得到地上。
     五支控制：整批落空必须红／改成相对自身目录（含 ../ 写法）必须不红／部分落空只点名／
     根本没有这一项必须记"不判"而不是"没有落空"／glob 指到**文件**不得算落空（真实形状：
     `tsconfig.playwright.json` 的 include 里有 `playwright.config.ts`，按"必须是目录"判会把合规档读成红）。*/
  w('inc/server/keep.ts', 'export const k = 1;\n');
  w('inc/sub/playwright.config.ts', 'export const pw = 1;\n');
  w('inc/sub/tsconfig.dead.json', JSON.stringify({ include: ['scripts/**/*', 'server/**/*'], compilerOptions: { baseUrl: '.' } }));
  w('inc/sub/tsconfig.live.json', JSON.stringify({ include: ['**/*.ts', '../server/**/*.ts'], compilerOptions: { baseUrl: '.' } }));
  w('inc/sub/tsconfig.part.json', JSON.stringify({ include: ['**/*.ts', 'ghosts/**/*'] }));
  w('inc/sub/tsconfig.none.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
  w('inc/sub/tsconfig.file.json', JSON.stringify({ include: ['playwright.config.ts'] }));
  const incOne = (rel) => judgeIncludes([tsSurfaceFrom(root, rel)], (r) => path.dirname(path.join(root, r)), (q) => fs.existsSync(q))[0];
  const iDead = incOne('inc/sub/tsconfig.dead.json'), iLive = incOne('inc/sub/tsconfig.live.json');
  const iPart = incOne('inc/sub/tsconfig.part.json'), iNone = incOne('inc/sub/tsconfig.none.json');
  const iFile = incOne('inc/sub/tsconfig.file.json');
  A('include 整批按父目录写而文件住在子目录 ⇒ 必须判红（TS18003 那一族的形状）',
    iDead.verdict.startsWith('红') && /scripts\/\*\*/.test(iDead.why), JSON.stringify(iDead));
  A('同样一批目标改成相对自身目录（含 `../server/**`）⇒ 必须判"已核对"，不得凭空造红',
    iLive.verdict === '已核对', JSON.stringify(iLive));
  A('只有部分 glob 落空 ⇒ 逐条点名但**不判红**（"某条 glob 暂时没文件"在真实工程里合法）',
    iPart.verdict === '点名（不判红）' && /ghosts/.test(iPart.why), JSON.stringify(iPart));
  A('根本没有 include 这一项 ⇒ 判"不判（无 include）"，不得折成"没有落空"、也不得算红',
    iNone.verdict === '不判（无 include）', JSON.stringify(iNone));
  A('glob 第一段是个**文件**（如 playwright.config.ts）⇒ 不得判落空：存在性要文件与目录都算',
    iFile.verdict === '已核对', JSON.stringify(iFile));
  /* R-4（V349）：R-3 的上界——首段目录存在、include 也写了，编译器仍可一个输入都拿不到。
     夹具三档：只有 README 的目录（R-3 判「在」、R-4 判红，两向同框）／exclude 掏空／有 .ts 的合规档；
     再加「既不 include 也不 files」与「档读不到」两个第三态，免得空输入集与"没这一项"混成一格。 */
  const r3Of = (rel) => judgeIncludes([tsSurfaceFrom(root, rel)], (x) => path.dirname(path.join(root, x)), (q) => fs.existsSync(q))[0];
  w('inc/plain/deep/README.md', 'not a TypeScript source\n');
  w('inc/plain/has.ts', 'export const h = 1;\n');
  w('inc/plain/tsconfig.emptydir.json', JSON.stringify({ include: ['deep/**/*'] }));
  w('inc/plain/tsconfig.excluded.json', JSON.stringify({ include: ['**/*.ts'], exclude: ['**/*.ts'] }));
  w('inc/plain/tsconfig.ok.json', JSON.stringify({ include: ['**/*.ts'] }));
  w('inc/sub/tsconfig.filesonly.json', JSON.stringify({ files: ['playwright.config.ts'] }));
  const rEmpty = resolvedInputs(ts, root, 'inc/plain/tsconfig.emptydir.json');
  const rExcl = resolvedInputs(ts, root, 'inc/plain/tsconfig.excluded.json');
  const rOk = resolvedInputs(ts, root, 'inc/plain/tsconfig.ok.json');
  const rNone = resolvedInputs(ts, root, 'inc/sub/tsconfig.none.json');
  const rMiss = resolvedInputs(ts, root, 'inc/sub/tsconfig.nosuch.json');
  const rFiles = resolvedInputs(ts, root, 'inc/sub/tsconfig.filesonly.json');
  A('R-4 上界那一刀：首段目录存在但里面没有一个可编译文件 ⇒ R-3 必须判「已核对」而 R-4 必须判红（两向同框才算量到上界）',
    r3Of('inc/plain/tsconfig.emptydir.json').verdict === '已核对' && rEmpty.verdict.startsWith('红') && rEmpty.files === 0,
    JSON.stringify({ r3: r3Of('inc/plain/tsconfig.emptydir.json').verdict, r4: rEmpty.verdict, files: rEmpty.files }));
  A('exclude 把 include 拿到的全排掉 ⇒ R-4 必须判红（首段存在、include 非空都救不回空输入集）',
    rExcl.verdict.startsWith('红') && rExcl.files === 0, JSON.stringify({ verdict: rExcl.verdict, files: rExcl.files }));
  A('合规一档（目录里真有 .ts）⇒ R-4 判「已核对」且 files>0（正向对照：这条不开火，上面两条的红才不是永真）',
    rOk.verdict === '已核对' && rOk.files > 0, JSON.stringify({ verdict: rOk.verdict, files: rOk.files }));
  A('既无 include 也无 files ⇒ 必须判「不判」，不得折成「解析集为空」的红（默认规则是整目录递归，本尺不猜）',
    rNone.verdict === '不判（无 include 也无 files）', JSON.stringify(rNone));
  A('档读不到 ⇒ 必须判「不可判」，不得折成 0 输入的红（文件不存在与输入集为空是两个事实）',
    rMiss.verdict === '不可判', JSON.stringify(rMiss));
  A('files 直指盘上存在的文件（没有 include）⇒ R-4 必须判已核对，不得因为缺 include 就判红',
    rFiles.verdict === '已核对' && rFiles.files > 0, JSON.stringify({ verdict: rFiles.verdict, files: rFiles.files }));
  /* V350 的第二层上界：真实树里有两个面自己不声明 include、全靠 extends（探针实测有效 include 各 2 条、
     fileNames 各 804）。V349 那一版只喂自己声明的 raw JSON，对它们判「不判」；这里要求两向同框——
     **自身 raw 的 include／files 都是 0**（V349 的入判条件成立）而整条链必须拿到 >0 个输入。
     再配一条「extends 指空 ⇒ 不可判」：干净克隆没装依赖时就是这个形状，折成红就是把环境读成回归。 */
  w('inc/chain/tsconfig.base.json', JSON.stringify({ include: ['src/**/*.ts'] }));
  w('inc/chain/src/a.ts', 'export const a = 1;\n');
  w('inc/chain/child/tsconfig.json', JSON.stringify({ extends: '../tsconfig.base.json' }));
  w('inc/chain/child/tsconfig.broken.json', JSON.stringify({ extends: '../no-such-base.json' }));
  const rInh = resolvedInputs(ts, root, 'inc/chain/child/tsconfig.json');
  const ownRaw = (ts.readConfigFile(path.join(root, 'inc/chain/child/tsconfig.json'), ts.sys.readFile).config || {});
  const rBroken = resolvedInputs(ts, root, 'inc/chain/child/tsconfig.broken.json');
  A('第二层上界：子档自己不声明 include／files（V349 那版会判「不判」）而输入集全靠 extends ⇒ '
    + '整条解析链必须判「已核对」且 files>0，并标出 inherited=true（两向同框才算量到这一层）',
    (ownRaw.include === undefined && ownRaw.files === undefined)
    && rInh.verdict === '已核对' && rInh.files > 0 && rInh.inherited === true,
    JSON.stringify({ ownInclude: ownRaw.include === undefined ? '（无）' : '有', verdict: rInh.verdict,
      files: rInh.files, inherited: rInh.inherited }));
  A('继承来的 include 必须按**声明它的那一档的目录**重锚（父档写 src/**、子档在 child/ 下）⇒ 拿到 1 个输入而不是 0；'
    + '自研合并会把父档的 glob 按子档目录解，凭空造出「解析集为空」的假红',
    rInh.files === 1 && /继承自/.test(rInh.why), JSON.stringify({ files: rInh.files, why: rInh.why }));
  A('extends 指向读不到的父档 ⇒ 必须判「不可判」并点出链断裂，不得折成「解析集为空」的红，也不得读成绿（干净克隆未装依赖就是这个形状）',
    rBroken.verdict === '不可判' && /链断裂/.test(rBroken.why), JSON.stringify({ verdict: rBroken.verdict, codes: rBroken.codes }));
  A('字面不同但归一到同一目录必须判一致（比解析结果不比字面）',
    !!at('@/') && !at('@/').conflict && at('@/').dirs.length === 1,
    at('@/') ? at('@/').dirs.map((d) => d.replace(root, '')).join(' ≠ ') : '没收到');
  A('归一后确实不同目录的前缀必须判红', !!at('@x/') && at('@x/').conflict && at('@x/').dirs.length === 2,
    at('@x/') ? at('@x/').dirs.map((d) => d.replace(root, '')).join(' ≠ ') : '没收到');
  A('jest 映射指向盘上没有的目录必须判红（tsconfig 那一侧目录不存在不算，它是候选表）',
    !!at('@nope/') && at('@nope/').staleTargets.length === 1, at('@nope/') ? JSON.stringify(at('@nope/').staleTargets) : '没收到');

  // R-2 六档：夹具里 runner 只映射 `@/`，`@y/` 一律没映射（该红／该不判就看探针）
  const surf = [{ rel: 'sub/a/jest.config.cjs', kind: 'jest', prefixDirs: new Map([['@/', path.join(root, 'sub/src')]]), dirs: new Map(), notes: [] }];
  const one = (u, note) => [{ surfaceRel: 'sub/a/jest.config.cjs', used: u, corpusNote: note }];
  const cellY = { files: new Set(['sub/a/one.ts']), file: 'sub/a/one.ts', spec: '@y/thing' };
  const cellAt = { files: new Set(['sub/a/two.ts']), file: 'sub/a/two.ts', spec: '@/lib' };
  const usedY = new Map([['@y/', cellY]]);
  const usedAt = new Map([['@/', cellAt]]);
  const ex = (p) => fs.existsSync(p);
  const rRed = judgeCoverage(one(usedY, 'x'), surf, () => false, ex);
  const rPkg = judgeCoverage(one(usedY, 'x'), surf, (f, spec) => spec === '@y/thing', ex);
  const rCov = judgeCoverage(one(usedAt, 'x'), surf, () => false, ex);
  const rOff = judgeCoverage(one(null, '语料未启用'), surf, () => false, ex);
  const genSurf = [{ rel: 'g/jest.config.cjs', kind: 'jest', generated: true, prefixDirs: new Map(), dirs: new Map(), notes: ['生成档'] }];
  const rGen = judgeCoverage([{ surfaceRel: 'g/jest.config.cjs', used: usedY }], genSurf, () => false, ex);
  const ghostSurf = [{ rel: 'sub/a/jest.config.cjs', kind: 'jest', prefixDirs: new Map([['@/', path.join(root, 'sub/ghost-dir')]]), dirs: new Map(), notes: [] }];
  const rGhost = judgeCoverage(one(usedAt, 'x'), ghostSurf, () => false, ex);
  A('语料真用到、mapper 没有、包也解不出 ⇒ 必须红', rRed[0].verdict === '红：欠映射', rRed[0].verdict);
  A('同一欠映射若 require.resolve 解得出 ⇒ 必须不判（不拿集合差集冒充缺陷）', rPkg[0].verdict === '不判（包自己解得出）', rPkg[0].verdict);
  A('mapper 覆盖了就不该再出现红（探针解不出也不连坐——红只能由"没映射"造出来）',
    rCov[0].verdict === '已覆盖', rCov[0].verdict);
  A('映射覆盖了但指向盘上没有的目录 ⇒ 必须红（这一档 R-1 看不见：那一侧只有 jest 声明）',
    rGhost[0].verdict === '红：映射指向盘上没有的目录', rGhost[0].verdict);
  A('语料未启用必须落不可判、不得折成"没有欠映射"', rOff[0].verdict === '不可判' && /未启用/.test(rOff[0].why), JSON.stringify(rOff[0]));
  A('生成档必须记不可判而不是红（pathsToModuleNameMapper 落地后这把尺不能变假红）', rGen[0].verdict === '不可判' && /生成档/.test(rGen[0].why), JSON.stringify(rGen[0]));

  // 正则转义前缀：ts-jest 生成形状是 '^@lark\\-apaas/x/(.*)$'，不还原转义就永远匹配不到真实说明符 ⇒ 假红
  w('sub/b/jest.config.cjs', "module.exports = { moduleNameMapper: { '^@lark\\\\-apaas/x/(.*)$': '<rootDir>/lib/$1' } };\n");
  const jb = jestSurfaceFrom(root, 'sub/b/jest.config.cjs', fs.readFileSync(path.join(root, 'sub/b/jest.config.cjs'), 'utf8'), ts);
  const keysB = [...jb.prefixDirs.keys()];
  A('带转义的键必须还原成词面前缀（`@lark\\-apaas/x/` ⇒ `@lark-apaas/x/`），否则匹配不到真实说明符',
    keysB.length === 1 && keysB[0] === '@lark-apaas/x/', JSON.stringify(keysB));

  // 形状点名两支
  w('sub/c/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@app': ['./src/app.ts'], '@z/*': ['./z/*/deep/*'] } } }));
  const sc = tsSurfaceFrom(root, 'sub/c/tsconfig.json');
  A('非 prefix/* 与 * 不在末尾的 paths 条目必须逐条点名不可判（不得静默收下）',
    sc.prefixDirs.size === 0 && sc.notes.filter((n) => /不可判/.test(n)).length === 2, JSON.stringify(sc.notes));
  w('sub/d/tsconfig.json', '{ "compilerOptions": { "paths": {');
  const sd = tsSurfaceFrom(root, 'sub/d/tsconfig.json');
  A('坏 JSON 的面必须整面不可判并点名（不得读成"这份文件没有别名"）', !!sd.error, JSON.stringify(sd));
  w('sub/e/tsconfig.json', JSON.stringify({ extends: '../tsconfig.json' }));
  const se = tsSurfaceFrom(root, 'sub/e/tsconfig.json');
  A('只靠继承拿 paths 的文件必须标 inheritedOnly 并写明"只作参考"（不得读成零别名）',
    se.inheritedOnly === true && se.notes.some((n) => /只作参考/.test(n)), JSON.stringify(se.notes));

  // 分母自证：夹具树上两份 jest 面（jest.config.*＋package.json#jest）都要进清单，三份面同前缀必须归一到同一目录
  const twoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alysync2-'));
  const twoPkg = path.join(twoRoot, PKG);
  fs.mkdirSync(path.join(twoPkg, 'server'), { recursive: true });
  fs.mkdirSync(path.join(twoPkg, 'client'), { recursive: true });
  fs.writeFileSync(path.join(twoPkg, 'package.json'), JSON.stringify({ jest: { moduleNameMapper: { '^@s/(.*)$': '<rootDir>/server/$1' } } }));
  fs.writeFileSync(path.join(twoPkg, 'tsconfig.app.json'), JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@s/*': ['server/*'] } } }));
  fs.writeFileSync(path.join(twoPkg, 'client/jest.config.cjs'), "module.exports = { moduleNameMapper: { '^@s/(.*)$': '<rootDir>/../server/$1' } };\n");
  fs.writeFileSync(path.join(twoPkg, 'client/tsconfig.jest.json'), JSON.stringify({ extends: '../tsconfig.app.json' }));
  const col = collectSurfaces(twoRoot, ts);
  const pkgFace = col.surfaces.find((x) => /package\.json$/.test(x.rel));
  A('分母自证：夹具树的 2 份 tsconfig＋2 份 jest 面（含 package.json#jest）都要进清单',
    col.tsRels.length === 2 && col.jestRels.length === 1 && !!pkgFace && pkgFace.prefixDirs.size === 1 && col.surfaces.length === 4,
    `ts=${col.tsRels.length} jest=${col.jestRels.length} pkg=${pkgFace ? pkgFace.prefixDirs.size : '缺'} 面=${col.surfaces.length}`);
  const colRows = judgeTargets(col.surfaces, (p) => fs.existsSync(p)).rows;
  A('三份声明同一前缀的面归一后必须同目录（跨 rootDir／baseUrl 的四种写法算一件事）',
    colRows.length === 1 && colRows[0].dirs.length === 1 && !colRows[0].conflict,
    JSON.stringify(colRows.map((r) => `${r.prefix}:${r.dirs.map((d) => d.replace(twoRoot, '')).join('|')}`)));
  // tsconfig 声明相对 rootDir：client/tsconfig.jest.json 的 extends 不展开时，runner 面仍要认到 app 那份
  const cliFace = col.surfaces.find((x) => /client\/jest\.config\.cjs$/.test(x.rel));
  A('runner 的 tsconfig 声明按 rootDir 解析：client 配置的默认 rootDir＝配置目录，找不到文件就记 null 不乱猜',
    cliFace && cliFace.tsconfigRel === null, JSON.stringify(cliFace && cliFace.tsconfigRel));

  const col2root = fs.mkdtempSync(path.join(os.tmpdir(), 'alysync3-'));
  const w2 = (rel, txt) => { const p = path.join(col2root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
  // 枚举器只走 `ewoh-spark-app/` 这一棵，所以夹具也必须长成那个形状（放别处会得到空清单，
  // 而"空清单"与"真的没有面"在终端上同形——上面那支 `col` 用的就是这棵树）
  w2('ewoh-spark-app/tsconfig.app.json', JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@v/*': ['./src/*'] } } }));
  w2('ewoh-spark-app/package.json', JSON.stringify({ name: 'x', scripts: { test: 'jest' } }));
  w2('ewoh-spark-app/jest.config.cjs', "function build() { return { '^@v/(.*)$': '<rootDir>/src/$1' }; }\nmodule.exports = { moduleNameMapper: build() };\n");
  fs.mkdirSync(path.join(col2root, 'ewoh-spark-app/src'), { recursive: true });
  const col2 = collectSurfaces(col2root, ts, { requireGenerated: true });
  const genFace = col2.surfaces.find((x) => /jest\.config\.cjs$/.test(x.rel));
  A('生成档那一臂必须真的把表读进面清单（V342 之后四份跑测档全是生成档，读不到＝这把尺整件失去牙）',
    !!genFace && genFace.generated === true && genFace.prefixDirs.size === 1 && /require 档/.test(genFace.valueFrom || ''),
    `面=${col2.surfaces.length} 读到=${genFace ? genFace.prefixDirs.size : '无'}`);
  A('package.json 没有 jest 键 ⇒ 记"不是跑测档"（V342 之后是常态），既不算面也不得记成"读不到"',
    col2.nonFaces.some((r) => /package\.json$/.test(r)) && !col2.surfaces.some((x) => /package\.json$/.test(x.rel))
    && col2.unreadable.length === 0,
    `nonFaces=${JSON.stringify(col2.nonFaces)} unreadable=${JSON.stringify(col2.unreadable)}`);
  const col2Rows = judgeTargets(col2.surfaces, (p) => fs.existsSync(p)).rows;
  A('生成档算出的目录与 tsconfig 权威同目录 ⇒ 全清单必须判一致（这一臂不得凭空造红）',
    col2Rows.length === 1 && !col2Rows[0].conflict, JSON.stringify(col2Rows.map((r) => `${r.prefix}:${r.dirs.length}`)));
  fs.writeFileSync(path.join(col2root, 'ewoh-spark-app/jest.config.cjs'),
    "function build() { return { '^@v/(.*)$': '<rootDir>/elsewhere/$1' }; }\nmodule.exports = { moduleNameMapper: build() };\n");
  const col2Bad = judgeTargets(collectSurfaces(col2root, ts, { requireGenerated: true }).surfaces, (p) => fs.existsSync(p)).rows;
  A('把生成函数改成指别处 ⇒ 必须立刻判红（证明比对吃的是执行出来的实际值，不是函数名）',
    col2Bad.length === 1 && col2Bad[0].conflict, JSON.stringify(col2Bad.map((r) => r.dirs.length)));
  fs.writeFileSync(path.join(col2root, 'ewoh-spark-app/jest.config.cjs'),
    "function build() { throw new Error('夹具抛错'); }\nmodule.exports = { moduleNameMapper: build() };\n");
  const col2Boom = collectSurfaces(col2root, ts, { requireGenerated: true });
  A('配置件 require 抛错 ⇒ 整面按不可判点名，绝不折成"这个面没有映射"（静默空读＝假绿）',
    col2Boom.surfaces.every((x) => !/jest\.config\.cjs$/.test(x.rel) || x.prefixDirs.size === 0)
    && col2Boom.surfaces.some((x) => /jest\.config\.cjs$/.test(x.rel) && x.notes.some((n) => /require 失败/.test(n))),
    JSON.stringify(col2Boom.surfaces.filter((x) => /cjs$/.test(x.rel)).map((x) => x.notes)));

  const bad = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log(`  ${c.ok ? '✔' : '✗'} ${c.name}${c.ok ? '' : `（实得 ${c.detail}）`}`));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(twoRoot, { recursive: true, force: true });
  fs.rmSync(col2root, { recursive: true, force: true });
  console.log(`[alias-sync] 判据自测 ${checks.length - bad.length}/${checks.length} 通过`);
  return bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { collectSurfaces, judgeTargets, judgeCoverage, prefixesUsed, tsSurfaceFrom, jestSurfaceFrom,
  deadIncludeGlobs, judgeIncludes, resolvedInputs, judgeResolutions,
  resolveTsconfigDecl, effectivePaths, REPO };
