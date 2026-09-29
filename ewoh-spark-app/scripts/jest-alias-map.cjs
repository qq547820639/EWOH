#!/usr/bin/env node
/**
 * jest-alias-map.cjs —— 只回答一件事：**这个 jest 跑测档的 moduleNameMapper 应该是什么**，
 * 答案是「由该档自己 ts-jest 用的那份 tsconfig 的 paths 现算」，而不是再手抄一遍。
 *
 * 动因（V342）：路径别名在仓里是两类面各抄一份——`tsconfig*.json` 的 `compilerOptions.paths`（编译期靠它）
 * 与 jest 的 `moduleNameMapper`（运行期只靠它，ts-jest 不会把 paths 变成 mapper）。V341 实测当期 12 个面、
 * 5 个前缀，四份跑测档当时与权威同值，但"以后只改一边"没人拦得住；把 mapper 变成派生物才是真修法。
 *
 * 三条不许打折：
 *  1) **不写死 prefix**。生成器要的 `<rootDir>/…` 由「本配置的 rootDir」与「有效档自己声明的 baseUrl 目录」
 *     现算相对关系得出（本仓 client 档算出 `<rootDir>/../`、后端与 e2e 档算出 `<rootDir>/`）。写死它
 *     等于把手抄算术换个地方继续抄，而算错恰好是两边都不报错的那种（字面不同、目录相同仍判一致）。
 *  2) **沿 extends 链取有效档**：`tsconfig.spec.json`／`client/tsconfig.jest.json` 自己不声明 paths，
 *     直接把它交给生成器会读成空表。TS 的语义是 `paths` **整体覆盖**（不与父档合并），所以取链上
 *     **最近一份自己声明 paths 的档**。
 *  3) **链上撞到指向外部包的 extends 且这一路都没声明 paths ⇒ 抛错拒绝生成**，不静默产出一张缺前缀的表，
 *     也不去 node_modules 里读预设那份（带不带依赖会给出不同结果，等于把跑测配置挂在环境上）。
 *
 * 限度：`paths` 里非 `prefix/*`→`dir/*` 形状的条目怎么翻译，交给 `ts-jest` 的 `pathsToModuleNameMapper`
 * 自己决定（本件不重实现它的规则）；本件与 `chain-baseline-alias-sync` 读的是同一条来源，不各算一张表。
 */
const fs = require('fs');
const path = require('path');

/** 容注释与尾逗号的 JSON 读法（本仓 tsconfig.app.json 带尾逗号，标准 JSON.parse 会抛）。 */
function readJsonish(abs) {
  const raw = fs.readFileSync(abs, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(raw);
}

/** 从 (fromDirAbs, startRel) 出发沿**仓内** extends 链找最近一份声明 paths 的档。 */
function effectivePaths(fromDirAbs, startRel) {
  const chain = [];
  let cur = path.resolve(fromDirAbs, startRel);
  for (let hop = 0; hop < 8; hop += 1) {
    let raw;
    try { raw = readJsonish(cur); } catch (e) {
      throw new Error(`读不到 tsconfig ${cur}：${String(e.message).split('\n')[0]}`);
    }
    chain.push(cur);
    const co = (raw && raw.compilerOptions) || {};
    if (co.paths && typeof co.paths === 'object' && Object.keys(co.paths).length) {
      return { paths: co.paths, baseUrl: path.resolve(path.dirname(cur), co.baseUrl === undefined ? '.' : co.baseUrl),
        from: cur, chain };
    }
    const ext = raw && raw.extends;
    if (typeof ext !== 'string') throw new Error(`链到 ${cur} 都没声明 paths，也没有可跟进的 extends（链 ${chain.join(' → ')}）`);
    if (!ext.startsWith('.')) throw new Error(`链到 ${cur} 都没声明 paths，而 extends 指向外部包（${ext}）⇒ 拒绝生成空别名表；要让本档自己声明 paths`);
    cur = path.resolve(path.dirname(cur), ext);
  }
  throw new Error('extends 链超过 8 层');
}

/** 该跑测档的 rootDir 相对有效档 baseUrl 差几层 ⇒ 生成器要的 prefix（不写死）。 */
function prefixFor(rootDirAbs, baseUrlAbs) {
  const rel = path.relative(rootDirAbs, baseUrlAbs).split(path.sep).join('/');
  return rel ? `<rootDir>/${rel}/` : '<rootDir>/';
}

/** 跑测档用法：`moduleNameMapper: jestAliasMap({ rootDir: __dirname, tsconfig: 'tsconfig.jest.json' })`。
 *  `tsconfig` 允许带 `<rootDir>` 前缀（与 ts-jest 那份写法一致），解析口径也与 ts-jest 一样相对 **rootDir**。 */
function jestAliasMap(opts) {
  const rootDirAbs = path.resolve(opts.rootDir);
  const declared = String(opts.tsconfig || 'tsconfig.json').replace(/^<rootDir>\/?/, '');
  const eff = effectivePaths(rootDirAbs, declared);
  const { pathsToModuleNameMapper } = require('ts-jest');
  const gen = pathsToModuleNameMapper(eff.paths, { prefix: prefixFor(rootDirAbs, eff.baseUrl) });
  if (!Object.keys(gen).length) throw new Error(`有效档 ${eff.from} 声明了 paths 却生成出空表，拒绝写入 mapper`);
  if (opts.explain) opts.explain(eff);
  return gen;
}

module.exports = { jestAliasMap, effectivePaths, prefixFor, readJsonish };

if (require.main === module) {
  const [, , rootd, tsrel] = process.argv;
  if (!rootd || !tsrel) { console.log('用法：node jest-alias-map.cjs <rootDir 绝对路径> <tsconfig 相对路径>'); process.exitCode = 3; }
  else {
    const gen = jestAliasMap({ rootDir: rootd, tsconfig: tsrel,
      explain: (eff) => { console.log('// 有效档＝', path.relative(process.cwd(), eff.from), '｜baseUrl＝', path.relative(process.cwd(), eff.baseUrl),
        '｜prefix＝', prefixFor(path.resolve(rootd), eff.baseUrl)); } });
    console.log(JSON.stringify(gen, null, 1));
  }
}
