#!/usr/bin/env node
'use strict';

/**
 * 只回答一个问题：一键重放 A 段那 104 条 `verify` 里，有多少条**只是因为自己的迁移跑过了**才 PASS。
 *
 * 做法（前置态行走）：按 `standalone-chain.js --plan` 的权威顺序，在一座本轮自建的临时库上
 * 逐支迁移前进；每支迁移**应用之前**先跑它自己那条 verify——此时它守卫的对象还不存在，
 * 所以一条有牙的 verify 必须不 PASS。走完后再把全部 verify 在终态跑一遍当控制档（必须全 PASS，
 * 否则说明这座库与 A 段不同形，整份读数作废）。
 *
 * 分档（互斥，加总＝分母）：
 *   pass-at-prefix          没跑迁移也 VERIFY OK ⇒ **候选恒真**，逐条读码定性
 *   fail-at-prefix          断言跑了、判不符合 ⇒ 有牙
 *   error-missing-at-prefix 对象不存在直接报错 ⇒ 天然不会假绿（机制与上一档不同）
 *   error-at-prefix         非零退出但文案读不出 ⇒ 同样不会假绿，签名另列分布
 *   silent-at-prefix        rc=0 且只打了 `completed for schema` ⇒ GATE-27 那一形（没做断言就"过"）
 *   other-at-prefix         读不出签名 ⇒ 单列，不折算成任何一侧
 *
 * 用法：source tmp/chain-baseline/env.sh && node scripts/chain-baseline/verify-teeth.cjs [--self-test] [--keep]
 * 只出读数：本件不接任何共享门禁。绝不允许指到链基线库 `ewoh`——脚本自己只连 `ewoh_teeth_<pid>`。
 *
 * 读数纪律（V221 首轮实测 104＝4 pass／72 fail／10 error-missing／18 error／0 silent）：
 * `pass-at-prefix` **不等于**"这条 verify 是恒真的"。首轮四条逐条读码后分成三类，引用时必须点名是哪一类：
 *   ① 对象由**更早的迁移**带出（008／011）⇒ 该 verify 断的是"最终形态"（008 的注释自己写着"与创建者无关"），
 *      在全新链上必然前置盲；它证明的不是"这支迁移做了事"。
 *   ② **负向不变量型**（105「没有 active 且不合规的 L3 manifest」）⇒ 零违规行必真，要有牙得配"造一个违规行被拒"的行为探针。
 *   ③ **本量具自身的限度**（003 运行角色）⇒ 角色是**集群级**对象，临时库隔离不掉（本机前一轮全链 apply 已经把它建出来了）。
 *      不修：要让它隔离就得 DROP 集群级角色，而基线库 `ewoh` 正依赖 `ewoh_api` ⇒ 属于"会动到别人在用的共享面"，本件宁可留盲区并写明。
 * 因此可以说的是"104 条里没有一条是恒真断言"，**不能**说"100 条被证明有牙、4 条有缺陷"。
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..', '..');
const postgres = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'))('postgres');
const args = process.argv.slice(2);
const runner = path.join(root, 'db/runner/run_migrations.js');

function plan() {
  const r = spawnSync(process.execPath, [path.join(root, 'db/runner/standalone-chain.js'), '--plan'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`--plan 失败：${r.stderr}`);
  return JSON.parse(r.stdout);
}

function classify(result) {
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/VERIFY OK/.test(out)) return 'pass-at-prefix';
  if (/VERIFY FAILED/i.test(out)) return 'fail-at-prefix';
  // 退出码非零＝这一条在对象不存在时不会假绿（至于"为什么红"是签名的事，不参与定档）
  if (result.status !== 0) {
    return /does not exist|不存在|must be of type string|undefined is not iterable/.test(out)
      ? 'error-missing-at-prefix' : 'error-at-prefix';
  }
  // rc=0 却没有 VERIFY OK：正是 GATE-27 那一形（被兜底分支当迁移跑掉），单列成"静默档"
  if (/completed for schema/.test(out)) return 'silent-at-prefix';
  return 'other-at-prefix';
}

function runVerify(command, url) {
  const r = spawnSync(process.execPath, [runner, command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, EWOH_DATABASE_URL: url, EWOH_ALLOW_DDL: '1' },
  });
  return { rc: r.status, bucket: classify(r), out: `${r.stdout || ''}${r.stderr || ''}` };
}

function runApply(command, url) {
  const r = spawnSync(process.execPath, [runner, command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, EWOH_DATABASE_URL: url, EWOH_ALLOW_DDL: '1' },
  });
  if (r.status !== 0) throw new Error(`${command} 失败（rc=${r.status}）：${`${r.stderr || r.stdout}`.split('\n').slice(-3).join(' / ')}`);
}

// ---------------------------------------------------------------- 判据自测
function selfTest() {
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok });
  const fake = (stdout, stderr, status = 0) => ({ stdout, stderr, status });

  t('正对照 1：前缀态就 VERIFY OK ⇒ 必须判 pass-at-prefix（不许读成"有牙"）',
    classify(fake('VERIFY OK: whatever', '')) === 'pass-at-prefix');
  t('正对照 2：断言判不符合 ⇒ fail-at-prefix',
    classify(fake('', 'VERIFY FAILED: --verify-x did not return y=1')) === 'fail-at-prefix');
  t('正对照 3：对象不存在且退出码非零 ⇒ error-missing-at-prefix（有牙，但机制是"跑不起来"）',
    ['relation "public.ewoh_x" does not exist', 'function ewoh_open_andon_orgs() does not exist', 'column t.org_id does not exist']
      .every((msg) => classify(fake('', `ERROR ${msg}`, 1)) === 'error-missing-at-prefix'));
  t('正对照 4：静默档必须单列——rc=0 又没有 VERIFY OK、只打了 completed for schema（GATE-27 那一形）',
    classify(fake('--verify-standalone-fake completed for schema public', '')) === 'silent-at-prefix');
  t('反对照 5：rc≠0 但文案读不出 ⇒ error-at-prefix，**不得**并入 pass（非零＝不会假绿）',
    classify(fake('', 'ERROR 一些没见过的报错', 1)) === 'error-at-prefix');
  t('反对照 7：DO 块自己 RAISE 的 "verify FAILED: missing tables" 必须判 fail-at-prefix（断言判不符合），'
    + '不能因为同句里有 missing 就被吸进"对象不存在"档',
    classify(fake('', 'ERROR 017 verify FAILED: missing tables: ewoh_resource_reservation', 1)) === 'fail-at-prefix');
  t('反对照 8：中文报错"表 … 不存在" ⇒ error-missing-at-prefix（有牙，机制是跑不起来）',
    classify(fake('', 'ERROR verify standalone_002_users: 表 public.ewoh_user 不存在', 1)) === 'error-missing-at-prefix');
  t('反对照 6：rc=0、无签名、非兜底文案 ⇒ other-at-prefix（单列，不折算成任何一侧）',
    classify(fake('一些没有签名的输出', '')) === 'other-at-prefix');
  const p = plan();
  t('分母自证 1：链上每支都有 apply 与 verify 命令名（缺任一即不出数）',
    p.length > 50 && p.every((m) => m.apply?.startsWith('--apply-') && m.verify?.startsWith('--verify-')));
  t('分母自证 2：verify 命令逐支唯一（重复会让"谁守卫这条"错位）',
    new Set(p.map((m) => m.verify)).size === p.length);
  t('分母自证 3：id 单调可解（前置态行走依赖这个顺序）',
    p.every((m) => /^\d{3}$/.test(m.id)));
  const bad = cases.filter((x) => !x.ok);
  for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`判据自测 ${cases.length - bad.length}/${cases.length} 通过｜链上迁移 ${p.length} 支（分母由 --plan 现算）`);
  process.exit(bad.length ? 1 : 0);
}

// ---------------------------------------------------------------- 主档
async function main() {
  const ownerUrl = process.env.EWOH_PG_URL || '';
  if (!ownerUrl) {
    console.error('缺少 EWOH_PG_URL（owner 权限连接串，需 source tmp/chain-baseline/env.sh）');
    process.exit(2);
  }
  const dbName = `ewoh_teeth_${process.pid}`;
  const u = new URL(ownerUrl);
  u.pathname = `/postgres`;
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
  } catch (e) {
    console.error(`无法建临时库：${e.message}`);
    await admin.end().catch(() => {});
    process.exit(2);
  }
  const url = new URL(ownerUrl);
  url.pathname = `/${dbName}`;
  const freshUrl = url.toString();

  const chain = plan();
  const buckets = {
    'pass-at-prefix': [], 'fail-at-prefix': [], 'error-missing-at-prefix': [],
    'error-at-prefix': [], 'silent-at-prefix': [], 'other-at-prefix': [],
  };
  let exit = 0;
  try {
    for (const m of chain) {
      const r = runVerify(m.verify, freshUrl);
      const tail = r.out.trim().split('\n').filter((x) => x.trim() !== '').slice(-1)[0] || `rc=${r.rc}`;
      buckets[r.bucket].push({ id: m.id, command: m.verify, rc: r.rc, tail });
      runApply(m.apply, freshUrl);
    }
    const sum = Object.values(buckets).reduce((a, b) => a + b.length, 0);
    console.log(`[verify-teeth] 分母（链上迁移逐支一支一 verify）= ${chain.length}｜Σ各档 = ${sum}`);
    if (sum !== chain.length) {
      console.error('读数作废：加总不等于分母');
      process.exit(2);
    }
    for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(19)} ${v.length}`);
    console.log('  pass-at-prefix 点名：');
    for (const x of buckets['pass-at-prefix']) console.log(`    · ${x.id} ${x.command}`);
    if (buckets['silent-at-prefix'].length) {
      console.log('  silent-at-prefix 点名（rc=0 但没做断言＝GATE-27 那一形）：');
      for (const x of buckets['silent-at-prefix']) console.log(`    ! ${x.id} ${x.command}｜${x.tail.slice(0, 90)}`);
    }
    // "读不出签名"的桶必须给分布：66 条里大概率混着"其实就是对象不存在、只是文案不同"，
    // 不打印签名就没法判这条量具是在分档还是在装分档。
    for (const b of ['other-at-prefix', 'error-at-prefix']) {
      const sig = new Map();
      for (const x of buckets[b]) {
        const k = x.tail.slice(0, 110);
        sig.set(k, (sig.get(k) || 0) + 1);
      }
      console.log(`  ${b} 签名分布（${buckets[b].length} 条 / ${sig.size} 种）：`);
      for (const [k, v] of [...sig.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 12)) console.log(`    ${String(v).padStart(3)}  ${k}`);
    }

    // 控制档：终态必须与 A 段同形（全 PASS），否则上面的行走读数不可信
    const control = chain.filter((m) => m.verify.startsWith('--verify-standalone'))
      .map((m) => runVerify(m.verify, freshUrl));
    const green = control.filter((c) => c.bucket === 'pass-at-prefix').length;
    console.log(`[verify-teeth] 控制档（终态全量 verify）= ${green}/${control.length} PASS`);
    if (green !== control.length) {
      console.error('控制档不绿 ⇒ 这座库与 A 段不同形，本轮不出结论');
      for (const c of control.filter((x) => x.bucket !== 'pass-at-prefix')) {
        console.error(`  ✗ ${c.bucket} rc=${c.rc}`);
      }
      exit = 2;
    }
  } catch (e) {
    console.error(`[verify-teeth] 中止：${e.message}`);
    exit = 2;
  } finally {
    if (!args.includes('--keep')) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    } else {
      console.log(`[verify-teeth] --keep：保留 ${dbName}`);
    }
    await admin.end().catch(() => {});
  }
  console.log('读数只回答"没跑迁移会不会 PASS"，不证明断言内容对业务有价值；pass-at-prefix 是候选面，逐条读码定性。');
  process.exit(exit);
}

if (args.includes('--self-test')) selfTest();
else main();
