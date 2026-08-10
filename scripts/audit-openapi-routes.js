#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const ts = requireFromApp('typescript');
const yaml = requireFromApp('js-yaml');

const HTTP_DECORATORS = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  // SSE 端点是 HTTP GET + text/event-stream（如 scheduler.controller.ts @Sse('v2/stream')）
  ['Sse', 'GET'],
]);

function parseArgs(argv) {
  const options = {
    spec: 'openapi/ewoh.yaml',
    controllers: 'ewoh-spark-app/server',
    json: false,
    strict: false,
    manifest: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '--spec') {
      options.spec = argv[++index];
    } else if (argument === '--controllers') {
      options.controllers = argv[++index];
    } else if (argument === '--write-manifest') {
      options.manifest = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.spec || !options.controllers) {
    throw new Error('--spec and --controllers require a path');
  }
  return options;
}

function controllerFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return controllerFiles(fullPath);
    }
    return entry.name.endsWith('.controller.ts') ? [fullPath] : [];
  });
}

function decorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}

function decoratorCall(decorator) {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
    return null;
  }
  const argument = expression.arguments[0];
  const value =
    argument &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ? argument.text
      : '';
  return { name: expression.expression.text, value };
}

function routePath(prefix, route) {
  return `/${prefix || ''}/${route || ''}`
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
}

function extractControllerOperations(directory) {
  const operations = [];
  for (const file of controllerFiles(directory)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) {
        return;
      }
      const controller = decorators(node)
        .map(decoratorCall)
        .find((candidate) => candidate?.name === 'Controller');
      if (!controller) {
        return;
      }
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) {
          continue;
        }
        for (const candidate of decorators(member).map(decoratorCall).filter(Boolean)) {
          const method = HTTP_DECORATORS.get(candidate.name);
          if (!method) {
            continue;
          }
          operations.push({
            method,
            path: routePath(controller.value, candidate.value),
            file: path.relative(root, file),
          });
        }
      }
    });
  }
  return operations;
}

function extractSpecOperations(specPath) {
  const document = yaml.load(fs.readFileSync(specPath, 'utf8'));
  if (!document || typeof document !== 'object' || !document.paths) {
    throw new Error(`OpenAPI document has no paths: ${path.relative(root, specPath)}`);
  }
  const operations = [];
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of HTTP_DECORATORS.values()) {
      if (item?.[method.toLowerCase()]) {
        operations.push({ method, path: route });
      }
    }
  }
  return operations;
}

function operationKey(operation) {
  return `${operation.method} ${operation.path}`;
}

/**
 * Manifest 键集合：去重 + 排序。
 * specKeys 来自 ewoh.yaml 与 work-orchestration.yaml 两本 spec 的操作并集，
 * 同一路由可能同时出现在两本 spec 中（GET 路由大量重叠），原始数组含重复项；
 * manifest 必须可复现且键唯一（“每个路由恰好出现一次”）。
 */
function uniqueSortedKeys(operations) {
  return [...new Set(operations.map(operationKey))].sort();
}

function auditRoutes(controllerOperations, specOperations) {
  const controllerKeys = new Map(
    controllerOperations.map((operation) => [operationKey(operation), operation]),
  );
  const specKeys = new Map(
    specOperations.map((operation) => [operationKey(operation), operation]),
  );
  const undocumented = controllerOperations
    .filter((operation) => !specKeys.has(operationKey(operation)))
    .sort((left, right) => operationKey(left).localeCompare(operationKey(right)));
  const unimplemented = specOperations
    .filter((operation) => !controllerKeys.has(operationKey(operation)))
    .sort((left, right) => operationKey(left).localeCompare(operationKey(right)));
  return {
    controllerOperations: controllerOperations.length,
    specOperations: specOperations.length,
    documentedControllerOperations: controllerOperations.length - undocumented.length,
    undocumented,
    unimplemented,
  };
}

function printText(result, spec) {
  console.log(`OpenAPI route audit: ${spec}`);
  console.log(`Controller operations: ${result.controllerOperations}`);
  console.log(`Spec operations: ${result.specOperations}`);
  console.log(`Documented controller operations: ${result.documentedControllerOperations}`);
  console.log(`Undocumented controller operations: ${result.undocumented.length}`);
  for (const operation of result.undocumented) {
    console.log(`  + ${operationKey(operation)} (${operation.file})`);
  }
  console.log(`Specified but unimplemented operations: ${result.unimplemented.length}`);
  for (const operation of result.unimplemented) {
    console.log(`  - ${operationKey(operation)}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const specPath = path.resolve(root, options.spec);
  const controllerPath = path.resolve(root, options.controllers);
  const specOperations = extractSpecOperations(specPath);
  const orchestrationSpec = path.resolve(root, 'openapi/work-orchestration.yaml');
  if (fs.existsSync(orchestrationSpec)) {
    specOperations.push(...extractSpecOperations(orchestrationSpec));
  }
  const controllerOperations = extractControllerOperations(controllerPath);
  const result = auditRoutes(controllerOperations, specOperations);
  if (options.manifest) {
    // 刻意不写 generatedAt：manifest 必须由当前 spec + controllers 字节级可复现
    // 生成（两次生成输出一致），任何时间戳都会破坏可复现性。
    const manifest = {
      spec: path.relative(root, specPath),
      controllerKeys: uniqueSortedKeys(controllerOperations),
      specKeys: uniqueSortedKeys(specOperations),
      ...result,
    };
    const manifestPath = path.resolve(root, options.manifest);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Route manifest written: ${path.relative(root, manifestPath)}`);
  }
  if (options.json) {
    console.log(JSON.stringify({ spec: path.relative(root, specPath), ...result }, null, 2));
  } else {
    printText(result, path.relative(root, specPath));
  }
  if (options.strict && (result.undocumented.length > 0 || result.unimplemented.length > 0)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  auditRoutes,
  extractControllerOperations,
  extractSpecOperations,
  operationKey,
  parseArgs,
  routePath,
};
