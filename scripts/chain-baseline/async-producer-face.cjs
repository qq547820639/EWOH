#!/usr/bin/env node
/*
 * V171 量具：断到终态的用例块，它断的那张权威表，**写入者里有没有已证实脱离请求上下文的（异步生产者）**？
 *
 * 为什么要这一面（V170 留下的、且明确没折进上一把尺的问题）：V170 读出 88 个断到终态的块里只有 1 个
 * 是"等到终态才断"（pollBound），81 个是单次快照。**单次读本身不是缺陷**——同步路径（调服务后断返回行）
 * 单次读就是正确写法；只有当被断言的事实**由异步生产者写**（定时器 / fire-and-forget / 脱离请求事务的
 * 回调）时，单次读才可能"因为还没写完而绿"或"因为等够了而绿"，两者在输出里同形。本尺就是把这两面分开。
 *
 * 三态（不折算、不互相吞并）：
 *  - `async-face`  ：块断到的表，至少有一个写入点被证实在脱离上下文里 ⇒ 单次读有时序假绿风险；
 *  - `no-async-evidence`：块断到的表，写入点**没找到**异步证据（≠ 已证明同步；这是三态里的一态，不是清白证明）；
 *  - `unresolved`  ：块内抽不到表线索（只走 HTTP API，没有 SQL/drizzle 表名）⇒ 不折进上面两面。
 *
 * 复用两个**权威**枚举器，不自建第二个（两套枚举器不一致即读数作废）：
 *  - 写入点：`status-write-guard-census.cjs --json` 的 `prod`（门禁主线在校准的那一份，24 处产品面）；
 *  - 用例块：`convergence-sites.cjs` 导出的 `blocks()/judgeFile()`（V170 同一把尺）。
 *
 * 脱离上下文的判据一律**大括号配对取范围**，不用 ±N 行窗口（V170 刚在这上面栽过）：
 *  marker = setInterval / setTimeout / setImmediate / process.nextTick / queueMicrotask /
 *           ctxStorage.run(undefined / .then( / .catch( / @Cron / @Interval / @Timeout（装饰器取其后方法体）。
 *  写入点在自己的文件里落在某个 marker 范围内 ⇒ `async-in-file`；
 *  写入点所在方法被别处 `.method(` 调用、且该调用点落在 marker 范围内，或该调用语句未 await 且挂了
 *  `.catch(`/`.then(` ⇒ `async-one-hop`（一跳；两跳以上看不见 ⇒ 本尺的 A 面是**下界**）。
 *
 * 表名解析到权威：drizzle 标识符 camelCase → snake_case，必须能在 `tmp/chain-baseline/schema-facts.txt`
 * 的表清单里找到；找不到的记 `unmapped` 并点名，不静默丢弃（静默零是最贵的绿）。
 *
 * 自测（--self-test，任一不过 rc≠0）：A1 setTimeout 内写入 / A2 @Cron 方法内写入 / A3 一跳 fire-and-forget
 * ⇒ 必须判 async；N1 普通 await 调用 ⇒ 必须判 no-async-evidence；N2 撤掉 A1 的 setTimeout ⇒ 必须回到 N1；
 * J1 块断到有异步写者的表 ⇒ async-face；J2 只有 API 路径的块 ⇒ unresolved（不得落进 A/B）；
 * J3 映射不到的表名 ⇒ 必须点名 unmapped，不得静默丢。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { blocks, judgeBlock } = require('./convergence-sites.cjs');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'ewoh-spark-app');
const CENSUS_JSON = path.join(ROOT, 'tmp/chain-baseline/status-write-guard-census.json');
const FACTS = path.join(ROOT, 'tmp/chain-baseline/schema-facts.txt');

/** 脱离请求上下文的 marker（装饰器类单独处理：取其后第一个方法体）。 */
const CALL_MARKERS = ['setInterval(', 'setTimeout(', 'setImmediate(', 'process.nextTick(', 'queueMicrotask(', 'ctxStorage.run(undefined', '.then(', '.catch('];
const DECO_MARKERS = ['@Cron(', '@Interval(', '@Timeout('];

function bodyRange(text, fromIndex) {
  const open = text.indexOf('{', fromIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return [open, i + 1]; }
  }
  return null;
}

/** 全部脱离上下文范围（大括号配对）。 */
function detachedRanges(text) {
  const out = [];
  for (const mk of CALL_MARKERS) {
    let i = -1;
    while ((i = text.indexOf(mk, i + 1)) !== -1) {
      // 回调体：marker 的实参括号里第一个 `{`
      const paren = text.indexOf('(', i + mk.length - 1);
      const r = bodyRange(text, paren === -1 ? i + mk.length : paren);
      if (r) out.push({ marker: mk, start: r[0], end: r[1] });
    }
  }
  for (const mk of DECO_MARKERS) {
    let i = -1;
    while ((i = text.indexOf(mk, i + 1)) !== -1) {
      const r = bodyRange(text, i);
      if (r) out.push({ marker: mk, start: r[0], end: r[1] });
    }
  }
  return out;
}

const inRanges = (ranges, off) => ranges.find((r) => off >= r.start && off < r.end) || null;

function serverTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(e.name)) serverTs(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** 行号 → 字符偏移。 */
function lineOffset(text, line) {
  const ls = text.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1 && i < ls.length; i += 1) off += ls[i].length + 1;
  return off;
}

/** 控制流关键字：V171 第一版把 `if (…)  {` 当成方法定义 ⇒ 15 个写入点的"所在方法"全解析成 `if`，
 *  一跳搜索因此去搜 `.if(`，把同一个无关调用点复制成 15 条假证据。夹具必须把写入点嵌进控制流才抓得到。 */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'function', 'else', 'try', 'do', 'case', 'typeof', 'new', 'throw', 'yield', 'delete', 'void', 'async', 'of', 'in']);

/** 写入点所在的方法/函数名（向上找最近的定义头；方法式与 `function` 式都认，取最靠近的那个）。 */
function enclosingMethod(text, off) {
  const head = text.slice(0, off);
  const pats = [
    /(?:^|\n)\s*(?:public |private |protected |readonly )*(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{\s*$/gm,
    /(?:^|\n)\s*(?:export )?(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  ];
  let best = null;
  for (const re of pats) {
    let m;
    while ((m = re.exec(head)) !== null) {
      if (KEYWORDS.has(m[1])) continue;
      if (!best || m.index > best.index) best = { name: m[1], index: m.index };
    }
  }
  return best ? best.name : null;
}

function ensureCensus() {
  if (!fs.existsSync(CENSUS_JSON)) {
    execFileSync(process.execPath, [path.join(__dirname, 'status-write-guard-census.cjs'), '--json'], { stdio: 'inherit' });
  }
  const d = JSON.parse(fs.readFileSync(CENSUS_JSON, 'utf8'));
  if (!d.prod || !d.prod.length) { console.error('✕ 写者普查 prod 为空 ⇒ 读数作废'); process.exit(1); }
  return d.prod;
}

/** 权威表清单（B 段事实文件）。 */
function authorityTables() {
  if (!fs.existsSync(FACTS)) return null;
  const t = fs.readFileSync(FACTS, 'utf8');
  return new Set([...t.matchAll(/\b(ewoh_[a-z0-9_]+)\b/g)].map((m) => m[1]));
}

const snake = (id) => id.replace(/([A-Z])/g, '_$1').toLowerCase();

/** 每个写入点判 async 面。返回 {table, site, verdict, evidence}。 */
function classifySites(prod) {
  const files = serverTs(path.join(APP, 'server'));
  const cache = new Map();
  const load = (rel) => {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!cache.has(abs)) {
      const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      cache.set(abs, { text, ranges: detachedRanges(text) });
    }
    return cache.get(abs);
  };
  // 先建"方法名 → 写入点"索引，供一跳解析
  const byMethod = new Map();
  for (const s of prod) {
    const abs = path.isAbsolute(s.file) ? s.file : path.join(ROOT, s.file);
    const { text } = load(abs);
    if (!text) continue;
    const off = lineOffset(text, Number(s.line));
    const m = enclosingMethod(text, off);
    s._abs = abs; s._off = off; s._method = m; s._table = snake(String(s.table));
    if (m) { if (!byMethod.has(m)) byMethod.set(m, []); byMethod.get(m).push(s); }
  }
  // 一跳：全 server/** 里 `.method(` 的调用点是否脱离上下文 / 未 await 且挂 catch|then
  const hopEvidence = new Map();
  for (const f of files) {
    const { text, ranges } = load(f);
    if (!text) continue;
    for (const [method, sites] of byMethod) {
      const re = new RegExp(`\\.\\s*${method.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        // 语句边界：往前到最近的 `;` 或 `{`，往后到最近的 `;`（跨行也对，不用 ±N 行窗口）
        const sStart = Math.max(text.lastIndexOf(';', m.index), text.lastIndexOf('{', m.index));
        let sEnd = text.indexOf(';', m.index);
        if (sEnd === -1) sEnd = text.length;
        const prefix = text.slice(sStart + 1, m.index);
        const suffix = text.slice(m.index, sEnd);
        const detached = inRanges(ranges, m.index);
        // 未 await 且（挂了 .catch/.then 或显式 void）才算 fire-and-forget；
        // `await x().catch(…)` 与 `return x()` 都在请求路径上，不算脱离。
        const unawaited = !/\bawait\b|\breturn\b|\byield\b/.test(prefix)
          && (/^\s*void\b/.test(prefix) || /\.catch\s*\(|\.then\s*\(/.test(suffix));
        if (!detached && !unawaited) continue;
        const rel = path.relative(ROOT, f);
        const line = text.slice(0, m.index).split('\n').length;
        const why = detached ? `调用点在 \`${detached.marker}\` 范围内` : '未 await 且挂了 .catch/.then（fire-and-forget）';
        for (const s of sites) {
          const key = `${s.file}:${s.line}`;
          if (!hopEvidence.has(key)) hopEvidence.set(key, []);
          hopEvidence.get(key).push(`${rel}:${line} ${why}`);
        }
      }
    }
  }
  return prod.map((s) => {
    const { ranges } = load(s._abs);
    const inFile = inRanges(ranges || [], s._off);
    const hops = hopEvidence.get(`${s.file}:${s.line}`) || [];
    const verdict = inFile ? 'async-in-file' : hops.length ? 'async-one-hop' : 'no-async-evidence';
    return {
      table: s._table, drizzle: s.table, site: `${path.relative(ROOT, s._abs)}:${s.line}`, method: s._method,
      guard: s.guard, verdict,
      evidence: inFile ? `写入点落在 \`${inFile.marker}\` 范围内` : hops.slice(0, 3).join('；'),
    };
  });
}

/** 从块文本抽被断言的表（SQL 名 + drizzle 标识符）。 */
function blockTables(body) {
  const sql = [...body.matchAll(/(?:FROM|UPDATE|JOIN|INTO)\s+(ewoh_[a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
  const drz = [...body.matchAll(/\b(ewoh[A-Z][A-Za-z0-9]+)\b/g)].map((m) => snake(m[1]));
  return [...new Set([...sql, ...drz])];
}

function joinFaces(sites, opts = {}) {
  const conv = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/convergence-sites.json'), 'utf8'));
  const asyncTables = new Set(sites.filter((s) => s.verdict !== 'no-async-evidence').map((s) => s.table));
  const authority = authorityTables();
  const unmapped = new Set();
  const out = { 'async-face': [], 'no-async-evidence': [], unresolved: [] };
  const texts = new Map();
  const readText = (rel) => {
    if (!texts.has(rel)) texts.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    return texts.get(rel);
  };
  for (const row of conv.rows) {
    const text = readText(row.rel);
    const bs = blocks(text);
    for (const b of bs) {
      const j = judgeBlock(b.body);
      if (!j.asserted) continue;
      const tabs = blockTables(b.body);
      const known = tabs.filter((t) => !authority || authority.has(t));
      tabs.filter((t) => authority && !authority.has(t)).forEach((t) => unmapped.add(t));
      const key = `${row.rel} :: ${String(b.label).slice(0, 48)} :: ${j.bucket}`;
      if (!known.length) { out.unresolved.push({ key, clue: tabs.length ? `只抽到未映射名 ${tabs.join(',')}` : '块内无 SQL/drizzle 表线索（只走 HTTP API）' }); continue; }
      const hit = known.filter((t) => asyncTables.has(t));
      if (hit.length) out['async-face'].push({ key, tables: known, asyncTables: hit });
      else out['no-async-evidence'].push({ key, tables: known });
    }
  }
  return { faces: out, unmapped: [...unmapped], asyncTables: [...asyncTables] };
}

function main() {
  const prod = ensureCensus();
  const sites = classifySites(prod);
  const byVerdict = {};
  for (const s of sites) byVerdict[s.verdict] = (byVerdict[s.verdict] || 0) + 1;
  console.log(`写入点（来自 status-write-guard-census --json 的 prod，权威且被门禁校准）：${sites.length} 处`);
  console.log(`  判档：${Object.entries(byVerdict).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log('  异步证据逐条（可核）：');
  for (const s of sites.filter((x) => x.verdict !== 'no-async-evidence')) {
    console.log(`   · [${s.verdict}] ${s.site} → ${s.table}（${s.method}，guard=${s.guard}）\n       ${s.evidence}`);
  }
  const unmappedSites = sites.filter((s) => { const a = authorityTables(); return a && !a.has(s.table); });
  if (unmappedSites.length) console.log(`  ⚠ 写入点表名映射不到权威清单（点名，不静默丢）：${unmappedSites.map((s) => `${s.drizzle}→${s.table}`).join(', ')}`);

  const { faces, unmapped, asyncTables } = joinFaces(sites);
  const n = (k) => faces[k].length;
  const total = n('async-face') + n('no-async-evidence') + n('unresolved');
  console.log(`\n有异步写者的权威表：${asyncTables.length} 张 → ${asyncTables.join(', ') || '（一张都没有）'}`);
  console.log(`断到终态的用例块按面分（合计 ${total}，与 V170 的 88 块同源同枚举器）：`);
  console.log(`  async-face ${n('async-face')} · no-async-evidence ${n('no-async-evidence')} · unresolved ${n('unresolved')}`);
  if (unmapped.length) console.log(`  ⚠ 块内抽到但映射不到权威表清单的名字（点名）：${unmapped.join(', ')}`);
  console.log('  async-face 逐条（这些才是"单次读可能时序假绿"的块）：');
  for (const f of faces['async-face']) console.log(`   · ${f.key}\n       异步写者的表：${f.asyncTables.join(',')}`);
  console.log('边界：①一跳解析，两跳以上看不见 ⇒ async-face 是**下界**；②no-async-evidence ≠ 已证明同步（可能由未解析的动态调用/事件总线触达）；③unresolved 块只走 HTTP API，要归面需 controller→service→表 的解析，本轮不做、不折算比例；④写入点分母来自门禁校准过的普查，本尺不自己再数一遍。');
  fs.writeFileSync(path.join(ROOT, 'tmp/async-producer-face.json'), JSON.stringify({
    sites, byVerdict, asyncTables, faces, unmappedBlocks: unmapped, totalBlocks: total,
  }, null, 2) + '\n');
  console.log('机器可读：tmp/async-producer-face.json');
}

/* ---------------- 自测（夹具在临时目录里跑同一套判据函数） ---------------- */
function selfTest() {
  const dir = fs.mkdtempSync('/tmp/ewoh-async-');
  const w = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
  let ok = true;
  const chk = (name, cond, detail) => { if (!cond) ok = false; console.log(`  ${cond ? '✔' : '✕'} ${name}${detail ? ` → ${detail}` : ''}`); };

  // A1：写入点落在 setTimeout 回调里
  const a1 = w('a1.ts', "export class S {\n  async tick(db) {\n    setTimeout(() => {\n      db.update(ewohSchedulingRun).set({ status: 'failed' });\n    }, 1000);\n  }\n}\n");
  // A2：@Cron 方法体内
  const a2 = w('a2.ts', "export class S {\n  @Cron('*/5 * * * *')\n  async sweep(db) {\n    await db.update(ewohControlCommand).set({ status: 'expired' });\n  }\n}\n");
  // N1：普通方法，调用方 await（无脱离证据）
  const n1 = w('n1.ts', "export class S {\n  async closeRun(db) {\n    await db.update(ewohSchedulingRun).set({ status: 'succeeded' });\n  }\n}\n");
  const judge = (file, line) => {
    const text = fs.readFileSync(file, 'utf8');
    const off = lineOffset(text, line);
    const r = inRanges(detachedRanges(text), off);
    return r ? `async-in-file(${r.marker})` : 'no-async-evidence';
  };
  const lineOf = (file, needle) => fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1;
  chk('A1 setTimeout 内写入判 async', judge(a1, lineOf(a1, 'db.update')).startsWith('async-in-file'), judge(a1, lineOf(a1, 'db.update')));
  chk('A2 @Cron 方法体内写入判 async', judge(a2, lineOf(a2, 'db.update')).startsWith('async-in-file'), judge(a2, lineOf(a2, 'db.update')));
  chk('N1 普通 await 方法内写入不得判 async', judge(n1, lineOf(n1, 'db.update')) === 'no-async-evidence', judge(n1, lineOf(n1, 'db.update')));
  // N2：撤掉 A1 的 setTimeout ⇒ 必须回到 no-async-evidence（撤销对照）
  const n2 = w('n2.ts', fs.readFileSync(a1, 'utf8').replace(/setTimeout\(\(\) => \{\n/, '').replace(/\n    \}, 1000\);/, ';'));
  chk('N2 撤掉 setTimeout 后必须回到 no-async-evidence', judge(n2, lineOf(n2, 'db.update')) === 'no-async-evidence', judge(n2, lineOf(n2, 'db.update')));

  // A3：一跳 fire-and-forget（调用点未 await 且挂 .catch）
  const caller = w('caller.ts', "export class C {\n  go(svc) {\n    svc.closeRun(this.db).catch((e) => this.log(e));\n  }\n}\n");
  const ct = fs.readFileSync(caller, 'utf8');
  const idx = ct.indexOf('.closeRun(');
  const ls = ct.lastIndexOf('\n', idx) + 1;
  const stmt = ct.slice(ls, ct.indexOf('\n', idx));
  const unawaited = !/\bawait\b/.test(stmt.slice(0, idx - ls)) && /void\s|\.catch\(|\.then\(/.test(stmt);
  chk('A3 一跳 fire-and-forget 调用点被认出', unawaited === true, stmt.trim());
  // 反向：同一调用改成 await ⇒ 不得再判 fire-and-forget
  const caller2 = w('caller2.ts', ct.replace('svc.closeRun(this.db).catch((e) => this.log(e));', 'await svc.closeRun(this.db);'));
  const ct2 = fs.readFileSync(caller2, 'utf8');
  const idx2 = ct2.indexOf('.closeRun(');
  const ls2 = ct2.lastIndexOf('\n', idx2) + 1;
  const stmt2 = ct2.slice(ls2, ct2.indexOf('\n', idx2));
  const un2 = !/\bawait\b/.test(stmt2.slice(0, idx2 - ls2)) && /void\s|\.catch\(|\.then\(/.test(stmt2);
  chk('A3-反向 改成 await 后不得再判 fire-and-forget', un2 === false, stmt2.trim());

  // A4：写入点嵌在 if/for 里 ⇒ "所在方法"必须解析成真方法名，绝不能是控制流关键字
  //（第一版就栽在这：15 个写入点的所在方法全被解析成 `if`，一跳去搜 `.if(`，把同一个无关调用点复制成 15 条假证据）
  const a4 = w('a4.ts', "export class S {\n  async closeRun(db, ok) {\n    if (ok) {\n      for (const r of rows) {\n        await db.update(ewohSchedulingRun).set({ status: 'failed' });\n      }\n    }\n  }\n}\n");
  const a4t = fs.readFileSync(a4, 'utf8');
  const a4m = enclosingMethod(a4t, lineOffset(a4t, lineOf(a4, 'db.update')));
  chk('A4 嵌在 if/for 里的写入点，所在方法必须是 closeRun 而不是 if', a4m === 'closeRun', `解析到 ${a4m}`);
  const a4b = w('a4b.ts', "export async function closeSchedulingRun(db, input) {\n  if (!input.orgId) { return false; }\n  const rows = await db.update(ewohSchedulingRun).set({ status: 'x' });\n  return true;\n}\n");
  const a4bt = fs.readFileSync(a4b, 'utf8');
  chk('A4b function 式定义也要解析到（scheduling-run.lifecycle.ts 就是这一形）',
    enclosingMethod(a4bt, lineOffset(a4bt, lineOf(a4b, 'db.update'))) === 'closeSchedulingRun',
    `解析到 ${enclosingMethod(a4bt, lineOffset(a4bt, lineOf(a4b, 'db.update')))}`);

  // A5：`await svc.x().catch(…)` 在请求路径上 ⇒ 不得判 fire-and-forget
  const isFF = (src, method) => {
    const idx = src.indexOf(`.${method}(`);
    if (idx === -1) return null;
    const sStart = Math.max(src.lastIndexOf(';', idx), src.lastIndexOf('{', idx));
    let sEnd = src.indexOf(';', idx); if (sEnd === -1) sEnd = src.length;
    const prefix = src.slice(sStart + 1, idx); const suffix = src.slice(idx, sEnd);
    return !/\bawait\b|\breturn\b|\byield\b/.test(prefix) && (/^\s*void\b/.test(prefix) || /\.catch\s*\(|\.then\s*\(/.test(suffix));
  };
  const a5 = w('a5.ts', "export class C {\n  async go(svc) {\n    await svc.closeRun(this.db).catch((e) => this.log(e));\n  }\n}\n");
  chk('A5 await + .catch 仍在请求路径上 ⇒ 不得判 fire-and-forget', isFF(fs.readFileSync(a5, 'utf8'), 'closeRun') === false);
  const a5b = w('a5b.ts', "export class C {\n  go(svc) {\n    void svc.closeRun(this.db);\n  }\n}\n");
  chk('A5b 显式 void 的脱管调用 ⇒ 必须判 fire-and-forget', isFF(fs.readFileSync(a5b, 'utf8'), 'closeRun') === true);

  // J1/J2：块归面
  const asyncTables = new Set(['ewoh_scheduling_run']);
  const faceOf = (body) => {
    const tabs = blockTables(body).filter((t) => t.startsWith('ewoh_'));
    if (!tabs.length) return 'unresolved';
    return tabs.some((t) => asyncTables.has(t)) ? 'async-face' : 'no-async-evidence';
  };
  chk('J1 断到有异步写者的表 ⇒ async-face',
    faceOf("it('x', async () => {\n  const rows = await owner`SELECT status FROM ewoh_scheduling_run WHERE org_id = ${org}`;\n  expect(rows.every((r) => ['succeeded','failed'].includes(r.status))).toBe(true);\n});") === 'async-face');
  chk('J1b 断到无异步证据的表 ⇒ no-async-evidence',
    faceOf("it('x', async () => {\n  const rows = await owner`SELECT status FROM ewoh_schedule_plan`;\n  expect(String(rows[0].status)).toBe('dispatched');\n});") === 'no-async-evidence');
  chk('J2 只走 HTTP API 的块 ⇒ unresolved（不得折进 A/B）',
    faceOf("it('x', async () => {\n  const r = await apiRequest('/api/scheduler/runs', {});\n  expect(String(r.body.status)).toBe('succeeded');\n});") === 'unresolved');
  // J3：drizzle 标识符 → snake_case 必须解析到权威名
  chk('J3 drizzle 标识符映射', snake('ewohSchedulingPlanAssignment') === 'ewoh_scheduling_plan_assignment', snake('ewohSchedulingPlanAssignment'));
  const auth = authorityTables();
  chk('J3b 权威表清单可读且非空（否则映射无锚）', !!auth && auth.size > 5, auth ? `${auth.size} 个名字` : '事实文件缺失');
  chk('J3c 映射结果必须落在权威清单里（不在即 unmapped，要点名）', !auth || auth.has('ewoh_scheduling_run'), 'ewoh_scheduling_run');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok ? '结论：尺子可用（脱离上下文必开火、撤销必回落、await 调用不得冒充异步、块归面三态不互吞）'
    : '结论：尺子不可用，本轮不出数');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest(); else main();
}
module.exports = { detachedRanges, inRanges, blockTables, snake, enclosingMethod, lineOffset };
