#!/usr/bin/env node
/*
 * V330 建、V331/V332 改：状态机契约里 `condition` 标签**有没有实现侧对应物**（CNAM-01 的代价尺与裁决面）。
 *
 * 这条量具只回答一个问题：`contracts/state-machines/` 里那些带 `condition` 的箭头，按箭头自己声明的
 * `kind` 分档后，动作类里有多少支**在实现侧找不到任何对应物**——那才是 CNAM-01 的欠账分子。
 * 守卫名（`deadline_passed`／`all_steps_complete` 这类）本来就不是标识符，零命中属预期，不计欠账：
 * V328 实测过，"要求每个 condition 都解析到实体"这条判据今天会红一大片、其中一半是误伤。
 *
 * 三根来源，一根一根加，每根都留下读数差：
 *   V330 只有词形启发式 ⇒ 分类不可信（V331 现算它把 11 支守卫读成动作）。
 *   V331 契约自带 `kind:` ⇒ 分类的事实源进制品；词形降级为"缺声明时的建议"，缺声明即判红（退 6）。
 *   V332 契约自带 `writer:` ⇒ 对应物的事实源也进制品。标签解析不到时看 writer；两者都无 ⇒ **dangling，退 8**；
 *          `writer: unimplemented` 是**显式声明"这条边没人实现"**，单列一档（既不算已解析，也不算欠账）。
 * 为什么不另建映射表：那是给契约造第二份事实副本，下一轮还得新增判据核两份一致（与 V331 弃用词表同一理由）。
 *
 * 语料面（V332 起）：server＋shared＋client/src＋**src/edge_platform**＋ewoh-edge（后者不存在，留着无害）。
 *   加边缘是因为 plan.yaml 的 `simulate` 等 writer 只在边缘实现；语料不含边缘会把它们误判成 dangling。
 *   因此本尺同时报**两档欠账**：`含边缘`（默认判据）与 `只云侧`（历史口径，V331 及以前的读数出处）。
 *
 * 退出码：0 干净 ｜ 6 kind 缺声明或非法 ｜ 7 Σ≠分母（读数作废）｜ 8 存在 dangling 动作箭头。
 * 用法：node scripts/chain-baseline/contract-condition-labels.cjs [--self-test] [--json]
 *      判据自测条数由脚本自报（真语料控制打在真实契约上，夹具控制打在合成语料上）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '../..');
const req = createRequire(path.join(ROOT, 'ewoh-spark-app', 'package.json'));
const yaml = req('js-yaml');

const DEFAULT_SM = path.join(ROOT, 'contracts', 'state-machines');
// 云侧四目录 + 边缘（V332 加）；不含 docs/台账，否则登记文本自己会把标签"实现"掉
const CLOUD_DIRS = [
  path.join(ROOT, 'ewoh-spark-app', 'server'),
  path.join(ROOT, 'ewoh-spark-app', 'shared'),
  path.join(ROOT, 'ewoh-spark-app', 'client', 'src'),
  path.join(ROOT, 'ewoh-edge'),
];
const EDGE_DIRS = [path.join(ROOT, 'src', 'edge_platform')];
const CODE_DIRS = CLOUD_DIRS.concat(EDGE_DIRS);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.py', '.sql', '.yaml', '.yml']);
// V331 起只作"缺声明时的建议"，不参与定档；矛盾档已取消（声明与词形不合时以声明为准）
const GUARD_FORM = /^(all_|any_|no_|has_|is_|if_|not_)|(_passed|_received|_complete|_approved|_rejected|_failed|_exists|_expired|_allowed|_ready|_sent|_empty)$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'build') walk(p, out);
    } else if (CODE_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

/** 语料：既给拼接后的整块文本（快速存在性判断），也给逐文件索引（writer 命中要能点名文件）。 */
function codeBlob(dirs) {
  const files = [];
  for (const d of dirs) walk(d, files);
  const index = files.map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
  return { text: index.map((x) => x.text).join('\n'), files: files.length, index };
}

const camel = (n) => n.split(/[_-]/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
const pascal = (n) => camel(n).replace(/^(.)/, (m) => m.toUpperCase());

const formsOf = (label) => [label, camel(label), pascal(label)].filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 标签/token 在语料里是否作为标识符或路由串出现（三形任一即算命中）。blob 可以是字符串或 codeBlob() 的返回值。 */
function resolves(token, blob) {
  if (!token) return null;
  const text = typeof blob === 'string' ? blob : blob.text;
  for (const f of formsOf(String(token))) {
    const re = new RegExp('["\'`.]?' + escapeRe(f) + '\\b');
    if (re.test(text)) return f;
  }
  return null;
}

/** token 的前两个命中文件（writer 归属要用它区分"云侧真有"与"只有边缘有"）。 */
function hitsOf(token, blob) {
  const idx = (typeof blob === 'string' ? null : blob.index) || [];
  const out = [];
  for (const { file, text } of idx) {
    for (const f of formsOf(String(token))) {
      if (new RegExp('["\'`.]?' + escapeRe(f) + '\\b').test(text)) { out.push(file); break; }
    }
    if (out.length >= 2) break;
  }
  return out;
}

/** 目录里全部箭头数（含不带 condition 的）——分母要能自证。 */
function allArrows(smDir) {
  let n = 0;
  for (const f of fs.readdirSync(smDir).filter((x) => x.endsWith('.yaml') || x.endsWith('.yml')).sort()) {
    const doc = yaml.load(fs.readFileSync(path.join(smDir, f), 'utf8')) || {};
    if (Array.isArray(doc.transitions)) n += doc.transitions.length;
  }
  return n;
}

/** 解析一个目录下的状态机契约，返回带 condition 的箭头（含 kind／writer 轨迹）。 */
function arrows(smDir) {
  const out = [];
  for (const f of fs.readdirSync(smDir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml')).sort()) {
    const doc = yaml.load(fs.readFileSync(path.join(smDir, f), 'utf8')) || {};
    const list = Array.isArray(doc.transitions) ? doc.transitions : [];
    for (const t of list) {
      if (!t || typeof t !== 'object' || !t.condition) continue;
      const label = String(t.condition);
      const declared = t.kind == null ? null : String(t.kind);
      const writer = t.writer == null ? null : String(t.writer);
      const suggest = GUARD_FORM.test(label) ? 'guard' : 'action';
      let bucket;
      if (declared == null) bucket = 'kind-missing';
      else if (declared !== 'action' && declared !== 'guard') bucket = 'kind-invalid';
      else bucket = declared;
      out.push({ file: f, from: String(t.from), to: String(t.to), label, declared, suggest, writer, bucket });
    }
  }
  return out;
}

const BUCKETS = ['action-resolved', 'action-resolved-writer', 'action-unimplemented', 'action-dangling',
  'guard', 'kind-missing', 'kind-invalid'];

/**
 * writer 的归因判定。值 shapes：
 *   `unimplemented`            ⇒ 显式声明"这条边没人实现"（单列一档）
 *   `<相对路径>#<标识符>`       ⇒ 必须**该文件存在**且**该文件里读得到那个标识符**才算落定
 *   裸标识符                    ⇒ 一律不认（V332 实测：裸 `process`/`simulate`/`cancel` 会被无关同名符号顶开）
 */
function resolveWriter(writer, cloudDirsOnly) {
  if (!writer) return { ok: false, why: 'none' };
  if (writer === 'unimplemented') return { ok: false, why: 'unimplemented' };
  const i = writer.indexOf('#');
  if (i < 0) return { ok: false, why: 'bare-token' };
  const rel = writer.slice(0, i), token = writer.slice(i + 1);
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { ok: false, why: 'missing-file', file: rel, token };
  const text = fs.readFileSync(abs, 'utf8');
  const hit = formsOf(token).some((f) => new RegExp('["\'`.]?' + escapeRe(f) + '\\b').test(text));
  if (!hit) return { ok: false, why: 'no-token', file: rel, token };
  const under = (d) => abs.startsWith(path.resolve(ROOT, d));
  const inCloud = CLOUD_DIRS.some(under);
  if (cloudDirsOnly && !inCloud) return { ok: false, why: 'outside-cloud', file: rel, token };
  return { ok: true, file: path.relative(ROOT, abs), token, side: inCloud ? 'cloud' : 'edge' };
}

/** 动作箭头定档：标签可解析 → resolved；否则看 writer（unimplemented 单列）；两头都无着落 → dangling。 */
function classifyAction(x, blob, cloudOnly) {
  if (resolves(x.label, blob)) return { bucket: 'action-resolved', via: 'label' };
  const w = resolveWriter(x.writer, cloudOnly);
  if (w.why === 'unimplemented') return { bucket: 'action-unimplemented', via: 'writer-unimplemented' };
  if (w.ok) return { bucket: 'action-resolved-writer', via: 'writer', file: w.file, side: w.side };
  return { bucket: 'action-dangling', via: w.why || 'none' };
}

function measure(smDir, blobIn) {
  const blob = typeof blobIn === 'string' ? { text: blobIn, index: [] } : blobIn;
  const a = arrows(smDir);
  const b = {};
  for (const k of BUCKETS) b[k] = [];
  for (const x of a) {
    if (x.bucket === 'guard' || x.bucket === 'kind-missing' || x.bucket === 'kind-invalid') {
      b[x.bucket].push(x);
      continue;
    }
    const c = classifyAction(x, blob);
    x.via = c.via;
    if (c.file) { x.writerFile = c.file; x.writerSide = c.side; }
    b[c.bucket].push(x);
  }
  const sum = Object.values(b).reduce((s, v) => s + v.length, 0);
  if (a.length !== sum) {
    console.error(`Σ 不等于分母：分母 ${a.length}，档位合计 ${sum}`);
    process.exit(7);
  }
  return { total: a.length, buckets: b, arrows: a };
}

/** 只云侧口径（V331 及以前的语料面）下的欠账支数：边缘实现的 writer 在这一档算未落定。 */
function cloudOnlyDangling(m, cloudBlob) {
  let n = 0;
  for (const x of m.arrows) {
    if (x.declared !== 'action') continue;
    const c = classifyAction(x, cloudBlob, true);
    if (c.bucket === 'action-dangling') n += 1;
  }
  return n;
}

function tmpFixture(name, arrowsYaml, implFile) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ccl-${name}-`));
  fs.writeFileSync(path.join(d, 'x.yaml'), `states: [a, b]\ntransitions:\n${arrowsYaml}\nterminal: [b]\n`, 'utf8');
  if (implFile) fs.writeFileSync(path.join(d, implFile.name), implFile.text, 'utf8');
  return d;
}
const wpath = (dir, name, token) => `${path.join(dir, name)}#${token}`;

function selfTest() {
  const blob = codeBlob(CODE_DIRS);
  const real = measure(DEFAULT_SM, blob);
  const failures = [];
  let ran = 0;
  const ok = (cond, msg) => { ran += 1; if (!cond) failures.push(msg); };
  const inBucket = (bs, label) => bs.some((x) => x.label === label);
  const NONE = 'nothing at all here 0x';

  // 真语料四条：证明四根档都在看东西，而不是只在自造夹具里过
  ok(inBucket(real.buckets['action-resolved-writer'], 'convert_to_task'),
    'C1 真语料：`convert_to_task` 应落 action-resolved-writer（标签零命中、writer=markPlanDispatched 可解析）');
  ok(inBucket(real.buckets['action-resolved'], 'approve'),
    'C2 真语料：`approve` 应落 action-resolved（标签本身就解析得到）');
  ok(real.buckets['kind-missing'].length === 0 && real.buckets['kind-invalid'].length === 0,
    `C3 真语料：契约是分类唯一事实源 ⇒ 缺声明 ${real.buckets['kind-missing'].length}／非法 ${real.buckets['kind-invalid'].length} 都必须为 0`);
  ok(inBucket(real.buckets['action-unimplemented'], 'reject_and_revise'),
    'C4 真语料：`reject_and_revise` 必须落 action-unimplemented（显式未实现，既不许算已解析也不许算欠账）');
  ok(real.buckets['action-dangling'].length === 0,
    `C5 真语料：今天 dangling 必须为 0（实报 ${real.buckets['action-dangling'].length}）⇒ 有动作箭头两头都无着落`);

  const ABSENT = 'zzz-ccl-absent-name-9x';
  let m = measure(tmpFixture('guard', `  - { from: a, to: b, condition: ${ABSENT}, kind: guard }`), NONE);
  ok(m.buckets.guard.length === 1 && m.buckets['action-dangling'].length === 0,
    'C6 `kind: guard` ＋仓内不存在的名字 ⇒ 落 guard，不得进欠账');
  m = measure(tmpFixture('dangling', `  - { from: a, to: b, condition: ${ABSENT}, kind: action }`), NONE);
  ok(m.buckets['action-dangling'].length === 1 && m.buckets['action-resolved'].length === 0,
    'C7 动作箭头标签零命中且**没有 writer** ⇒ 必须 dangling（V332 起这才是欠账形状）');
  let d8 = tmpFixture('writer-ok', `  - { from: a, to: b, condition: ${ABSENT}, kind: action, writer: ${wpath('@DIR@', 'impl.ts', 'approve')} }`, { name: 'impl.ts', text: 'export function approve() {}\n' });
  fs.writeFileSync(path.join(d8, 'x.yaml'), fs.readFileSync(path.join(d8, 'x.yaml'), 'utf8').replace(/@DIR@/g, d8), 'utf8');
  m = measure(d8, NONE);
  ok(m.buckets['action-resolved-writer'].length === 1 && m.buckets['action-dangling'].length === 0
    && m.buckets['action-resolved-writer'][0].writerSide === 'edge',
    'C8 标签零命中但 writer=`文件#标识符` 且该文件读得到 ⇒ 落 action-resolved-writer，不再算欠账');
  let d9a = tmpFixture('writer-notoken', `  - { from: a, to: b, condition: ${ABSENT}, kind: action, writer: ${wpath('@DIR@', 'impl.ts', 'approve')} }`, { name: 'impl.ts', text: 'export function unrelated() {}\n' });
  fs.writeFileSync(path.join(d9a, 'x.yaml'), fs.readFileSync(path.join(d9a, 'x.yaml'), 'utf8').replace(/@DIR@/g, d9a), 'utf8');
  m = measure(d9a, NONE);
  ok(m.buckets['action-dangling'].length === 1 && m.buckets['action-dangling'][0].via === 'no-token',
    'C9 writer 指的文件在、但那个标识符不在文件里 ⇒ 必须 dangling（via=no-token，不能靠"写了 writer"过关）');
  m = measure(tmpFixture('writer-bare', `  - { from: a, to: b, condition: ${ABSENT}, kind: action, writer: approve }`),
    'export function approve() {}');
  ok(m.buckets['action-dangling'].length === 1 && m.buckets['action-dangling'][0].via === 'bare-token',
    'C9′ 裸标识符 writer（没有文件限定）一律不认 ⇒ dangling（via=bare-token）：实测裸 process/simulate 会被无关同名符号顶开');
  m = measure(tmpFixture('unimpl', `  - { from: a, to: b, condition: ${ABSENT}, kind: action, writer: unimplemented }`), NONE);
  ok(m.buckets['action-unimplemented'].length === 1 && m.buckets['action-dangling'].length === 0,
    'C10 `writer: unimplemented` ⇒ 单列一档，不算 dangling 也不算 resolved');
  m = measure(tmpFixture('undeclared', `  - { from: a, to: b, condition: ${ABSENT} }`), NONE);
  ok(m.buckets['kind-missing'].length === 1 && m.buckets['action-dangling'].length === 0 && m.buckets.guard.length === 0,
    'C11 没有 `kind:` ⇒ 单列 kind-missing，不许由词形猜档（V331 取消猜档）');
  m = measure(tmpFixture('invalid', `  - { from: a, to: b, condition: ${ABSENT}, kind: maybe }`), NONE);
  ok(m.buckets['kind-invalid'].length === 1, 'C12 `kind: maybe`（非法值）⇒ 单列 kind-invalid');
  m = measure(tmpFixture('shape-override', `  - { from: a, to: b, condition: deadline_hit, kind: guard }`), NONE);
  ok(m.buckets.guard.length === 1 && m.buckets['kind-invalid'].length === 0 && m.buckets['kind-missing'].length === 0
    && m.buckets.guard[0].suggest === 'action',
    'C13（必须**不开火**的旧档）声明 guard 而词形读作 action ⇒ 按声明定档，不得再报矛盾');
  m = measure(tmpFixture('sum', `  - { from: a, to: b, condition: approve, kind: action }\n  - { from: b, to: a, condition: ${ABSENT}3, kind: action, writer: ${ABSENT}4 }`),
    'export function approve() {}');
  ok(m.total === 2 && m.buckets['action-resolved'].length === 1 && m.buckets['action-dangling'].length === 1,
    'C14 分母与档位同步（两支 ⇒ Σ=2，一支已解析、一支 dangling）');

  console.log(`判据自测：C1-C5 真语料（分母 ${real.total}）＋ C6-C14′ 夹具`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  if (failures.length) {
    console.log(`❌ 自测 ${failures.length} 条不过`);
    process.exit(1);
  }
  console.log(`✅ 自测全过；本轮判据自测条数=${ran}（本脚本执行到的 ok() 数，不是手抄），全部通过`);
}

function report(asJson) {
  const blob = codeBlob(CODE_DIRS);
  const cloud = codeBlob(CLOUD_DIRS);
  const m = measure(DEFAULT_SM, blob);
  const names = (bs) => [...new Set(bs.map((x) => x.label))].sort();
  const badKind = m.buckets['kind-missing'].length + m.buckets['kind-invalid'].length;
  const dangling = m.buckets['action-dangling'].length;
  const out = {
    smDir: path.relative(ROOT, DEFAULT_SM), arrows: allArrows(DEFAULT_SM), total: m.total,
    names: [...new Set(m.arrows.map((x) => x.label))].length,
    corpus: { files: blob.files, dirs: CODE_DIRS.map((d) => path.relative(ROOT, d)) },
    buckets: Object.fromEntries(BUCKETS.map((k) => [k, m.buckets[k].length])),
    cloudOnlyDangling: cloudOnlyDangling(m, cloud),
  };
  if (asJson) {
    console.log(JSON.stringify({ ...out, dangling: m.buckets['action-dangling'], unimplemented: m.buckets['action-unimplemented'] }, null, 2));
  } else {
    console.log(`契约目录：${out.smDir}（箭头总数 ${out.arrows}，带 condition 的 ${m.total} 支、去重标签名 ${out.names} 个）`);
    console.log(`代码语料：${out.corpus.dirs.join(', ')}（${out.corpus.files} 个文件）`);
    console.log(`档位：action-resolved ${out.buckets['action-resolved']}`
      + ` ｜ action-resolved-writer ${out.buckets['action-resolved-writer']}`
      + ` ｜ action-unimplemented ${out.buckets['action-unimplemented']}`
      + ` ｜ action-dangling ${out.buckets['action-dangling']}`
      + ` ｜ guard ${out.buckets.guard}`
      + ` ｜ kind-missing ${out.buckets['kind-missing']} ｜ kind-invalid ${out.buckets['kind-invalid']}`
      + ` ⇒ Σ=${out.total}`);
    console.log(`欠账两根口径：全实现语料 dangling=${dangling}｜只云侧（V331 的历史口径，边缘实现的那几支在这档算未落定）dangling=${out.cloudOnlyDangling}`);
    console.log(`              另有 unimplemented ${out.buckets['action-unimplemented']} 支（显式声明未实现，两档都不算欠账）`);
    if (m.buckets['action-resolved-writer'].length) {
      console.log('\n靠 writer 落到实体的箭头（标签本身零命中）：');
      for (const x of m.buckets['action-resolved-writer']) {
        console.log(`   ${x.file}  ${x.from}→${x.to}  condition=${x.label}  writer=${x.writer}  ⇒ ${x.writerFile}（${x.writerSide}）`);
      }
    }
    if (m.buckets['action-unimplemented'].length) {
      console.log('\n显式声明未实现（writer: unimplemented，既不算已解析也不算欠账）：');
      for (const x of m.buckets['action-unimplemented']) {
        console.log(`   ${x.file}  ${x.from}→${x.to}  condition=${x.label}`);
      }
    }
    if (m.buckets['action-dangling'].length) {
      console.log('\n❌ dangling（动作箭头标签与 writer 两头都无着落 ⇒ 这才是 CNAM-01 的欠账）：');
      for (const x of m.buckets['action-dangling']) {
        console.log(`   ${x.file}  ${x.from}→${x.to}  condition=${x.label}  writer=${x.writer ?? '（无）'}  via=${x.via}`);
      }
    }
    for (const key of ['kind-missing', 'kind-invalid']) {
      if (m.buckets[key].length) {
        console.log(`\n${key}：` + m.buckets[key].map((x) => `${x.file}:${x.from}→${x.to} condition=${x.label} kind=${x.declared ?? '无（词形会猜成 ' + x.suggest + '，不参与定档）'}`).join('\n'));
      }
    }
    console.log('\n> 本尺**未接进共享门禁**（CLBL-01 待裁）；守卫名零命中属预期、不计欠账，但逐条点名：'
      + names(m.buckets.guard).join(', '));
  }
  if (badKind) {
    console.log(`\n❌ kind 缺声明/非法 ${badKind} 支 ⇒ 退 6`);
    process.exit(6);
  }
  if (dangling) {
    console.log(`\n❌ dangling ${dangling} 支 ⇒ 退 8：动作箭头要么标签可解析，要么声明 writer 指向实体（确实没实现就写 unimplemented）`);
    process.exit(8);
  }
}

module.exports = { arrows, measure, resolves, hitsOf, codeBlob, classifyAction, cloudOnlyDangling, DEFAULT_SM, CODE_DIRS, CLOUD_DIRS, BUCKETS };

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else report(process.argv.includes('--json'));
}
