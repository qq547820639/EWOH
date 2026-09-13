/* FE-2 后端角色事实源解析器：把 server/modules/**\/*.controller.ts 的
 * @Controller / @Get|@Post… / @Roles / @FallbackRoles / @Public 静态解析成
 * 「路由 → 有效角色集」表，供 roleMatrix.test.ts 与前端 navGroups 比对。
 *
 * 为什么是源码解析而不是 import 控制器：controller 文件用的是 legacy 装饰器
 * （experimentalDecorators），在 client 的 ts-jest 配置下 require 会在
 * @Query()/@Req() 参数装饰器处抛 "Cannot read properties of undefined"，
 * 因此只能解析文本。唯一的"真值"仍来自 server 源码本身（含 FALLBACK 映射表
 * 与 ANY_AUTHENTICATED_ROLES 常量都直接 require 真实文件，不复制一份）。
 *
 * 解析口径与 server/modules/shared/roles.guard.ts 的 canActivate 一致：
 *   方法级 @Roles > 方法级 @FallbackRoles > 类级 @Roles > 类级 @FallbackRoles
 *   > FALLBACK_CONTROLLER_ROLES[类名]；完全无声明 = 默认拒绝（roles 为空）。
 * 2026-09-13 对抗自查补口：
 *   · `@Roles(...CONST)`：解析同文件 `export const CONST = [...]`（其余情形抛错，
 *     绝不静默回退类级角色——那会把窄放行面放大成类级放行面）；
 *   · `@Sse('x')` 按 GET 路由登记（Nest 底层即 GET，漏记会让"零遗漏"门禁失明）；
 *   · `@Get(['/', '*'])` 数组路径逐元素展开成多条路由。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiRef, HttpMethod } from './roleMatrix';

export interface BackendRoute {
  controller: string;
  method: HttpMethod;
  path: string;
  /** 有效角色集；@Public 路由为空数组。 */
  roles: string[];
  isPublic: boolean;
  /**
   * 角色来自 `...ANY_AUTHENTICATED_ROLES`（= 任何已登录用户可读）。
   * 这类路由表达的是"开放读"，前端导航按任务域裁剪是产品决策，
   * 不属于"服务端放行但无入口"缺陷，故不参与 dead-entry 门禁。
   */
  open: boolean;
}

const HTTP_VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Sse'] as const;
// @Sse 在 Nest 底层注册为 GET 路由（SSE 流），事实方法必须记成 GET，
// 否则 SSE 路由会整条从路由表里消失（2026-09-13 对抗自查实测漏掉
// GET /api/scheduler/v2/stream，"零遗漏"门禁对它失明）。
const VERB_HTTP_METHOD: Record<(typeof HTTP_VERBS)[number], HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Sse: 'GET',
};
const VERB_RE = new RegExp(`@(${HTTP_VERBS.join('|')})\\((.*?)\\)`, 'g');
const CONTROLLER_RE = /@Controller\(([^)]*)\)/g;
const ROLES_RE = /@Roles\(([^)]*)\)/g;
const FALLBACK_ROLES_RE = /@FallbackRoles\(([^)]*)\)/g;
const CLASS_RE = /export class (\w+Controller)/g;
const ANY_AUTH = 'ANY_AUTHENTICATED_ROLES';

/** 装饰器块里的续行：装饰器本身、注解/注释行、参数列表续行。 */
function isDecoratorLine(line: string): boolean {
  const s = line.trim();
  if (s === '') return false;
  return (
    s.startsWith('@') ||
    s.startsWith('//') ||
    s.startsWith('/*') ||
    s.startsWith('*') ||
    s.startsWith("'") ||
    s.startsWith('"') ||
    s.endsWith(')')
  );
}

/** 取 index 之前紧邻的那一段装饰器（允许中间夹杂注释与多行参数）。 */
function decoratorBlockBefore(source: string, index: number): string {
  const lines = source.slice(0, index).split('\n');
  const block: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (isDecoratorLine(line)) {
      block.unshift(line);
    } else {
      break;
    }
  }
  return block.join('\n');
}

function lastMatch(source: string, re: RegExp): string | null {
  let found: string | null = null;
  const global = new RegExp(re.source, 'g');
  let m = global.exec(source);
  while (m) {
    found = m[1];
    m = global.exec(source);
  }
  return found;
}

interface RolesDecl {
  roles: string[];
  open: boolean;
}

/**
 * 解析 @Roles/@FallbackRoles 的参数为角色集。
 *
 * 2026-09-13 修复：`@Roles(...SOME_CONST)`（常量展开）此前会因匹配不到字符串字面量
 * 被当成"未声明"，静默回退到类级角色/FALLBACK 表——实测把 POST /api/approvals/:id/bypass
 * （实际只有 global_admin）解析成类级三角色、把 POST /api/shifts（SHIFT_WRITE_ROLES 四角色）
 * 解析成 ANY_AUTH 七角色，等于在机器门禁里复活了服务端已修掉的放行面缺陷（I2）。
 * 现在：同文件 `export const NAME = [...]` 的常量直接解析；解析不到就**抛错**（fail-loud），
 * 绝不静默回退——路由表是门禁的事实源，宁可解析失败也不给假的放行面。
 */
function parseRoles(
  args: string | null,
  anyAuthenticated: string[],
  fileConstants: Record<string, string[]>,
): RolesDecl | null {
  if (args === null || args.trim() === '') return null;
  if (args.includes(ANY_AUTH)) {
    return { roles: [...anyAuthenticated], open: true };
  }
  const roles = [...args.matchAll(/'([A-Za-z_]\w*)'/g)].map((m) => m[1]);
  for (const m of args.matchAll(/\.\.\.\s*([A-Za-z_]\w*)/g)) {
    const name = m[1];
    const resolved = fileConstants[name];
    if (!resolved) {
      throw new Error(
        `roleMatrixBackend 无法解析 @Roles(...${name})：该常量未定义在同一 controller 文件内。` +
          '为了不伪造放行面，这里选择失败而不是回退到类级角色；请把常量定义移入该文件或扩展本解析器。',
      );
    }
    roles.push(...resolved);
  }
  return roles.length > 0 ? { roles, open: false } : null;
}

/**
 * 抽取 controller 源文件内 `export const NAME = ['a', 'b']`（含 `as const`、多行、
 * `: readonly string[]` 类型注解）定义的角色常量，供 @Roles(...NAME) 同文件解析。
 */
function extractFileRoleConstants(source: string): Record<string, string[]> {
  const constants: Record<string, string[]> = {};
  const re = /export\s+const\s+([A-Za-z_]\w*)\s*(?::[^=]+?)?=\s*\[([^\]]*)\]/g;
  for (const m of source.matchAll(re)) {
    constants[m[1]] = [...m[2].matchAll(/'([A-Za-z_]\w*)'/g)].map((x) => x[1]);
  }
  return constants;
}

/** @Get/@Post… 的路径参数 → 一条或多条子路径（数组形式逐元素展开，如 @Get(['/', '*'])）。 */
function verbSubPaths(arg: string): string[] {
  const trimmed = arg.trim();
  if (trimmed.startsWith('[')) {
    return [...trimmed.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  }
  return [trimmed.replace(/^['"]|['"]$/g, '')];
}

function collectControllerFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectControllerFiles(full, out);
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
}

/** 直接复用 server 的真实常量：FALLBACK 映射表 + ANY_AUTHENTICATED_ROLES。 */
export function loadServerRoleSources(appRoot: string): {
  fallback: Record<string, string[]>;
  anyAuthenticated: string[];
} {
  // client jest 下必须用 require 读 server 源码（见文件头），这里显式豁免
  // no-require-imports 规则（no-var-requires 在本配置下不生效，留只会报 unused）。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const policy = require(
    path.join(appRoot, 'server/modules/shared/route-role.policy.ts'),
  ) as { FALLBACK_CONTROLLER_ROLES: Record<string, string[]> };
  const decorator = require(
    path.join(appRoot, 'server/modules/shared/roles.decorator.ts'),
  ) as { ANY_AUTHENTICATED_ROLES: readonly string[] };
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    fallback: policy.FALLBACK_CONTROLLER_ROLES,
    anyAuthenticated: [...decorator.ANY_AUTHENTICATED_ROLES],
  };
}

/** 解析一个 controller 源文件为若干条路由。 */
export function parseControllerSource(
  source: string,
  fallback: Record<string, string[]>,
  anyAuthenticated: string[],
): BackendRoute[] {
  const routes: BackendRoute[] = [];
  const fileConstants = extractFileRoleConstants(source);
  const classMatches = [...source.matchAll(CLASS_RE)];
  classMatches.forEach((cls, idx) => {
    const className = cls[1];
    const classIndex = cls.index ?? 0;
    const block = decoratorBlockBefore(source, classIndex);

    const controllerPrefix = lastMatch(block, CONTROLLER_RE);
    const prefix = controllerPrefix ? controllerPrefix.trim().replace(/^['"]|['"]$/g, '') : '';

    const classRoles = parseRoles(lastMatch(block, ROLES_RE), anyAuthenticated, fileConstants);
    const classFallback = parseRoles(lastMatch(block, FALLBACK_ROLES_RE), anyAuthenticated, fileConstants);
    const classPublic = /@Public\(/.test(block);

    const nextClassIndex =
      idx + 1 < classMatches.length ? (classMatches[idx + 1].index ?? source.length) : source.length;
    const body = source.slice(classIndex, nextClassIndex);

    // 方法之间以空行分隔 → 按空行切块，每块 = 一个方法的装饰器 + 签名 + 实现。
    for (const chunk of body.split(/\n\s*\n/)) {
      const verbs = [...chunk.matchAll(new RegExp(VERB_RE.source, 'g'))];
      if (verbs.length === 0) continue;

      const method = VERB_HTTP_METHOD[verbs[0][1] as (typeof HTTP_VERBS)[number]];
      // 取该块里最后出现的非空路径参数作为子路径（多装饰器堆叠时以最具体者为准）；
      // 数组形式（@Get(['/', '*'])）逐元素展开成多条路由（Nest 即如此注册）。
      let subPathArg = '';
      for (const verb of verbs) {
        const candidate = verb[2].trim();
        if (candidate) subPathArg = candidate;
      }

      const methodRoles = parseRoles(lastMatch(chunk, ROLES_RE), anyAuthenticated, fileConstants);
      const methodFallback = parseRoles(lastMatch(chunk, FALLBACK_ROLES_RE), anyAuthenticated, fileConstants);
      const effective =
        methodRoles ??
        methodFallback ??
        classRoles ??
        classFallback ??
        (fallback[className] && fallback[className].length > 0
          ? { roles: [...fallback[className]], open: false }
          : null);

      const subPaths = verbSubPaths(subPathArg);
      for (const subPath of subPaths) {
        // 合并前缀与子路径并折叠多余斜杠（@Get('/') + 无前缀 → '//' → '/'；
        // Nest 的 joinPaths 同样折叠，路由表要与之对齐才能做字面量匹配）。
        const routePath = `/${prefix}${subPath ? `/${subPath}` : ''}`.replace(/\/{2,}/g, '/');
        routes.push({
          controller: className,
          method,
          path: routePath,
          roles: effective?.roles ?? [],
          isPublic: classPublic || /@Public\(/.test(chunk),
          open: effective?.open ?? false,
        });
      }
    }
  });
  return routes;
}

/** 扫描 server/modules 下全部 controller，产出后端路由 → 角色事实表。 */
export function buildBackendRouteTable(modulesRoot: string, appRoot: string): BackendRoute[] {
  const { fallback, anyAuthenticated } = loadServerRoleSources(appRoot);
  const files: string[] = [];
  collectControllerFiles(modulesRoot, files);
  return files.flatMap((file) =>
    parseControllerSource(fs.readFileSync(file, 'utf8'), fallback, anyAuthenticated),
  );
}

/** 在路由表里按「方法 + 字面路径」定位契约路由（找不到 = 后端删改，属硬失败）。 */
export function findBackendRoute(
  table: BackendRoute[],
  ref: ApiRef,
): BackendRoute | undefined {
  return table.find((route) => route.method === ref.method && route.path === ref.path);
}
