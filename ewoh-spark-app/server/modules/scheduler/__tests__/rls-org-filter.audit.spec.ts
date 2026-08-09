/* D2：调度读路径 RLS 组织过滤审计测试
 *
 * 背景（系统性走读）：ewoh_world_state_snapshot / ewoh_outbox /
 * ewoh_assignment_event / ewoh_replan_trigger / ewoh_scheduling_run
 * 为非 RLS 表，靠应用层 org 过滤（Actor.primaryOrgId 显式 where 条件），
 * 此前缺自动审计。
 *
 * 选型理由（与现有 __tests__ 基建一致，纯静态、无 DB 依赖）：
 * 调度模块测试用轻量 fake db（thenable 链），无法用 drizzle toSQL() 抓真实 SQL；
 * 因此采用 TypeScript AST 静态扫描：对 scheduler 模块 *.service.ts 中
 * `this.db.select()...from(非RLS表)` 的读路径，断言其所在方法存在应用层 org
 * 过滤（方法文本含 `orgId`/`org_id`）或命中显式 allowlist（键查询/聚合/已知缺口）。
 *
 * 捕获能力（验收要求，静态文本启发式局限声明）：
 * - 新增读路径未带 org 过滤且未登记 → 测试失败（回归捕获）——这是本测试**可靠捕获**的场景；
 * - 移除现有 org 过滤但方法文本仍残留 `orgId`/`org_id` 字样（如注释、未使用变量、
 *   无关字符串）→ 测试不会失败，属**已知假阴性边界**：静态文本启发式只能证明"方法文本
 *   含 org 字样"，无法证明"过滤仍在生效"；真正移除过滤但残留字样不会被本测试捕获，
 *   需要 code review / 运行时 SQL 断言兜底；
 * - 反例验证见 test_audit_flags_unfiltered_read（合成坏方法被捕获）。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** 非 RLS 表（schema.ts 导出名 → SQL 表名）。 */
const NON_RLS_TABLES = new Set([
  'ewohWorldStateSnapshot',
  'ewohOutbox',
  'ewohAssignmentEvent',
  'ewohReplanTrigger',
  'ewohSchedulingRun',
]);

/**
 * 显式 allowlist：键查询/聚合/已知缺口的读路径。
 * key = `${fileName}::${methodName}`；reason 说明为何无需 org 过滤。
 */
const ALLOWLIST: Record<string, string> = {
  'outbox.service.ts::enqueueThrottled':
    '去重查找按 eventType+entityId 全局唯一键命中同实体 pending 行（org 不变），非列表暴露',
  'outbox.service.ts::latestSequence': '聚合 max(sequence)，不返回业务行',
  'outbox.service.ts::listSince':
    'sequence 键全局事件日志（SSE 重放）。org 隔离为已知缺口：SSE replaySince 接线不在本次修复范围',
  'outbox.service.ts::listLatest':
    'sequence 键全局事件日志（SSE 轮询/快照）。org 隔离为已知缺口：SSE replaySince 接线不在本次修复范围',
  'world-state.service.ts::getSnapshot': 'snapshotVersion 全局唯一版本键查询（快照按版本存取）',
  'world-state.service.ts::nextSnapshotVersion': '版本号派生 prefix 匹配，不暴露业务行',
  'trigger.service.ts::getTriggerByKey': 'triggerKey 全局唯一幂等键查询',
  'scheduler.service.ts::getRun': 'runId 全局唯一主键查询',
};

export interface ReadPathViolation {
  file: string;
  method: string;
  table: string;
  line: number;
}

export function findReadChains(source: ts.SourceFile) {
  const chains: Array<{
    table: string;
    methodName: string;
    methodText: string;
    line: number;
  }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'from' &&
        callee.expression &&
        node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (ts.isIdentifier(arg) && NON_RLS_TABLES.has(arg.text)) {
          // 确认链根是 this.db（避免误扫其他对象的 .from）
          const outermost = outermostChainCall(node);
          const chainText = outermost.getText(source);
          if (chainText.startsWith('this.db')) {
            const method = enclosingMethod(node);
            const methodName = method ? methodNameOf(method) : '<top-level>';
            chains.push({
              table: arg.text,
              methodName,
              methodText: method ? method.getText(source) : '',
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return chains;
}

function outermostChainCall(node: ts.CallExpression): ts.CallExpression {
  let cur = node;
  let parent = cur.parent;
  while (
    parent &&
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.expression === cur
  ) {
    cur = parent;
    parent = cur.parent;
  }
  return cur;
}

function enclosingMethod(node: ts.Node): ts.MethodDeclaration | ts.FunctionDeclaration | null {
  let cur = node.parent;
  while (cur) {
    if (ts.isMethodDeclaration(cur) || ts.isFunctionDeclaration(cur)) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function methodNameOf(method: ts.MethodDeclaration | ts.FunctionDeclaration): string {
  const name = method.name;
  if (name && ts.isIdentifier(name)) return name.text;
  return '<anonymous>';
}

/** 检查一个源文件的非 RLS 读路径，返回违规列表。 */
export function auditSource(fileName: string, sourceText: string): ReadPathViolation[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: ReadPathViolation[] = [];
  for (const chain of findReadChains(source)) {
    const key = `${path.basename(fileName)}::${chain.methodName}`;
    const orgFiltered = chain.methodText.includes('.orgId') || chain.methodText.includes('org_id');
    if (orgFiltered) continue;
    if (ALLOWLIST[key]) continue;
    violations.push({
      file: fileName,
      method: chain.methodName,
      table: chain.table,
      line: chain.line,
    });
  }
  return violations;
}

describe('D2 调度读路径 RLS 组织过滤审计', () => {
  const moduleDir = path.join(__dirname, '..');
  const serviceFiles = fs
    .readdirSync(moduleDir)
    .filter((f) => f.endsWith('.service.ts'))
    .map((f) => path.join(moduleDir, f));

  it('所有调度读路径（非 RLS 表）均具备应用层 org 过滤或显式 allowlist', () => {
    const violations: ReadPathViolation[] = [];
    for (const file of serviceFiles) {
      violations.push(...auditSource(file, fs.readFileSync(file, 'utf8')));
    }
    expect(violations).toEqual([]);
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        '非 RLS 表读路径缺失 org 过滤：',
        violations.map((v) => `${v.file}:${v.line} ${v.method} → ${v.table}`),
      );
    }
  });

  it('新增读路径未带 org 过滤且未登记 → 被审计捕获（反例验证）', () => {
    // 模拟回归：新增一个读 ewohOutbox 的方法，无 org 过滤、无 allowlist 登记。
    const badSource = `
      import { ewohOutbox } from '@server/database/schema';
      import { gt } from 'drizzle-orm';
      export class EvilService {
        async leak(since: number) {
          return this.db.select().from(ewohOutbox).where(gt(ewohOutbox.sequence, since));
        }
      }
    `;
    const violations = auditSource('evil.service.ts', badSource);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].table).toBe('ewohOutbox');
  });

  it('移除现有 org 过滤 → 被审计捕获（反例验证）', () => {
    // 模拟回归：trigger.service.latestTrigger 原本按 orgId 过滤，被人误删。
    const badSource = `
      import { ewohReplanTrigger } from '@server/database/schema';
      export class TriggerService {
        async latestTrigger(orgKey: string, triggerType: string) {
          return this.db
            .select()
            .from(ewohReplanTrigger)
            .where(eq(ewohReplanTrigger.triggerType, triggerType))
            .orderBy(desc(ewohReplanTrigger.createdAt))
            .limit(1);
        }
      }
    `;
    // 方法文本不再含 .orgId → 且不在 allowlist → 捕获
    const violations = auditSource('trigger.service.ts', badSource);
    expect(violations.some((v) => v.method === 'latestTrigger')).toBe(true);
  });

  it('带 org 过滤的读路径不被误报（正例）', () => {
    const goodSource = `
      import { ewohSchedulingRun } from '@server/database/schema';
      export class RunService {
        async listRuns(actor?: { primaryOrgId: string }) {
          const conditions = [];
          if (actor?.primaryOrgId) {
            conditions.push(eq(ewohSchedulingRun.orgId, actor.primaryOrgId));
          }
          return this.db.select().from(ewohSchedulingRun).where(and(...conditions));
        }
      }
    `;
    expect(auditSource('scheduler.service.ts', goodSource)).toEqual([]);
  });
});
