import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 采集试点链相关表的**约束层事实**（取值 CHECK、唯一键、外键、触发器、RLS 策略正文）。
 *
 * 存在的理由：`db/verify/*.verify.sql` 只断言「索引/列/策略存在」，不给出策略正文，
 * 因此「谁能改哪类事实」无法只靠 verify 输出回答。本脚本直接从系统目录读出可核对的原文，
 * 供 docs/audit/current/chain-behavior-baseline.md 引用（SCHEMA-01…05 的出处）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const req = createRequire(path.join(root, 'ewoh-spark-app/package.json'));
const postgres = req('postgres');

const env = (name, fallback) => (process.env[name] || '').trim() || fallback;
const url = env(
  'EWOH_DATABASE_URL',
  `postgresql://${env('EWOH_CHAIN_BASE_OWNER', 'ewoh_owner')}:${env('EWOH_CHAIN_BASE_OWNER_PW', 'ewoh_chain_pw')}@127.0.0.1:${env('EWOH_CHAIN_BASE_PORT', '55432')}/${env('EWOH_CHAIN_BASE_DB', 'ewoh')}`,
);
const sql = postgres(url, { max: 1 });

const CHAIN_TABLES = [
  'ewoh_scheduling_run', 'ewoh_schedule_plan', 'ewoh_scheduling_plan_assignment',
  'ewoh_schedule_assignment', 'ewoh_scheduling_execution', 'ewoh_production_task',
  'ewoh_control_request', 'ewoh_control_command', 'ewoh_control_result',
  'ewoh_agent_approval', 'ewoh_idempotency_keys', 'ewoh_idempotency_payload_fingerprint',
  'ewoh_assignment_event', 'ewoh_scheduling_conflict', 'ewoh_scheduling_constraint',
  'ewoh_resource_reservation', 'ewoh_replan_trigger', 'ewoh_world_state_snapshot',
];

/** 覆盖判据（纯函数，--self-test 直接喂假输入）：
 *  链相关表缺一张就说明连的不是链库 / 迁移不完整——此时**所有** section 都会空，
 *  而旧行为是 rc=0 + 22 行"段标题"，B 段照样记成功（V116 实测：空库 public 表总数 0、
 *  链相关表 0/18，探针仍然绿）。与 V110 的 "0 passed 也算过" 同一形状。 */
export function assessCoverage(found, expected) {
  const have = new Set(found);
  const missing = expected.filter((t) => !have.has(t));
  return { ok: missing.length === 0, missing, n: have.size, total: expected.length };
}

/** 反向控制自测：证明上面这条判据**能红**，而不是永远绿。 */
function selfTest() {
  const full = ['a', 'b', 'c'];
  const cases = [
    { label: '全覆盖 → 判 ok', got: assessCoverage(['a', 'b', 'c'], full), wantOk: true },
    { label: '缺一张 → 必须不 ok', got: assessCoverage(['a', 'c'], full), wantOk: false },
    { label: '空库（0/3）→ 必须不 ok（本轮实测出的假绿形状）', got: assessCoverage([], full), wantOk: false },
    { label: '多出来不影响（表名集合是下界不是等式）', got: assessCoverage(['a', 'b', 'c', 'd'], full), wantOk: true },
  ];
  let bad = 0;
  for (const c of cases) {
    const ok = c.got.ok === c.wantOk && (c.wantOk || c.got.missing.length > 0);
    if (!ok) { console.log(`  ✕ ${c.label} → 判据给出 ok=${c.got.ok} missing=${JSON.stringify(c.got.missing)}`); bad += 1; }
  }
  // V145：段健康判据自己的对照——必须能红（有一段 ERROR），也必须不误报（0 行段只是事实）。
  const secCases = [
    { label: '正向·有 ERROR 段必须判不健康', got: assessSections(['CHECK 约束'], [], 8), want: false },
    { label: '正向·空段（外键=0）是事实，不得因此判红', got: assessSections([], ['外键'], 8), want: true },
    { label: '反向·一段都没有（total=0）必须判不健康', got: assessSections([], [], 0), want: false },
    { label: '反向对照·全部正常 ⇒ 健康', got: assessSections([], [], 8), want: true },
  ];
  for (const c of secCases) {
    if (c.got.ok !== c.want) { bad += 1; console.log(`  ✕ ${c.label} → ok=${c.got.ok}（期望 ${c.want}）`); }
    else console.log(`  ✓ ${c.label}`);
  }
  console.log(bad ? `schema-probe 判据自测：不通过（${bad} 项）` : `schema-probe 判据自测：通过（${cases.length} 项：2 正向 + 2 反向）+ 段健康 4 项`);
  process.exit(bad ? 3 : 0);
}
if (process.argv.includes('--self-test')) selfTest();

const erroredSections = [];
const emptySections = [];
/** 段健康判据（纯函数，--self-test 直接喂假输入）：ERROR 段一律不可采；0 行段是事实但必须点名。 */
export function assessSections(errored, empty, total) {
  return { ok: errored.length === 0 && total > 0, errored, empty, total };
}

async function section(title, query) {
  console.log(`\n=== ${title} ===`);
  let n = 0;
  try {
    for (const row of await query) { console.log(Object.values(row).join('\t')); n += 1; }
  } catch (error) {
    console.log(`ERROR ${String(error.message ?? error).split('\n')[0]}`);
    console.log(`SECTION ${title} rows=ERROR`);
    erroredSections.push(title);
    return;
  }
  // 每段的行数打成机器可读：空段是**事实**（例如链表之间没有外键），
  // 但必须看得见，不能混在 375 行里靠人读。
  console.log(`SECTION ${title} rows=${n}`);
  if (n === 0) emptySections.push(title);
}

const present = await sql`select table_name from information_schema.tables
  where table_schema = 'public' and table_name = any(${CHAIN_TABLES}) order by table_name`;
const tables = present.map((r) => String(Object.values(r)[0]));
const total = await sql`select count(*)::int as n from information_schema.tables where table_schema='public'`;
const cov = assessCoverage(tables, CHAIN_TABLES);
console.log(`public 表总数 ${Object.values(total[0])[0]}；链相关表 ${cov.n}/${cov.total}`);
if (!cov.ok) {
  console.error(`FAIL schema_probe：链相关表缺 ${cov.missing.length} 张（${cov.missing.join(', ')}）`);
  console.error('  ⇒ 连的不是链基线库，或迁移链没跑完；此时下面所有段都会是空的，采到的"事实"为 0 条。');
  await sql.end({ timeout: 3 });
  process.exit(1);
}
console.log(tables.join('\n'));

await section('状态/时限列', sql`select table_name||'.'||column_name||' '||data_type||' null='||is_nullable
    ||' default='||coalesce(column_default, '<none>')
  from information_schema.columns
  where table_schema='public' and table_name = any(${tables})
    and (column_name ~ 'status|state|_at$|version|idempot|attempt|expires|deadline|lease|ack|deliver|sent|token')
  order by table_name, ordinal_position`);
await section('状态列 DEFAULT（V146：行的初生状态可能没有任何写者或契约声明它）', sql`
  select table_name||'.'||column_name||' :: default='||column_default||' :: is_nullable='||is_nullable
  from information_schema.columns
  where table_schema='public' and table_name = any(${tables})
    and column_name = 'status' and column_default is not null
  order by table_name`);
await section('列级授权（V146：权威是不是只到表级，靠这条判，不靠"没采"）', sql`
  select table_name||'.'||column_name||' :: '||privilege_type||' :: grantee='||grantee
  from information_schema.column_privileges
  where table_schema='public' and table_name = any(${tables})
  order by table_name, column_name, privilege_type`);
await section('CHECK 约束', sql`select conrelid::regclass::text||' :: '||conname||' :: '||pg_get_constraintdef(oid)
  from pg_constraint where contype='c' and conrelid::regclass::text = any(${tables}) order by 1`);
await section('主键/唯一', sql`select conrelid::regclass::text||' :: '||conname||' :: '||pg_get_constraintdef(oid)
  from pg_constraint where contype in ('u','p') and conrelid::regclass::text = any(${tables}) order by 1`);
await section('外键（为空即链路表之间无引用完整性）', sql`select conrelid::regclass::text||' :: '||conname||' :: '||pg_get_constraintdef(oid)
  from pg_constraint where contype='f' and conrelid::regclass::text = any(${tables}) order by 1`);
await section('触发器', sql`select tgrelid::regclass::text||' :: '||tgname from pg_trigger
  where not tgisinternal and tgrelid::regclass::text = any(${tables}) order by 1`);
await section('RLS 开关', sql`select relname||' rls='||relrowsecurity||' forced='||relforcerowsecurity
  from pg_class where relname = any(${tables}) and relkind='r' order by 1`);
await section('RLS 策略正文', sql`select tablename||' :: '||policyname||' :: '||cmd||' :: roles='
    ||array_to_string(roles, ',')||' :: using='||coalesce(qual, '-')||' :: check='||coalesce(with_check, '-')
  from pg_policies where schemaname='public' and tablename = any(${tables})
  order by tablename, policyname`);
await section('表级授权（谁被授予读写）', sql`select table_name||' :: '||privilege_type||' :: '||grantee
  from information_schema.role_table_grants
  where table_schema='public' and table_name = any(${tables}) order by table_name, grantee, privilege_type`);

const SECTIONS_TOTAL = 10;
const health = assessSections(erroredSections, emptySections, SECTIONS_TOTAL);
console.log(`段健康：共 ${SECTIONS_TOTAL} 段，ERROR ${health.errored.length} 段${health.errored.length ? '（' + health.errored.join('、') + '）' : ''}，空段 ${health.empty.length}${health.empty.length ? '（' + health.empty.join('、') + '）' : ''}`);
await sql.end({ timeout: 3 });
// V145：段查询报错必须让探针判红。此前 4 段（CHECK/主键唯一/外键/触发器）因 `order by 1,2`
// 越界而整段变成 "ERROR …" 文本，探针仍然 rc=0，于是"B 段事实 383 行 + 链相关表 18/18"两条判据
// 一起绿——读数量的是行数，不是"这一段到底采到了没有"。
if (!health.ok) {
  console.error(`FAIL schema_probe：${health.errored.length} 段查询失败 ⇒ 约束层事实没采到，不能当"已核对"用`);
  process.exit(1);
}
