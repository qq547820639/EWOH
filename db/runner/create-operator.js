#!/usr/bin/env node
'use strict';

/**
 * 运营账号（operator account）开通/维护命令。
 *
 * 为什么需要它（2026-09-10 交付闭环审计发现）：
 * B5 审批独立性治理（standalone_069 + `SELF_APPROVAL_FORBIDDEN`）要求
 * "方案生成人不得审批自己的方案"。但系统此前只有 bootstrap 单个 admin 的开通
 * 路径（`--seed-standalone-admin`），没有任何新增登录账号的方式。结果是一个
 * 全新部署的工厂**永远无法审批任何方案**：唯一账号生成的方案它自己不能批。
 * 这直接违反"真实工厂用户能否完成工作"这一最高优先级。
 *
 * 设计取舍：
 *  - 只做运维命令，**不新增 HTTP 用户管理端点**。身份开通是安全敏感路径，
 *    走 owner 连接 + 一次性密码注入，避免把"创建管理员"变成一个新的远程攻击面，
 *    也与既有 `--seed-standalone-admin` 的信任模型一致。
 *  - 密码只从环境变量或 stdin 读，**不接受命令行参数**（argv 会出现在
 *    `ps` 输出与 shell 历史里）。
 *  - 默认幂等且保守：已存在的账号默认不改动；改角色/改密码必须显式开关。
 *  - 写入 `ewoh_user` 需要表属主权限：该表启用 RLS 且**故意不给业务运行角色
 *    任何授权或策略**（业务侧只能经 `ewoh_find_active_user()` 这个
 *    SECURITY DEFINER 函数读身份）。所以本命令必须使用 owner 连接。
 *
 * 用法：
 *   EWOH_DATABASE_URL=postgresql://ewoh_owner:...@host:5432/ewoh \
 *   EWOH_OPERATOR_PASSWORD='<>=16 chars' \
 *     node db/runner/create-operator.js \
 *       --username planner.pan --display-name '潘计划' --roles dispatcher,workshop_lead
 *
 *   # 逐个列出账号（不写库）
 *   node db/runner/create-operator.js --list
 *
 *   # 维护既有账号
 *   node db/runner/create-operator.js --username planner.pan --update-roles --roles dispatcher
 *   node db/runner/create-operator.js --username planner.pan --reset-password
 *   node db/runner/create-operator.js --username planner.pan --deactivate
 *
 * 退出码：0 成功；1 用法/校验错误；2 数据库或前置条件错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

/** 规范角色集合（与 client/src/types/ewoh.ts 的 EWOH_ROLES 一致）。 */
const ROLES = [
  'viewer',
  'worker',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
  'global_admin',
];
const ROLE_LABELS = {
  viewer: '只读访客',
  worker: '一线作业员',
  dispatcher: '调度员',
  workshop_lead: '班组长',
  safety_admin: '安全管理员',
  device_ops: '设备运维',
  global_admin: '全局管理员',
};
/** 与 seed 一致的密码下限；上调只影响本命令，不改动既有账号。 */
const MIN_PASSWORD_LENGTH = 12;

function usage(exitCode = 1) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`用法：node db/runner/create-operator.js --username <name> [选项]

必填（非 --list）：
  --username <name>          登录名，3-128 位 [A-Za-z0-9_.@-]

选项：
  --display-name <text>      显示名（默认同 username）
  --roles <a,b>              角色清单（默认 viewer）；可用：${ROLES.join(',')}
  --org-id <uuid>            归属组织（默认库中首个组织）
  --person-id <id>           绑定业务人员 ID（人员域）。用于现场回执"本人可报"
                             与现场作业台"我的任务"；不设置则该账号未绑定，
                             非特权角色无法回执任何任务（fail-closed）。
  --global-admin             授予全局管理员（is_global_admin=true）
  --password-env <VAR>       从该环境变量读密码（默认 EWOH_OPERATOR_PASSWORD）
  --password-stdin           从 stdin 读密码（与 --password-env 互斥）
  --update-roles             账号已存在时更新角色（默认不改动）
  --update-person            账号已存在时更新人员绑定（默认不改动）
  --reset-password           账号已存在时轮换密码（默认不改动）
  --deactivate               停用账号（status=disabled）
  --activate                 重新启用账号（status=active）
  --list                     列出账号后退出（不写库）
  --dry-run                  只打印将执行的操作
  --help                     显示本帮助

环境：
  EWOH_SCHEMA                目标 schema（默认 public）
  EWOH_DATABASE_URL          owner 连接串（必填，除 --list 也需要）
  EWOH_OPERATOR_PASSWORD     默认密码来源

示例：
  EWOH_DATABASE_URL=postgresql://ewoh_owner:pw@127.0.0.1:5432/ewoh \\
  EWOH_OPERATOR_PASSWORD='FactoryApprover#2026' \\
    node db/runner/create-operator.js --username approver.li \\
      --display-name '李审批' --roles dispatcher,workshop_lead
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { roles: [], flags: new Set() };
  const valueFlags = new Set([
    '--username',
    '--display-name',
    '--roles',
    '--org-id',
    '--person-id',
    '--password-env',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} 需要一个取值`);
      }
      i += 1;
      if (arg === '--roles') {
        opts.roles = value.split(',').map((r) => r.trim()).filter(Boolean);
      } else {
        opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
    } else if (arg.startsWith('--')) {
      opts.flags.add(arg.slice(2));
    } else {
      throw new Error(`无法识别的参数：${arg}`);
    }
  }
  return opts;
}

function validateUsername(username) {
  if (!username || !/^[A-Za-z0-9_.@-]{3,128}$/.test(username)) {
    throw new Error('--username 必须是 3-128 位 [A-Za-z0-9_.@-]');
  }
}

function validateRoles(roles) {
  const unknown = roles.filter((r) => !ROLES.includes(r));
  if (unknown.length) {
    throw new Error(`未知角色：${unknown.join(',')}（可用：${ROLES.join(',')}）`);
  }
}

/** 密码读取：仅 env / stdin，绝不从 argv。 */
function readPassword(opts) {
  if (opts.flags.has('password-stdin')) {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.split('\n')[0];
  }
  const envName = opts.passwordEnv || 'EWOH_OPERATOR_PASSWORD';
  const value = process.env[envName];
  if (!value) {
    throw new Error(
      `未提供密码：请设置 ${envName}，或使用 --password-stdin（不接受命令行明文密码）`,
    );
  }
  return value;
}

function assertPassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码长度至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

function resolveDatabaseUrl() {
  const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
  if (!url) throw new Error('EWOH_DATABASE_URL 未设置（本命令写 ewoh_user，需要 owner 连接）');
  return url;
}

function loadDotenv() {
  const envPath = path.join(appDir, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    // quiet：抑制 dotenv 的推广横幅——本命令的 stdout 需要可被脚本解析。
    // 默认 dotenv 不覆盖已存在的环境变量，因此显式传入的 env 始终优先。
    requireFromApp('dotenv').config({ path: envPath, quiet: true });
  } catch {
    // dotenv 缺失不阻断：显式环境变量仍可用。
  }
}

/** 角色读取：兼容 jsonb 数组与被双重编码成 JSON 字符串的历史行。 */
function rolesOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 落到下面的兜底
    }
  }
  return [];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadDotenv();
  const dryRun = opts.flags.has('dry-run');
  const schema = process.env.EWOH_SCHEMA || 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`EWOH_SCHEMA 非法：${schema}`);
  }
  const url = resolveDatabaseUrl();
  const postgres = requireFromApp('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    if (opts.flags.has('list')) {
      const rows = await sql.unsafe(
        `SELECT username, display_name, roles, is_global_admin, status, org_id::text AS org_id,
                person_id
           FROM ${schema}.ewoh_user ORDER BY username`,
      );
      if (!rows.length) {
        console.log('（无账号）');
        return;
      }
      for (const row of rows) {
        if (!row.roles) {
          console.error(`警告：账号 ${row.username} 的 roles 字段缺失或不可解析（值为 ${JSON.stringify(row.roles)}）`);
        }
        const label = rolesOf(row.roles).map((r) => ROLE_LABELS[r] || r).join('/');
        console.log(
          `${row.username}\t${row.display_name ?? ''}\t${label}`
            + `${row.is_global_admin ? '\t[全局管理员]' : ''}\t${row.status}\t${row.org_id}`
            + `\t人员绑定=${row.person_id ?? '未绑定'}`,
        );
      }
      return;
    }

    const username = opts.username;
    validateUsername(username);
    const roles = opts.roles.length ? opts.roles : ['viewer'];
    validateRoles(roles);

    const [org] = await sql.unsafe(
      opts.orgId
        ? `SELECT id::text AS id FROM ${schema}.ewoh_organization WHERE id = $1::uuid`
        : `SELECT id::text AS id FROM ${schema}.ewoh_organization ORDER BY id LIMIT 1`,
      opts.orgId ? [opts.orgId] : [],
    );
    if (!org) {
      throw new Error(
        opts.orgId ? `组织不存在：${opts.orgId}` : '库中没有任何组织，无法归属账号',
      );
    }

    const [existing] = await sql.unsafe(
      `SELECT username, status, roles, is_global_admin FROM ${schema}.ewoh_user WHERE username = $1`,
      [username],
    );
    const displayName = opts.displayName || username;
    const wantsRoleUpdate = opts.flags.has('update-roles');
    const wantsPasswordReset = opts.flags.has('reset-password');
    const deactivate = opts.flags.has('deactivate');
    const activate = opts.flags.has('activate');
    const globalAdmin = opts.flags.has('global-admin');

    if (deactivate && activate) throw new Error('--deactivate 与 --activate 互斥');

    if (!existing) {
      const password = readPassword(opts);
      assertPassword(password);
      const bcrypt = requireFromApp('bcryptjs');
      const hash = bcrypt.hashSync(password, 12);
      console.log(
        `将创建账号 ${username}（角色 ${roles.join(',')}，组织 ${org.id}`
          + `${globalAdmin ? '，全局管理员' : ''}）`,
      );
      if (dryRun) return;
      // sql.json()：让 postgres.js 直接以 jsonb 值发送。若传 JS 字符串再 `::jsonb`，
      // 驱动会把字符串序列化成 JSON 字符串标量（得到 "[\"a\"]" 而非 ["a"]）。
      await sql.unsafe(
        `INSERT INTO ${schema}.ewoh_user
           (username, password_hash, display_name, org_id, roles, is_global_admin, status, person_id)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, 'active', $7)
         ON CONFLICT (username) DO NOTHING`,
        [username, hash, displayName, org.id, sql.json(roles), globalAdmin, opts.personId ?? null],
      );
      console.log(`已创建账号 ${username}`);
      return;
    }

    // 既有账号：默认保守不动。
    const changes = [];
    if (wantsRoleUpdate) changes.push(`角色 → ${roles.join(',')}`);
    if (opts.flags.has('update-person')) changes.push(`人员绑定 → ${opts.personId ?? '解除绑定'}`);
    if (wantsPasswordReset) changes.push('密码轮换');
    if (deactivate) changes.push('状态 → disabled');
    if (activate) changes.push('状态 → active');
    if (!changes.length) {
      console.log(
        `账号 ${username} 已存在（状态 ${existing.status}），未指定任何维护开关，未做改动。\n`
          + '如需修改：--update-roles / --reset-password / --deactivate / --activate',
      );
      return;
    }
    console.log(`将更新账号 ${username}：${changes.join('；')}`);
    if (dryRun) return;

    if (wantsPasswordReset) {
      const password = readPassword(opts);
      assertPassword(password);
      const bcrypt = requireFromApp('bcryptjs');
      await sql.unsafe(
        `UPDATE ${schema}.ewoh_user SET password_hash = $2, _updated_at = now() WHERE username = $1`,
        [username, bcrypt.hashSync(password, 12)],
      );
    }
    if (wantsRoleUpdate) {
      await sql.unsafe(
        `UPDATE ${schema}.ewoh_user SET roles = $2, _updated_at = now() WHERE username = $1`,
        [username, sql.json(roles)],
      );
    }
    if (opts.flags.has('update-person')) {
      // 唯一索引 (org_id, person_id) 会拒绝"一人绑多账号"——这是有意的：
      // 若同一人员已被别的账号绑定，先对该账号 --update-person（不带 --person-id）
      // 解除，再绑定新账号。
      await sql.unsafe(
        `UPDATE ${schema}.ewoh_user SET person_id = $2, _updated_at = now() WHERE username = $1`,
        [username, opts.personId ?? null],
      );
    }
    if (deactivate || activate) {
      await sql.unsafe(
        `UPDATE ${schema}.ewoh_user SET status = $2, _updated_at = now() WHERE username = $1`,
        [username, deactivate ? 'disabled' : 'active'],
      );
    }
    console.log(`已更新账号 ${username}：${changes.join('；')}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // 唯一索引冲突翻译成可执行指引：原始 "duplicate key value violates unique
  // constraint" 不会告诉运维下一步该做什么。
  if (/uq_ewoh_user_org_person/.test(message)) {
    console.error(
      '错误：该业务人员已绑定到另一个账号（唯一索引 uq_ewoh_user_org_person）。\n'
        + '一个人员在同一组织内只能有一个登录账号，否则"本人"失去唯一性。\n'
        + '处置：先对旧账号解除绑定（--update-person 且不带 --person-id），再绑定新账号。',
    );
    process.exitCode = 1;
    return;
  }
  console.error(`错误：${message}`);
  process.exitCode = /未设置|不存在|owner 连接/.test(message) ? 2 : 1;
});
