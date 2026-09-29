#!/usr/bin/env node
/**
 * owner-id-claims.cjs —— 只回答一个问题：**量具在 help／注释里说自己是「某编号的机械半」时，那个编号在不在登记册里**。
 *
 * 动因（V345，OWNID-01）：`Makefile:477` 的 `chain-baseline-alias-sync` help 写着「V341，**ALIAS-01**」并自称是它的「机械半」，
 * 而 `ALIAS-01` 在登记册、状态件、裁决包里**一处都不存在**（`grep -rn ALIAS-01` 全仓只有这一行）——
 * 别名同步机检真正的归属行是 `ENTAX-01`。既有判据查不到它：`artifact-consistency` 核的是
 * 「§5.4 行编号 ↔ 状态件 findings」与「指向不存在小节的引用」与「文档点名的文件是否存在」，
 * **没有任何一条把"编号"当被声明物来核**（V345 实测：在册编号 564 个，这类悬空点名字 1 处）。
 * 危害不是美观：下一个人按 help 去找 `ALIAS-01` 那行缺陷会找不到，而量具自述的"我守的是哪条缺陷"
 * 一旦指空，它就变成一条没人认领的判据——与本试点反对的"有名无实契约"同族。
 *
 * 判据形状（故意窄）：只认「<编号> + 的 + {机械半|机械核|常驻位点|判据|位点|对账}」这一族**归属短语**，
 * 编号形状 `[A-Z]{2,12}-\d{1,3}[a-z]?`。
 * 为什么不做成"扫描全部点名字"（V345 实测过再收窄）：宽口径会把 98 个 token 报成不在册，
 * 其中 `ADR-004`/`ADR-006`（ADR 文档号）、`AAA-01`/`BBB-02`/`XX-99`/`ZZ-77`/`UIX-90`/`SH-01`（量具自测夹具的假编号）、
 * `NEST-513`（NestJS 诊断码）全是合法写法 ⇒ 宽口径等于造假红，窄口径当期 4 处命中里 1 真 3 不误伤。
 *
 * 限度：只认得这一族短语——注释里用别的措辞认领编号（「对应缺陷 X-01」）仍看不见 ⇒ 下界；
 * 在册集合由调用方给（登记册 §5.4 行 ∪ 状态件 findings），本件不自己解析登记册，避免长出第二套编号定义。
 */
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');

const CLAIM_RE = /\b([A-Z]{2,12}-\d{1,3}[a-z]?)\s*的?\s*(机械半|机械核|常驻位点|位点|判据|对账)/g;

/** 「…」内的内容按"引用别人的说法"处理，不算本文件的声明（V345 实测：把这条判据接进尺子之后，
 *  尺子自己的注释里写着「ALIAS-01 的机械半」这句被引用的原话，就被自己的判据点成指空——
 *  靠"排除某个文件"救不了这一族，任何解释这条缺陷的注释/文档都会复现它。
 *  取舍：引号内不判 = 允许"抄一段别人的话"而不被误伤，代价是"故意躲在「」里的声明"逃过判据；
 *  登记册/裁决包不在被扫面里，量具 help 与 CI 步骤名里的真实声明一律写在引号外，当期不因此漏判。 */
function stripQuotes(text) {
  return String(text).replace(/\u300c[^\u300d]*\u300d/g, (seg) => seg.replace(/[^\n]/g, ' '));
}

/** 一份文本里所有的归属声明：[{id, phrase, at}]。引号内的内容先抹平，再匹配。 */
function claimsIn(text) {
  const scrub = stripQuotes(text);
  const out = [];
  CLAIM_RE.lastIndex = 0;
  let m;
  while ((m = CLAIM_RE.exec(scrub))) {
    out.push({ id: m[1], phrase: m[0], at: m.index });
  }
  return out;
}

/** 纯判据：faces = {名字: 文本}；registerIds = Set。返回点名字不在册的清单（不判红"没读到面"）。 */
function offenders(faces, registerIds) {
  const ids = registerIds instanceof Set ? registerIds : new Set(registerIds || []);
  const bad = [];
  for (const [name, text] of Object.entries(faces || {})) {
    for (const c of claimsIn(text)) {
      if (!ids.has(c.id)) bad.push({ file: name, id: c.id, phrase: c.phrase });
    }
  }
  return bad;
}

/** 被扫的面：Makefile ＋ CI workflow ＋ 仓内量具源码（这三张面是"量具自述归属"实际会写的地方）。 */
function collectFaces(repo) {
  const root = repo || REPO;
  const faces = {};
  const mk = path.join(root, 'Makefile');
  if (fs.existsSync(mk)) faces['Makefile'] = fs.readFileSync(mk, 'utf8');
  const wf = path.join(root, '.github', 'workflows');
  try {
    for (const f of fs.readdirSync(wf).sort()) {
      if (f.endsWith('.yml') || f.endsWith('.yaml')) faces['.github/workflows/' + f] = fs.readFileSync(path.join(wf, f), 'utf8');
    }
  } catch { /* 没有 workflow 目录就不扫，不记成"没有点名字" */ }
  const sb = path.join(root, 'scripts', 'chain-baseline');
  try {
    for (const f of fs.readdirSync(sb).sort()) {
      if (!f.endsWith('.cjs')) continue;
      const abs = path.join(sb, f);
      // 自引用面必须排除：本文件的测试夹具里就写着「ALIAS-01 的机械半」这种字符串（那是必须开火的正例），
      // 把它当真实声明扫会得到"量具自己的夹具悬空"——与"needle 指向电池自身"同族。排除只针对本件自己，
      // 其余量具的归属声明照扫（doc-face-reconciliation.cjs 那句 DOCFACE-01 就是要被扫的）。
      if (fs.realpathSync(abs) === fs.realpathSync(__filename)) continue;
      faces['scripts/chain-baseline/' + f] = fs.readFileSync(abs, 'utf8');
    }
  } catch { /* 同上 */ }
  return faces;
}

function run(argv) {
  if (argv.includes('--self-test')) return selftest();
  const faces = collectFaces(REPO);
  // 在册编号：登记册 §5.4 行 ∪ 状态件 findings（与尺子同源的两条正则，不另造第三套编号定义）。
  // 注意：不能 require('./artifact-consistency.cjs')——它是脚本、末尾 process.exit，会把本件一起带走。
  const doc = fs.readFileSync(path.join(REPO, 'docs/audit/current/chain-behavior-baseline.md'), 'utf8');
  const st = JSON.parse(fs.readFileSync(path.join(REPO, '.codex/artifacts/chain-behavior-baseline-state.json'), 'utf8'));
  const ids = new Set();
  for (const k of ['fixed', 'open']) for (const e of (st.findings && st.findings[k]) || []) {
    const m = String(e).match(/^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/);
    if (m) ids.add(m[0]);
  }
  const ROW = /^\|\s*(?:~~)?\*{0,2}([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/;
  // 与尺子同源：只在 §5.4 那一节内取行编号（全文扫会把 §六／§6.2／§七 各表的首格也当编号收进来，
  // 那是一份"看着更大其实更松"的在册集合——它会让真正悬空的点名字被别人的表头救走）。
  const dl = doc.split('\n');
  const a54 = dl.findIndex((l) => l.startsWith('### 5.4 开放缺陷'));
  const b5 = dl.findIndex((l, i) => i > a54 && /^##\s/.test(l));
  if (a54 < 0) { console.log('[owner-id-claims] 不可判：登记册里找不到 §5.4 标题 ⇒ 不读成"全在册"'); process.exitCode = 3; return; }
  for (const l of dl.slice(a54, b5 < 0 ? dl.length : b5)) { const m = ROW.exec(l); if (m) ids.add(m[1]); }
  const claimTotal = Object.values(faces).reduce((a, t) => a + claimsIn(t).length, 0);
  const bad = offenders(faces, ids);
  console.log(`[owner-id-claims] 面 ${Object.keys(faces).length} 份（Makefile＋CI＋量具）｜在册编号 ${ids.size} 个｜归属短语声明 ${claimTotal} 处`);
  for (const b of bad) console.log(`  ✗ ${b.file} 点名「${b.id}」不在登记册里（短语「${b.phrase}」）`);
  console.log(bad.length ? `[owner-id-claims] 判决：✗ ${bad.length} 处悬空点名字` : '[owner-id-claims] 判决：✅ 归属短语点名的编号全在册');
  return bad.length ? 1 : 0;
}

/** 判据自测：必须开火一支（悬空点名字）＋必须不开火三支（在册／不是归属句式／编号形如诊断码）＋面读不到时不得折成零。 */
function selftest() {
  const checks = [];
  const A = (name, ok, detail) => checks.push({ name, ok, detail });
  const ids = new Set(['ENTAX-01', 'DOCFACE-01', 'PROJ-11']);
  A('点名字不在册 ⇒ 必须开火并点名文件与编号',
    JSON.stringify(offenders({ 'Makefile': 'x ## 甲（V9，ALIAS-01 的机械半）' }, ids)) === '[{"file":"Makefile","id":"ALIAS-01","phrase":"ALIAS-01 的机械半"}]',
    JSON.stringify(offenders({ 'Makefile': 'x ## 甲（V9，ALIAS-01 的机械半）' }, ids)));
  A('编号在册 ⇒ 不得开火（这条判据只管悬空，不管措辞风格）',
    offenders({ 'Makefile': 'ENTAX-01 的机械半' }, ids).length === 0,
    JSON.stringify(offenders({ 'Makefile': 'ENTAX-01 的机械半' }, ids)));
  A('不是归属句式的编号（如 ADR-004 的机制、TS18003 诊断码）不得开火',
    offenders({ 'a.cjs': 'ADR-004 的机制说明；TS18003 报错；NO-07b 已闭' }, ids).length === 0,
    '句式不匹配就不该进分母');
  A('同一面里多处声明要逐条数，不能只报第一条',
    offenders({ 'Makefile': 'ENTAX-01 的机械半 与 GHOST-09 的位点' }, ids).map((x) => x.id).join() === 'GHOST-09',
    '在册那条不许混进来');
  const empty = collectFaces(path.join('/tmp', 'no-such-tree-' + Date.now()));
  A('面一份都读不到 ⇒ 不得把"零声明"读成通过（要能看出是空面）',
    Object.keys(empty).length === 0, JSON.stringify(Object.keys(empty)));
  const real = collectFaces(REPO);
  const realBad = offenders(real, ids);
  A('真语料必须被扫到（面数 ≥ 30，否则这条自测什么都没核）',
    Object.keys(real).length >= 30, '实得 ' + Object.keys(real).length + ' 份面');
  A('写在「」里的引用不算声明（解释这条缺陷的注释会原样复现被引用的短语，靠排除文件救不了）',
    claimsIn('尺子注释：曾写着「ALIAS-01 的机械半」这句原话').length === 0
      && claimsIn('chain-baseline-x: ## 新量具，ZED-01 的机械半').length === 1,
    '引号内 0 条、引号外 1 条才对');
  A('真语料上的声明数 > 0（判据在真树上有对象可判，不是空转）',
    Object.values(real).reduce((a, t) => a + claimsIn(t).length, 0) > 0,
    '声明数 ' + Object.values(real).reduce((a, t) => a + claimsIn(t).length, 0));
  A('自引用面必须被排除：本件自己（夹具里写着归属句式）不得进被扫清单',
    !Object.keys(real).some((k) => k.endsWith('owner-id-claims.cjs')), JSON.stringify(Object.keys(real).filter((k) => k.includes('owner-id-claims'))));
  A('真语料当期必须零悬空点名字（有人新写一条指空的归属短语，这一支就红）',
    offenders(real, ids).length === 0, JSON.stringify(offenders(real, ids)));
  const bad = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log(`  ${c.ok ? '✔' : '✗'} ${c.name}${c.ok ? '' : `（实得 ${c.detail}）`}`));
  console.log(`[owner-id-claims] 判据自测 ${checks.length - bad.length}/${checks.length} 通过`);
  return bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { claimsIn, offenders, collectFaces, stripQuotes, CLAIM_RE };
