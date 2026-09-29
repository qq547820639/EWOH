#!/usr/bin/env bash
# 全量后端单测的「可归因」跑法（FLAKE-01 的可诊断化，V83）。
#
# 为什么需要：FLAKE-01 的原始事故形状是"失败发生了，但失败用例名被管道过滤吞掉"，
# 于是此后 N 次全绿既不能证明问题已消失，也不能定位它属于哪一例。
# 本脚本把一次全量运行固定产出两样东西：完整日志 + **失败用例名清单**（jest --json 解析，
# 不靠正则猜），并复用本项目已付过学费的一条判据：**运行健康先于判定**——
# 汇总行缺失（收集阶段就崩、被 kill、空跑）一律判"不健康"，绝不读成"无失败"。
#
# 用法：
#   unit-triage.sh                 # 跑全量并归档
#   unit-triage.sh --selftest      # 只测判据本身（含"崩掉的运行不得判成干净"的反向控制）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BASE_DIR="${EWOH_CHAIN_BASE_DIR:-$ROOT/tmp/chain-baseline}"
mkdir -p "$BASE_DIR"

extract() {  # $1=json $2=humanlog → 打印判定，并按 0=干净 / 1=有失败 / 3=不健康 退出
  node -e '
const fs = require("fs");
const [jsonPath, logPath] = process.argv.slice(1);
function die(msg, code) { console.log(msg); process.exit(code); }
if (!fs.existsSync(jsonPath)) die("不健康：jest 的 --json 产物不存在（运行没跑到终点）", 3);
let j;
try { j = JSON.parse(fs.readFileSync(jsonPath, "utf8")); }
catch (e) { die(`不健康：--json 产物不可解析（${e.message.split("\n")[0]}）`, 3); }
const suites = j.testResults || [];
const failed = [];
for (const s of suites) {
  for (const a of (s.assertionResults || [])) {
    if (a.status === "failed") failed.push(`${s.name.replace(/^.*\/(?=[^/]*$)/, "")} › ${a.fullName}`);
  }
  // 套件级失败（编译错/在 beforeAll 里抛）下 assertionResults 可能为空 ⇒ 单列一类，别丢
  if ((s.assertionResults || []).length === 0) {
    failed.push(`(套件级) ${s.name.replace(/^.*\/(?=[^/]*$)/, "")} status=${s.status || "?"}`);
  }
}
const summary = (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "")
  .split("\n").filter((l) => /^(Test Suites:|Tests:|Snapshots:|Time:)/.test(l)).join(" | ");
if (!/^.*Tests:/m.test(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "")) {
  console.log("不健康：汇总行缺失（一次什么都没跑成的运行不算通过证据）");
  console.log(`（json: numTotal=${j.numTotalTests} numFailed=${j.numFailedTests}）`);
  process.exit(3);
}
console.log(summary);
// 判序有讲究：先报失败（含"套件级失败"这种 0 断言的形状），再判空跑——
// 否则一个在收集阶段就崩掉的运行会被读成"0 用例 ⇒ 不健康"而丢掉**是哪个文件**崩了这条信息。
if (!failed.length) {
  if (j.numTotalTests === 0) die("不健康：用例总数为 0（空跑不得判成干净）", 3);
  console.log(`干净：${j.numPassedTests}/${j.numTotalTests} 通过，0 失败`); process.exit(0);
}
console.log(`失败 ${failed.length} 例（名字已归档，不需要靠复跑去"再看一次"）：`);
for (const f of failed) console.log("  ✕ " + f);
process.exit(1);
' "$@"
}

if [ "${1:-}" = "--selftest" ] || [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mk() { printf '%s\n' "$2" > "$tmp/$1"; }
  pass=0; fail=0
  check() { # label want_rc json log
    out="$(extract "$4" "$5")"; rc=$?
    if [ "$rc" = "$2" ]; then pass=$((pass+1)); printf '  ok   %s (rc=%s)\n' "$1" "$rc";
    else fail=$((fail+1)); printf '  FAIL %s 期望 rc=%s 实得 rc=%s\n%s\n' "$1" "$2" "$rc" "$out"; fi
  }
  S='{"numTotalTests":3,"numPassedTests":1,"numFailedTests":2,"testResults":[{"name":"/p/server/a.spec.ts","status":"failed","assertionResults":[{"status":"passed","fullName":"one"},{"status":"failed","fullName":"two causes red"},{"status":"failed","fullName":"three causes red"}]}]}'
  mk good.json '{"numTotalTests":3,"numPassedTests":3,"numFailedTests":0,"testResults":[{"name":"/p/server/a.spec.ts","status":"passed","assertionResults":[{"status":"passed","fullName":"one"},{"status":"passed","fullName":"two"},{"status":"passed","fullName":"three"}]}]}'
  mk good.log 'Test Suites: 1 passed, 1 total'
  printf '\nTests:       3 passed, 3 total\n' >> "$tmp/good.log"
  mk bad.json "$S"; printf 'Test Suites: 1 failed\nTests:       2 failed, 1 passed, 3 total\n' > "$tmp/bad.log"
  # 反向控制①：收集阶段就崩（有 json 但日志没有汇总行）⇒ 必须"不健康"，不得判成干净
  printf '%s\n' "$S" > "$tmp/broken.json"; printf 'FAIL server/a.spec.ts\n  ● Test suite failed to run\n' > "$tmp/broken.log"
  # 反向控制②：空跑（0 用例）⇒ 不健康
  mk empty.json '{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"testResults":[]}'
  printf 'Test Suites: 0 total\nTests:       0 total\n' > "$tmp/empty.log"
  # 反向控制③：套件级失败且没有逐条断言 ⇒ 必须点名，不能"0 失败"
  mk suite.json '{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"testResults":[{"name":"/p/server/b.spec.ts","status":"failed","assertionResults":[]}]}'
  printf 'Test Suites: 1 failed, 1 total\nTests:       0 total\n' > "$tmp/suite.log"
  echo "── unit-triage 判据自测"
  check "干净运行判 0"            0 x "$tmp/good.json"   "$tmp/good.log"
  check "有失败判 1 并点名"        1 x "$tmp/bad.json"    "$tmp/bad.log"
  check "崩掉的运行判不健康(3)"    3 x "$tmp/broken.json" "$tmp/broken.log"
  check "空跑判不健康(3)"          3 x "$tmp/empty.json"  "$tmp/empty.log"
  check "套件级失败必须点名"       1 x "$tmp/suite.json"  "$tmp/suite.log"
  check "--json 产物缺失判不健康"  3 x "$tmp/nope.json"   "$tmp/good.log"
  echo "  通过 $pass / 失败 $fail"
  [ "$fail" = 0 ] || exit 1
  exit 0
fi

stamped="$(date +%Y%m%d-%H%M%S)"
log="$BASE_DIR/unit-$stamped.log"
json="$BASE_DIR/unit-$stamped.json"
echo "[unit-triage] 全量后端单测 → $log"
(cd "$ROOT/ewoh-spark-app" && npx jest --json --outputFile "$json" > "$log" 2>&1)
rc=$?
echo "[unit-triage] jest 退出码 = $rc"
extract "$json" "$log"
rc2=$?
if [ "$rc2" = 0 ] && [ "$rc" != 0 ]; then
  echo "[unit-triage] 不一致：判据说干净但 jest 非 0（退出码里混进了非用例因素）⇒ 记不健康"
  exit 3
fi
exit "$rc2"
