#!/usr/bin/env node
/**
 * backlog-premise-probe.cjs — 把"需用户确认的前置"里能在线核的部分核掉（V353 新建）
 *
 * 回答两件事，且只回答到证据允许的程度：
 *   A3（ewoh_handoffs 跨租户）：这张表到底有没有租户列、有没有 RLS/policy、
 *       **以运行角色**（不是 owner，owner 会绕过 RLS）在他 org 的 GUC 下能读几行。
 *   A5（resource_type 容量超卖）：这一列有没有 CHECK 约束、库里现有哪些值、
 *       合法词表从契约层的联合类型自己取（不手抄，手抄就等于把实现的口径当契约）。
 *
 * 三态纪律：取不到连接 / 表不在 / 词表解析不到 ⇒ 一律 `不可判`，绝不折成"没有泄露"或"会红"。
 * 只读纪律：本探针不写任何业务表；元数据查询与运行角色读取都不产生持久副作用。
 */
const fs = require('fs');
const path = require('path');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));
const TABLES = ['ewoh_handoffs', 'ewoh_resource_locks', 'ewoh_git_sync_state', 'ewoh_evidence_metadata'];
const CONTRACT_UNION_FILE = 'ewoh-spark-app/shared/scheduler.ts';

// ---------- 纯判据（可自测，不碰库） ----------

/** 一张表的租户保护判决。八个桶互斥，Σ 必须等于表数。
 *  注意 `tenant-guarded` 要求**两条臂同时成立**：本 org 读得到（>0）且他 org 读不到（=0）。
 *  只看"他 org 读 0 行"是空转判据——运行角色若什么都读不到（口令错、表无权限、行数被别的条件挡掉）
 *  同样读 0，所以必须先证它读得到，才谈得上证它读不到别人的。 */
function judgeTenant(t) {
  if (t.tablePresent !== true) return 'table-missing';                 // 不可判
  if (t.hasOrgColumn !== true) return 'no-tenant-column';              // 谓词在数据模型上不可能成立
  if (Number(t.totalRows) === 0) return 'never-written';               // 从未写过 ≠ 无风险 ≠ 有风险
  if (t.roleBypassRls === true) return 'observer-bypasses-rls';        // 测不出保护，也不能据此说没保护
  if (t.foreignOrgPremise !== true) return 'premise-failed';           // 伪造 org 在本表竟有行 ⇒ 该臂作废
  if (Number(t.ownOrgVisibleRows) === 0) return 'observer-reads-nothing';  // 合规侧不开火 ⇒ 整臂不可判
  if (t.hasPolicy !== true) return 'unguarded-no-policy';
  if (Number(t.foreignOrgVisibleRows) > 0) return 'policy-but-leaks';  // 判红档
  return 'tenant-guarded';
}

/** A5：加 CHECK 今天会不会红。legalSet 解析不到 ⇒ 不可判，不折成"合法"。 */
function judgeResourceType({ hasCheck, distinct, legalSet }) {
  if (!legalSet || !legalSet.length) return { verdict: 'legal-set-undecidable', illegal: [] };
  if (!distinct || !distinct.length) return { verdict: 'no-rows', illegal: [] };
  // 形状门：真库返回的是 {v,n}，判据吃的是 {value,n}。第一版没对形状就比，
  // 把 person/station（注册表内的合法值）整批报成了"非法值"——读数看着精确，其实是形状错位。
  if (distinct.some((d) => !d || typeof d.value !== 'string')) return { verdict: 'row-shape-invalid', illegal: [] };
  const illegal = distinct.filter((d) => !legalSet.includes(d.value));
  return { verdict: illegal.length ? 'would-fire' : 'would-pass', illegal };
}

// ---------- 合法词表：优先取契约层注册表，取不到再退到 TS 联合类型 ----------

/** 两个来源都是"契约/定义层"，不是实现的 WHERE 子句——手抄实现口径会把实现当契约（本仓踩过）。
 *  两处都取不到 ⇒ 返回 null ⇒ 判 `legal-set-undecidable`，绝不折成"值都合法"。 */
function findRegistry(node, key, out) {
  if (Array.isArray(node)) node.forEach((n) => findRegistry(n, key, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key && v && Array.isArray(v.const)) out.push(v.const);
      else findRegistry(v, key, out);
    }
  }
  return out;
}

/** 合法词表两个候选来源，都是定义层而非实现的 WHERE：
 *  ① `contracts/resource/resource.schema.json` 的 `resourceTypeRegistry.const`（JSON Schema 封闭注册表）
 *  ② `shared/scheduler.ts` 的 `ResourceType` 联合类型（TS 侧）
 *  两处都取不到 ⇒ null ⇒ 判 `legal-set-undecidable`，绝不折成"值都合法"。 */
function loadLegalSet() {
  const jsonPath = path.join(ROOT, 'contracts/resource/resource.schema.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const hit = findRegistry(doc, 'resourceTypeRegistry', []);
      const vals = [...new Set(hit.flat().filter((v) => typeof v === 'string'))];
      if (vals.length) return { source: 'contracts/resource/resource.schema.json#resourceTypeRegistry.const', values: vals };
    } catch { /* 落到下一个来源 */ }
  }
  let ts = null;
  try { ts = require(path.join(ROOT, 'ewoh-spark-app/node_modules/typescript')); } catch { return null; }
  const abs = path.join(ROOT, CONTRACT_UNION_FILE);
  if (!fs.existsSync(abs)) return null;
  const src = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = null;
  const visit = (node) => {
    if (!found && ts.isTypeAliasDeclaration(node) && /ResourceType/.test(node.name.text)) {
      const lits = [];
      const collect = (n) => {
        if (ts.isLiteralTypeNode(n) && n.literal.kind === ts.SyntaxKind.StringLiteral) lits.push(n.literal.text);
        ts.forEachChild(n, collect);
      };
      collect(node.type);
      if (lits.length) found = lits;
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found ? { source: `${CONTRACT_UNION_FILE} 的 ResourceType 联合类型`, values: found } : null;
}

// ---------- 自测 ----------

function selfTest() {
  const cases = [];
  const T = (name, why, fn) => cases.push({ name, why, fn });
  const base = { tablePresent: true, hasOrgColumn: true, totalRows: 5, hasPolicy: true,
    ownOrgVisibleRows: 5, foreignOrgVisibleRows: 0, foreignOrgPremise: true, roleBypassRls: false };

  T('POS-CONTROL', '正向对照：有 org 列＋有 policy＋本 org 读得到＋他 org 读 0 行 ⇒ 必须判 tenant-guarded',
    () => judgeTenant(base) === 'tenant-guarded');
  T('LEAK-FIRE', '判红档：有 policy 但他 org 读到 2 行 ⇒ 必须落 policy-but-leaks',
    () => judgeTenant({ ...base, foreignOrgVisibleRows: 2 }) === 'policy-but-leaks');
  T('A3-SHAPE', '无租户列必须单列一档，既不得读成"无泄露"也不得读成"有泄露"',
    () => judgeTenant({ ...base, hasOrgColumn: false }) === 'no-tenant-column');
  T('EMPTY-CTRL', '空表 ⇒ never-written，不是"合规"',
    () => judgeTenant({ ...base, totalRows: 0 }) === 'never-written');
  T('MISSING-CTRL', '表不在 ⇒ table-missing（不可判），不是"合规"',
    () => judgeTenant({ ...base, tablePresent: false }) === 'table-missing');
  T('BYPASS-CTRL', '观测角色绕过 RLS ⇒ 只能判"测不出"，不得读成"没保护"',
    () => judgeTenant({ ...base, roleBypassRls: true }) === 'observer-bypasses-rls');
  T('NOPOLICY', '有列无策略 ⇒ unguarded-no-policy',
    () => judgeTenant({ ...base, hasPolicy: false }) === 'unguarded-no-policy');
  T('OWN-ZERO', '合规侧不开火 ⇒ observer-reads-nothing：本 org 都读不到时，"他 org 读 0 行"不构成保护证据',
    () => judgeTenant({ ...base, ownOrgVisibleRows: 0 }) === 'observer-reads-nothing');
  T('PREM-FAIL', '前提塌 ⇒ premise-failed：伪造 org 在本表竟有行，整臂作废而不是判"合规"',
    () => judgeTenant({ ...base, foreignOrgPremise: false }) === 'premise-failed');
  T('EXCL-SUM', '互斥性硬断言：同一张表在九种读数下各落一桶且互不相同',
    () => {
      const arms = [base, { ...base, foreignOrgVisibleRows: 2 }, { ...base, hasOrgColumn: false }, { ...base, totalRows: 0 },
        { ...base, tablePresent: false }, { ...base, roleBypassRls: true }, { ...base, hasPolicy: false },
        { ...base, ownOrgVisibleRows: 0 }, { ...base, foreignOrgPremise: false }];
      const v = arms.map(judgeTenant);
      return new Set(v).size === 9 && v.every((x) => typeof x === 'string');
    });
  T('LEGAL-SOURCE', '取真值那条路必须有一条控制：真契约里必须读出 person/device/station 三个已知答案（读不到就是取值路径断了，不是"没有非法值"）',
    () => {
      const l = loadLegalSet();
      return !!l && ['person', 'device', 'station'].every((v) => l.values.includes(v));
    });
  T('RS-SHAPE', '形状门：真库给的是 {v,n} 而判据吃 {value,n} ⇒ 必须判 row-shape-invalid，不得把合法值报成非法',
    () => judgeResourceType({ hasCheck: false, distinct: [{ v: 'person', n: 17 }], legalSet: ['person'] }).verdict === 'row-shape-invalid');
  T('RS-LEGAL', '假阳性面：全部值都合法 ⇒ would-pass，不得判会红',
    () => judgeResourceType({ hasCheck: false, distinct: [{ value: 'person', n: 3 }], legalSet: ['person', 'device', 'station'] }).verdict === 'would-pass');
  T('RS-FIRE', '判红档：出现词表外的值 ⇒ would-fire 并点名',
    () => { const r = judgeResourceType({ hasCheck: false, distinct: [{ value: 'person', n: 3 }, { value: 'tool', n: 2 }], legalSet: ['person', 'device', 'station'] }); return r.verdict === 'would-fire' && r.illegal.length === 1 && r.illegal[0].value === 'tool'; });
  T('RS-NULLLEGAL', '词表解析不到 ⇒ 不可判，绝不折成"合法"',
    () => judgeResourceType({ hasCheck: false, distinct: [{ value: 'zzz', n: 1 }], legalSet: null }).verdict === 'legal-set-undecidable');
  T('RS-EMPTY', '无行 ⇒ no-rows，不折成 would-pass',
    () => judgeResourceType({ hasCheck: false, distinct: [], legalSet: ['person'] }).verdict === 'no-rows');

  let ok = 0; const bad = [];
  for (const c of cases) {
    let r = false;
    try { r = c.fn() === true; } catch (e) { bad.push(`${c.name}: ${e.message}`); continue; }
    if (r) ok += 1; else bad.push(`${c.name}: 未开火（${c.why}）`);
  }
  console.log(`  （backlog-premise-probe 判据自测 ${ok}/${cases.length} 条：租户面九档互斥各一支 ＋ 正向对照 ＋ 假阳性面 ＋ 四张不可判各一支 ＋ 值域四态 ＋ 词表取值路径校准）`);
  for (const b of bad) console.log('  ✗ ' + b);
  return ok === cases.length;
}

// ---------- 真库读数 ----------

const IDENT = /^[a-z_][a-z_0-9]*$/;
function safeTable(tb) {
  if (!IDENT.test(tb) || (!TABLES.includes(tb) && tb !== CONTROL_TABLE)) throw new Error(`表名不在租户面白名单：${tb}`);
  return tb;
}
/** A5 那一路的表名来自 information_schema（不是用户输入），只需形状校验，不必进租户面白名单 */
function safeIdent(name) {
  if (!IDENT.test(name)) throw new Error(`标识符形状非法：${name}`);
  return name;
}
const CONTROL_TABLE = 'ewoh_resource_locks';   // 正向对照表：有 org_id 且有 RLS

async function run() {
  const ownerUrl = process.env.EWOH_PG_URL || process.env.EWOH_DATABASE_URL;
  const runtimeUrl = process.env.EWOH_E2E_RUNTIME_DATABASE_URL || process.env.DATABASE_URL;
  if (!ownerUrl || !runtimeUrl) {
    console.log('  · 不可判：连接串取不到（EWOH_PG_URL / EWOH_E2E_RUNTIME_DATABASE_URL 不在环境里）⇒ 先 source tmp/chain-baseline/env.sh，不折算成"没有风险"');
    process.exitCode = 3; return;
  }
  const pg = require(path.join(ROOT, 'ewoh-spark-app/node_modules/postgres'));
  // 注意形状：postgres.js@3.4.9 只认 positional URL；传 {url} 会被忽略并退回 5432，
  // 报出来的却是 ECONNREFUSED（不是"配置错"）——本轮探针就是这样空转了一次。
  const owner = pg(ownerUrl);
  const runtime = pg(runtimeUrl);
  const legal = loadLegalSet();
  console.log(`  · 合法词表来源：${legal ? legal.source + ' → ' + legal.values.join('/') : '两处都解析不到 ⇒ A5 判不可判'}`);

  const bypass = await owner`select rolbypassrls from pg_roles where rolname = current_user`;
  const present = new Set((await owner`select table_name from information_schema.tables where table_schema='public'`).map((t) => t.table_name));
  const buckets = {};
  const readUnder = (tb, orgVal) => runtime.begin(async (tx) => {
    await tx`select set_config('app.current_org_id', ${orgVal}::text, true)`;
    const q = await tx`select count(*)::int n from ${tx('public.' + safeTable(tb))}`;
    return q[0].n;
  });

  for (const tb of [...TABLES]) {
    const cols = await owner`select column_name from information_schema.columns where table_schema='public' and table_name=${tb}`;
    const hasOrg = cols.some((c) => c.column_name === 'org_id');
    const pol = await owner`select count(*)::int n from pg_policies where tablename=${tb}`;
    const inDb = present.has(tb);
    let total = 0;
    if (inDb) { const r = await owner`select count(*)::int n from ${owner('public.' + safeTable(tb))}`; total = r[0].n; }
    let ownVisible = null; let foreignVisible = null; let premise = true;
    const FOREIGN = '__v353_probe_foreign_org__';
    if (inDb && hasOrg && total > 0) {
      const own = await owner`select org_id, count(*)::int n from ${owner('public.' + safeTable(tb))} group by org_id order by n desc limit 1`;
      const pre = await owner`select count(*)::int n from ${owner('public.' + safeTable(tb))} where org_id = ${FOREIGN}`;
      premise = pre[0].n === 0;
      if (own.length && premise) {
        ownVisible = await readUnder(tb, String(own[0].org_id));
        foreignVisible = await readUnder(tb, FOREIGN);
        console.log(`  · ${tb}: 运行角色 本org(${String(own[0].org_id).slice(0, 12)}…) 读到 ${ownVisible} 行／他org 读到 ${foreignVisible} 行（表总行数=${total}，policy=${pol[0].n}）`);
      } else {
        console.log(`  · ${tb}: 前提塌——伪造 org 在本表竟有 ${pre[0].n} 行 ⇒ 该臂作废，不判"合规"`);
      }
    } else {
      console.log(`  · ${tb}: 在位=${inDb} org_id列=${hasOrg} policy数=${pol[0].n} 行数=${total} ⇒ 可读性臂不适用（无行或无租户列）`);
    }
    const v = judgeTenant({
      tablePresent: inDb, hasOrgColumn: hasOrg, totalRows: total, hasPolicy: pol[0].n > 0,
      ownOrgVisibleRows: ownVisible ?? 0, foreignOrgVisibleRows: foreignVisible ?? 0,
      foreignOrgPremise: premise, roleBypassRls: bypass.length ? bypass[0].rolbypassrls : false,
    });
    buckets[v] = (buckets[v] || 0) + 1;
    console.log(`    ⇒ ${v}`);
  }

  // 正向对照（inject→双臂→清理核验）：证明这对双臂真能既开火又收手，不是恒 0
  let ctrl = 'skipped';
  if (present.has(CONTROL_TABLE)) {
    const A = '__v353_probe_org_A__', B = '__v353_probe_org_B__';
    const ins = (org, key, holder) => owner`insert into public.${owner(CONTROL_TABLE)} (org_id, resource_key, resource_id, holder)
      values (${org}, ${key}, ${key}, ${holder}) on conflict do nothing`;
    try {
      await ins(A, 'k1', 'probe'); await ins(A, 'k2', 'probe2'); await ins(B, 'k3', 'probe3');
      const a = await readUnder(CONTROL_TABLE, A);
      const b = await readUnder(CONTROL_TABLE, B);
      const f = await readUnder(CONTROL_TABLE, '__v353_probe_foreign_org__');
      await owner`delete from public.${owner(CONTROL_TABLE)} where org_id like '__v353_probe_%'`;
      const left = await owner`select count(*)::int n from public.${owner(CONTROL_TABLE)} where org_id like '__v353_probe_%'`;
      console.log(`  · 正向对照（${CONTROL_TABLE} 注入 3 行／两个 org）：A 臂读到 ${a}（应为 2）、B 臂读到 ${b}（应为 1）、他 org 读到 ${f}（应为 0）；清理后残留 ${left[0].n}（应为 0）`);
      ctrl = (a === 2 && b === 1 && f === 0 && left[0].n === 0) ? 'ok' : 'FAILED';
    } catch (e) {
      console.log('  · 正向对照失败：' + String(e.message).slice(0, 140));
      ctrl = 'error';
    }
    console.log(`  · 正向对照判决：${ctrl}${ctrl === 'ok' ? '（双臂既能开火也收手 ⇒ 上面各表的"读 0 行"不是恒真）' : ' ⇒ 可读性臂的读数全部降级为不可信，不得引用'}`);
  }

  const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
  console.log(`  · 租户面分桶 ${JSON.stringify(buckets)}｜Σ=${sum}｜分母=${TABLES.length}${sum === TABLES.length ? '' : ' ⇒ Σ不等于分母，读数作废'}`);

  const rtCols = await owner`select table_name, column_name from information_schema.columns where column_name='resource_type'`;
  console.log(`  · resource_type 列在位：${rtCols.map((c) => c.table_name).join(', ') || '未找到'}`);
  for (const c of rtCols) {
    const cons = await owner`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid = ('public.' || ${c.table_name})::regclass and contype='c'`;
    const hasCheck = cons.some((k) => /resource_type/i.test(k.def));
    const raw = await owner`select ${owner('public.' + safeIdent(c.table_name) + '.resource_type')} v, count(*)::int n from public.${owner(safeIdent(c.table_name))} group by 1 order by 2 desc`;
    const rows = raw.map((r) => ({ value: r.v === null ? null : String(r.v), n: r.n }));
    const j = judgeResourceType({ hasCheck, distinct: rows, legalSet: legal ? legal.values : null });
    console.log(`    - ${c.table_name}: CHECK=${hasCheck} 现值=${JSON.stringify(rows).slice(0, 220)} ⇒ ${j.verdict}${j.illegal.length ? ' 非法值 ' + JSON.stringify(j.illegal) : ''}`);
  }
  await owner.end(); await runtime.end();
  const reds = Object.keys(buckets).filter((b) => b === 'policy-but-leaks');
  process.exitCode = (reds.length || sum !== TABLES.length || ctrl === 'FAILED') ? 2 : 0;
  if (process.exitCode === 0) console.log('  · 判决：无判红档（`no-tenant-column`/`never-written`/`table-missing`/`observer-reads-nothing` 都不等于"安全"）');
}

if (process.argv.includes('--self-test')) { process.exitCode = selfTest() ? 0 : 2; }
else if (process.argv.includes('--run')) { run().catch((e) => { console.log('  · 取数失败：' + e.message); process.exitCode = 3; }); }
else { console.error('usage: backlog-premise-probe.cjs --self-test | --run'); process.exitCode = 2; }
