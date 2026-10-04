#!/usr/bin/env node
/**
 * 约束「持久面 ↔ 解码器 ↔ 求解器守卫」三面对账探针（V363）。
 *
 * 这把尺只回答一个问题：**库里的一行约束，走生产解码器之后，还剩下什么能让求解器认它？**
 * 三面的词表都不手抄：
 *   ① 解码器认哪些 value_json 键 —— 现取 constraint-loader.service.ts 的 rowToConstraint；
 *   ② 求解器每个 case 需要哪些字段非空 —— 现取 heuristic-scheduling-solver.ts 的 switch(c.type)；
 *   ③ 两个生产写入口往 value_json 里放哪些键 —— 现取 plan.service.ts / scheduler-plan-application.service.ts。
 * 判决三态：可满足 / 不可满足（=inert：守卫当场短路，既不生效也不记 violation）/ 该类型无 case（无声跳过）。
 * 取不到库、解析不到源码一律判**不可判**（rc=3），绝不折成「没有 inert 行」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/Volumes/Extra/CodeProj/EWOH';
const APP = path.join(ROOT, 'ewoh-spark-app');
const LOADER = path.join(APP, 'server/modules/scheduler/constraint-loader.service.ts');
const HEUR = path.join(APP, 'server/modules/scheduler/heuristic-scheduling-solver.ts');
const WRITERS = [
  path.join(APP, 'server/modules/scheduler/plan.service.ts'),
  path.join(APP, 'server/modules/scheduler/scheduler-plan-application.service.ts'),
];

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

/** ① 解码器：rowToConstraint 函数体里 `v.<key> as` 的全部键名（切片按结构边界，不按行窗口）。 */
function decoderKeys(src) {
  const start = src.indexOf('private rowToConstraint');
  if (start < 0) return null;
  const rest = src.slice(start);
  const endMarkers = ['\n  /** 稳定序列化', '\n  private hash'];
  let end = rest.length;
  for (const m of endMarkers) {
    const i = rest.indexOf(m);
    if (i > 0 && i < end) end = i;
  }
  const body = rest.slice(0, end);
  if (!body.includes('return {')) return null;
  const keys = [...new Set([...body.matchAll(/\bv\.([A-Za-z][A-Za-z0-9]*)\s+as\b/g)].map((m) => m[1]))];
  return { keys, readsValue: /\bv\.value\b/.test(body), body };
}

/** ② 求解器：每个 case 有哪些**可选分支守卫**（每个守卫需要哪些 c.<字段> 非空）。
 *    EXCLUDED_RESOURCE／PREFERRED_RESOURCE 这类一个 case 里三条腿各一个 if ⇒ 只要任一条腿能点着，
 *    这行约束就不是 inert；把整块里出现的 c.* 全并要求会误判（自测第 8 支正是抓这个）。 */
function solverGuards(src) {
  const anchor = src.indexOf('switch (c.type) {');
  if (anchor < 0) return null;
  const dflt = src.indexOf('default:', anchor);
  if (dflt < 0) return null;
  const sw = src.slice(anchor, dflt);
  const out = {};
  for (const m of sw.matchAll(/case '([A-Z_]+)':\s*([\s\S]*?)(?=\n\s*case '|\n\s*default:|$)/g)) {
    const block = m[2];
    const preds = [...block.matchAll(/if \(([^)]{0,200})\)/g)].map((x) => {
      const cond = x[1].trim();
      const need = [...new Set([...cond.matchAll(/\bc\.([A-Za-z][A-Za-z0-9]*)/g)].map((y) => y[1]))];
      return { cond, need };
    });
    out[m[1]] = preds.length ? preds : [{ cond: '(无守卫，进 case 即生效)', need: [] }];
  }
  return Object.keys(out).length ? out : null;
}

/** ③ 写入口：两个 valueJson 字面量里写出的键。 */
function writerKeys(files) {
  const all = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/valueJson:\s*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/([A-Za-z][A-Za-z0-9]*):\s/g)) all.push(k[1]);
    }
  }
  return [...new Set(all)];
}

/** 分类：一行约束在给定三面词表下会落到哪一档。decKeys 可注入（自测的反向对照要用掏空版）。
 *  一个 case 里多条腿 ⇒ 任一条腿的守卫可点着即判「可满足」；全点不着才判 inert，并报每条腿缺什么。
 *  V366：`value` 不再特殊处理——解码名册含它（`v.value as`）时它与其他字段同一条规则。
 *  旧写法（`n === 'value' ? !readsValue`）是为"解码器不读 value"那一版判的，
 *  修复后会反过来把「没写 value 的行」误读成可满足 ⇒ 一律按 survived 里有没有值判。 */
function classify(row, decKeys, guards) {
  const vk = Object.keys(row.value_json || {});
  const survived = {};
  for (const k of decKeys) if (vk.includes(k)) survived[k] = row.value_json[k];
  // taskId 来自真实列而不是 value_json
  const c = { ...survived, taskId: row.task_id ?? undefined };
  const preds = guards[row.type];
  if (!preds) return { verdict: '该类型无 case（无声跳过）', survived: Object.keys(survived), written: vk, legs: [] };
  const legs = preds.map((p) => ({
    cond: p.cond,
    missing: p.need.filter((n) => c[n] === undefined || c[n] === null || c[n] === ''),
  }));
  const fireable = legs.filter((l) => l.missing.length === 0);
  return {
    verdict: fireable.length ? '可满足' : '不可满足（inert）',
    legs,
    survived: Object.keys(survived),
    written: vk,
  };
}

function selfTest() {
  const cases = [];
  const dec = decoderKeys(read(LOADER));
  const gu = solverGuards(read(HEUR));
  const wr = writerKeys(WRITERS);
  cases.push({
    name: '分母自证 1：三面的词表都解析到了（解码器键／求解 case／写入口键都非空）',
    ok: dec && dec.keys.length > 0 && gu && Object.keys(gu).length > 0 && wr.length > 0,
  });
  cases.push({
    name: '分母自证 2：写入口与解码器都各自有名册，且不把写入口当成解码器（两个集合分开报）',
    ok: wr.length >= 6 && dec.keys.length >= 6,
  });
  // 正向对照：camelCase 齐全的行不得被判 inert
  const okRow = { constraint_id: 'X-OK', type: 'LOCKED_PERSON', task_id: 'T1', value_json: { personId: 'P1' } };
  cases.push({
    name: '正向对照：camelCase 齐全的 LOCKED_PERSON 行 ⇒ 判「可满足」（这把尺不能见谁都报 inert）',
    ok: classify(okRow, dec.keys, gu).verdict === '可满足',
  });
  // 开火 1：种子形状（snake_case）
  const seedRow = { constraint_id: 'CONST-TASK128-LOCK', type: 'LOCKED_PERSON', task_id: 'TASK-128', value_json: { person_id: 'P008' } };
  cases.push({
    name: '开火 1：种子那行的键形（person_id）经解码器读出空字段 ⇒ 必须判不可满足（inert）',
    ok: classify(seedRow, dec.keys, gu).verdict === '不可满足（inert）',
  });
  // 开火 2（V366 反转极性）：解码面含 value ⇒ 写了 value 的 MIN_BATTERY 行应判可满足；
  // 它的对偶臂把 readsValue 关掉，同一行必须翻回 inert——否则这条判据就成了恒真读数。
  const valRow = { constraint_id: 'CONST-V', type: 'MIN_BATTERY', task_id: null, value_json: { value: 30 } };
  const v = classify(valRow, dec.keys, gu);
  cases.push({
    name: '开火 2：value_json 写了 value 的 MIN_BATTERY 行判可满足，且名册两面都含 value（解码器读、写入口写）',
    ok: v.verdict === '可满足' && dec.keys.includes('value') && wr.includes('value'),
  });
  const vOff = classify(valRow, dec.keys.filter((k) => k !== 'value'), gu);
  cases.push({
    name: '开火 2 的对偶臂：把 value 从解码面摘掉，同一行必须翻回不可满足（可满足不是硬编码）',
    ok: vOff.verdict === '不可满足（inert）' && vOff.legs.some((l) => l.missing.includes('value')),
  });
  // 反向对照：把解码器键表掏空 ⇒ 全部行翻成 inert（证明判决真的走解码面，不是硬编码名单）
  const emptied = classify(okRow, [], gu);
  cases.push({
    name: '反向对照：把解码器键表掏空后，同一行必须从「可满足」翻成不可满足（掏空即失效才算判据在动）',
    ok: emptied.verdict === '不可满足（inert）',
  });
  // 三条腿的 case：任一条腿点得着就不算 inert（第一版把整块 c.* 全并要求，在这里判错过）
  const legRow = { constraint_id: 'CONST-LEG', type: 'EXCLUDED_RESOURCE', task_id: 'T1', value_json: { stationId: 'S1' } };
  const legEmpty = { constraint_id: 'CONST-LEG0', type: 'EXCLUDED_RESOURCE', task_id: 'T1', value_json: {} };
  cases.push({
    name: '分支极性：EXCLUDED_RESOURCE 只带 stationId ⇒ 判可满足（三条腿点着一条即生效，不许全并要求）',
    ok: classify(legRow, dec.keys, gu).verdict === '可满足',
  });
  cases.push({
    name: '分支极性的对偶：同一类型三条腿都点不着（空 value_json）⇒ 必须判 inert（不许因『有 case』就放行）',
    ok: classify(legEmpty, dec.keys, gu).verdict === '不可满足（inert）',
  });
  // 无 case 的类型单独一档，不折进 inert
  const softRow = { constraint_id: 'CONST-S', type: 'PREFERRED_RESOURCE', task_id: 'T1', value_json: { personId: 'P1' } };
  const softRow2 = { constraint_id: 'CONST-U', type: 'RESOURCE_TIME_WINDOW', task_id: 'T1', value_json: { startMs: 1, endMs: 2 } };
  cases.push({
    name: '档位边界：switch 里没有 case 的类型（RESOURCE_TIME_WINDOW）判「该类型无 case」，不折成 inert 也不折成可满足',
    ok: classify(softRow2, dec.keys, gu).verdict === '该类型无 case（无声跳过）',
  });
  cases.push({
    name: '档位边界：有 case 且字段齐全的软类型（PREFERRED_RESOURCE）判可满足',
    ok: classify(softRow, dec.keys, gu).verdict === '可满足',
  });
  // 每条被检查的行都必须落三态之一
  const states = new Set(['可满足', '不可满足（inert）', '该类型无 case（无声跳过）']);
  cases.push({
    name: '分母自证 3：判决值域封闭（三态之一，别造出第四态或空判决）',
    ok: [okRow, seedRow, valRow, softRow, softRow2].every((r) => states.has(classify(r, dec.keys, gu).verdict)),
  });
  const bad = cases.filter((x) => !x.ok);
  console.log(`三面词表现取：解码器 ${dec.keys.length} 键 [${dec.keys.join(',')}]`);
  console.log(`              求解 case ${Object.keys(gu).length} 个，写入口键 ${wr.length} 个 [${wr.join(',')}]`);
  console.log(`              解码器读 value 吗：${dec.readsValue ? '读' : '不读'}`);
  for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`判据自测 ${cases.length - bad.length}/${cases.length} 通过`);
  process.exit(bad.length ? 1 : 0);
}

async function main() {
  const url = process.env.EWOH_PG_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('缺少 EWOH_PG_URL（owner 连接串，source tmp/chain-baseline/env.sh）⇒ 不可判，退出 3');
    process.exit(3);
  }
  const dec = decoderKeys(read(LOADER));
  const gu = solverGuards(read(HEUR));
  if (!dec || !gu) {
    console.error('三面词表解析失败 ⇒ 不可判（绝不把读不到折成「无 inert 行」）');
    process.exit(3);
  }
  const postgres = require(path.join(APP, 'node_modules/postgres'));
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let rows;
  try {
    rows = await sql`select constraint_id, type, task_id, value_json from public.ewoh_scheduling_constraint order by constraint_id`;
  } catch (e) {
    console.error(`读库失败：${e.message} ⇒ 不可判`);
    await sql.end().catch(() => {});
    process.exit(3);
  }
  console.log(`约束行 ${rows.length} 条｜解码器键 ${dec.keys.length} 个｜求解 case ${Object.keys(gu).length} 个`);
  const tally = { '可满足': 0, '不可满足（inert）': 0, '该类型无 case（无声跳过）': 0 };
  for (const r of rows) {
    const x = classify(r, dec.keys, gu);
    tally[x.verdict] = (tally[x.verdict] || 0) + 1;
    console.log(`  ${r.constraint_id} ${r.type}：${x.verdict}` +
      (x.verdict === '不可满足（inert）'
        ? `｜写侧键 [${x.written.join(',') || '无'}]｜解码剩余 [${x.survived.join(',') || '无'}]｜各腿所缺 ${x.legs.map((l) => `[${l.cond} → 缺 ${l.missing.join('&') || '无'}]`).join(' ')}`
        : ''));
  }
  const sum = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`分母闭合：${sum}=${rows.length}（每行只归一态）`);
  console.log(`读数：可满足 ${tally['可满足']}｜inert ${tally['不可满足（inert）']}｜无 case ${tally['该类型无 case（无声跳过）']}`);
  await sql.end();
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();
else main();
