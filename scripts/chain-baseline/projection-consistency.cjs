#!/usr/bin/env node
'use strict';

/**
 * 只回答一个问题：链上每张**派生投影表**，"它和权威源一致"这句话有没有被**机械核过**——
 * 写入口在哪、失败后有没有补齐路径、有没有一条常驻用例在**同一个 it() 块里同时读了源和投影并比较**
 * （只断"投影里有这行"不算比较）。
 *
 * 为什么要有落点清单：`.codex/artifacts/projection-map.json` 里每一格都带 needle（所在行原文片段），
 * 本件按 needle 现定位（**不信行号**——行号会随他人改动漂移，V216 实测过），任一 needle 读不到或不唯一
 * 就把那一格判 `indeterminate` 并以非零退出，而不是"没找到就当没有"。这样"谁把那条对账断言删了"
 * 会当场红，而不是等到某次投影真的漂了才发现没人拦。
 *
 * 用法：
 *   node scripts/chain-baseline/projection-consistency.cjs --self-test     # 判据自测（条数自报）
 *   node scripts/chain-baseline/projection-consistency.cjs                 # 按清单复算当期读数
 *   node scripts/chain-baseline/projection-consistency.cjs --map <p> [--json <out>]
 *
 * 读数纪律：`two-sided` 只说明"同一个块里读了两边并比较"，不说明比较覆盖了全部派生字段；
 * `existence` 与 `none` 是**覆盖缺口**而不是缺陷证据；`indeterminate` 既不折成有也不折成无。
 * 分母来自清单（清单由 V222 逐条读码建立并留 basis 原文），不是全库表数——"哪些表算投影"
 * 是语义判断，本件不自行扩分母。只出读数，未接任何共享门禁。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const SELF = path.join(ROOT, 'scripts/chain-baseline/projection-consistency.cjs');
const DEFAULT_MAP = path.join(ROOT, '.codex/artifacts/projection-map.json');
const args = process.argv.slice(2);

/** 剥掉行注释与块注释：V223 实测过一条假阳性——BS-01 的**注释**里提到权威表名，
 *  于是块内"源与投影同现"成立、被误升成 two-sided。判据不能读注释，只读代码与 SQL。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/([^:'"])\/\/[^'\n]*$/gm, '$1 ');
}

/** 把 spec 切成 it()/test() 块（V170 的块级口径：块边界＝一个 `it(` 到下一个 `it(` 或文件尾）。 */
function itBlocks(text) {
  const re = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])/g;
  const starts = [];
  let m;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  return starts.map((s, i) => text.slice(s, i + 1 < starts.length ? starts[i + 1] : text.length));
}

/** needle 定位：恰好命中一次才算读到；0 次或多于一次 ⇒ null（不可判）。 */
function readAt(base, rel, needle) {
  const abs = path.join(base, rel);
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8');
  return src.split(needle).length - 1 === 1 ? src : null;
}

/** 表名存在性核对（V252 新增）。起因＝V251 手工把清单表名逐张对回真实树，抓到三处不 resolve
 *  （OUTBOX 登记的两个源表名在真实树里根本不存在、SHADOW_OBS 多写了一个 `ewoh_` 前缀）。
 *  这张清单是普查分母的来源，名字错了有两重代价：别人按名复核会以为"这张投影不存在"；
 *  而 two-sided 判据要求块内同现**登记的表名**，错名会让那一格永远升不上档（不是判错，是永远看不见）。
 *  三态：真值源读得到且找得到⇒计入；找得到建表处之外的一切「不 resolve」⇒该格进不可判；
 *  真值源本身读不到（自测夹具那种合成树）⇒整条核对记为 skipped，既不折成违规也不折成已核。 */
const TABLE_SHAPE = /^[a-z][a-z0-9_]*$/;
const truthCache = new Map();
function truthSource(base) {
  if (truthCache.has(base)) return truthCache.get(base);
  const sp = path.join(base, 'ewoh-spark-app', 'server', 'database', 'schema.ts');
  const dir = path.join(base, 'db', 'migrations');
  const schema = fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : '';
  const mig = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    : '';
  const v = schema || mig ? { schema, mig } : null;
  truthCache.set(base, v);
  return v;
}
function nameCheck(entry, base) {
  const legSources = (Array.isArray(entry.legs) ? entry.legs : []).flatMap((l) => l.sources || []);
  const shapes = [entry.table, ...(entry.sources || []), ...legSources].filter((n) => typeof n === 'string');
  const markers = shapes.filter((n) => !TABLE_SHAPE.test(n));
  const tbl = shapes.filter((n) => TABLE_SHAPE.test(n));
  const src = truthSource(base);
  if (!src) return { status: 'skipped', checked: tbl.length, markers: markers.length, missing: [] };
  const missing = tbl.filter((n) => !(src.schema.includes(`pgTable("${n}"`)
    || new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?${n}"?\\b`, 'i').test(src.mig)));
  return { status: 'checked', checked: tbl.length, markers: markers.length, missing };
}

/** 一格投影的机械复核。同一份逻辑既跑真清单也跑自测夹具（不留第二把尺子）。 */
function judgeEntry(entry, base) {
  const problems = [];
  let writersRead = 0;
  for (const w of entry.writers || []) {
    if (readAt(base, w.file, w.needle) === null) problems.push(`writer needle 读不到或不唯一：${w.file}`);
    else writersRead += 1;
  }
  if (!(entry.writers || []).length) problems.push('没有登记任何写入口（分母格不成立）');
  if (!entry.sources || !entry.sources.length) problems.push('没有登记权威源表（无从谈"一致"）');
  const names = nameCheck(entry, base);
  if (names.missing.length) problems.push(`表名在真实树里找不到建表处：${names.missing.join('、')}`);

  let repair = 'none';
  if (entry.repair) {
    if (readAt(base, entry.repair.file, entry.repair.needle) === null) {
      problems.push(`repair needle 读不到或不唯一：${entry.repair.file}`);
      repair = 'unverifiable';
    } else repair = 'present';
  }

  // 多腿登记（V275）：一张派生表常常有多个权威腿（通知表＝安灯／控制命令／数据质量三条腿），
  // 而"块内同现源与投影"这条配对判据原先只能按**格级单一 sources** 核 —— 把第二腿的表并进 sources
  // 会让第一腿凑不齐两边、整格从 two-sided 掉到 existence（V273/V274 两次实测）。
  // 现在每腿自带 sources，命中数按腿**求和**；一格只要任一腿有命中块就是 two-sided。
  let assertion = 'none';
  let blocksHit = 0;
  const legReport = [];
  const wantOf = (legSources) => (legSources ? [entry.table, ...legSources] : [entry.table, ...(entry.sources || [])]);
  const counted = new Set();
  /** 返回命中的**块身份**（文件＋块序），供主指针与多条腿共用同一集合去重。 */
  const countBlocks = (file, want) => {
    const abs = path.join(base, file);
    if (!fs.existsSync(abs)) { problems.push(`断言文件不存在：${file}`); return null; }
    const src = fs.readFileSync(abs, 'utf8');
    return itBlocks(src).map(stripComments)
      .map((b, i) => ({ b, key: `${file}:${i}` }))
      .filter(({ b }) => want.every((x) => b.includes(x)) && /expect\(/.test(b))
      .map(({ key }) => key);
  };
  if (entry.assertion) {
    const hit = countBlocks(entry.assertion.spec, wantOf());
    if (hit) {
      hit.forEach((k) => counted.add(k));
      assertion = hit.length ? 'two-sided' : 'existence';
      if (entry.assertion.needle && readAt(base, entry.assertion.spec, entry.assertion.needle) === null) {
        problems.push(`断言标题 needle 读不到或不唯一：${entry.assertion.spec}`);
      }
    }
  }
  for (const leg of (Array.isArray(entry.legs) ? entry.legs : [])) {
    if (!leg || !leg.spec || !leg.needle) {
      problems.push(`腿登记不完整（要 spec＋needle）：${(leg && (leg.name || leg.spec)) || '?'}`);
      continue;
    }
    if (readAt(base, leg.spec, leg.needle) === null) {
      problems.push(`腿 needle 读不到或不唯一：${leg.spec}`);
      legReport.push(`${leg.name || leg.spec}=unreadable`);
      continue;
    }
    if (!(leg.sources || []).length) { problems.push(`腿 ${leg.name || leg.spec} 没登记自己的源表 ⇒ 无从配对，不计`); continue; }
    const hit = countBlocks(leg.spec, wantOf(leg.sources));
    if (!hit) continue;
    hit.forEach((k) => counted.add(k));
    legReport.push(`${leg.name || leg.spec}=${hit.length}`);
    if (hit.length === 0) problems.push(`腿 ${leg.name || leg.spec} 块内没配齐「投影表＋该腿源表」⇒ 该腿不计`);
  }
  blocksHit = counted.size;
  if (blocksHit > 0) assertion = 'two-sided';
  return {
    id: entry.id, table: entry.table, sources: entry.sources || [],
    writersRead, writersTotal: (entry.writers || []).length, repair, assertion, blocksHit, names, problems,
    legs: legReport,
  };
}

function run(mapPath) {
  if (!fs.existsSync(mapPath)) {
    console.error(`落点清单不存在：${path.relative(ROOT, mapPath)}（没有清单就不出数，不从别处猜分母）`);
    process.exit(2);
  }
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const entries = map.projections || [];
  if (!entries.length) {
    console.error('分母为 0：清单是空的，不能读成"没有投影"');
    process.exit(2);
  }
  const rows = entries.map((e) => judgeEntry(e, ROOT));
  const bad = rows.filter((r) => r.problems.length);
  const ok = rows.filter((r) => !r.problems.length);
  if (ok.length + bad.length !== entries.length) {
    console.error('读数作废：加总不等于分母');
    process.exit(2);
  }
  console.log(`[projection] 分母（清单登记的投影格）= ${entries.length}｜Σ＝${ok.length + bad.length}｜清单来源 ${path.relative(ROOT, mapPath)}`);
  const combo = {};
  for (const r of ok) {
    const k = `对账断言 ${r.assertion}｜补齐 ${r.repair}`;
    combo[k] = (combo[k] || 0) + 1;
  }
  console.log('覆盖组合：');
  for (const [k, v] of Object.entries(combo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  for (const r of ok) console.log(`  · ${r.id} ${r.table}｜源 ${r.sources.join(',')}｜写入口 ${r.writersRead}/${r.writersTotal}｜补齐 ${r.repair}｜对账 ${r.assertion}${r.assertion === 'two-sided' ? `（命中块 ${r.blocksHit}）` : ''}${(r.legs && r.legs.length) ? `｜腿 ${r.legs.length}（${r.legs.join('，')}）` : ''}`);
  for (const r of bad) console.log(`  ！ ${r.id} ${r.table}｜不可判：${r.problems.join('；')}`);
  console.log(`四格分开报数：两边比较 ${ok.filter((r) => r.assertion === 'two-sided').length}`
    + `｜只断存在（或块里根本没比较）${ok.filter((r) => r.assertion === 'existence').length}`
    + `｜无对账用例 ${ok.filter((r) => r.assertion === 'none').length}`
    + `｜不可判 ${bad.length}`);
  console.log(`补齐路径：有 ${ok.filter((r) => r.repair === 'present').length}／登记为无 ${ok.filter((r) => r.repair === 'none').length}／不可判 ${ok.filter((r) => r.repair === 'unverifiable').length}`);
  const nm = { checked: 0, markers: 0, missing: [], skipped: 0 };
  for (const r of rows) {
    if (!r.names) continue;
    nm.checked += r.names.checked;
    nm.markers += r.names.markers;
    if (r.names.status === 'skipped') nm.skipped += 1;
    nm.missing.push(...r.names.missing);
  }
  console.log(`表名核对：形状 ${nm.checked + nm.markers} 个（按表名判 ${nm.checked}／源侧标记跳过 ${nm.markers}）`
    + `｜在真实树找不到建表处 ${nm.missing.length}${nm.missing.length ? `：${Array.from(new Set(nm.missing)).join('、')}` : '（无）'}`
    + `${nm.skipped ? `｜真值源不可读而整条跳过的格 ${nm.skipped}（不折成违规也不折成已核）` : ''}`);
  const jp = args.indexOf('--json');
  if (jp >= 0 && args[jp + 1]) fs.writeFileSync(path.resolve(args[jp + 1]), JSON.stringify({ den: entries.length, rows }, null, 2) + '\n');
  if (bad.length) {
    console.error(`落点清单与当前树不同步（${bad.length} 格不可判）`);
    process.exit(2);
  }
  console.log('说明：two-sided 只证明"同一个块里读了两边并比较"，不证明比较覆盖全部派生字段。');
}

// ---------------------------------------------------------------- 判据自测
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projc-'));
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok });
  const wr = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  wr('svc.ts', 'x\n');
  wr('spec.ts', `
describe('投影一致性', () => {
  it('比较两边', async () => {
    const a = await db\`select * from ewoh_world_state_snapshot\`;
    const b = await db\`select * from ewoh_assignment\`;
    expect(a[0].status).toBe(b[0].status);
  });
  it('只断投影存在', async () => {
    const rows = await db\`select * from ewoh_outbox\`;
    expect(rows.length).toBe(1);
  });
  it('跨块各出现一次', async () => {
    const a = await db\`select * from ewoh_outbox\`;
    expect(a.length).toBe(1);
  });
});
`);
  const j = (e) => judgeEntry(e, dir);
  const base = { sources: ['ewoh_assignment'], writers: [{ file: 'svc.ts', needle: 'x' }] };
  wr('comment-only.ts', `
describe('注释陷阱', () => {
  it('只有注释提到源', async () => {
    // 这里说 ewoh_assignment 与 ewoh_control_backlog_snapshot 都出现过，但那是注释
    const rows = await db\`select * from ewoh_control_backlog_snapshot\`;
    expect(rows.length).toBe(1);
  });
});
`);

  let r = j({ ...base, id: 'P1', table: 'ewoh_world_state_snapshot', assertion: { spec: 'spec.ts', needle: "it('比较两边'" } });
  t('正对照 1：同一个 it() 块里出现源＋投影且有 expect ⇒ two-sided', r.assertion === 'two-sided' && !r.problems.length);

  r = j({ ...base, id: 'P2', table: 'ewoh_outbox', assertion: { spec: 'spec.ts' } });
  t('反对照 2：三个块里只有"投影＋源分别出现"，没有一个块同时出现两边 ⇒ 不得判 two-sided'
    + '（块级切分不互相污染；"投影里有这行"不是一致性对账）', r.assertion === 'existence');

  r = j({ ...base, id: 'P4', table: 'ewoh_outbox', sources: [], writers: [{ file: 'nope.ts', needle: 'absent' }] });
  t('反对照 3：writer needle 读不到 ⇒ 只能进不可判（既不折成"没有写入口"也不折成"已核"）',
    r.problems.some((x) => /writer needle/.test(x)) && r.problems.some((x) => /没有登记权威源表/.test(x)));

  t('反对照 9：只在**注释**里同时提到投影与源表 ⇒ 不得判 two-sided（V223 实测到的假阳性形状）',
    j({ ...base, id: 'P9', table: 'ewoh_control_backlog_snapshot', assertion: { spec: 'comment-only.ts' } }).assertion === 'existence');

  r = j({ ...base, id: 'P5', table: 'ewoh_outbox', repair: { file: 'nope.ts', needle: 'absent' } });
  t('反对照 4：补齐路径 needle 读不到 ⇒ 不可判（"登记说有修复"这句话必须能被复算）',
    r.problems.some((x) => /repair needle/.test(x)));

  r = j({ id: 'P6', table: 'ewoh_outbox', sources: ['ewoh_assignment'], writers: [] });
  t('反对照 5：一格没登记任何写入口 ⇒ 不可判，不静默算已核', r.problems.some((x) => /没有登记任何写入口/.test(x)));

  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ projections: [] }));
  const rr = spawnSync(process.execPath, [SELF, '--map', empty], { encoding: 'utf8' });
  t('反对照 6：清单为空 ⇒ 必须非零退出且不许打"没有投影"（静默为空与干净同形的那一形）',
    rr.status !== 0 && /分母为 0/.test(`${rr.stdout}${rr.stderr}`));

  // V252：表名存在性核对的四条控制（合规不红／错名必须红／标记串不误判／真值源缺失只能记 skipped）
  const d2 = path.join(dir, 'truth');
  wr('truth/svc.ts', 'x\n');
  wr('truth/ewoh-spark-app/server/database/schema.ts', 'pgTable("ewoh_assignment", {})\npgTable("ewoh_outbox", {})\n');
  wr('truth/db/migrations/001.sql', 'CREATE TABLE IF NOT EXISTS ewoh_outbox (id int);\n');
  const j2 = (e) => judgeEntry(e, d2);
  r = j2({ id: 'N1', table: 'ewoh_outbox', sources: ['ewoh_assignment'], writers: [{ file: 'svc.ts', needle: 'x' }] });
  t('正对照 8：表名都能在真实树找到建表处 ⇒ 表名判据不得开火（合规侧对照）',
    r.names.status === 'checked' && r.names.missing.length === 0 && !r.problems.some((x) => /表名/.test(x)));
  r = j2({ id: 'N2', table: 'ewoh_outbox', sources: ['ewoh_schedulpln_typo'], writers: [{ file: 'svc.ts', needle: 'x' }] });
  t('反对照 10：源表名拼错或不存在 ⇒ 必须进不可判并报「找不到建表处」（V251 手工抓到的两处正是这个形状）',
    r.problems.some((x) => /表名在真实树里找不到建表处/.test(x)) && r.names.missing.includes('ewoh_schedulpln_typo'));
  r = j2({ id: 'N3', table: 'ewoh_outbox', sources: ['live[taskKey()]'], writers: [{ file: 'svc.ts', needle: 'x' }] });
  t('反对照 11：源侧是标记串（`live[taskKey()]`）而不是表名 ⇒ 必须跳过，不得误判成不 resolve',
    r.names.markers === 1 && r.names.missing.length === 0 && !r.problems.some((x) => /表名/.test(x)));
  r = j({ id: 'N4', table: 'ewoh_outbox', sources: ['ewoh_assignment'], writers: [{ file: 'svc.ts', needle: 'x' }] });
  t('反对照 12：真值源读不到的合成树 ⇒ 整条核对记 skipped，既不折成违规也不折成已核',
    r.names.status === 'skipped' && !r.problems.some((x) => /表名/.test(x)));

  // ── V275：多腿登记（一格多个权威腿）的三条控制 ──────────────────────────
  wr('legs.ts', `
describe('多腿', () => {
  it('安灯腿等式', async () => {
    const n = await db\`select * from ewoh_notification\`;
    const e = await db\`select * from ewoh_event\`;
    expect(n.length).toBe(e.length);
  });
  it('控制命令腿等式', async () => {
    const n = await db\`select * from ewoh_notification\`;
    const c = await db\`select * from ewoh_control_command\`;
    expect(n.length).toBe(c.length);
  });
  it('只读投影不读源', async () => {
    const n = await db\`select * from ewoh_notification\`;
    expect(n.length).toBe(1);
  });
});
`);
  const twoLegs = {
    id: 'L1', table: 'ewoh_notification', sources: ['ewoh_event'],
    writers: [{ file: 'svc.ts', needle: 'x' }],
    assertion: { spec: 'legs.ts', needle: "it('安灯腿等式'" },
    legs: [
      { name: '安灯腿', spec: 'legs.ts', needle: "it('安灯腿等式'", sources: ['ewoh_event'] },
      { name: '命令腿', spec: 'legs.ts', needle: "it('控制命令腿等式'", sources: ['ewoh_control_command'] },
    ],
  };
  r = j(twoLegs);
  t('正对照 13：两条腿各自在同一块里配「投影表＋该腿源表」⇒ 两条都计、且主指针与安灯腿同一块不得翻倍',
    r.assertion === 'two-sided' && r.blocksHit === 2 && !r.problems.length
    && r.legs.length === 2 && r.legs.every((x) => /=1$/.test(x)) && r.legs.some((x) => /^安灯腿=/.test(x)));

  r = j({ ...twoLegs,
    legs: [twoLegs.legs[0], { ...twoLegs.legs[1], sources: ['ewoh_typo_not_a_table'] }] });
  t('反对照 14：某腿的源表在该块里没出现 ⇒ 只报该腿"没配齐"、另一腿照计（不整格降档，也不静默放过）',
    r.blocksHit === 1 && r.problems.some((x) => /命令腿 块内没配齐/.test(x))
    && !r.problems.some((x) => /安灯腿/.test(x)) && r.assertion === 'two-sided');

  r = j({ ...twoLegs, legs: [{ name: '缺源表腿', spec: 'legs.ts', needle: "it('安灯腿等式'" }] });
  t('反对照 15：腿登记不完整（没写自己的源表）⇒ 必须报，不得当成"该腿已核"',
    r.problems.some((x) => /没登记自己的源表/.test(x)) && r.blocksHit === 1);

  r = j({ ...twoLegs, legs: [{ name: '针错腿', spec: 'legs.ts', needle: "it('不存在的那条腿'", sources: ['ewoh_event'] }] });
  t('反对照 16：腿 needle 读不到或不唯一 ⇒ 整格进不可判并报出（清单与树不同步不许静默）',
    r.problems.some((x) => /腿 needle 读不到或不唯一/.test(x)) && r.blocksHit === 1);

  const bad = cases.filter((x) => !x.ok);
  for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`判据自测 ${cases.length - bad.length}/${cases.length} 通过`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(bad.length ? 1 : 0);
}

if (args.includes('--self-test')) selfTest();
const mp = args.indexOf('--map');
run(mp >= 0 && args[mp + 1] ? path.resolve(args[mp + 1]) : DEFAULT_MAP);
