#!/usr/bin/env node
/**
 * 已闭修法 ↔ 常驻防回归位点 的逐项核验（V114 常驻入口）。
 *
 * 要回答的是目标里那句"恢复能力得到改善"能不能**继续成立**：一条修法一旦闭掉，
 * 今天有没有一个**真在执行的东西**会在它被改回去时变红。登记册里 28 项已闭条目，
 * 文本上"看起来提到位点"的有 23 项——但"提到"不等于"存在且常驻"：
 * 引用可能写错号、用例可能在磁盘上却不在重放清单里、门禁脚本可能谁都没调用。
 *
 * 位点只认四类**活证据**（都从产物反解，不信文档措辞）：
 *   A 用例号：该号出现在某个测试的**标题行**里（e2e spec / 后端单测 / 边缘 pytest），
 *     且 e2e 的还要看它是否真在 `CHAIN_SPECS` 清单里（在磁盘但不在清单 = 重放不会跑它）。
 *   B 门禁规则：`scripts/audit-*.js` 被 Makefile 的「── 主线N」某条实跑引用。
 *   C 重放场景：`e2e:<name>` 在 verify.sh 的权威 SCENARIOS 清单里。
 *   D 常驻入口：`make <target>` 在 Makefile 里真的存在。
 * 「§5.3 里提过」「见某文档」**不是位点**——这是本判据存在的理由。
 *
 * 退出码：0 全部已闭条目都有 ≥1 个活位点；1 存在"无活位点"或"引用了不存在的位点"；
 *        3 输入不可判（登记册 / 文档 / 清单读不到）。
 * 用法：node scripts/chain-baseline/fix-sites.cjs [--json] [--self-test]
 *      夹具用 --state/--doc/--verify/--specs/--makefile/--unitdir/--edgetests/--scripts 覆盖。
 *      归属档 V186_SECTION_ATTRIBUTION=entry（默认，只认登记条目正文）|strict（标题点名的小节）|loose（旧行为）；
 *      V186 同时新增 E 类常驻门禁位点（正文自点的 scripts/ 脚本 + 主线/CI 接线现算）。
 *      主线段边界 V187_MAINLINE_SCOPE=segment（默认，止于下一个目标头）|persistent（旧口径，延续到文件尾）。
 *      两档差值由 scripts/chain-baseline/attribution-shadow.cjs 并排读数，本工具默认不跑旧档。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const TOKEN = /\b[A-Z]{1,5}-\d{1,3}[a-z]?\b/g;   // 必须有词边界：否则 BS-02 会被切成 S-0（实测噪声源）
// argv 必须"每次现读"且名字自带 --：旧实现把 argv 冻结在加载时、又在 opt() 里再补一次 `--`，
// 于是 defaults() 里 opt('--state') 实际找的是 `----state` ⇒ 文件头写着的夹具覆盖面一直没生效（V186 实测）。
const argv = () => process.argv.slice(2);
const flag = (n) => argv().includes(n.startsWith('--') ? n : `--${n}`);
const opt = (n) => { const a = argv(); const i = a.indexOf(n.startsWith('--') ? n : `--${n}`); return i >= 0 ? a[i + 1] : undefined; };

function numOnly(t) { return /^\d+$/.test(t); }
/** V186 位点归属档：entry（默认，只认登记条目自己的正文）｜strict（只认标题点名该号的小节）｜loose（旧行为，正文含该号即整段并入）。
 *  实测三档在同一语料上的位点面：loose 802 处 / strict 298 处 / entry 58 处 ⇒ 现行判据 93% 的"位点"来自邻节文字，
 *  并且会在 §5.4 之前新增一节时把该节点名的 spec 名算给**同区共处的其他项**（V185 实测：UIX-02 的声明性豁免被顶成过期）。 */
const SECTION_ATTRIBUTION = (process.env.V186_SECTION_ATTRIBUTION
  || (process.env.V143_STRICT_SECTION ? 'strict' : 'entry')).toLowerCase();
function readIf(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
function chainSpecs(verifyText) {
  const hits = [...verifyText.matchAll(/CHAIN_SPECS="([\s\S]*?)"/g)].map((m) => m[1]);
  if (!hits.length) throw new Error('没有 CHAIN_SPECS');
  return hits.sort((a, b) => b.length - a.length)[0].replace(/\\\s*\n/g, ' ').split(/\s+/).filter(Boolean);
}
function scenarios(verifyText) {
  const hits = [...verifyText.matchAll(/SCENARIOS="([^"]*)"/g)].map((m) => m[1]);
  if (!hits.length) return [];
  return hits.sort((a, b) => b.length - a.length)[0].split(/\s+/).filter(Boolean);
}
/** V187 主线段边界（GATE-24）：旧实现让 `── 主线N` 一直延续到文件尾 ⇒ 后面**别的 Makefile 目标**里的脚本
 *  会被记到最后一条主线号上（实测：接线清单 59 个脚本，段边界口径只有 21 个）。
 *  默认收成"到下一个目标头为止"；`V187_MAINLINE_SCOPE=persistent` 复现旧口径，供判据自测双向对照。
 *  在函数内读 env（不是模块加载期），自测才能在同一进程里跑两档。 */
const TARGET_HEAD = /^[a-z][a-z0-9-]*:/;
const segmentScoped = () => (process.env.V187_MAINLINE_SCOPE || 'segment') !== 'persistent';

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#(?!include)).*$/gm, '');
}

/** A 类：从测试标题行建"用例号 → 位点"索引。 */
function caseIndex(dirs) {
  const index = new Map();      // A：测试标题里的用例号
  const body = new Map();       // A2：测试文件正文（含注释）出现的用例号——位点存在，但不保证是"这条用例" 
  for (const d of dirs) {
    const { dir, kind, inList } = d;
    if (!fs.existsSync(dir)) continue;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) {
          if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue; // 生成物不算位点
          walk(full); continue;
        }
        if (!/\.(ts|js|py)$/.test(e.name)) continue;
        const raw = fs.readFileSync(full, 'utf8');
        const src = stripComments(raw);
        const titles = [];
        if (kind === 'py') {
          // pytest 的用例号写在函数名里（test_no_64a_…），要归一化成 NO-64A 才和文档写法对得上
          for (const m of src.matchAll(/^\s*(?:async\s+)?def\s+(test_[a-z0-9_]+)\b/gm)) {
            const nm = m[1].replace(/^test_/, '');
            const spaced = nm.replace(/_/g, ' ').toUpperCase();
            // 边缘侧写法是 test_s_03_… / test_no_64a_…：把"前缀 + 数字"再拼成 S-03 / NO-64A 才和文档写法一致
            const dashed = (nm.toUpperCase().match(/([A-Z]{1,5})[_]?(\d{1,3})([A-Z]?)/g) || [])
              .map((x) => x.replace(/^([A-Z]+)[_]?/, '$1-').replace(/_+/g, '-'));
            titles.push({ text: spaced + ' ' + dashed.join(' '), line: raw.slice(0, m.index).split('\n').length });
          }
        } else {
          for (const m of src.matchAll(/\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]{0,400}?)\1/g)) {
            titles.push({ text: m[2], line: raw.slice(0, m.index).split('\n').length });
          }
        }
        for (const t of titles) {
          for (const tok of (t.text.match(TOKEN) || [])) {
            const key = tok.toUpperCase();
            if (!index.has(key)) index.set(key, []);
            index.get(key).push({ kind, file: path.relative(ROOT, full), line: t.line, inList: inList ? inList(e.name) : null });
          }
        }
        // 原文（含注释）：注释里出现的号说明"这个位点被提过但可能不是执行用例"，
        // 那是**待加固**（记为提示），不是假引用；只有哪儿都找不到的号才是假引用。
        for (const tok of (raw.match(TOKEN) || [])) {
          const key = tok.toUpperCase();
          if (!body.has(key)) body.set(key, []);
          if (body.get(key).length < 3) body.get(key).push({ kind, file: path.relative(ROOT, full) });
        }
      }
    };
    walk(dir);
  }
  index.body = body;
  return index;
}

/** B 类：audit 脚本 → 它被哪条主线 / 哪个 CI workflow 引用。
 *  两个接线面都必须看：本轮实测 `audit-openapi-routes.js` 不在任何主线上，却被
 *  standalone.yml 与 test.yml 以 `--strict` 执行——只看 Makefile 会把它误判成"没有门禁"。*/
function gateIndex(makeText, scriptsDir, workflowDir) {
  const map = new Map();
  const lines = makeText.split('\n');
  let mainline = null;
  for (const l of lines) {
    const m = l.match(/──\s*主线(\d+)/);
    if (m) mainline = Number(m[1]);
    else if (segmentScoped() && TARGET_HEAD.test(l)) mainline = null;   // 下一个目标头 ⇒ 主线段结束
    if (!mainline) continue;
    for (const s of (l.match(/scripts\/audit-[a-z0-9-]+\.js/g) || [])) {
      const name = path.basename(s);
      if (!map.has(name)) map.set(name, []);
      if (!map.get(name).includes(mainline)) map.get(name).push(mainline);
    }
  }
  const ci = new Map();
  if (workflowDir && fs.existsSync(workflowDir)) {
    for (const f of fs.readdirSync(workflowDir).filter((x) => /\.ya?ml$/.test(x))) {
      const t = fs.readFileSync(path.join(workflowDir, f), 'utf8');
      if (/continue-on-error/.test(t) && t.indexOf(f) === 0) { /* 占位：见下方 coe 检查 */ }
      for (const m of t.matchAll(/scripts\/(audit-[a-z0-9-]+\.js)/g)) {
        const name = m[1];
        if (!ci.has(name)) ci.set(name, []);
        if (!ci.get(name).includes(f)) ci.get(name).push(f);
      }
    }
  }
  const exists = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir).filter((f) => /^audit-.*\.js$/.test(f)) : [];
  return { map, ci, exists: new Set(exists) };
}

/** E 类索引：登记条目正文点名的 `scripts/...` 脚本 → 它被哪几条主线 / 哪个 CI workflow 调用、文件在不在。
 *  接线面与 B 类同构（Makefile 主线 + CI workflow 两处都要看），并且**允许一跳**：
 *  主线/CI 上写的是 `make test-gated`，而脚本在 test-gated 的配方里，同样算常驻
 *  （V186 实测：CI-01a 的 scripts/assert-test-skips.py 正是这条形状——旧判据只认直调，把它读成"没接线"）。
 *  差别只在 B 类专管 `audit-*.js`、E 类收其余（verify.sh、chain-baseline/*.cjs、assert-*.py……）。
 *  "含判据自测"只作为信息位打印（有/没有都算位点），免得给一个既有修法凭空造出新的红。*/
function instrumentIndex(makeText, workflowDir, scriptsDir) {
  const RE = /scripts\/[A-Za-z0-9._/-]+\.(?:js|cjs|mjs|sh|py)/g;
  const norm = (x) => x.replace(/^\.\//, '');
  const base = scriptsDir ? path.dirname(scriptsDir) : process.cwd();
  // 1) Makefile 逐行：当前主线号、目标配方（target → 该目标体内出现的脚本路径）
  const lines = makeText.split('\n');
  const recipe = new Map();
  let curTarget = null, mainline = null;
  const directMain = new Map();      // 脚本 → [主线号]
  const makeOnWired = new Map();     // `make 目标` → 出现在哪些接线上（主线号 / workflow 名）
  const put = (m, k, v) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(v)) m.get(k).push(v); };
  for (const l of lines) {
    const mm = l.match(/──\s*主线(\d+)/);
    if (mm) mainline = Number(mm[1]);
    const tgt = l.match(/^([a-z][a-z0-9-]*):/);
    if (!mm && segmentScoped() && tgt) mainline = null;   // 下一个目标头 ⇒ 主线段结束（GATE-24）
    if (tgt) { curTarget = tgt[1]; if (!recipe.has(curTarget)) recipe.set(curTarget, []); }
    else if (!/^[ \t]/.test(l) && l.trim()) curTarget = null;
    for (const x of (l.match(RE) || [])) {
      const name = norm(x);
      if (mainline) put(directMain, name, mainline);
      if (curTarget && !recipe.get(curTarget).includes(name)) recipe.get(curTarget).push(name);
    }
    for (const g of (l.match(/make\s+([a-z][a-z0-9-]*)/g) || [])) {
      const t = g.split(/\s+/)[1];
      if (mainline) put(makeOnWired, t, `主线${mainline}`);
    }
  }
  // 2) CI workflow：脚本直调 + `make 目标` 两种写法
  const directCi = new Map();
  if (workflowDir && fs.existsSync(workflowDir)) {
    for (const f of fs.readdirSync(workflowDir).filter((x) => /\.ya?ml$/.test(x))) {
      const t = fs.readFileSync(path.join(workflowDir, f), 'utf8');
      for (const m of t.matchAll(/scripts\/([A-Za-z0-9._/-]+\.(?:js|cjs|mjs|sh|py))/g)) put(directCi, 'scripts/' + m[1], f);
      for (const m of t.matchAll(/make\s+([a-z][a-z0-9-]*)/g)) put(makeOnWired, m[1], f);
    }
  }
  // 3) 汇总：直调 ∪ 经"被接线目标"的一跳
  const mains = new Map(), ci = new Map();
  for (const [name, arr] of directMain) arr.forEach((m) => put(mains, name, `主线${m}`));
  for (const [name, arr] of directCi) arr.forEach((f) => put(ci, name, f));
  for (const [t, faces] of makeOnWired) {
    for (const name of (recipe.get(t) || [])) {
      for (const f of faces) put(/^主线/.test(f) ? mains : ci, name, `${f}→make ${t}`);
    }
  }
  const selfTesting = new Set();
  for (const name of [...mains.keys(), ...ci.keys()]) {
    if (!/\.(cjs|mjs|js|sh)$/.test(name)) continue;
    const t = readIf(path.join(base, name)) || '';
    if (t.includes('--self-test') || t.includes('selfTest(')) selfTesting.add(name);
  }
  return {
    mains, ci, selfTesting,
    exists: (name) => fs.existsSync(path.join(base, name)),
  };
}

function analyze(entry, ctx) {
  // GATE-28：编号归因必须两支都试过再落占位串。旧写法先 `m1 || '（无编号）'` 再 `r0.id || m2`，
  // 而占位串是 truthy ⇒ 第二支永不参与，凡 ≥7 字母前缀（RCPTCTX-01／DOCFACE-01／KPIRATE-01，
  // 第一支的 `[A-Z]{1,6}` 装不下）在「引用的位点不成立」那一行里统统印成（无编号），读者回不到登记行。
  const parent = (entry.match(/^\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/) || [])[1];
  const r0 = {
    id: (entry.match(/^\s*([A-Z]{1,6}-\d{1,3}[a-z]?)/) || [])[1]
      || (entry.match(/^\s*([A-Z][A-Z0-9-]*)/) || [])[1]
      || parent || '（无编号）',
  };
  const extra = SECTION_ATTRIBUTION === 'entry' ? ''
    : (ctx.sections.get(r0.id) || ctx.sections.get(parent) || '');
  const body = entry + '\n' + extra;
  const sites = []; const badCites = []; const citeNotes = [];
  const tokens = new Set((body.match(TOKEN) || []).map((x) => x.toUpperCase()));
  for (const tok of tokens) {
    const hits = ctx.cases.get(tok.toUpperCase()) || ctx.bodyIdx.get(tok.toUpperCase());
    if (hits && hits.length) {
      // kind==='register' 是"登记册/契约文档里提过"，**不是**可执行的防回归位点：
      // V116 实测这一支被算进 live，于是"文档提过就算有位点"，与 V114 自己写的判据相反，
      // 也把"每项已闭都有活位点"的读数抬高了（GATE-09）。
      const live = hits.filter((h) => h.kind !== 'e2e' && h.kind !== 'register' || h.kind === 'e2e' && h.inList === true);
      const offList = hits.filter((h) => h.kind === 'e2e' && h.inList === false);
      const onlyDoc = hits.every((h) => h.kind === 'register');
      if (live.length) {
        const inTitle = ctx.cases.get(tok.toUpperCase()) || [];
        sites.push({
          type: inTitle.length ? 'A 用例号' : 'A2 用例号（在测试文件正文，非标题）',
          what: tok, where: live.map((h) => `${h.file}:${h.line}`).slice(0, 2),
        });
      }
      else if (onlyDoc) {
        citeNotes.push(`${r0.id}：位点号「${tok}」只在登记册/契约文档里出现过，不算活位点（V116 判据）`);
      }
      else if (offList.length) {
        sites.push({ type: 'A 用例号（不在重放清单）', what: tok, where: offList.map((h) => `${h.file}:${h.line}`).slice(0, 2), weak: true });
      }
    } else if (tokens.has(tok.replace(/-\d+$/, '') + '-1') || /\d/.test(tok) === false) {
      // 形如 S-0 的"区间前缀"写法（文档里写 S-0[1-6]）不是单个位点引用：跳过
    } else if (ctx.isPrefixOfResolved(tok, tokens)) {
      // 它是同一段里某个可解析号的前缀（S-0 ⊂ S-03/S-06）⇒ 区间写法，不是假引用
    } else if (tok.toUpperCase() === r0.id.toUpperCase() && !ctx.cases.has(tok.toUpperCase())) {
      // 条目自己的编号（F-01 等）反复出现在文档里，不是"引用了一个位点"
    } else if (ctx.mentioned(tok)) {
      citeNotes.push(`${r0.id}：位点号「${tok}」只出现在测试文件正文/注释或登记册里，不是可执行的用例标题（待加固）`);
    } else if (ctx.citedHere(body, tok) && !ctx.registerIds.has(tok)) {
      // 只有"号 + 位点措辞"同时出现才算**引用了一个位点**：登记册自己的编号（BR-01/F-10b 之类）
      // 不是测试位点，第一版把它们一律当引用，报了 191 条噪声——判据过宽等于没有判据。
      badCites.push(tok);
    }
  }
  for (const sn of ctx.specList) {
    if (body.includes(sn) || body.includes(sn + '.e2e.spec.ts')) {
      sites.push({ type: 'A3 常驻 spec', what: sn + '.e2e.spec.ts', where: ['CHAIN_SPECS'] });
    }
  }
  for (const s of new Set((body.match(/scripts\/audit-[a-z0-9-]+\.js/g) || []).map((x) => path.basename(x)))) {
    const mains = ctx.gates.map.get(s);
    const ci = ctx.gates.ci.get(s);
    if (mains && mains.length) sites.push({ type: 'B 门禁规则', what: s, where: [`主线${mains.join('/')}`] });
    else if (ci && ci.length) sites.push({ type: 'B 门禁规则（CI 调用，不在本机主线）', what: s, where: ci, ciOnly: true });
    else if (ctx.gates.exists.has(s)) sites.push({ type: 'B 门禁规则（Makefile 与 CI 都没调用）', what: s, where: ['无调用方'], weak: true });
    else sites.push({ type: 'B 门禁规则（文件不存在）', what: s, where: ['scripts/ 无此文件'], weak: true });
  }
  // E 类（V186）：登记条目**自己点名**的常驻门禁脚本（scripts/ 下、且被主线或 CI 接线）。
  // 判据收紧类修法（GATE-xx）真正的位点不是某个用例号，而是"那条主线上跑着这把尺子"；
  // 全部由磁盘与 Makefile/workflow 现算，与文档邻近性无关 ⇒ 不会被邻节文字污染。audit-*.js 归 B 类，这里跳过。
  for (const name of new Set((body.match(/scripts\/[A-Za-z0-9._/-]+\.(?:js|cjs|mjs|sh|py)/g) || [])
    .map((x) => x.replace(/^\.\//, '')).filter((x) => !/^scripts\/audit-/.test(x)))) {
    const faces = [...new Set([...(ctx.instruments.mains.get(name) || []), ...(ctx.instruments.ci.get(name) || [])])].join('/');
    if (!ctx.instruments.exists(name)) {
      sites.push({ type: 'E 常驻门禁位点（文件不存在）', what: name, where: ['scripts/ 无此文件'], weak: true });
    } else if (!faces) {
      sites.push({ type: 'E 常驻门禁位点（无主线也无 CI 调用）', what: name, where: ['两处接线都没有（含一跳）'], weak: true });
    } else {
      sites.push({ type: 'E 常驻门禁位点', what: name,
        where: [faces + (ctx.instruments.selfTesting.has(name) ? '·含判据自测' : '·无判据自测')] });
    }
  }
  for (const sc of new Set((body.match(/e2e:([a-z0-9-]+)/g) || []).map((x) => x.slice(4)))) {    if (ctx.scen.includes(sc)) sites.push({ type: 'C 重放场景', what: `e2e:${sc}`, where: ['verify.sh SCENARIOS'] });
    else sites.push({ type: 'C 重放场景（不在清单）', what: `e2e:${sc}`, where: ['verify.sh 权威清单里没有'], weak: true });
  }
  for (const t of new Set((body.match(/make\s+([a-z][a-z0-9-]*)/g) || []).map((x) => x.split(/\s+/)[1]))) {
    if (ctx.makeTargets.has(t)) sites.push({ type: 'D 常驻入口', what: `make ${t}`, where: ['Makefile'] });
    else sites.push({ type: 'D 常驻入口（目标不存在）', what: `make ${t}`, where: ['Makefile 无此目标'], weak: true });
  }
  const strong = sites.filter((x) => !x.weak);
  // V143 分档：**行为级**位点 = 会在真链路/真进程上跑的那一类（e2e spec 用例、CHAIN_SPECS 常驻 spec、
  // 一键重放场景、边缘 pytest）。纯函数/组件级 jest 单测与静态门禁**不算行为级**：它们只在"这个函数被改"
  // 时红，不在"这条边界被破坏"时红（V142 刚实测到一例：gap 判据有单测、生产零调用点）。
  const behavioralSite = (x) => {
    if (x.type.startsWith('A3 常驻 spec') || x.type.startsWith('C 重放场景')) return true;
    if (!x.type.startsWith('A 用例号')) return false;
    return (x.where || []).some((p) => /\.e2e\.spec\.ts(?::|$)/.test(p) || /\.py(?::|$)/.test(p));
  };
  const behavioral = strong.some(behavioralSite);
  let tier = '无';
  if (behavioral) tier = '行为级';
  else if (strong.some((x) => x.type.startsWith('B 门禁规则') || x.type.startsWith('E 常驻门禁'))) tier = '静态机检';
  else if (strong.some((x) => x.type.startsWith('A'))) tier = '函数级单测';
  else if (strong.length) tier = '仅常驻入口';
  let verdict = '无可核位点';
  // D 类（正文提到 `make 目标`）不足以证明"这条修法有东西在跑"：V143 实测，解释陷阱的那段叙述文字
  // 自己就含两个目标名，足以把 UIX-02 的"只改注释"豁免顶成过期。⇒ 豁免项只有在存在 A/B/C 类位点时才算过期。
  const nonEntry = strong.filter((x) => !x.type.startsWith('D 常驻入口'));
  if (SITE_FREE_DECLARED[r0.id] && !nonEntry.length && SITE_FREE_PHRASE.test(entry)) verdict = '声明性豁免（只改注释）';
  else if (strong.length) verdict = '有活位点';
  else if (sites.length) verdict = '仅有弱位点';
  return { id: r0.id, verdict, tier, behavioral, sites, badCites, citeNotes, snippet: entry.slice(0, 60) };
}

// 声明性豁免（V138）：**只改注释、行为零变化**的修法原理上不存在行为位点。
// 必须同时满足两条：① 号在下面白名单里（带理由）；② 条目文本自己声明"只改注释/行为零变化"。
// 两道锁，且白名单是双向的：号一旦有了真位点，本工具反过来报"豁免已过期，请删号"——不留后门。
const SITE_FREE_DECLARED = {
  'UIX-02': 'V138 只改注释：useSchedulerStream.ts 的兜底周期说明与实际数字不符',
  // V328（PCND-01 那批的副项）：CI-06 的修法是把 CI 步骤名里冻着的「十三条主线」去掉——
  // 纯文本面、行为零变化，原理上没有行为位点可言；今天复算该冻数早已不在（`.github/workflows/`
  // 里 grep「条主线」0 命中），所以这里登记豁免、登记册那行随之闭合，而不是再造一条用例。
  'CI-06': 'V328 行为零变化：long-cycle-gates.yml 步骤名不再写死主线条数（改由 Makefile 现抽）',
};
const SITE_FREE_PHRASE = /(只改注释|行为零变化)/;

function run(ctx) {
  const problems = []; const notes = [];
  const rows = ctx.fixed.map((e) => analyze(e, ctx));
  for (const r of rows) {
    if (r.verdict !== '有活位点' && r.verdict !== '声明性豁免（只改注释）') {
      problems.push(`${r.id}：${r.verdict}（${r.snippet}…）`);
    }
    // 豁免过期判定：只认 A/B/C（用例标题、门禁主线、重放场景）——D 类"`make 目标`"在**叙述性正文**里
    // 出现太容易（V143：解释"别写 make 前缀"的那段话自己就写了两个目标名，于是把 UIX-02 顶成过期）。
    // 宽档实测：严档（只认标题点名本节的小节）会丢 8 个真行为位点并造出 GATE-01/05/09 三条假"无可核位点"，
    // 所以收紧"小节合并口径"被否决；改为 analyze() 里让 D-only 的豁免项仍判"声明性豁免"，此处只在真有 A/B/C 位点时报过期。
    if (SITE_FREE_DECLARED[r.id] && r.verdict === '有活位点') {
      problems.push(`${r.id}：豁免已过期——现在有 A/B/C 类活位点了，请删掉 SITE_FREE_DECLARED 里的这一号`);
    }
    // 弱位点**一律单独报**：一条修法可以有多重防回归，但只要它引用的某个位点其实不成立，
    // 那句"已闭"就有一块是空头支票——不能因为还有别的强位点就放过（matrix-check 同规）。
    r.sites.filter((x) => x.weak).forEach((x) => problems.push(`${r.id}：引用的位点不成立——${x.type} ${x.what}（${x.where.join('; ')}）`));
    r.badCites.forEach((t) => problems.push(`${r.id}：引用了找不到测试标题的位点号「${t}」`));
  }
  rows.forEach((r) => (r.citeNotes || []).forEach((x) => notes.push('提示 · ' + x)));
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  notes.push(`已闭条目 ${rows.length}：有活位点 ${n('有活位点')}、仅有弱位点 ${n('仅有弱位点')}、`
    + `声明性豁免（只改注释）${n('声明性豁免（只改注释）')}、无可核位点 ${n('无可核位点')}`);
  notes.push(`位点索引：用例号 ${ctx.cases.size} 个｜主线引用脚本 ${ctx.gates.map.size} 个｜重放场景 ${ctx.scen.length} 个｜make 目标 ${ctx.makeTargets.size} 个`);
  // V143：位点**强度**分档。"有活位点"只回答有没有，不回答它在哪个层面红——而推广判据里
  // "维护成本下降 / 业务语义没丢"要的是后者（V142 实测到：gap 判据有单测、生产零调用点）。
  const withSite = rows.filter((r) => r.verdict === '有活位点');
  const cnt = (k) => withSite.filter((r) => r.tier === k).length;
  const noBeh = withSite.filter((r) => !r.behavioral).map((r) => r.id);
  notes.push(`位点强度分档（V143，只在有活位点的 ${withSite.length} 项里分）：行为级 ${cnt('行为级')}｜静态机检 ${cnt('静态机检')}｜`
    + `函数级单测 ${cnt('函数级单测')}｜仅常驻入口 ${cnt('仅常驻入口')}`);
  notes.push(`无行为级位点的已闭修法 ${noBeh.length} 项（链路边界被破坏时不会红，只有那个函数/那条静态规则被动到时才红）：`
    + `${noBeh.slice(0, 14).join(' ') || '（无）'}`);
  return { rc: problems.length ? 1 : 0, problems, notes, rows };
}

function buildCtx(o) {
  const state = JSON.parse(readIf(o.state));
  const doc = readIf(o.doc);
  const verify = readIf(o.verify);
  const makeText = readIf(o.makefile);
  if (!state || !doc || !verify || !makeText) return { error: '输入不可判：登记册 / 文档 / verify.sh / Makefile 有读不到的' };
  const fixed = state.findings.fixed;
  // §5.3 小节区域：把每个已闭编号出现处所在小节整段并进来当"修法文本"
  const a = doc.indexOf('### 5.1');
  const b = doc.indexOf('### 5.4');
  const region = doc.slice(a >= 0 ? a : 0, b > 0 ? b : doc.length);
  const sections = new Map();
  for (const e of fixed) {
    const id = (e.match(/^\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/) || [])[1];
    if (!id) continue;
    const hit = region.includes(id)
      ? region.split(/\n(?=### )/).filter((sec) => (SECTION_ATTRIBUTION === 'loose'
        ? sec.includes(id)                     // 旧行为：正文含该号即整段并入（V185 实测的污染源）
        : sec.split('\n')[0].includes(id))).join('\n')   // 只认"标题点名本节讲这个号"的那节
      : '';
    sections.set(id, hit);
  }
  const list = chainSpecs(verify);
  const allEntries = [...fixed, ...state.findings.open,
    ...((state.behavior_changes || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) )];
  const registerIds = new Set();
  for (const e of allEntries) {
    const m = e.match(/^\s*([A-Z]{1,6}-\d{1,3}[a-z]?)/);
    if (m) registerIds.add(m[1]);
  }
  const SITE_VERB = /(钉住|钉牢|用例|断言|位点|回归|常驻|覆盖|锁住|挡住)/;
  const citedHere = (text, tok) => {
    let i = text.indexOf(tok);
    while (i >= 0) {
      const win = text.slice(Math.max(0, i - 16), i + tok.length + 16);
      if (SITE_VERB.test(win)) return true;
      i = text.indexOf(tok, i + 1);
    }
    return false;
  };
  // 登记册词汇：§5.4 表格行里出现过的编号（SCHEMA-05、EDGE-01b 这类）是"另一条登记项的编号"，
  // 不是测试位点；把它们计入白名单，否则判据会把"引用了同册另一项"报成"引用了不存在的位点"。
  for (const m of doc.matchAll(/^\|\s*(?:~~)?\*{0,2}([A-Z]{1,6}-\d{1,3}[a-z]?)\b/gm)) registerIds.add(m[1]);
  const cases = caseIndex([
    { dir: o.specs, kind: 'e2e', inList: (f) => list.includes(f.replace(/\.e2e\.spec\.ts$/, '')) },
    { dir: o.unitdir, kind: 'unit' },
    { dir: o.servetests, kind: 'unit' },
    { dir: o.edgetests, kind: 'py' },
  ]);
  // 登记册/契约/迁移里的编号也只算"提过"，不算假引用
  for (const extra of (o.mentionDirs || [])) {
    if (!fs.existsSync(extra)) continue;
    for (const f of fs.readdirSync(extra)) {
      const full = path.join(extra, f);
      if (!fs.statSync(full).isFile()) continue;
      const raw = readIf(full) || '';
      for (const tok of (raw.match(TOKEN) || [])) cases.body.has(tok.toUpperCase()) || cases.body.set(tok.toUpperCase(), [{ kind: 'register', file: f }]);
    }
  }
  const isPrefixOfResolved = (tok, tokens) => {
    const up = tok.toUpperCase();
    if (!/-\d+$/.test(up)) return false;
    const head = up.slice(0, up.lastIndexOf('-'));
    const num = up.slice(up.lastIndexOf('-') + 1);
    return [...tokens].some((other) => other !== up
      && other.toUpperCase().startsWith(head + '-')
      && /^-?\d+[a-z]?$/.test(other.toUpperCase().slice(head.length)));
  };
  const mentioned = (tok) => {
    const up = tok.toUpperCase();
    if (numOnly(tok)) return false;
    return (cases.body && cases.body.has(up)) || registerIds.has(tok) || [...registerIds].some((x) => x.toUpperCase() === up);
  };
  return {
    isPrefixOfResolved, mentioned,
    bodyIdx: cases.body || new Map(),
    fixed, sections, registerIds, citedHere,
    scen: scenarios(verify),
    makeTargets: new Set([...makeText.matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1])),
    gates: gateIndex(makeText, o.scriptsDir, o.workflowDir),
    instruments: instrumentIndex(makeText, o.workflowDir, o.scriptsDir),
    specList: list,
    cases,
  };
}

function defaults() {
  return {
    state: opt('--state') || path.join(ROOT, '.codex/artifacts/chain-behavior-baseline-state.json'),
    doc: opt('--doc') || path.join(ROOT, 'docs/audit/current/chain-behavior-baseline.md'),
    verify: opt('--verify') || path.join(ROOT, 'scripts/chain-baseline/verify.sh'),
    makefile: opt('--makefile') || path.join(ROOT, 'Makefile'),
    specs: opt('--specs') || path.join(ROOT, 'ewoh-spark-app/test/e2e'),
    unitdir: opt('--unitdir') || path.join(ROOT, 'ewoh-spark-app/test/unit'),
    // V130：修法常常钉在**服务侧单测**（server/modules/**/__tests__）里，而原先的位点宇宙只有
    // test/unit 与 e2e ⇒ 这类活位点会被判成"无可核位点"。补一个目录，判据才认得它。
    servetests: opt('--servetests') || path.join(ROOT, 'ewoh-spark-app/server'),
    edgetests: opt('--edgetests') || path.join(ROOT, 'src/edge_platform/tests'),
    scriptsDir: opt('--scripts') || path.join(ROOT, 'scripts'),
    workflowDir: opt('--workflows') || path.join(ROOT, '.github/workflows'),
    mentionDirs: (opt('--mention') || 'docs/audit/current,db/contracts,contracts/state-machines').split(','),
  };
}

function selfTest() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sites-'));
  const w = (rel, s) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const state = (fixedArr) => JSON.stringify({ findings: { fixed: fixedArr, open: ['F-99 开放项'] } });
  const okEntry = 'F-01 已修：撤回事实存活，位点 BA-01 钉住';
  const gateEntry = 'F-02 已修：expired 唯一 writer，位点 PB-01 钉住，并有门禁规则 scripts/audit-thing.js 常驻';
  // F-03 的位点只存在于服务侧单测目录（srv/）：证明"补这个目录"买到覆盖，不是装饰
  const srvEntry = 'F-03 已修：服务侧完成时刻可注入，位点 SVR-01 钉住';
  const base = {
    state: state([okEntry, gateEntry, srvEntry]),
    doc: '### 5.3a 说明\n（V1 小节）BA-01 与 PB-01 两条断言各自钉住一项修法。\n### 5.4 开放缺陷\n',
    verify: 'CHAIN_SPECS="alpha beta gamma delta epsilon"\nSCENARIOS="golden wave control-actuator receipt edge"\n',
    // 形状与真实 Makefile 一致：主线号与调用写在同一行；一跳=「主线行 make 某目标，目标配方里跑脚本」；
    // not-wired.cjs 只出现在**没有主线号的目标体**里 ⇒ 段边界档必须判它没接线（persistent 档才会误判成主线2）。
    makefile: "echo ── 主线1 x scripts/audit-thing.js node scripts/chain-baseline/thing-guard.cjs --self-test\n"
      + "run-target:\n\techo hi\n"
      + "echo ── 主线2 gated && make gated-target\n"
      + "gated-target:\n\t@node scripts/via-make.cjs\n"
      + "unwired-target:\n\t@node scripts/not-wired.cjs\n", 
    cbGuard: '#!/usr/bin/env node\n// 量具夹具：argv.includes("--self-test")\n',
    cbPlain: '#!/usr/bin/env node\n// 没有判据自测的量具\n',
    specAlpha: "describe('S', () => {\n  it('BA-01 撤回后事实存活', () => { expect(1).toBe(1); });\n});\n",
    specBeta: "describe('S', () => {\n  it('PB-01 过期收敛', () => { expect(1).toBe(1); });\n});\n",
    auditScript: '// x\n',
  };
  const build = (mut) => {
    fs.rmSync(path.join(root, 'wf'), { recursive: true, force: true });   // 夹具必须逐例重置（V108 的教训：注入会互相继承）
    w('.codex/state.json', base.state);
    w('doc.md', base.doc);
    w('verify.sh', base.verify);
    w('Makefile', base.makefile);
    w('e2e/alpha.e2e.spec.ts', base.specAlpha);
    w('e2e/beta.e2e.spec.ts', base.specBeta);
    w('unit/x.spec.ts', "\ndescribe('u', () => { it('PB-01 单测侧也钉住', () => { expect(1).toBe(1); }); });\n");
    fs.rmSync(path.join(root, 'srv'), { recursive: true, force: true });
    if (!process.env.V130_DROP_SRV) {
      w('srv/modules/m/__tests__/m.spec.ts', "\ndescribe('svc', () => { it('SVR-01 完成时刻取注入值', () => { expect(1).toBe(1); }); });\n");
    }
    w('pytests/test_a.py', "\ndef test_ba_01_pinned():\n    assert True\n");
    w('scripts/audit-thing.js', base.auditScript);
    fs.rmSync(path.join(root, 'scripts/chain-baseline'), { recursive: true, force: true });
    w('scripts/chain-baseline/thing-guard.cjs', base.cbGuard);
    w('scripts/not-wired.cjs', base.cbPlain);   // 只出现在没有主线号的目标体里 ⇒ 段边界档不算接线
    w('scripts/via-make.cjs', base.cbPlain);    // 存在、只被"某个被主线 make 到的目标"调用 ⇒ 一跳接线
    w('reg/other-doc.md', '本页只是登记册里的另一段，提到 ZZ-77 一次。\n');
    if (mut) mut();
    const ctx = buildCtx({
      state: path.join(root, '.codex/state.json'), doc: path.join(root, 'doc.md'),
      verify: path.join(root, 'verify.sh'), makefile: path.join(root, 'Makefile'),
      specs: path.join(root, 'e2e'), unitdir: path.join(root, 'unit'),
      servetests: path.join(root, 'srv'),
      edgetests: path.join(root, 'pytests'), scriptsDir: path.join(root, 'scripts'),
      workflowDir: path.join(root, 'wf'), mentionDirs: [path.join(root, 'reg')],
    });
    return run(ctx);
  };
  const cases = [];
  // tn：断言**读数**（notes）而不是失败项——分档是报告轴，不是新判据，不能靠退出码验。
  const tn = (label, mut, wantIn) => {
    const got = build(mut);
    const hit = (got.notes || []).find((x) => x.includes(wantIn));
    cases.push({ label, ok: got.rc === 0 && Boolean(hit), wantRc: 0, gotRc: got.rc, why: hit || got.problems[0] || `读数里没有「${wantIn}」` });
  };
  // tEnv：只改"主线段边界"这一个变量，跑同一份夹具（env 在 buildCtx 调用期读取，用完立刻复原）
  const tEnv = (label, scope, mut, wantRc, wantIn) => {
    const saved = process.env.V187_MAINLINE_SCOPE;
    if (scope) process.env.V187_MAINLINE_SCOPE = scope; else delete process.env.V187_MAINLINE_SCOPE;
    let got; try { got = build(mut); } finally {
      if (saved === undefined) delete process.env.V187_MAINLINE_SCOPE; else process.env.V187_MAINLINE_SCOPE = saved;
    }
    const all = got.problems.join('\n');
    cases.push({ label, ok: got.rc === wantRc && (!wantIn || all.includes(wantIn)),
      wantRc, gotRc: got.rc, why: (got.problems[0] || got.notes[0] || '—') });
  };
  const t = (label, mut, wantRc, wantIn) => {
    const got = build(mut);
    const all = got.problems.join('\n');
    const ok = got.rc === wantRc && (!wantIn || all.includes(wantIn));
    cases.push({ label, ok, wantRc, gotRc: got.rc, why: (got.problems[0] || got.notes[0] || '—') });
  };
  t('正向：三项已闭各有 e2e/单测/服务侧单测活位点 ⇒ 通过', null, 0, null);
  t('注入①：已闭条目引用的用例号在任何测试标题里都不存在 ⇒ 必须抓到',
    () => w('.codex/state.json', state(['F-01 已修：位点 XX-99 钉住', gateEntry])), 1, 'XX-99');
  // 注：类 A 的「spec 在磁盘但不在 CHAIN_SPECS」这一降级分支**没有自测覆盖**（试过两次都因夹具里
  // 别的索引项也有同一号而判不出）；真实语料里该分支命中 0 次，因此它目前是"写出来但未验证"的代码。
  // 记在这里而不是偷偷删掉，是为了让下一轮知道它需要什么样的夹具才能测。
  t('注入③之二：脚本只被 Makefile 摘掉、但 CI 里仍在跑 ⇒ 仍算活位点（不误报）',
    () => { w('Makefile', base.makefile.replace('── 主线1 x scripts/audit-thing.js', '── 主线1 x'));
            w('wf/ci.yml', 'jobs:\n  build:\n    steps:\n      - name: audit\n        run: node scripts/audit-thing.js --strict\n'); },
    0, null),
  // V114 把这一支记成"写出来但没有可重跑的注入"，并猜原因是"夹具的 Makefile 形状不保真"。
  // 本轮实测推翻了这个归因：换脚本名与抹掉整行两种形状都能抓到（做过对照实验），
  // 所以缺的不是保真夹具，只是当时没写这条用例。真实语料侧它验证过一次——
  // V114 加 CI 面前，audit-openapi-routes.js 正是由这一支报出，随后查明两个 workflow 以 --strict 跑它。
  t('注入③之三：脚本在 Makefile 与 CI 两处都无接线 ⇒ 必须抓到「无调用方」（Makefile 形状保真）',
    () => w('Makefile', base.makefile.replace('scripts/audit-thing.js', 'scripts/other-thing.js')),
    1, '都没调用'),
  t('注入⑧：白名单号 + 文本声明"只改注释" ⇒ 免检不误报（豁免确实生效）',
    () => w('.codex/state.json', state(['UIX-02 已修：只改注释、行为零变化（无行为位点）', gateEntry])), 0, null),
  t('注入⑧之二：同样的文字但号**不在**白名单 ⇒ 必须仍报无可核位点（豁免不是文字游戏）',
    () => w('.codex/state.json', state(['UIX-99 已修：只改注释、行为零变化（无行为位点）', gateEntry])),
    1, '无可核位点'),
  t('注入⑦：唯一"位点"只是登记册/契约文档里提过的号 ⇒ 必须判无可核位点（V116 收紧 live 过滤）',
    () => w('.codex/state.json', state(['F-01 已修：位点 ZZ-77 钉住', gateEntry])),
    1, '无可核位点'),
  t('注入④：已闭条目只剩"见 §5.3"这种文字 ⇒ 必须抓到（文档引用不是位点）',
    () => w('.codex/state.json', state(['F-01 已修：见 §5.3a（无位点）', gateEntry])), 1, '无可核位点');
  t('注入⑤：e2e 与单测都删掉该用例 ⇒ 必须抓到（位点被删）',
    () => {
      w('e2e/alpha.e2e.spec.ts', "describe('S', () => {\n});\n");
      w('unit/x.spec.ts', "\ndescribe('u', () => { });\n");
      w('pytests/test_a.py', "\ndef test_unrelated():\n    assert True\n");
      w('.codex/state.json', state(['F-01 已修：位点 BA-01', gateEntry]));
    },
    1, 'BA-01');
  // V143 分档的双向对照：同一份夹具，只改"位点落在哪一层"这一个变量。
  tn('正向·分档：F-03 的位点只在服务侧单测 ⇒ 必须报「函数级单测 1、无行为级 1 项含 F-03」', null, '函数级单测 1');
  tn('正向·分档：无行为级清单必须点名 F-03（不是把所有已闭都算成有覆盖）', null, 'F-03');
  tn('反向对照·分档：把 SVR-01 同时钉进清单内的 e2e ⇒ 无行为级必须归 0（证明分档看的是层，不是目录名硬编码）',
    () => w('e2e/alpha.e2e.spec.ts',
      "describe('S', () => {\n  it('BA-01 撤回后事实存活', () => { expect(1).toBe(1); });\n  it('SVR-01 完成时刻取注入值（链级）', () => { expect(1).toBe(1); });\n});\n"),
    '无行为级位点的已闭修法 0 项');
  // V143 双向对照：豁免项**只被 D 类（正文提到 make 目标）**命中时不得判过期——叙述文字里提一句目标名太容易；
  // 而有 A/B/C 类位点时必须判过期（证明这条收紧没有把后门打开）。
  t('注入⑨：豁免项只在正文里提到 make 目标（D 类）⇒ 必须仍算"声明性豁免"不误报', 
    () => w('.codex/state.json', state(['UIX-02 已修：只改注释、行为零变化；复算入口 make run-target', gateEntry])), 0, null);
  t('注入⑨之二：豁免项另有用例标题位点（A 类）⇒ 必须报"豁免已过期"（收紧不是后门）',
    () => w('.codex/state.json', state(['UIX-02 已修：只改注释、行为零变化；位点 BA-01 钉住', gateEntry])),
    1, '豁免已过期');
  // V186：文件头承诺的夹具覆盖面（--state/--doc/…）在旧实现里是**死接口**——opt() 又补了一次 `--`，
  // 于是 opt('--state') 找的是 `----state`，任何按注释传的覆盖都被静默忽略、回落到真实登记册。
  // 双向对照：给了覆盖必须吃到覆盖；不给覆盖必须回落真实件（证明上一条看的确实是"覆盖"这个变量）。
  {
    const decoy = path.join(root, 'decoy-state.json');
    fs.writeFileSync(decoy, base.state);
    const saved = process.argv;
    process.argv = ['node', 'fix-sites.cjs', '--state', decoy, '--doc', path.join(root, 'doc.md')];
    const dOn = defaults();
    process.argv = saved;
    const dOff = defaults();
    cases.push({ label: '正向·CLI --state/--doc 覆盖必须生效（否则头部注释承诺的夹具面是死接口）',
      ok: dOn.state === decoy && dOn.doc === path.join(root, 'doc.md'),
      wantRc: 0, gotRc: 0, why: `实得 state=${dOn.state}` });
    cases.push({ label: '反向对照·不给覆盖时必须回落真实登记册（上一条看的确实是覆盖，不是恒等）',
      ok: dOff.state !== decoy && /chain-behavior-baseline-state\.json$/.test(dOff.state),
      wantRc: 0, gotRc: 0, why: `实得 state=${dOff.state}` });
  }
  // V186 归属档与 E 类：默认档（entry）下邻节文字不得为其他项造位点；E 类必须"有自测 + 被主线跑"才算强位点。
  // （loose 档会污染这件事由 `scripts/chain-baseline/attribution-shadow.cjs` 的自测用两个子进程档位实测，
  //  本文件里改不了归属档——它在模块加载期读取，进程内改 env 无效，故不在此伪造反向对照。）
  t('注入⑩：默认归属档下，邻节正文点名常驻 spec 也不得把"只改注释"豁免顶成过期',
    () => {
      w('doc.md', base.doc + '### 5.3z 另一轮的方法小节\n这里顺带讨论 UIX-02，并点名 alpha.e2e.spec.ts 与 BA-01 作为对照。\n');
      w('.codex/state.json', state([okEntry, gateEntry, srvEntry, 'UIX-02 已修：只改注释、行为零变化；复算入口 make run-target']));
    }, 0, null);
  tn('正向·E 类：条目点名"被主线调用"的量具 ⇒ 该项按静态机检档计入（F-02 有 e2e 用例，优先算行为级）',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9X 已修：判据收紧，位点 scripts/chain-baseline/thing-guard.cjs 的 --self-test 常驻主线'])),
    '静态机检 1');
  t('注入⑩之一（撤销对照，证明上一条靠的是 E 类这一个变量）：条目不再点名任何量具 ⇒ 该项判"无可核位点"',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9X 已修：判据收紧，另加了负向控制'])),
    1, 'GATE-9');
  t('注入⑩之二：条目点名的量具根本不存在 ⇒ E 类只给弱位点，必须判"引用的位点不成立"（收紧不是后门）',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9Y 已修：判据收紧，位点 scripts/chain-baseline/ghost-guard.cjs 常驻主线'])),
    1, 'GATE-9Y');
  t('注入⑩之三：量具真实存在但没有任何主线调用它 ⇒ 同样只给弱位点（E 类看的是接线，不是文件名）',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9Z 已修：判据收紧，位点 scripts/not-wired.cjs 常驻'])),
    1, 'GATE-9Z');
  // GATE-28（V267 实测到的归因盲区）：两支编号正则必须都试过才允许落占位串。
  // 第一支 `[A-Z]{1,6}-…` 装不下 7 字母前缀，旧写法的占位串又是 truthy ⇒ 第二支永不参与。
  t('注入⑪：≥7 字母前缀的条目点名一个不存在的量具 ⇒ 告警必须印出自己的编号（不得退化成（无编号））',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'RCPTCTX-9X 已修：判据收紧，位点 scripts/chain-baseline/ghost-long.cjs 常驻主线'])),
    1, 'RCPTCTX-9X：引用的位点不成立');
  t('对照·注入⑪：条目开头确实没有编号形状 ⇒ 仍须如实印「（无编号）」（修归因不等于给每条猜一个号）',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      '已修：只改了散文措辞，没有位点'])),
    1, '（无编号）：');
  // GATE-24 的双向对照：同一个"只在无主线号目标体里出现"的脚本，段边界档必须判未接线、旧口径必须判已接线。
  tEnv('正向·GATE-24 段边界档：脚本只出现在没有主线号的目标体里 ⇒ 不得算接线（判"引用的位点不成立"）', 'segment',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9V 已修：判据收紧，位点 scripts/not-wired.cjs 常驻主线'])), 1, 'GATE-9V');
  tEnv('反向对照·persistent 旧口径：同一份夹具里该脚本被记到上一条主线号上 ⇒ 必须判"有活位点"（证明上一条看的只有边界规则这一个变量）',
    'persistent', () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9V 已修：判据收紧，位点 scripts/not-wired.cjs 常驻主线'])), 0, null);
  tn('正向·E 类一跳：脚本只被"主线 make 到的目标"调用 ⇒ 同样算常驻位点（V186 的 CI-01a 形状）',
    () => w('.codex/state.json', state([okEntry, gateEntry, srvEntry,
      'GATE-9W 已修：判据收紧，位点 scripts/via-make.cjs 常驻主线'])),
    '静态机检 1');
  fs.rmSync(root, { recursive: true, force: true });
  let bad = 0;
  cases.forEach((c) => {
    if (!c.ok) { bad += 1; console.log(`  ✕ ${c.label}（期望 rc=${c.wantRc} 实得 rc=${c.gotRc}）\n      ↳ ${c.why}`); }
    else console.log(`  ✓ ${c.label}\n      ↳ ${c.why}`);
  });
  if (bad) { console.log(`修法位点判据自测：不通过（${bad} 项）`); process.exitCode = 3; return; }
  console.log(`修法位点判据自测：通过（${cases.length} 项：1 正向 + ${cases.length - 1} 注入，注入均改变判决）`);
}

function main() {
  if (flag('--self-test')) { selfTest(); return; }
  let ctx;
  try { ctx = buildCtx(defaults()); } catch (e) { console.log(`不可用：${e.message}`); process.exitCode = 3; return; }
  if (ctx.error) { console.log(`不可用：${ctx.error}`); process.exitCode = 3; return; }
  const r = run(ctx);
  console.log(`修法位点核验：已闭 ${r.rows.length} 项`);
  r.notes.forEach((n) => console.log('  ·', n));
  r.rows.filter((x) => x.verdict !== '有活位点').forEach((x) => {
    console.log(`  · ${x.id}：${x.verdict}；解析到 ${x.sites.length} 个候选（${x.sites.map((s) => s.type.split('（')[0] + ':' + s.what).join(', ') || '无'}）`);
  });
  r.problems.forEach((p) => console.log('  ✕', p));
  if (flag('--json')) {
    fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tmp/fix-sites.json'), JSON.stringify(r.rows, null, 1));
  }
  console.log(r.rc === 0 ? '  ✅ 每项已闭修法都有活位点' : `  ❌ ${r.problems.length} 项待处理`);
  process.exitCode = r.rc;
}

main();
