#!/usr/bin/env node
/*
 * V174 量具：哪些常驻用例断的是**现状**（as-is）而不是**应然**，各自挂在哪个待裁项名下？
 *
 * 为什么要这把尺（V173 撞到的一般形状）：F-04 的裁决请求单缺的最后一格是"今天会红哪一条"，现核出来的答案是
 * `approval-instance-uniqueness.e2e.spec.ts:197` 断 `approvedOnTask.length >= 2`——**一条 CHAIN_SPECS 里的常驻用例
 * 把"没有唯一性"钉成了现状断言，每遍重放都跑**。所以任何收紧都必须与"断言反转"同批落地，否则重放当场红，
 * 而红的意思是"现状被改掉了"，不是"改坏了"。这不是孤例的形状：本仓的做法是给未定行为写"现状实测/现状基线"
 * 用例（见 feedback-refactor-discipline：未定行为一律标"现状基线"）。把这些用例**按待裁项归堆**，
 * 裁决者才能一次看到"我拍这一条，要连带改判哪几条常驻断言"。
 *
 * 一问（只此一问）：一条常驻断言，它是"钉现状"还是"钉应然"；若钉现状，它挂在哪个登记项名下？
 *
 * 归属区间（不用 ±N 行窗口）：块 = `it(`/`test(` 之间的连续区；**紧邻块头上方的连续注释/空行**算它的文档区
 * （本仓习惯把长注释写在 `it(` 上面，例如 plan-reject-authority 的 RJ-03）。标记与编号在这两段里找，
 * 但**断言必须出现在块体内**——只有散文没有断言不算（自测 N2 钉这条）。
 *
 * 五桶（互斥；前四桶都要求块内有断言行）：
 *  - `quo-with-id`  ：有现状标记 + 至少一个能解析到登记册的编号 ⇒ 裁决落地时必须同批改判的断言；
 *  - `quo-no-id`    ：有现状标记但无可解析编号 ⇒ 需要归属（不猜）；
 *  - `violation-count`：无现状标记，但断言形状是"违规/重复计数 ≥2 或 >0"⇒ 候选，需人工读；
 *  - `id-no-quo`    ：只提到登记编号、没有现状标记 ⇒ 引用，不算现状断言；
 *  - 其余不计。
 *
 * 编号一律**解析到权威**（登记册 §5.4 的行首编号，即一致性自检用的同一份），解析不到的**点名**，不静默丢弃。
 *
 * 自测（--self-test，任一不过 rc≠0）：P1 现状标记+编号 ⇒ quo-with-id；P2 违规计数无标记 ⇒ violation-count；
 * N1 普通应然断言 ⇒ 不计；N2 只有散文标记没有断言 ⇒ 不计；N3 编号解析不到 ⇒ 必须点名 unresolved；
 * N4 撤销对照：把 P1 的现状标记去掉 ⇒ 必须离开 quo-with-id。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { blocks, specFiles } = require('./convergence-sites.cjs');

const ROOT = path.resolve(__dirname, '../..');
const DOC = path.join(ROOT, 'docs/audit/current/chain-behavior-baseline.md');
const STATE = path.join(ROOT, '.codex/artifacts/chain-behavior-baseline-state.json');

/** 现状标记（本仓实际用词；不用"可疑/坏"这类判断词，只认自陈"这是现状"的写法）。 */
const QUO_MARKERS = ['现状实测', '现状基线', '现状', 'as-is', '不判对错', '待裁', '口径未定', '由属主', '未定行为'];
/** 断言行（与 V170 同族，另收场景脚本的 step/record 与 SQL 违规计数查询）。 */
const ASSERT_LINE = /(expect\s*\(|expect\.poll\s*\(|\.every\s*\(|\bstep\s*\(|\brecord\s*\(|assert\()/;
/** "违规/重复计数 ≥2 或 >0" 的形状（F-04 那条就是这一形）。 */
const VIOLATION_COUNT = /(toBeGreaterThanOrEqual\s*\(\s*2\s*\)|toBeGreaterThan\s*\(\s*[01]\s*\)|length\s*\)\.toBe\(\s*[2-9]|\.toBe\(\s*[2-9]\d*\s*\)\s*;?\s*\/\/.*(?:两份|重复|多开))/;
/** 编号形状：1～9 个字母 + `-` + 1～3 位数字（可带小写字母后缀）。
 *  第一版写成 `[A-Z][A-Z0-9]{1,9}-` ⇒ **单字母前缀全部解析不到**（F-04/F-12/D-01 都是这一形），
 *  自测 P1 因此落到 quo-no-id——正向对照把正则抓了个现行。 */
const ID_RE = /\b([A-Z]{1,9}-\d{1,3}[a-z]?)\b/g;

/** 登记册 §5.4 的行首编号＝权威编号集（与一致性自检同一份口径）。 */
function authorityIds() {
  const text = fs.readFileSync(DOC, 'utf8');
  const a = text.indexOf('### 5.4 ');
  const b = text.indexOf('## 六', a);
  if (a === -1 || b === -1) { console.error('✕ 登记册 §5.4 区间定位失败 ⇒ 读数作废'); process.exit(1); }
  const re = /^\|\s*(?:~~)?\*{0,2}([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\*{0,2}(?:~~)?\s*\|/;
  const ids = new Set();
  for (const l of text.slice(a, b).split('\n')) {
    const m = re.exec(l);
    if (m) ids.add(m[1].toUpperCase());
  }
  // 状态件里的 findings 也并入（编号可能只活在工件里）
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const k of ['findings', 'fixed_findings', 'open_findings']) {
      const v = st[k];
      if (Array.isArray(v)) for (const e of v) {
        const id = typeof e === 'string' ? e : (e && (e.id || e.code));
        if (typeof id === 'string') ids.add(id.toUpperCase());
      }
      else if (v && typeof v === 'object') for (const id of Object.keys(v)) ids.add(id.toUpperCase());
    }
  } catch (_) { /* 状态件不可读时只用登记册，且在输出里说明 */ }
  if (ids.size < 20) { console.error(`✕ 权威编号集小得离谱（${ids.size}）⇒ 拒绝出数`); process.exit(1); }
  return ids;
}

/** 紧邻 head 上方的连续注释/空行的**起始下标**（结构有界，不是 ±N 行）。 */
function leadingDocsSpan(text, head) {
  const lines = text.slice(0, head).split('\n');
  let cut = lines.length - 1;                      // 指向 head 所在行的行首
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    const l = lines[i];
    if (/^\s*$/.test(l) || /^\s*(\/\/|\/\*|\*|#)/.test(l)) { cut = i; continue; }
    break;
  }
  let off = 0;
  for (let i = 0; i < cut; i += 1) off += lines[i].length + 1;
  return off;
}

function leadingDocs(text, head) {
  return text.slice(leadingDocsSpan(text, head), head);
}

/** 块体里**尾部那段连续注释**其实属于下一块的文档区（blocks() 是 [head_i, head_{i+1}) 的连续切分）。
 *  V175 在 RJ-03 头上补标 F-12 时，这一泄漏让 RJ-02 也跟着"挂上"了 F-12 ⇒ 前后对照多算 2 块（被脚本的
 *  +1/−1 断言当场拦下）。修法：判定用的块体先剥掉尾部注释行；下一块的文档区仍通过 leadingDocs 归给下一块。 */
function bodyOnly(body) {
  return body.replace(/(?:\n[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|\*[^\n]*|#(?!!)[^\n]*))+[ \t]*$/, '\n');
}

function judgeRegion(regionText, bodyText, ids) {
  bodyText = bodyOnly(bodyText);
  const hasAssert = bodyText.split('\n').some((l) => ASSERT_LINE.test(l) && !/^\s*(\/\/|\*)/.test(l));
  if (!hasAssert) return null;                                    // 只有散文 ⇒ 不计（N2）
  const markers = QUO_MARKERS.filter((m) => regionText.includes(m));
  const raw = [...new Set([...regionText.matchAll(ID_RE)].map((m) => m[1]))];
  const known = raw.filter((r) => ids.has(r.toUpperCase()));
  const unresolved = raw.filter((r) => !ids.has(r.toUpperCase()) && !/^(V|RC|P|AI|RJ|S|DR|H|BS|AV|LR|CP|OD|K|N|T|A|B|C|D|E|N1|N2|P1|P2)-?\d*$/.test(r));
  const violation = VIOLATION_COUNT.test(bodyText);
  if (markers.length && known.length) return { bucket: 'quo-with-id', ids: known, markers, unresolved };
  if (markers.length) return { bucket: 'quo-no-id', ids: [], markers, unresolved };
  if (violation) return { bucket: 'violation-count', ids: known, markers: [], unresolved };
  if (known.length) return { bucket: 'id-no-quo', ids: known, markers: [], unresolved };
  return null;
}

/** 把一个文件切成"判定区"：块体**切到下一块文档区的起点**，邻块的标记/编号不再渗进本块。
 *  （V175 的 bodyOnly() 只剥了断言扫描用的 body，而标记/编号是在 region 里搜的 ⇒ 那次"修泄漏"其实没修到，
 *   V176 的对照实验因此读出净效应 0；这里改在**切分**上，region 与 body 同源于一个边界。） */
function regionsOf(text) {
  const heads = [];
  const re = /^\s*(?:it|test)(?:\.\w+)?\s*\(/gm;
  let m;
  while ((m = re.exec(text)) !== null) heads.push(m.index);
  if (!heads.length) return [{ label: '(whole-file)', region: text, body: text }];
  const docStarts = heads.map((h) => leadingDocsSpan(text, h));
  const out = [];
  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i];
    const docs = text.slice(docStarts[i], head);
    const bodyEnd = i + 1 < heads.length ? docStarts[i + 1] : text.length;
    const body = text.slice(head, Math.max(head, bodyEnd));
    const nl = text.indexOf('\n', head);
    const firstLine = text.slice(head, nl === -1 ? text.length : nl);
    const label = (firstLine.match(/['"`]([^'"`]{2,90})['"`]/) || [, firstLine.trim().slice(0, 60)])[1];
    out.push({ label, region: docs + '\n' + body, body });
  }
  return out;
}

function census(opts = {}) {
  const ids = opts.ids || authorityIds();
  const files = opts.files || specFiles();
  const rows = [];
  const unresolvedAll = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const seg of regionsOf(text)) {
      const r = judgeRegion(seg.region, seg.body, ids);
      if (!r) continue;
      (r.unresolved || []).forEach((u) => unresolvedAll.add(u));
      rows.push({ rel: path.relative(ROOT, f), label: seg.label, ...r });
    }
  }
  return { filesScanned: files.length, rows, unresolved: [...unresolvedAll], authoritySize: ids.size };
}

function main() {
  const c = census();
  const byBucket = {};
  for (const r of c.rows) byBucket[r.bucket] = (byBucket[r.bucket] || 0) + 1;
  const sum = Object.values(byBucket).reduce((a, b) => a + b, 0);
  if (sum !== c.rows.length) { console.error('✕ 桶不加总 ⇒ 读数作废'); process.exit(1); }
  console.log(`扫过 ${c.filesScanned} 个常驻用例文件；权威编号集 ${c.authoritySize} 个（登记册 §5.4 + 状态件 findings）`);
  console.log(`钉"现状"或提到登记编号的断言块 ${c.rows.length} 个：`
    + Object.entries(byBucket).map(([k, v]) => `${k} ${v}`).join(' · '));
  // 按待裁项归堆：裁决者要看的是"我拍这一条要连带改判哪几条常驻断言"
  const byId = new Map();
  for (const r of c.rows.filter((x) => x.bucket === 'quo-with-id' || x.bucket === 'id-no-quo')) {
    for (const id of r.ids) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(r);
    }
  }
  const quoIds = [...byId.entries()].filter(([, v]) => v.some((x) => x.bucket === 'quo-with-id'));
  console.log(`\n按登记编号归堆：${byId.size} 个编号被常驻断言提到，其中 ${quoIds.length} 个编号名下有"钉现状"的断言（裁决落地必须同批改判）：`);
  for (const [id, v] of quoIds.sort((a, b) => b[1].length - a[1].length)) {
    const quo = v.filter((x) => x.bucket === 'quo-with-id');
    console.log(`  · ${id}（钉现状 ${quo.length} 条 / 另引用 ${v.length - quo.length} 条）`);
    for (const r of quo.slice(0, 4)) {
      console.log(`      ${r.rel.split('/').slice(-1)[0]} :: ${String(r.label).slice(0, 60)} :: 标记「${r.markers[0]}」`);
    }
    if (quo.length > 4) console.log(`      …另有 ${quo.length - 4} 条（完整清单见 JSON）`);
  }
  const noId = c.rows.filter((r) => r.bucket === 'quo-no-id');
  if (noId.length) {
    console.log(`\n有现状标记但没挂到任何登记编号（需要归属，本尺不猜）：${noId.length} 条`);
    for (const r of noId.slice(0, 10)) console.log(`  · ${r.rel} :: ${String(r.label).slice(0, 64)} :: 「${r.markers[0]}」`);
    if (noId.length > 10) console.log(`  …另有 ${noId.length - 10} 条`);
  }
  const vc = c.rows.filter((r) => r.bucket === 'violation-count');
  // 宽桶 100+ 条不逐条读（读了也读不出结论）；收窄成**短名单**：同文件里有"现状"标记的违规计数形状
  const quoFiles = new Set(c.rows.filter((r) => r.markers && r.markers.length).map((r) => r.rel));
  const shortlist = vc.filter((r) => quoFiles.has(r.rel));
  console.log(`\n"违规/重复计数 ≥2"形状共 ${vc.length} 条（宽桶，含大量合法的阈值断言，如 PDB minAvailable≥2 ⇒ 不据此下结论）`);
  console.log(`  收窄后的短名单 = 同文件另有"现状"标记的违规计数块：${shortlist.length} 条（这才有必要逐条读）`);
  for (const r of shortlist) console.log(`  · ${r.rel} :: ${String(r.label).slice(0, 64)}`);
  const quoUnresolved = [...new Set(c.rows.filter((r) => r.markers && r.markers.length).flatMap((r) => r.unresolved || []))];
  if (quoUnresolved.length) {
    console.log(`\n⚠ 钉"现状"的那批里，提到但解析不到登记册 §5.4 的编号（点名，不静默丢）：${quoUnresolved.slice(0, 24).join(', ')}${quoUnresolved.length > 24 ? ` …另 ${quoUnresolved.length - 24} 个` : ''}`);
  }
  console.log('边界：①标记词表是本仓实际用词，别的写法（例如只写"这是今天的行为"）看不见 ⇒ 下界；②"违规计数"形状只认字面量阈值，经变量比较的看不见；③本尺不判"该不该反转"，只答"哪条断言钉的是现状、挂在谁名下"；④编号解析以登记册 §5.4 行首为权威，解析不到一律点名。');
  fs.writeFileSync(path.join(ROOT, 'tmp/status-quo-assertions.json'), JSON.stringify({
    filesScanned: c.filesScanned, authoritySize: c.authoritySize, buckets: byBucket,
    rows: c.rows, unresolved: c.unresolved,
    quoIds: quoIds.map(([id, v]) => ({ id, quo: v.filter((x) => x.bucket === 'quo-with-id').length, refs: v.length })),
  }, null, 2) + '\n');
  console.log('机器可读：tmp/status-quo-assertions.json');
}

function selfTest() {
  const ids = new Set(['F-04', 'F-12', 'GUARD-01', 'RUN-02', 'CAS-01']);
  const dir = fs.mkdtempSync('/tmp/ewoh-quo-');
  const w = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
  let ok = true;
  const run = (src) => regionsOf(src).map((s) => judgeRegion(s.region, s.body, ids)).filter(Boolean);
  const chk = (name, cond, detail) => { if (!cond) ok = false; console.log(`  ${cond ? '✔' : '✕'} ${name}${detail ? ` → ${detail}` : ''}`); };

  const P1 = w('p1.spec.ts', "/**\n * RJ-03：把形态推到已派工方案上（现状实测）。\n * F-12 待裁：被拒/已派工的方案能不能重排。\n */\nit('RJ-03 已派工方案被 replan（现状实测）', async () => {\n  expect(replanned.status).toBe(201);\n});\n");
  const r1 = run(fs.readFileSync(P1, 'utf8'));
  chk('P1 现状标记 + 可解析编号 ⇒ quo-with-id', r1.length === 1 && r1[0].bucket === 'quo-with-id' && r1[0].ids.includes('F-12'), JSON.stringify(r1[0] && { b: r1[0].bucket, ids: r1[0].ids }));

  const P2 = w('p2.spec.ts', "it('AI-01 同一业务对象可并存两份都已通过的审批实例', async () => {\n  const approvedOnTask = instances.filter((r) => r.status === 'approved');\n  expect(approvedOnTask.length).toBeGreaterThanOrEqual(2);\n});\n");
  const r2 = run(fs.readFileSync(P2, 'utf8'));
  chk('P2 违规计数形状（无现状标记）⇒ violation-count', r2.length === 1 && r2[0].bucket === 'violation-count', JSON.stringify(r2[0] && r2[0].bucket));

  const N1 = w('n1.spec.ts', "it('派工后方案为 dispatched', async () => {\n  expect(String(row.status)).toBe('dispatched');\n});\n");
  chk('N1 普通应然断言 ⇒ 不计', run(fs.readFileSync(N1, 'utf8')).length === 0);

  const N2 = w('n2.spec.ts', "/** 现状实测：F-12 待裁，这里只写散文不断言。 */\nit('只描述不断言', async () => {\n  const x = await read();\n  console.log(x);\n});\n");
  chk('N2 只有散文标记、块内无断言 ⇒ 不计', run(fs.readFileSync(N2, 'utf8')).length === 0);

  const N3 = w('n3.spec.ts', "/** 现状实测：ZZZ-99 这一项登记册里没有。 */\nit('挂了个解析不到的编号', async () => {\n  expect(a.status).toBe('approved');\n});\n");
  const r3 = run(fs.readFileSync(N3, 'utf8'));
  chk('N3 解析不到的编号必须被点名（不得静默丢）', r3.length === 1 && (r3[0].unresolved || []).includes('ZZZ-99'), JSON.stringify(r3[0] && r3[0].unresolved));

  const N4 = w('n4.spec.ts', fs.readFileSync(P1, 'utf8').replace(/现状实测/g, '应然').replace(/F-12 待裁：/g, 'F-12：'));
  const r4 = run(fs.readFileSync(N4, 'utf8'));
  chk('N4 撤销现状标记后必须离开 quo-with-id', !r4.some((x) => x.bucket === 'quo-with-id'), JSON.stringify(r4.map((x) => x.bucket)));

  // P5：**缺失的那支反向对照**——邻块文档区里的标记/编号不得越界进本块。
  //（V175 的 bodyOnly() 只剥断言扫描用的 body，标记/编号是在 region 里搜的 ⇒ 泄漏没修到；
  //  有这条对照，当时就会红。）
  const P5 = w('p5.spec.ts',
    "it('A 是应然断言', async () => {\n  expect(String(row.status)).toBe('dispatched');\n});\n/** F-12 待裁：下面这块钉的是现状 */\nit('B 现状实测', async () => {\n  expect(String(a.status)).toBe('superseded');\n});\n");
  const seg5 = regionsOf(fs.readFileSync(P5, 'utf8'))
    .map((s) => ({ label: s.label, r: judgeRegion(s.region, s.body, ids) })).filter((x) => x.r);
  chk('P5 邻块的标记/编号不得越界进 A 块（越界即归属错挂）',
    seg5.length === 1 && /B 现状实测/.test(seg5[0].label) && seg5[0].r.bucket === 'quo-with-id',
    JSON.stringify(seg5.map((x) => [String(x.label).slice(0, 12), x.r.bucket])));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok ? '结论：尺子可用（钉现状必开火且能挂到编号；散文不开火；解析不到的编号必点名；撤销标记必回落）'
    : '结论：尺子不可用，本轮不出数');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest(); else main();
}
module.exports = { judgeRegion, leadingDocs, authorityIds, QUO_MARKERS };
