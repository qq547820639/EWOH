#!/usr/bin/env node
/**
 * 授权指纹密钥轮换演练（NO-74d）。
 *
 * 为什么要演练：runbook 写了轮换四步（挪旧→切新→等在飞清零→移除 _PREVIOUS），
 * 但没演练过的操作手册只是"看起来可行"。本脚本把四步变成可重复执行、
 * 每步都有验证的流程；在 dev 环境跑一遍，现场的第一次真实轮换就不是第一次。
 *
 * 纪律（与 runbook 一致）：
 *   · 复核窗口：`_PREVIOUS` 让复核同时接受上一把密钥（在飞命令不被误撤回）；
 *     **签发只用新密钥**。
 *   · 窗口必须有期限：在飞清零后**立即移除** `_PREVIOUS`（越久 = 被撤销的旧密钥越可用）。
 *   · `_PREVIOUS` 与当前密钥相同视为配置错误（代码不放宽）。
 *
 * 用法：
 *   node tools/control-key-rotation-drill.mjs                # dry-run：只打印计划，不改任何东西
 *   node tools/control-key-rotation-drill.mjs --apply        # 真正执行（改 env + 重启平台 + 轮询 + 收尾）
 *   --env-file .env.local-standalone                          # 目标 env 文件（默认）
 *   --inflight-timeout-sec 120                                # 等"在飞清零"的最长等待
 *
 * 诚实边界：脚本只管 dev/演练环境；生产轮换由运维按 runbook 执行（涉及多实例顺序）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const envArgIdx = args.indexOf('--env-file');
const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const envFile = path.resolve(appDir, envArgIdx >= 0 ? args[envArgIdx + 1] : '.env.local-standalone');
const inflightTimeoutSec = Number(args[args.indexOf('--inflight-timeout-sec') + 1] ?? 120) || 120;
const pgUrlArgIdx = args.indexOf('--pg-url');
const pgUrlOverride = pgUrlArgIdx >= 0 ? args[pgUrlArgIdx + 1] : '';

const SECRET_KEY = 'EWOH_CONTROL_FINGERPRINT_SECRET';
const PREVIOUS_KEY = 'EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS';
const PG_URL_KEYS = ['EWOH_DATABASE_URL', 'DATABASE_URL'];

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function readEnvKeys(text) {
  const keys = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) keys[m[1]] = m[2];
  }
  return keys;
}

function setEnvLine(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  return `${text.trimEnd()}\n${line}\n`;
}

function removeEnvLine(text, key) {
  return text
    .split('\n')
    .filter((line) => !new RegExp(`^${key}=.*$`).test(line.trim()))
    .join('\n');
}

/** 把 env 文件的键值合并进子进程环境（本地平台靠 env 文件提供 DATABASE_URL 等）。 */
function envFileProcessEnv(text) {
  const merged = { ...process.env };
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2];
    // 引号是 shell 语法不是值的一部分（`set -a && . file` 的语义）；实测：
    // INGEST_API_KEYS='{"..."}' 带引号传入 → JSON 解析失败 → ingest fail-closed 拒启。
    const q = value.length >= 2 ? value[0] : '';
    if ((q === "'" || q === '"') && value.endsWith(q)) value = value.slice(1, -1);
    merged[m[1]] = value;
  }
  return merged;
}

async function restartPlatform(envText) {
  // 本地演练：单实例直接重启（生产多实例的滚动重启见 runbook，不在脚本范围）。
  const { execSync } = await import('node:child_process');
  try {
    execSync('pkill -f "dist/server/main.js" || true', { cwd: appDir, stdio: 'ignore' });
  } catch {
    // pkill 无匹配时退出码非 0，忽略
  }
  await new Promise((r) => setTimeout(r, 2000));
  const { spawn } = await import('node:child_process');
  const { openSync } = await import('node:fs');
  // 子进程输出落到日志文件：运维脚本绝不能把"起不来"变成静默（本次实测的教训）。
  const out = openSync('/tmp/ewoh-key-rotation-drill.log', 'a');
  const child = spawn('node', ['dist/server/main.js'], {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...envFileProcessEnv(envText), NODE_ENV: 'production' },
  });
  child.unref();
  child.on('exit', (code, signal) => {
    log('2x', `平台子进程退出：code=${code} signal=${signal}（详见 /tmp/ewoh-key-rotation-drill.log）`);
  });
  // 等就绪（/api/exo/sessions 未认证应 401）
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch('http://127.0.0.1:3100/api/exo/sessions');
      if (res.status === 401) return true;
    } catch {
      // 未就绪，继续等
    }
  }
  return false;
}

async function inflightCount(pgUrl) {
  const sql = postgres(pgUrl, { max: 1 });
  try {
    const rows = await sql`
      select count(*)::int as n
        from ewoh_control_command
       where status in ('sent', 'gateway_received')`;
    return rows[0]?.n ?? -1;
  } catch (error) {
    // 错误必须可见（实测：连不上/无权限时被吞成空消息，演练者不知道卡在哪）
    console.error(`在飞计数查询失败（url=${String(pgUrl).replace(/:[^:@/]+@/, ':***@')}）：`,
      error instanceof Error ? error.message : error);
    return -2;
  } finally {
    await sql.end();
  }
}

async function main() {
  if (!existsSync(envFile)) {
    console.error(`env 文件不存在：${envFile}`);
    process.exit(2);
  }
  const text = readFileSync(envFile, 'utf8');
  const keys = readEnvKeys(text);
  const currentSecret = keys[SECRET_KEY] ?? '';
  const previousSecret = keys[PREVIOUS_KEY] ?? '';
  // 计数身份必须是**能看全租户行**的角色：ewoh_api 走 RLS 会把未命中 GUC 的行全滤掉，
  // count=0 会被误判成"在飞已清零"（假清零）——优先 owner URL，并在日志里打印用的哪个。
  const pgUrl = pgUrlOverride
    || process.env.EWOH_E2E_OWNER_DATABASE_URL
    || PG_URL_KEYS.map((k) => keys[k]).find(Boolean)
    || (process.env.EWOH_DATABASE_URL ?? '');
  if (!pgUrlOverride && !process.env.EWOH_E2E_OWNER_DATABASE_URL) {
    log('?', '警告：未显式提供 --pg-url / EWOH_E2E_OWNER_DATABASE_URL——若回落到运行角色（RLS），在飞计数可能被过滤成假 0');
  }

  log('0', `目标 env：${envFile}${apply ? '（--apply：真轮换）' : '（dry-run：只打印计划）'}`);

  // --resume：上一轮演练中断后，env 已处于"轮换中"（新密钥 + _PREVIOUS）。跳过第 1 步，
  // 直接从"等在飞清零 → 移除 _PREVIOUS"继续——恢复路径本身就是演练的一部分。
  // 注意：resume 分支必须**先于** _PREVIOUS 守卫（_PREVIOUS 存在是恢复的合法前提）。
  if (args.includes('--resume')) {
    if (previousSecret === '') {
      console.error('中止：--resume 但 _PREVIOUS 未设置——没有进行中的轮换可恢复。');
      process.exit(1);
    }
    log('R', '恢复模式：跳过密钥生成，直接进入"等在飞清零 → 移除 _PREVIOUS"');
    await resumeRotation(text);
    return;
  }
  if (previousSecret !== '') {
    console.error('中止：_PREVIOUS 已设置——上一轮轮换还没收尾（先在飞清零并移除它，再开始新一轮；中断恢复用 --resume）。');
    process.exit(1);
  }
  if (currentSecret === '') {
    console.error('中止：当前未配置签名密钥（SECRET 为空）。配好后演练才有意义（无密钥 = v1 一致性指纹）。');
    process.exit(1);
  }

  const newSecret = `rotated-${randomBytes(16).toString('hex')}`;
  log('1', `计划：${SECRET_KEY} → ${newSecret.slice(0, 12)}…；${PREVIOUS_KEY} ← 旧密钥（复核窗口）`);

  if (!apply) {
    log('1b', 'dry-run 结束：实际执行请加 --apply（会改 env、重启平台、轮询在飞、最后移除 _PREVIOUS）');
    return;
  }

  // 第 1 步：挪旧 + 切新（复核接受两把，签发只用新密钥）
  let next = setEnvLine(text, SECRET_KEY, newSecret);
  next = setEnvLine(next, PREVIOUS_KEY, currentSecret);
  writeFileSync(envFile, next);
  log('2', 'env 已写入（新密钥签发 + 旧密钥复核窗口），重启平台…');
  const up = await restartPlatform(next);
  if (!up) {
    console.error('重启后平台未就绪——请人工检查后重试（env 已处于轮换中状态）。');
    process.exit(1);
  }
  log('2b', '平台已就绪（复核窗口开启中）');

  // 第 2 步：等在飞清零（窗口存在的唯一理由就是在飞命令）
  const finished = await waitInflightAndCloseWindow(next, pgUrl);
  if (!finished) process.exit(1);
  log('5', '轮换演练完成：新密钥签发 + 无复核窗口（纪律：窗口越短越好）');
}

/** 演练后半段：等在飞清零 → 移除 _PREVIOUS → 重启退出窗口。 */
async function waitInflightAndCloseWindow(envText, pgUrl) {
  log('3', `等待在飞命令清零（最长 ${inflightTimeoutSec}s；计数连接 ${String(pgUrl).replace(/:[^:@/]+@/, ':***@').slice(0, 48)}…）`);
  if (!pgUrl) {
    console.error('中止：没有可用的 PG 连接串（--pg-url / EWOH_E2E_OWNER_DATABASE_URL / env 的 DATABASE_URL）——在飞计数无法进行。');
    return false;
  }
  const deadline = Date.now() + inflightTimeoutSec * 1000;
  let remaining = -1;
  while (Date.now() < deadline) {
    remaining = await inflightCount(pgUrl);
    if (remaining === 0) break;
    if (remaining === -1 || remaining === -2) break; // 查询失败：绝不能当成"已清零"
    process.stdout.write(`  在飞 ${remaining} 条，10s 后再查…\n`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (remaining > 0 || remaining === -1 || remaining === -2) {
    console.error(`在飞未清零（剩 ${remaining} 条）——**保留 _PREVIOUS**，稍后用 --resume 重跑本脚本收尾。`);
    return false;
  }
  log('3b', '在飞已清零');

  // 第 3 步：移除 _PREVIOUS（窗口必须短）
  const closed = removeEnvLine(envText, PREVIOUS_KEY);
  writeFileSync(envFile, closed);
  log('4', '_PREVIOUS 已移除，再次重启平台（退出轮换窗口）…');
  const up2 = await restartPlatform(closed);
  if (!up2) {
    console.error('第二次重启未就绪——请人工检查（_PREVIOUS 已移除，属安全侧状态）。');
    return false;
  }
  return true;
}

/** --resume：从"轮换中"状态恢复（不再生成新密钥）。 */
async function resumeRotation(envText) {
  const keys = readEnvKeys(envText);
  const pgUrl = pgUrlOverride
    || process.env.EWOH_E2E_OWNER_DATABASE_URL
    || PG_URL_KEYS.map((k) => keys[k]).find(Boolean)
    || (process.env.EWOH_DATABASE_URL ?? '');
  const ok = await waitInflightAndCloseWindow(envText, pgUrl);
  if (!ok) process.exit(1);
  log('R2', '轮换窗口已关闭，演练收尾完成');
  if (!up2) {
    console.error('第二次重启未就绪——请人工检查（_PREVIOUS 已移除，属安全侧状态）。');
    process.exit(1);
  }
  log('5', '轮换演练完成：新密钥签发 + 无复核窗口（纪律：窗口越短越好）');
}

main().catch((error) => {
  console.error('演练失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
