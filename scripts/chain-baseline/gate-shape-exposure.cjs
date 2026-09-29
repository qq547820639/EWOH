#!/usr/bin/env node
/**
 * 门禁主线1（租户隔离静态扫描 audit-org-predicates）的**镜像判据 + 形状暴露面**度量。
 *
 * 为什么要镜像：V123 实测主线1 只认 `.service.ts` 里的 `.from(裸标识符)`/`.update(裸标识符)`，
 * 成员表达式表引用、动态表变量、裸 SQL、非 service 文件四类写法一律扫不到（GATE-13）。
 * 光说"有盲区"没法用——必须给暴露面分档计数。而镜像只有在**与门禁自报分母对账一致**时，
 * 它的盲区计数才是真的，所以本件把对账做成硬判据：镜像的 VISIBLE 档必须等于门禁输出里的
 * 「查询链 N 条」，不等即判"镜像已落后于门禁"并以 rc=1 拒出数（与 GATE-14 同一族规矩：
 * 量具自己不可信时，不许把它的读数当证据）。
 *
 * 五档（KEYS）：
 *   VISIBLE  门禁看得见：`.service.ts` + `.from/.update(裸标识符)` 且标识符 ∈ org 表
 *   BLIND1   成员表达式表引用 `.from(schema.X)` / `.update(a.bX)`，X ∈ org 表
 *   BLIND2   动态表变量 `.from(a.b)`（属性名不是 org 表 ⇒ 静态上无法判定是哪张表）
 *   BLIND3   裸 SQL `sql`...from <链事实表>...``（完全不经 Drizzle 链）
 *   BLIND4   org 表链出现在非 `.service.ts` 文件（作用域盲区）
 *
 * 用法：
 *   node scripts/chain-baseline/gate-shape-exposure.cjs            # 真实语料 + 与门禁对账
 *   node scripts/chain-baseline/gate-shape-exposure.cjs --self-test # 判据能不能红
 *   node scripts/chain-baseline/gate-shape-exposure.cjs --no-gate   # 跳过对账（只出形状数，会显式标注"未对账"）
 * 退出码：0=度量成功；1=判据不成立（镜像与门禁分母不符 / 自测未抓到）；3=环境不可读（不判）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const SELF_TEST = ARGS.includes('--self-test');
const NO_GATE = ARGS.includes('--no-gate');
const SCAN_ROOT = path.join('ewoh-spark-app', 'server');
const SCHEMA_FILE = path.join(SCAN_ROOT, 'database', 'schema.ts');
const GATE = path.join('scripts', 'audit-org-predicates.js');
const FACT_LIST = path.join('scripts', 'chain-baseline', 'write-fanout.cjs');

const KEYS = ['VISIBLE', 'BLIND1', 'BLIND2', 'BLIND3', 'BLIND4'];

/** 与门禁同源判据（镜像：不改共享门禁，把它对 org 表的定义抄一遍并在运行时核对张数）。 */
function deriveOrgTables(schemaSrc) {
  const tables = new Map();
  const re = /export const (\w+) = pgTable\("([^"]+)"/g;
  let m;
  while ((m = re.exec(schemaSrc)) !== null) {
    const open = schemaSrc.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    let depth = 0, end = -1;
    for (let i = open; i < schemaSrc.length; i++) {
      if (schemaSrc[i] === '{') depth++;
      else if (schemaSrc[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    if (/(^|\s)orgId:\s*\w+\("org_id"/.test(schemaSrc.slice(open, end))) tables.set(m[1], m[2]);
  }
  return tables;
}

/** 链事实表：键名对着 schema.ts 解析（拒绝猜表名，GATE-14 教训），unmapped 项单列不参与。 */
function chainTables(schemaSrc) {
  // 只吃 `const FACTS = [ … ];` 这一段：write-fanout.cjs 的 --self-test 夹具里也写着
  // `['ewohA', …]` 这种假键，全文匹配会把夹具当真语料 ⇒ 报"幽灵键"崩溃（V149 实测抓到）。
  const src = fs.readFileSync(FACT_LIST, 'utf8');
  const block = src.match(/const FACTS\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error('解析不到 FACTS 数组本体 ⇒ 清单来源不成立，读数作废');
  const rows = [...block[1]
    .matchAll(/^\s*\['(ewoh\w+)'(,[^\]]*)?\]/gm)]
    .map((m) => ({ key: m[1], unmapped: /unmapped/.test(m[2] || '') }));
  if (rows.length === 0) throw new Error('FACTS 一条都没解析到 ⇒ 探针空转，读数作废');
  const unmapped = rows.filter((r) => r.unmapped).map((r) => r.key);
  const names = rows.filter((r) => !r.unmapped).map((r) => {
    const m = new RegExp(`export const ${r.key}\\s*=\\s*pgTable\\(\\s*['"]([\\w]+)`).exec(schemaSrc);
    if (!m) throw new Error(`${r.key} 在 schema.ts 里解析不到物理表名 ⇒ 幽灵键，读数作废`);
    return m[1];
  }).sort();
  return { names, unmapped };
}

const CHAIN_RE = /\.from\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\)|\.update\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\)/g;
const SQL_BLOCK = /sql`([\s\S]*?)`/g;

/** 纯函数：一份源码 → 五档命中（orgTables / chainNames 由调用方注入，自测可用合成 schema）。 */
function scanText(label, src, isService, orgTables, chainNames) {
  const r = {};
  KEYS.forEach((k) => (r[k] = []));
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    let m;
    CHAIN_RE.lastIndex = 0;
    while ((m = CHAIN_RE.exec(l))) {
      const target = m[1] || m[2];
      const at = `${label}:${i + 1} .${m[1] ? 'from' : 'update'}(${target})`;
      if (target.includes('.')) {
        const sym = target.split('.').pop();
        if (orgTables.has(sym)) r.BLIND1.push(at);
        else if (!target.startsWith('schema.')) r.BLIND2.push(at);
      } else if (orgTables.has(target)) {
        (isService ? r.VISIBLE : r.BLIND4).push(at);
      }
    }
  });
  SQL_BLOCK.lastIndex = 0;
  let mm;
  while ((mm = SQL_BLOCK.exec(src))) {
    const body = mm[1];
    const tbl = chainNames.find((t) => new RegExp(`\\b${t}\\b`).test(body));
    if (!tbl) continue;
    r.BLIND3.push(`${label}:${src.slice(0, mm.index).split('\n').length} 裸SQL→${tbl}${/\borg_id\b/i.test(body) ? '' : '（无 org_id）'}`);
  }
  return r;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'test', '__tests__'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 跑一次真门禁，抽它自报的「查询链 N 条」——镜像分母与门禁分母必须一致。 */
function gateChainCount() {
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /查询链 (\d+) 条/.exec(out);
  if (r.error || !m) return null;   // 读不到 ⇒ 不可判（不当成"一致"）
  return Number(m[1]);
}

if (SELF_TEST) {
  const ORG = new Map([['ewohProductionTask', 'ewoh_production_task'], ['ewohDevice', 'ewoh_device']]);
  const CHAIN = ['ewoh_production_task'];
  const want = { VISIBLE: 0, BLIND1: 0, BLIND2: 0, BLIND3: 0, BLIND4: 0 };
  const t = (name, label, src, isService, exp) => {
    const got = {};
    const r = scanText(label, src, isService, ORG, CHAIN);
    KEYS.forEach((k) => (got[k] = r[k].length));
    const e = { ...want, ...exp };
    const ok = JSON.stringify(got) === JSON.stringify(e);
    console.log(`${ok ? '✅' : '❌'} 自测 ${name} 期望 ${JSON.stringify(e)} 实得 ${JSON.stringify(got)}`);
    return ok;
  };
  let bad = 0;
  // 正向：门禁看得见的形状必须落在 VISIBLE（否则"盲区计数"没有分母）
  if (!t('VISIBLE：service 文件里的裸标识符链是门禁分母', 'a.service.ts', 'db.select().from(ewohProductionTask)', true, { VISIBLE: 1 })) bad++;
  if (!t('BLIND1：成员表达式表引用（含 .update 侧）', 'a.service.ts',
    'db.select().from(schema.ewohDevice)\ndb.update(schema.ewohProductionTask).set({})', true, { BLIND1: 2 })) bad++;
  if (!t('BLIND2：动态表变量（属性名不是 org 表）', 'a.service.ts', 'db.select().from(source.table)', true, { BLIND2: 1 })) bad++;
  if (!t('BLIND3：裸 SQL 直读链事实表', 'a.service.ts', 'db.execute(sql`select * from ewoh_production_task`)', true, { BLIND3: 1 })) bad++;
  if (!t('BLIND4：org 表链出现在非 service 文件', 'repo.ts', 'db.select().from(ewohDevice)', false, { BLIND4: 1 })) bad++;
  if (!t('对照：非 org 表 / 非链表一律不命中', 'a.service.ts', 'db.select().from(someOther)\ndb.execute(sql`select 1`)', true, {})) bad++;
  // 分档不许互相冒充：BLIND1 与 BLIND2 的边界（属性名恰好是 org 表 ⇒ 形状盲区而非类型未知）
  if (!t('边界：schema.前缀但表名不是 org 表 ⇒ 不算任何一档', 'a.service.ts', 'db.select().from(schema.ewohNotATable)', true, {})) bad++;
  console.log(bad ? `形状暴露面判据自测：不通过（${bad} 项）`
    : `形状暴露面判据自测：通过（${8 - 1} 项：1 正向 + 4 盲区各一 + 1 对照 + 1 边界，逐档证明探针会响）`);
  process.exit(bad ? 1 : 0);
}

const schemaSrc = fs.readFileSync(path.join(ROOT, SCHEMA_FILE), 'utf8');
const orgTables = deriveOrgTables(schemaSrc);
if (orgTables.size < 20) throw new Error(`org 表镜像派生 ${orgTables.size} 张（门禁要求 ≥20）⇒ 镜像判据不成立，读数作废`);
const chain = chainTables(schemaSrc);

const tot = {};
KEYS.forEach((k) => (tot[k] = []));
const files = walk(path.join(ROOT, SCAN_ROOT));
for (const f of files) {
  const r = scanText(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'), f.endsWith('.service.ts'), orgTables, chain.names);
  for (const k of KEYS) tot[k].push(...r[k]);
}
const nFiles = (a) => new Set(a.map((x) => x.split(':')[0])).size;
const blind = tot.BLIND1.length + tot.BLIND2.length + tot.BLIND3.length + tot.BLIND4.length;

console.log(`镜像扫描：${SCAN_ROOT} 下 ${files.length} 个 .ts｜org 表 ${orgTables.size} 张｜链事实表 ${chain.names.length} 张（unmapped ${chain.unmapped.length ? chain.unmapped.join(',') : '无'}）`);
console.log(`VISIBLE(门禁分母)=${tot.VISIBLE.length} 处 / ${nFiles(tot.VISIBLE)} 文件`);
console.log(`BLIND1(成员表达式 .from(schema.X))=${tot.BLIND1.length} 处 / ${nFiles(tot.BLIND1)} 文件`);
tot.BLIND1.forEach((x) => console.log(`  B1 ${x}`));
console.log(`BLIND2(动态表变量)=${tot.BLIND2.length} 处 / ${nFiles(tot.BLIND2)} 文件`);
tot.BLIND2.forEach((x) => console.log(`  B2 ${x}`));
console.log(`BLIND3(裸 SQL 读链事实表)=${tot.BLIND3.length} 处 / ${nFiles(tot.BLIND3)} 文件`);
tot.BLIND3.forEach((x) => console.log(`  B3 ${x}`));
console.log(`BLIND4(非 .service.ts 的 org 表链)=${tot.BLIND4.length} 处 / ${nFiles(tot.BLIND4)} 文件`);
tot.BLIND4.forEach((x) => console.log(`  B4 ${x}`));
console.log(`盲区合计=${blind} 处｜占可见面 ${(blind / Math.max(1, tot.VISIBLE.length) * 100).toFixed(1)}%`);

if (NO_GATE) {
  console.log('对账：--no-gate 跳过 ⇒ 本读数**未与门禁分母核对**，不得作为"GATE-13 暴露面"证据引用');
  process.exit(0);
}
const gate = gateChainCount();
if (gate === null) {
  console.log(`不可判：跑 ${GATE} 没读到「查询链 N 条」（未启动/输出形状变了）⇒ 不把"没对上"当成"对上了"`);
  process.exit(3);
}
const agree = gate === tot.VISIBLE.length;
console.log(`分母对账：镜像 VISIBLE=${tot.VISIBLE.length} ↔ 门禁自报「查询链 ${gate} 条」⇒ ${agree ? '一致（盲区计数可用）' : '不一致（镜像已落后于门禁判据，读数作废）'}`);
process.exit(agree ? 0 : 1);
