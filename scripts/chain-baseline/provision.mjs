import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 基线集群的角色与库准备（幂等）。
 *
 * 用仓库自带依赖 `postgres`（createRequire 从 ewoh-spark-app 解析），与
 * `scripts/migration-fresh-chain-check.js` 同一做法：不新增依赖、也不要求系统装 psql。
 *
 * 三个角色的分工是这套基线能被用来验证「谁能改哪类事实」的前提：
 *  - ewoh_migrator：initdb 超级用户，仅用于建角色/建库；
 *  - ewoh_owner：DDL owner，NOBYPASSRLS —— 迁移与 verify 用它；
 *  - ewoh_service：非特权运行角色，用来在需要时证明 RLS 真的会拦（NOBYPASSRLS）。
 *    应用运行角色 `ewoh_api` 由 standalone_003 迁移自己创建，不在这里越权代做。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const req = createRequire(path.join(root, 'ewoh-spark-app/package.json'));
const postgres = req('postgres');

const env = (name, fallback) => (process.env[name] || '').trim() || fallback;
const owner = env('EWOH_CHAIN_BASE_OWNER', 'ewoh_owner');
const ownerPw = env('EWOH_CHAIN_BASE_OWNER_PW', 'ewoh_chain_pw');
const db = env('EWOH_CHAIN_BASE_DB', 'ewoh');
const admin = 'ewoh_migrator';

const adminUrl = `postgresql://${admin}@127.0.0.1:${env('EWOH_CHAIN_BASE_PORT', '55432')}/postgres`;
const sql = postgres(adminUrl, { max: 1 });

// CREATE ROLE / CREATE DATABASE 不接受参数化标识符，因此这里改成「白名单校验 + 常量化」：
// 名字只允许普通小写标识符，密码只允许不含引号/反斜杠的字符，任一不合规直接失败。
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_PW = /^[A-Za-z0-9#@%^_.+=-]{8,}$/;
for (const [name, value] of [['role', owner], ['db', db], ['admin', admin]]) {
  if (!IDENT.test(value)) throw new Error(`${name} 含非法标识符字符：${value}`);
}
if (!SAFE_PW.test(ownerPw)) throw new Error('EWOH_CHAIN_BASE_OWNER_PW 需为 8 位以上且不含引号/反斜杠');

const roleExists = await sql`select 1 from pg_roles where rolname = ${owner}`;
if (roleExists.length === 0) {
  await sql.unsafe(
    `CREATE ROLE ${owner} LOGIN SUPERUSER CREATEDB CREATEROLE NOBYPASSRLS PASSWORD '${ownerPw}'`,
  );
  console.log(`[provision] 角色 ${owner} 已创建（本会话仅用于一次性隔离集群）`);
} else {
  console.log(`[provision] 角色 ${owner} 已存在，跳过`);
}

const dbExists = await sql`select 1 from pg_database where datname = ${db}`;
if (dbExists.length === 0) {
  await sql.unsafe(`CREATE DATABASE ${db} OWNER ${owner}`);
  console.log(`[provision] 库 ${db} 已创建`);
} else {
  console.log(`[provision] 库 ${db} 已存在，跳过（不清空）`);
}

const service = await sql`select 1 from pg_roles where rolname = 'ewoh_service'`;
if (service.length === 0) {
  await sql`CREATE ROLE ewoh_service LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD 'ewoh_service_pw'`;
  console.log('[provision] 非特权运行角色 ewoh_service 已创建');
} else {
  console.log('[provision] ewoh_service 已存在，跳过');
}

await sql.end();
