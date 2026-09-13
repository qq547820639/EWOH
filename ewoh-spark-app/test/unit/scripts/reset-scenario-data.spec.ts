/**
 * 场景复位脚本回归（议题 R-1：本地/测试库无界累积）。
 *
 * 锁定的不变量：
 *  1. 默认 dry-run、必须 --yes 才写库；--purge-derived 必须显式请求。
 *  2. 必须显式 --org-id，且必须是合法 uuid（拒绝"猜一个 org 然后清空它"）。
 *  3. --purge-derived 的清理范围是**白名单**：覆盖派生的/累积的运行时事实，
 *     但绝不包含配置类种子（人、设备、班次、模板、策略基线…）。
 *  4. dry-run 预览路径只发 SELECT，绝不发 DELETE/UPDATE（"预览不写库"）。
 *  5. 执行路径逐表 DELETE 且逐表回报删除行数；org 一律参数绑定，内联即失败。
 *
 * 说明：本 spec 不连数据库——用假的 sql 句柄把「读/写路径」的差异钉死，
 * CLI 层用 spawnSync 覆盖拒绝分支（无 org、非法 uuid、缺连接串）。
 */

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(__dirname, '../../../..');
const scriptPath = resolve(root, 'db/runner/reset-scenario-data.js');
const script = require(scriptPath);

/** 假 sql 句柄：记录收到的每条 SQL，按表名返回预置行数。 */
function makeFakeSql(counts: Record<string, number>, opts: { missing?: Set<string> } = {}) {
  const calls: string[] = [];
  const tableOf = (query: string): string => {
    const match = query.match(/FROM public\.(\w+)/);
    if (!match) throw new Error(`无法从 SQL 解析表名：${query}`);
    return match[1];
  };
  const sql = {
    unsafe: async (query: string, params?: unknown[]) => {
      calls.push(query);
      if (/^SELECT to_regclass/.test(query)) {
        const present = !opts.missing?.has(String(params?.[0]).replace(/^public\./, ''));
        return [{ present }];
      }
      if (/^SELECT count\(\*\)/.test(query)) {
        return [{ count: counts[tableOf(query)] ?? 0 }];
      }
      if (/^DELETE FROM/.test(query)) {
        // 复刻 postgres.js 语义：不带 RETURNING 的 DELETE 返回空数组 + .count。
        const rows = [] as unknown[] & { count?: number };
        rows.count = counts[tableOf(query)] ?? 0;
        return rows;
      }
      throw new Error(`dry-run 预览不应发出写语句或未知语句：${query}`);
    },
  };
  return { sql, calls };
}

const ORG = '00000000-0000-4000-8000-000000000001';

function runCli(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    // 清空连接串：这些分支必须在**连接数据库之前**就拒绝，不能靠连库失败兜底。
    env: { ...process.env, EWOH_DATABASE_URL: '', SUDA_DATABASE_URL: '' },
  });
}

describe('reset-scenario-data 参数与模式（dry-run / --yes 纪律）', () => {
  it('默认 dry-run：只有显式 --yes 才写库', () => {
    expect(script.resolveOptions({ flags: new Set() }).dryRun).toBe(true);
    expect(script.resolveOptions({ flags: new Set(['purge-derived']) }).dryRun).toBe(true);
    expect(script.resolveOptions({ flags: new Set(['yes']) }).dryRun).toBe(false);
  });

  it('--dry-run 覆盖 --yes（显式预览永远赢）', () => {
    expect(script.resolveOptions({ flags: new Set(['yes', 'dry-run']) }).dryRun).toBe(true);
  });

  it('--purge-derived 必须显式请求，默认不清理累积表', () => {
    expect(script.resolveOptions({ flags: new Set() }).purgeDerived).toBe(false);
    expect(script.resolveOptions({ flags: new Set(['yes']) }).purgeDerived).toBe(false);
    expect(script.resolveOptions({ flags: new Set(['purge-derived']) }).purgeDerived).toBe(true);
  });

  it('parse：识别 --org-id，拒绝未知位置参数与缺失的 uuid', () => {
    expect(script.parse(['--org-id', ORG, '--yes']).orgId).toBe(ORG);
    expect(script.parse(['--org-id', ORG, '--yes']).flags.has('yes')).toBe(true);
    expect(() => script.parse(['--org-id', '--yes'])).toThrow('需要一个 uuid');
    expect(() => script.parse(['bogus'])).toThrow('无法识别的参数');
  });
});

describe('reset-scenario-data 累积表白名单（派生的删，配置的留）', () => {
  const tables: string[] = script.PURGE_TABLES.map((t: { table: string }) => t.table);

  it('覆盖 R-1 的累积源：快照 / 事件 / 排产派生 / outbox / 通知 / 审计', () => {
    for (const expected of [
      'ewoh_world_state_snapshot', 'ewoh_event', 'ewoh_telemetry', 'ewoh_trace_span',
      'ewoh_audit_log', 'ewoh_outbox', 'ewoh_notification', 'ewoh_scheduling_run',
      'ewoh_schedule_plan', 'ewoh_scheduling_plan_assignment', 'ewoh_scheduling_execution',
      'ewoh_scheduling_feedback', 'ewoh_assignment_event', 'ewoh_resource_reservation',
      'ewoh_replan_trigger', 'ewoh_simulation_run',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('绝不包含配置类种子（人 / 设备 / 班次 / 模板 / 策略基线…）', () => {
    const protectedTables: string[] = script.PROTECTED_TABLES;
    expect(new Set(tables).size).toBe(tables.length); // 无重复登记
    for (const table of tables) {
      expect(protectedTables).not.toContain(table);
    }
    // 反向断言：确知是种子的表一个都不能进清理白名单。
    for (const seeded of [
      'ewoh_personnel', 'ewoh_device', 'ewoh_shift', 'ewoh_task_template',
      'ewoh_scheduling_policy', 'ewoh_scheduler_config', 'ewoh_role', 'ewoh_user',
      'ewoh_organization', 'ewoh_spatial_entity',
    ]) {
      expect(tables).not.toContain(seeded);
    }
  });

  it('每条白名单条目都写清了为什么（便于后续核对，不是拍脑袋删）', () => {
    for (const entry of script.PURGE_TABLES) {
      expect(entry.table).toMatch(/^ewoh_[a-z_]+$/);
      expect(typeof entry.why).toBe('string');
      expect(entry.why.length).toBeGreaterThan(0);
      expect(typeof entry.group).toBe('string');
    }
  });
});

describe('reset-scenario-data 逐表计数与 SQL 预览（org 参数绑定，绝不内联）', () => {
  it('buildPurgeStatements：逐表一条，org 走 $1 绑定而非内联', () => {
    const statements = script.buildPurgeStatements('public', ORG);
    expect(statements).toHaveLength(script.PURGE_TABLES.length);
    for (const statement of statements) {
      expect(statement.deleteSql).toMatch(/^DELETE FROM public\.ewoh_[a-z_]+ WHERE org_id::text = \$1$/);
      expect(statement.countSql).toMatch(/^SELECT count\(\*\)::int AS count FROM public\.ewoh_[a-z_]+ WHERE org_id::text = \$1$/);
      expect(statement.deleteSql).not.toContain(ORG); // 未校验租户不得内联
      expect(statement.deleteParams).toEqual([ORG]);
    }
  });

  it('collectPurgeCounts：逐表回报行数（dry-run 只发 SELECT，绝不写库）', async () => {
    const { sql, calls } = makeFakeSql({ ewoh_event: 7, ewoh_world_state_snapshot: 3 });
    const rows = await script.collectPurgeCounts(sql, 'public', ORG);
    expect(rows).toHaveLength(script.PURGE_TABLES.length);
    expect(rows.find((r: { table: string }) => r.table === 'ewoh_event').count).toBe(7);
    expect(rows.find((r: { table: string }) => r.table === 'ewoh_world_state_snapshot').count).toBe(3);
    expect(rows.find((r: { table: string }) => r.table === 'ewoh_scheduling_run').count).toBe(0);
    // 关键不变量：预览路径的每一条语句都是 SELECT。
    expect(calls.every((query) => /^SELECT /.test(query))).toBe(true);
  });

  it('collectPurgeCounts：表不存在时如实标注 missing，不静默当 0', async () => {
    const { sql } = makeFakeSql({}, { missing: new Set(['ewoh_world_snapshot']) });
    const rows = await script.collectPurgeCounts(sql, 'public', ORG);
    const missing = rows.find((r: { table: string }) => r.table === 'ewoh_world_snapshot');
    expect(missing.missing).toBe(true);
    expect(missing.count).toBeNull();
  });

  it('applyPurge：逐表 DELETE 并回报删除行数（复刻 postgres.js 的 .count 语义）', async () => {
    const { sql, calls } = makeFakeSql({ ewoh_event: 11, ewoh_scheduling_run: 5 });
    const rows = await script.applyPurge(sql, 'public', ORG);
    expect(rows.find((r: { table: string }) => r.table === 'ewoh_event').deleted).toBe(11);
    expect(rows.find((r: { table: string }) => r.table === 'ewoh_scheduling_run').deleted).toBe(5);
    expect(rows.find((r: { table: string }) => r.table === 'ewoh_audit_log').deleted).toBe(0);
    expect(calls.filter((query) => /^DELETE FROM/.test(query)).length).toBe(script.PURGE_TABLES.length);
  });

  it('formatPurgePreview：给出将执行的 SQL 与目标 org', () => {
    const preview = script.formatPurgePreview('public', ORG);
    expect(preview).toContain('DELETE FROM public.ewoh_world_state_snapshot');
    expect(preview).toContain(ORG);
  });

  it('规模观测：候选任务数用 pending_dispatch 过滤（求解成本的直接输入）', async () => {
    const entry = script.SCALE_TABLES.find(
      (t: { table: string; filter?: string }) => t.table === 'ewoh_production_task');
    expect(entry.filter).toContain("status = 'pending_dispatch'");
  });
});

describe('reset-scenario-data CLI 拒绝分支（连接库之前就拒绝）', () => {
  it('缺少 --org-id → 退出码 1，并说明必须显式提供', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('必须显式提供 --org-id');
  });

  it('--yes 也不能绕过 --org-id（绝不猜租户）', () => {
    const result = runCli(['--purge-derived', '--yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('必须显式提供 --org-id');
  });

  it('非法 uuid → 退出码 1', () => {
    const result = runCli(['--org-id', 'not-a-uuid']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('不是合法 uuid');
  });

  it('提供合法 org 但缺 EWOH_DATABASE_URL → 退出码 2（前置条件错误）', () => {
    const result = runCli(['--org-id', ORG, '--purge-derived', '--yes']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('EWOH_DATABASE_URL 未设置');
  });

  it('--help → 退出码 0，且帮助里写明默认 dry-run 与 --purge-derived', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--purge-derived');
    expect(result.stdout).toContain('--yes');
  });
});
