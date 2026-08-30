/**
 * R-08 codemod 后续修复：把错位插入的 errorMessage/errorDescription import
 * 行移动到第一个完整 import 语句之后（codemod 曾把行插进多行 import 中间）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'client', 'src');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

const RE_BAD_IMPORT =
  /^import \{ (?:errorMessage, errorDescription|errorMessage|errorDescription) \} from '(?:\.\.?\/[^']*|@client\/src\/lib\/errorContract)';$/;

let fixed = 0;
for (const file of walk(ROOT)) {
  if (file.includes('errorContract.ts')) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const badIdx = lines.findIndex((l) => RE_BAD_IMPORT.test(l.trim()));
  if (badIdx === -1) continue;
  const importLine = lines[badIdx];
  // 判定错位：上一行或下一行构成多行 import 的一部分（即不以合法语句边界收尾）。
  const prev = (lines[badIdx - 1] ?? '').trim();
  const next = (lines[badIdx + 1] ?? '').trim();
  const misplaced =
    prev === 'import {' ||
    prev.endsWith('{') ||
    (next === 'Dialog,' || next.endsWith(',') || next === '} from') === false &&
      prev !== '' &&
      !/^(import|export|\/\/|\/\*|\*|const|let|type)/.test(prev);
  if (!misplaced && prev !== 'import {' && !prev.endsWith('{')) continue;

  lines.splice(badIdx, 1); // 移除错位行
  // 重新定位：第一个以 `import ` 开头的语句，扫描到其结束行。
  let firstImport = lines.findIndex((l) => /^import /.test(l));
  if (firstImport === -1) {
    lines.unshift(importLine);
  } else {
    let cursor = firstImport;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (/from ['"]/.test(line) && /\)?\s*;?\s*$/.test(line)) break;
      if (/^\s*\}\s*from ['"]/.test(line)) break;
      if (!/import |^\s*\{?$|^\s*[\w, ]+,?$/.test(line)) break;
      cursor += 1;
    }
    lines.splice(cursor + 1, 0, importLine);
  }
  fs.writeFileSync(file, lines.join('\n'));
  fixed += 1;
  console.log(`fixed: ${path.relative(ROOT, file)}`);
}
console.log(`\nfixed files: ${fixed}`);
