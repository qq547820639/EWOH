/**
 * R-08 codemod：把 `X instanceof Error ? X.message : FALLBACK` 三元收敛到
 * errorContract 的 errorMessage()/errorDescription()。
 *
 * 形态映射：
 *   X instanceof Error ? X.message : String(X)   → errorMessage(X)
 *   X instanceof Error ? X.message : undefined   → errorDescription(X)
 *   X instanceof Error ? X.message : '字面量'     → errorMessage(X, '字面量')
 *
 * 仅处理 client/src（排除 errorContract 自身与测试）；自动补 import。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'client', 'src');
const SKIP = new Set([path.join(ROOT, 'lib', 'errorContract.ts')]);
const IMPORT_LINE = "import { errorMessage, errorDescription } from '../lib/errorContract';";
const IMPORT_LINE_ALIASED =
  "import { errorMessage, errorDescription } from '@client/src/lib/errorContract';";

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) yield full;
  }
}

const RE_STRING = /(\w+)\s+instanceof Error\s*\?\s*\1\.message\s*:\s*String\(\1\)/g;
const RE_UNDEF = /(\w+)\s+instanceof Error\s*\?\s*\1\.message\s*:\s*undefined/g;
const RE_LITERAL = /(\w+)\s+instanceof Error\s*\?\s*\1\.message\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;

let touched = 0;
let replaced = 0;
for (const file of walk(ROOT)) {
  if (SKIP.has(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (!/instanceof Error\s*\?\s*\w+\.message/.test(src)) continue;
  let out = src;
  let count = 0;
  out = out.replace(RE_STRING, (_m, v) => { count += 1; return `errorMessage(${v})`; });
  out = out.replace(RE_UNDEF, (_m, v) => { count += 1; return `errorDescription(${v})`; });
  out = out.replace(RE_LITERAL, (_m, v, lit) => { count += 1; return `errorMessage(${v}, ${lit})`; });
  if (count === 0) continue;
  if (!/from '.*errorContract'|from "@.*errorContract"/.test(out)) {
    const usesDesc = /errorDescription\(/.test(out);
    const usesMsg = /errorMessage\(/.test(out);
    const names = usesMsg && usesDesc ? '{ errorMessage, errorDescription }' : usesDesc ? '{ errorDescription }' : '{ errorMessage }';
    const importLine = /from '@client\//.test(out)
      ? `import ${names} from '@client/src/lib/errorContract';`
      : `import ${names} from '${path.relative(path.dirname(file), path.join(ROOT, 'lib', 'errorContract.ts')).replace(/\\/g, '/').replace(/^([^./])/, './$1').replace(/\.ts$/, '')}';`;
    const lines = out.split('\n');
    let insertAt = 0;
    for (let i = 0; i < Math.min(lines.length, 30); i += 1) {
      if (/^import /.test(lines[i])) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, importLine);
    out = lines.join('\n');
  }
  fs.writeFileSync(file, out);
  touched += 1;
  replaced += count;
  console.log(`${path.relative(ROOT, file)}: ${count}`);
}
console.log(`\nfiles: ${touched}, replacements: ${replaced}`);
