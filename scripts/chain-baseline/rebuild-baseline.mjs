// 基线库复位入口（V80 / SEED-01 之后落地）：把 `ewoh` 从空库重建。
//
// 为什么需要这一步（实测，不是审美）：链级场景会**消费**自己的前置事实，而既有链路里没有任何
// 文档化的复位路径——`provision.mjs` 明确「已存在，跳过（不清空）」、`seed.sh` 明确「不 DROP
// DATABASE」、`reset-scenario-data.js` 只清派生数据。基线一旦被消费到 `reset` 救不回来的程度，
// 重放就只剩"看起来链坏了"这一种表现（V79/V80 撞上的 ENV-02 正是这一步）。
//
// 安全护栏（与 lib.sh 的集群归属检查双保险，任何一条不满足就拒绝发 DROP）：
// host 必须 127.0.0.1、端口必须是 EWOH_CHAIN_BASE_PORT、库名必须正好是基线库名。
import { createRequire } from 'node:module';
const req = createRequire(process.cwd() + '/ewoh-spark-app/package.json');
const postgres = req('postgres');

const PORT = process.env.EWOH_CHAIN_BASE_PORT || '55432';
const DB = process.env.EWOH_CHAIN_BASE_DB || 'ewoh';
// 库名要拼进 DDL，因此只接受裸标识符；带引号/分号/空格的形状一律拒绝。
if (!/^[a-z_][a-z0-9_]*$/.test(DB)) {
  console.log(`[rebuild-baseline] 拒绝：基线库名形状不合法（${JSON.stringify(DB)}）`);
  process.exit(2);
}
const raw = process.env.EWOH_E2E_OWNER_DATABASE_URL || '';
let u;
try {
  u = new URL(raw);
} catch {
  console.log('[rebuild-baseline] 拒绝：没有可解析的 owner 连接串（先 source tmp/chain-baseline/env.sh）');
  process.exit(2);
}
if (u.hostname !== '127.0.0.1' || u.port !== PORT || decodeURIComponent(u.pathname) !== `/${DB}`) {
  console.log(
    `[rebuild-baseline] 拒绝：目标不是本套脚本自有的基线库`
      + `（host=${u.hostname} port=${u.port} db=${u.pathname}，要求 127.0.0.1:${PORT}/${DB}）`,
  );
  process.exit(2);
}
if (process.argv.slice(2).includes('--check')) {
  console.log(`[rebuild-baseline] 护栏通过：目标 127.0.0.1:${PORT}/${DB}（未执行 DROP）`);
  process.exit(0);
}

const adminUrl = new URL(raw);
adminUrl.pathname = '/template1';
const admin = postgres(adminUrl.toString(), { max: 1 });
try {
  await admin.unsafe(`drop database if exists ${DB} with (force)`).simple();
  await admin.unsafe(`create database ${DB} template template1`).simple();
  console.log(`[rebuild-baseline] 基线库 ${DB} 已重建为空库；接着跑 make chain-baseline-seed`);
} catch (e) {
  console.log('[rebuild-baseline] 重建失败：', String((e && e.message) || e).split('\n')[0]);
  process.exitCode = 1;
} finally {
  await admin.end();
}
