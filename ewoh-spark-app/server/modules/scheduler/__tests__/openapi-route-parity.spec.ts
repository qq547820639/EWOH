/**
 * OpenAPI 路由双向一致性 Jest 门禁（与 scripts/audit-openapi-routes.js --strict 等价）。
 *
 * 直接读取仓库根 openapi/route-manifest.json + openapi/ewoh.yaml +
 * openapi/work-orchestration.yaml，无 HTTP、确定性、快速：
 *  - manifest 键唯一（无重复 GET/POST/... 键）；
 *  - manifest 与当前两本 spec 的实时扫描一致（manifest 过期即失败）；
 *  - 每个 controller 路由均已文档化（controllerKeys ⊆ spec 路径并集）；
 *  - 每个已文档化路径均已实现（spec 路径并集 ⊆ controllerKeys）；
 *  - GET /api/scheduler/context 已文档化。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../../');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

function operationKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

function readJson(relativePath: string): {
  controllerKeys: string[];
  specKeys: string[];
} {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

/** 从一本 spec 提取操作键（与 scripts/audit-openapi-routes.js extractSpecOperations 同语义）。 */
function specOperationKeys(relativePath: string): string[] {
  const document = load(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const keys: string[] = [];
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item?.[method]) {
        keys.push(operationKey(method, route));
      }
    }
  }
  return keys;
}

/** 两本 spec 的并集键（去重 + 排序，与 manifest 写入端一致）。 */
function liveSpecKeys(): string[] {
  const keys = [
    ...specOperationKeys('openapi/ewoh.yaml'),
    ...specOperationKeys('openapi/work-orchestration.yaml'),
  ];
  return [...new Set(keys)].sort();
}

describe('OpenAPI 路由一致性（route-manifest ↔ specs ↔ controllers）', () => {
  const manifest = readJson('openapi/route-manifest.json');
  const specKeys = liveSpecKeys();
  const specKeySet = new Set(specKeys);

  it('manifest.controllerKeys 无重复键', () => {
    expect(new Set(manifest.controllerKeys).size).toBe(manifest.controllerKeys.length);
  });

  it('manifest.specKeys 无重复键（两本 spec 路由重叠会产生重复 GET 键，必须去重）', () => {
    expect(new Set(manifest.specKeys).size).toBe(manifest.specKeys.length);
  });

  it('manifest 与当前两本 spec 的实时扫描一致（manifest 未过期）', () => {
    expect(manifest.specKeys).toEqual(specKeys);
  });

  it('每个 controller 路由均已文档化（无未文档化路由）', () => {
    const undocumented = manifest.controllerKeys.filter((key) => !specKeySet.has(key));
    expect(undocumented).toEqual([]);
  });

  it('每个已文档化路径均已实现（无已文档化但未实现路由）', () => {
    const unimplemented = specKeys.filter((key) => !manifest.controllerKeys.includes(key));
    expect(unimplemented).toEqual([]);
  });

  it('GET /api/scheduler/context 已文档化且已实现', () => {
    expect(manifest.controllerKeys).toContain('GET /api/scheduler/context');
    expect(specKeySet.has('GET /api/scheduler/context')).toBe(true);
  });
});
