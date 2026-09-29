// 「§六 点名的单测归档必须与它旁边抄的读数同源」这条判据的形状部分（V351，UARCH-01）。
//
// 存在理由：一致性尺子原先只把文档里的 `后端单测 N/M 通过` 与"最新一份含汇总行的 unit 日志"对账，
// **文档里写死的那个归档文件名从来没人核**。V350 抓到活例：那一格抄的数是 417/3694（V348/V349 那两遍），
// 点名却是 `unit-20260929-133730.log`（V347 那一遍），四条收尾门禁全绿——数对、名不对，读的人按名去翻证据会翻到旧树。
// 这里只放**纯形状**（不读盘），让常驻用例能直接 require 它断正反面；读盘与档位由尺子做。
//
// 判据（刻意宽松，避免把"两份归档读数相同"这种合法情况判成红）：
//   点名的那份必须在产物集里存在；其汇总行的 tests/total/套件数必须与文档抄的三个数逐一相符；
//   产物集为空 ⇒ 不可判（不折成"一致"，也不折成违规）。

const CLAIM_RE = /当期读数（V\d+，同一份定稿树：后端单测 (\d+)\/(\d+) 通过\*\*（(\d+) 套件，rc=0，归档 `([^`]+)`/;

function parseUnitClaim(sec6) {
  const m = CLAIM_RE.exec(sec6);
  if (!m) return null;
  return { tests: Number(m[1]), total: Number(m[2]), suites: Number(m[3]), archive: m[4] };
}

function parseUnitSummary(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  const t = /Tests:\s*(\d+) passed,\s*(\d+) total/.exec(clean);
  const s = /Test Suites:\s*(\d+) passed/.exec(clean);
  if (!t) return null;
  return { tests: Number(t[1]), total: Number(t[2]), suites: s ? Number(s[1]) : null };
}

/** claim：文档抄下来的那句；namedText：点名那份归档的正文（读不到给 null）；
 *  candidateBasenames：产物集（unit-\\d{8}-\\d{6}\\.log）的文件名集合，可为空数组。
 *  返回 {verdict:'一致'|'违规'|'不可判', issues:string[]}——issues 只在违规时非空。 */
function checkUnitArchiveClaim(claim, namedText, candidateBasenames) {
  if (!claim) return { verdict: '不可判', issues: [] };
  if (!candidateBasenames || !candidateBasenames.length) {
    return { verdict: '不可判', issues: [] };
  }
  const issues = [];
  const base = String(claim.archive).split('/').pop();
  const known = candidateBasenames.map((p) => String(p).split('/').pop());
  if (!known.includes(base)) {
    issues.push(`§六 点名的单测归档 ${base} 不在产物集里（产物集 ${candidateBasenames.length} 份：`
      + `${known.slice(-3).join('、')}…）⇒ 这句"当期读数"没有可翻的证据，不折成一致`);
    return { verdict: '违规', issues };
  }
  const sum = parseUnitSummary(namedText || '');
  if (!sum) {
    issues.push(`§六 点名的归档 ${base} 读不到 \`Tests: N passed, M total\` 汇总行 ⇒ 核不了，不折成一致`);
    return { verdict: '违规', issues };
  }
  if (sum.tests !== claim.tests || sum.total !== claim.total) {
    issues.push(`§六 写 后端单测 ${claim.tests}/${claim.total}，点名的 ${base} 汇总行是 ${sum.tests}/${sum.total}`);
  }
  if (sum.suites !== null && sum.suites !== claim.suites) {
    issues.push(`§六 写 ${claim.suites} 套件，点名的 ${base} 自报 ${sum.suites} 个套件通过`);
  }
  return issues.length ? { verdict: '违规', issues } : { verdict: '一致', issues: [] };
}

module.exports = { parseUnitClaim, parseUnitSummary, checkUnitArchiveClaim, CLAIM_RE };
