#!/usr/bin/env bash
# 一键重放试点链行为基线：约束层 + 链级场景 + 链级边界用例。
# 用法：verify.sh [--with-server] [--no-fresh] [场景名...]
#   场景名默认全跑：golden wave control-actuator receipt edge approval-expiry fault-replan
# 说明：wave 与 fault-replan 会被前序场景消费掉数据（见基线文档 §4.1），
#       因此这两个场景前各做一次「复位派生数据」，而不是复用脏库判定通过与否。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# lib.sh 顶部有 `set -euo pipefail`，-e 会随 source 泄漏进来：任何一次非零退出（例如某个
# 场景本来就是 FAIL）会直接终止整个脚本，让「跑完全部场景再汇总」变成空话。
# 本脚本自己逐项判返回码，所以这里显式关掉 -e。
set +e

WITH_SERVER=0; FRESH=1; SCENARIOS=""; SELF_TEST=0
for arg in "$@"; do
  case "$arg" in
    --with-server) WITH_SERVER=1 ;;
    --self-test) SELF_TEST=1 ;;
    --no-fresh) FRESH=0 ;;
    --*) printf '[chain-baseline] 未知参数: %s\n' "$arg" >&2; exit 2 ;;
    *) SCENARIOS="$SCENARIOS $arg" ;;
  esac
done
# 用空格分隔的字符串而不是数组：macOS 自带 bash 3.2 在 `set -u` 下对数组展开的处理不可靠
# （实测：进入 for 循环第一条命令时父进程直接退出，rc=2）。
[ -n "${SCENARIOS// /}" ] || SCENARIOS="golden wave control-actuator receipt edge approval-expiry fault-replan"

# jest 对**跳过**的用例仍然退出 0，所以「D 段退出码 0」并不等于「每条都跑了」。
# V66 之前那条长期挂着的 "1 已知显式 skip（D-01）" 就是这样被门禁看不见地放过去的——
# 与 §5.3d 修掉的 pytest skip≈pass 同一形状。这里按同一口径补运行健康判定：
# 汇总行里出现 skipped/todo 一律记未通过（跳过必须显式登记并说明，见基线文档 §5.4）。
assert_no_skips() {
  local label="$1" out="$2" summary nskip ntodo npass
  summary="$(grep -aE '^Tests:' "$out" | tail -1)"
  if [ -z "$summary" ]; then
    log "  FAIL ${label}：汇总行缺失（一次什么都没跑成的运行不算通过证据）"
    FAILED=$((FAILED+1)); return 1
  fi
  nskip="$(printf '%s' "$summary" | sed -nE 's/.*[^0-9]([0-9]+) skipped.*/\1/p')"
  ntodo="$(printf '%s' "$summary" | sed -nE 's/.*[^0-9]([0-9]+) todo.*/\1/p')"
  if [ "${nskip:-0}" != "0" ] || [ "${ntodo:-0}" != "0" ]; then
    log "  FAIL ${label}：有未运行的用例（SKIP/TODO 不得记为通过）— ${summary}"
    FAILED=$((FAILED+1)); return 1
  fi
  # V110 补的第二个洞：只查"有没有 skipped 字样"挡不住**一条都没跑**的运行。
  # 20 个链级 spec 全都写着 `(config ? describe : describe.skip)(…)`——e2e 配置缺失时整份文件
  # 会变成 0 用例，jest 汇总行是 `Tests: 0 total` 或 `0 skipped, 0 total`，
  # 旧判据看 skipped 计数为 0 就放行 ⇒ 假绿。所以这里再要求"至少有一条通过用例"。
  npass="$(printf '%s' "$summary" | sed -nE 's/.*[^0-9]([0-9]+) passed.*/\1/p')"
  if [ -z "$npass" ] || [ "$npass" = "0" ]; then
    log "  FAIL ${label}：汇总行里没有任何通过用例（0 passed 不是通过证据）— ${summary}"
    FAILED=$((FAILED+1)); return 1
  fi
  return 0
}

# 判据自测（V110）：assert_no_skips 的判据本身要能红。
# 每条 case = 合成汇总行 + 期望（pass/fail）。两条反向洞都在里面：`0 total` 与 `0 skipped, 0 total`。

# ── D / D2 两遍的"开关真的生效"判据（V117）─────────────────────────────────
# 为什么还要一条：D2 与 D 跑的是同一批 CHAIN_SPECS，唯一区别是环境变量。若哪天开关名写错、
# 被 .env 覆盖或子进程没继承，D2 会**静默退化成 D 的第二遍**，读数照旧 63 passed。
# 留痕由被测进程自己报（`health-ready-tx-guard.e2e.spec.ts` 的 [H-01] 行，V61 立的规矩），
# 这里只做判决：期望的那半必须在、不该有的那半必须在对边——两边互相"借证据"一律算红。
assert_switch_evidence() {
  local tag="$1" logf="$2" want="$3" forbid="$4"
  if [ ! -f "$logf" ]; then
    log "  FAIL ${tag} 开关留痕判据：日志文件不存在（这一遍没有证据）"; FAILED=$((FAILED+1)); return 1
  fi
  if ! grep -aqF "$want" "$logf"; then
    log "  FAIL ${tag} 开关留痕判据：被测进程没有自报「${want}」⇒ 该遍可能不在预期的兜底开关状态下跑"
    FAILED=$((FAILED+1)); return 1
  fi
  if [ -n "$forbid" ] && grep -aqF "$forbid" "$logf"; then
    log "  FAIL ${tag} 开关留痕判据：同一份日志里同时出现「${want}」与「${forbid}」⇒ 两遍互相借了证据，判不可信"
    FAILED=$((FAILED+1)); return 1
  fi
  log "  OK   ${tag} 开关留痕判据：被测进程自报「${want}」"
}

# ── D2 红的归因（V181）：把「这一遍红了」和「兜底开关被破坏」拆成两件事 ────────
# 旧判据只看出走码，凡是 D2 非零就打印「隔离兜底被破坏：有请求路径在事务外回落根句柄」。
# V181 同一天三次否证，全部有日志可查：
#   ① 第一遍全量重放红的是 authorization-validity-anchor 的毫秒容差，同树第二遍 70/70 全绿
#      ⇒ 一次时好时坏的用例抖动被说成一条租户隔离不变量的破口（两因一果）。
#   ② 改用「泛词 fail-closed 在场」当签名 ⇒ 假阳：D2 期间后端一句
#      `投影状态非契约词表，显式按 UNKNOWN（fail-closed）` 就打了 76 行（该词在本仓是设计通称）。
#   ③ 改用「抛点原文 回落根句柄」当签名 ⇒ 仍假阳：这句有**两个不同文本**，
#      开关关时是提示 `[RequestDatabaseContext] NEST-504: …无事务 store，回落根句柄（无 GUC/RLS）`
#      （对照遍 D 里 11 次、C 段后端 1 次），开关开时才是抛错；拿它判 D2 会把**对照遍**的行为算到本遍头上。
#      另：server.log 是 C 段那个后端的 stdout，D/D2 跑的是进程内 jest 应用 ⇒ 不是同一进程的同一遍证据。
# ⇒ 文本签名一律不做判据，只做参考。唯一单因可判的是「同一条用例在对照遍是否也红」：
#   两遍都红 ⇒ 与开关无关；红却取不到用例名 ⇒ 不可判。三种都不许印成"兜底被破坏"。
#   V194 起「只在带开关这遍红」也不再直接印"与开关相关"：那是从退出码推成因，V192 已被实测
#   证伪过一次（见下方 GATE-26 段）⇒ 改由两档复跑分布选措辞。
d2_cases() { # 提用例名（去掉 jest 的耗时尾巴），两遍同一口径才可比
  [ -f "$1" ] || return 0
  grep -aE '^[[:space:]]+✕ ' "$1" | sed -E 's/^[[:space:]]+✕[[:space:]]+//; s/[[:space:]]*\([0-9]+ ?m?s\)[[:space:]]*$//' | sort -u
}
d2_verdict() { # $1=本遍退出码 $2=本遍日志 $3=对档日志 → green|this_only|case_both|unknown
  local code="$1" jlog="$2" dlog="$3"
  if [ "$code" = "0" ]; then echo green; return; fi
  if [ ! -f "$jlog" ]; then echo unknown; return; fi
  local only both
  only="$(comm -13 <(d2_cases "$dlog") <(d2_cases "$jlog") | grep -c .)"
  both="$(comm -12 <(d2_cases "$dlog") <(d2_cases "$jlog") | grep -c .)"
  if [ "${only:-0}" -gt 0 ]; then echo this_only
  elif [ "${both:-0}" -gt 0 ]; then echo case_both
  else echo unknown; fi
}
d2_only_count() { comm -13 <(d2_cases "$2") <(d2_cases "$1") | grep -c .; }
d2_both_count() { comm -12 <(d2_cases "$2") <(d2_cases "$1") | grep -c .; }

# ── GATE-26（V194）：差分只走到"分布"为止，不从退出码组合印成因 ───────────────
# 上面那条 d2_verdict 已经把「这一遍红了」与「兜底被破坏」拆开，但"本遍独红"（this_only）那一支仍然
# 是从"哪一遍红"直接推出"与开关相关"。V192 收尾复跑实测这个推不出来：`pg-temporary-failure`
# 带开关档连跑 5 次全绿、对照档连跑 2 次红 1 次（tmp/v192-flake-repro.log:493）⇒ 红的分布与开关无关。
# ⇒ 现在红的那一刻必须把**失败例所在 spec 在两档各复跑 N 次**，报出"带开关 X/N · 对照 Y/N"，
#   措辞只由分布选，不由"哪一遍红"选。**遇红重跑直到绿**不在这里：那是把判据调成想要的颜色，
#   FAILED 计数照旧加，本遍仍判红。
d2_case_specs() { # $1=jest 日志 → 每行 "spec路径<TAB>用例名"；✕ 归到它上面最近的 PASS/FAIL 头
  [ -f "$1" ] || return 0
  awk -v mark='✕' '
    /^(PASS|FAIL)[[:space:]]/ { cur = $2; next }
    {
      line = $0
      head = line; sub(/^[[:space:]]*/, "", head)
      if (index(head, mark) != 1) next
      t = head; sub(mark, "", t)
      sub(/^[[:space:]]+/, "", t)
      sub(/[[:space:]]*\([0-9]+ ?m?s\)[[:space:]]*$/, "", t)
      if (cur != "" && t != "") printf "%s\t%s\n", cur, t
    }
  ' "$1"
}

# 单遍复跑：$1=spec 路径 $2=ON|OFF $3=日志路径；echo 退出码。OFF 档显式撤销变量，
# 免得本机 env.sh 里带着 EWOH_DB_REQUIRE_TX 时"对照遍"其实是第二遍带开关档。
# D2_REPRO_RUNNER 是**测试接缝**（常驻自测用它注入假 jest 产物，验证"复跑的是哪些 spec、
# 数的是哪些用例"这条接线）；生产路径不设它，接缝本身不改变任何判据方向。
d2_repro_once() {
  local spec="$1" arm="$2" log="$3" rc
  if [ -n "${D2_REPRO_RUNNER:-}" ]; then
    "$D2_REPRO_RUNNER" "$spec" "$arm" "$log"
    echo $?
    return
  fi
  if [ "$arm" = "ON" ]; then
    (cd "$ROOT/ewoh-spark-app" && EWOH_DB_REQUIRE_TX=1 timeout 900 npx jest \
      --config test/e2e/jest.config.js --runInBand "$spec") > "$log" 2>&1
  else
    (cd "$ROOT/ewoh-spark-app" && env -u EWOH_DB_REQUIRE_TX timeout 900 npx jest \
      --config test/e2e/jest.config.js --runInBand "$spec") > "$log" 2>&1
  fi
  rc=$?
  echo "$rc"
}

# 红的那一刻的完整报告（D2 遍专用）。抽成函数不是为了复用，是为了让**调用点本身**
# ——含 `read -r … <<<"$(…)"` 的三元组解析与"两遍同红不再跑"的分叉——进常驻自测；
# 只测措辞函数的话，接线错了照样一路绿灯。
d2_report_failure() { # $1=本遍日志 $2=对档日志 $3=verdict $4=独红条数 $5=同红条数 $6=退出码 $7=本遍档名(D2|D)
  local jlog="$1" dlog="$2" verdict="$3" nonly="${4:-0}" nboth="${5:-0}" code="${6:-?}" thisarm="${7:-D2}"
  local other; other="$([ "$thisarm" = D2 ] && echo 对照遍 || echo 带开关遍)"
  log "  FAIL ${thisarm} 遍退出码 ${code}（只在本遍红 ${nonly} 条 / 两遍同红 ${nboth} 条）"
  if [ "$verdict" = "case_both" ]; then
    # 分布证据本遍已经在手上（同一批用例两档都红）⇒ 不再复跑
    log "       ⇒ ${other}同样红 ⇒ 与开关无关，不得写成兜底破口（V181 前旧判据正是这样误报的）"
  else
    local r_on r_off r_n r_note r_tok
    read -r r_on r_off r_n r_note <<<"$(d2_repro_split "$jlog" "$dlog" "$verdict")"
    r_tok="$(d2_cause_token "${r_on:-0}" "${r_off:-0}" "${r_n:-0}")"
    log "       ⇒ $(d2_cause_line "$r_tok" "${r_on:-0}" "${r_off:-0}" "${r_n:-0}" "$r_note")"
    log "       ·复跑口径：只数「本遍独红的那几条用例又红了」，两档各复跑同一次数；红仍是红（FAILED 已 +1），不重跑至绿"
  fi
  grep -aE '^[[:space:]]+✕' "$jlog" 2>/dev/null | head -12 | while IFS= read -r line; do
    log "       ·$(printf '%s' "$line" | cut -c1-120)"
  done
}

# 纯函数：分布 → 判定档。只吃三个计数，不吃退出码 ⇒ "哪一遍红"没有通道进到这里。
d2_cause_token() { # $1=带开关档红次数 $2=对照档红次数 $3=每档复跑次数
  local on="${1:-0}" off="${2:-0}" n="${3:-0}"
  if [ "$n" -le 0 ] 2>/dev/null; then echo no_repro; return; fi
  if [ "$on" -gt 0 ] && [ "$off" -gt 0 ]; then echo both
  elif [ "$on" -gt 0 ]; then echo only_on
  elif [ "$off" -gt 0 ]; then echo only_off
  else echo none; fi
}

# 纯函数：判定档 → 印出来的措辞。任何一档都不许出现"与开关相关"这一由退出码推成的成因。
d2_cause_line() { # $1=token $2=on $3=off $4=n $5=说明
  local tok="$1" on="${2:-0}" off="${3:-0}" n="${4:-0}" note="${5:-}"
  case "$tok" in
    both) printf '两档都能复现（带开关 %s/%s · 对照 %s/%s）⇒ 与开关无关：这是该用例自身的内因，不得写成隔离兜底被破坏\n' "$on" "$n" "$off" "$n" ;;
    only_on) printf '只有带开关档复现（带开关 %s/%s · 对照 %s/%s）⇒ 开关是必要条件，但仍不等于兜底被破坏（F-10b 实测开关也会改时序）；按用例名读日志再定性\n' "$on" "$n" "$off" "$n" ;;
    only_off) printf '复现落在对照档（带开关 %s/%s · 对照 %s/%s）⇒ 本遍的红不是开关造成的：该用例在两档之间会跳 ⇒ 按内因／时机运气处理\n' "$on" "$n" "$off" "$n" ;;
    none) printf '两档复跑都没有再现（带开关 %s/%s · 对照 %s/%s）⇒ 单次红不在复现分布里：不印成因，只登记「这一遍红过 + 复跑分布」（FLAKE-01／FLAKE-05 族）\n' "$on" "$n" "$off" "$n" ;;
    *) printf '复跑未执行（%s）⇒ 只凭退出码组合不印成因；要看成因请手工把失败例在两档各复跑若干次\n' "${note:-原因未报}" ;;
  esac
}

# 纯函数：两遍退出码 → 该以哪一档当"本遍"去收集独红并复跑。
# 旧写法把这件事硬编在调用点（只有 D2 红才进报告体）⇒ 对照档独红无通道（FLAKE-07）。
# 两遍都红时仍归 D2：那种形状的分布证据本遍已经在手上（case_both 不再复跑），与 V194 行为一致。
d2_focus_arm() { # $1=D 退出码 $2=D2 退出码 → D2|D|none
  local dc="${1:-0}" jc="${2:-0}"
  if [ "$jc" != "0" ]; then echo D2; return; fi
  if [ "$dc" != "0" ]; then echo D; return; fi
  echo none
}

# 合成后的接线：由两遍退出码决定"本遍是哪一档"，再把对应日志喂给同一套报告体。
# 抽成函数的目的：让常驻自测能真走这一格（V194 教训——只测纯函数，接线写错照样一路绿灯）。
# 副作用：报告走 log()；本遍档名写进全局 D2_FOCUS（D2|D|none），由调用方决定 FAILED 计数。
d2_run_report() { # $1=D 退出码 $2=D2 退出码 $3=D 日志 $4=D2 日志
  local dc="${1:-0}" jc="${2:-0}" dlog="$3" jlog="$4"
  D2_FOCUS="$(d2_focus_arm "$dc" "$jc")"
  case "$D2_FOCUS" in
    D2) d2_report_failure "$jlog" "$dlog" "$(d2_verdict "$jc" "$jlog" "$dlog")" \
          "$(d2_only_count "$jlog" "$dlog")" "$(d2_both_count "$jlog" "$dlog")" "$jc" "D2" ;;
    D)  d2_report_failure "$dlog" "$jlog" "$(d2_verdict "$dc" "$dlog" "$jlog")" \
          "$(d2_only_count "$dlog" "$jlog")" "$(d2_both_count "$dlog" "$jlog")" "$dc" "D" ;;
  esac
}

# 红的那一刻真的去复跑：$1=本遍日志 $2=对档日志 $3=verdict 档
# → echo "on off n [说明]"（计数始终是**物理档**：on＝带开关档复现次数、off＝对照档；
#    "本遍是哪一档"只决定收集哪些用例，不改变这两个计数的含义 ⇒ D 遍与 D2 遍共用同一套判据）
d2_repro_split() {
  local jlog="$1" dlog="$2" verdict="$3"
  local runs="${D2_REPRO_RUNS:-3}" cap="${D2_REPRO_MAX_SPECS:-2}"
  # 自测模式下 EWOH_E2E_LOG_DIR 还没定义（它在预检之后才 export）⇒ 落到位 tmpd，判据本身不依赖生产路径
  local logdir="${EWOH_E2E_LOG_DIR:-$tmpd}"
  local titles="$logdir/repro-this-arm-only-cases.txt"
  if [ "${D2_REPRO:-1}" != "1" ]; then echo "0 0 0 D2_REPRO=${D2_REPRO}（复跑被关闭）"; return; fi
  if [ "$verdict" = "unknown" ] || [ ! -f "$jlog" ]; then echo "0 0 0 取不到失败用例名"; return; fi
  comm -13 <(d2_cases "$dlog") <(d2_cases "$jlog") > "$titles"
  if [ ! -s "$titles" ]; then echo "0 0 0 本遍没有独红用例（两遍同红或取不到名）"; return; fi
  local specs
  specs="$(d2_case_specs "$jlog" | grep -F -f "$titles" | cut -f1 | sort -u | head -n "$cap")"
  if [ -z "$specs" ]; then echo "0 0 0 失败用例名归不到 spec 头（日志形状变了）"; return; fi
  local spec arm i log rc on=0 off=0
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    for arm in ON OFF; do
      i=1
      while [ "$i" -le "$runs" ]; do
        log="$logdir/repro-$(basename "${spec}" .spec.ts)-${arm}-${i}.log"
        rc="$(d2_repro_once "$spec" "$arm" "$log")"
        # 只认"这些独红用例又红了"，不认"这一遍退出码非零"——否则换一条用例红也算复现
        if [ "$rc" != "0" ] && [ -n "$(d2_case_specs "$log" | grep -F -f "$titles")" ]; then
          if [ "$arm" = "ON" ]; then on=$((on + 1)); else off=$((off + 1)); fi
        fi
        i=$((i + 1))
      done
    done
  done <<EOFSPECS
$specs
EOFSPECS
  echo "${on} ${off} ${runs} 复跑日志见 e2e-logs/repro-*.log"
}

# ── C 段场景判决（纯函数，可被 --self-test 喂假输入）────────────────────────
# V116：旧逻辑是「exit 0 就 OK，汇总行只在为空时打印"无汇总行"」⇒ 一个跑完却什么都没
# 汇总的场景照样记成功（与 V110 的 "Tests: 0 passed 也算过" 同形状）。现在要求留痕。
scenario_verdict() {
  local code="$1" summary
  summary="$(printf '%s' "$2" | tr -d '[:space:]')"   # 全空白也算没留痕（自测抓到的形状）
  if [ "$code" = "2" ]; then echo SKIP; return; fi
  if [ "$code" != "0" ]; then echo FAIL; return; fi
  if [ -z "$summary" ]; then echo NOSUMMARY; return; fi
  echo OK
}

if [ "$SELF_TEST" = "1" ]; then
  FAILED=0   # set -u：判据内部会自增，这里先建好
  cases_pass='Tests:       63 passed, 63 total'
  cases_fail='Tests:       62 passed, 63 total, 1 skipped|Tests:       5 passed, 5 total, 1 todo|Tests:       0 total|Test Suites: 20 skipped, 0 passed\nTests: 0 skipped, 0 total|Tests:       0 passed, 0 total'
  bad=0
  tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
  printf '%s\n' "$cases_pass" > "$tmpd/p1.log"
  if assert_no_skips selftest "$tmpd/p1.log" >/dev/null 2>&1; then :; else
    echo "  ✕ 反向控制失效：正常汇总被判成不通过"; bad=$((bad+1)); fi
  n=0
  printf '%s\n' "$cases_fail" | tr '|' '\n' | while IFS= read -r c; do
    n=$((n+1)); printf '%b\n' "$c" > "$tmpd/f$n.log"
  done
  for f in "$tmpd"/f*.log; do
    [ -e "$f" ] || continue
    if [ "$(wc -l < "$f" | tr -d ' ')" = "0" ]; then continue; fi
    FAILED=0
    if assert_no_skips selftest "$f" >/dev/null 2>&1; then
      echo "  ✕ 判据漏网：$(tr '\n' ' ' < "$f")"; bad=$((bad+1))
    fi
  done
  # 空文件（没有汇总行）也必须判不通过
  : > "$tmpd/empty.log"; FAILED=0
  if assert_no_skips selftest "$tmpd/empty.log" >/dev/null 2>&1; then
    echo "  ✕ 判据漏网：没有汇总行的运行被判成通过"; bad=$((bad+1))
  fi
  if [ "$bad" != "0" ]; then echo "assert_no_skips 判据自测：不通过（$bad 项）"; exit 3; fi
  echo "assert_no_skips 判据自测：通过（1 条正向 + 5 条反向，含 0 passed 两种假绿形状）"

  # C 段场景判决的反向控制：跑完但没留痕必须不判 OK；SKIP 必须不算过
  sc_bad=0
  sc_check() {  # $1=描述 $2=exit $3=汇总 $4=期望
    got="$(scenario_verdict "$2" "$3")"
    if [ "$got" != "$4" ]; then echo "  ✕ 场景判决错位：$1 ⇒ 判成 ${got}（期望 $4）"; sc_bad=$((sc_bad+1)); fi
  }
  sc_check "有汇总且退出 0" 0 'PASS / Golden Path 全闭环' OK
  sc_check "汇总只有关键字" 0 'Golden Path' OK
  sc_check "退出 0 但零汇总行（V116 抓到的形状）" 0 '' NOSUMMARY
  sc_check "退出 2（未验证）" 2 'PASS / x' SKIP
  sc_check "退出 1" 1 'PASS / x' FAIL
  sc_check "退出 0 但汇总行只有空白（自测第一轮抓到判成 OK）" 0 '   ' NOSUMMARY
  # D/D2 开关留痕判据的反向控制（V117）：判据本身必须能红，且不会把"两遍互相借证据"放过
  W_ON='EWOH_DB_REQUIRE_TX=1（本遍在保护该不变量）'
  W_OFF='EWOH_DB_REQUIRE_TX=未设（对照遍）'
  ev_check() {  # $1=描述 $2=期望出现 $3=禁止出现 $4=期望判决(pass|fail) $5=两份留痕都写(1/0) $6=建文件(1/0)
    local desc="$1" want="$2" forbid="$3" verdict="$4" both="${5:-0}" mk="${6:-1}" f before after
    f="$tmpd/ev.log"
    if [ "$mk" = "1" ]; then
      printf '[H-01] %s ok\n' "$W_OFF" > "$f"
      [ "$both" = "1" ] && printf '[H-01] %s ok\n' "$W_ON" >> "$f"
    else
      rm -f "$f"
    fi
    before="$FAILED"
    assert_switch_evidence selftest "$f" "$want" "$forbid" >/dev/null 2>&1
    after="$FAILED"
    if [ "$verdict" = pass ] && [ "$before" = "$after" ]; then return 0; fi
    if [ "$verdict" = fail ] && [ "$after" -gt "$before" ]; then return 0; fi
    echo "  ✕ 开关留痕判据错位：${desc}（FAILED ${before}→${after}，want=$want both=$both mk=${mk}）"; sc_bad=$((sc_bad+1))
  }
  ev_check "对照遍自报未设 ⇒ 判 D 通过" "$W_OFF" "$W_ON" pass
  ev_check "同一份日志按 D2 判 ⇒ 必须不通过" "$W_ON" "$W_OFF" fail
  ev_check "两份留痕同时出现（互相借证据）⇒ 必须不通过" "$W_OFF" "$W_ON" fail 1
  ev_check "日志文件不存在 ⇒ 必须不通过（没有证据不算过）" "$W_OFF" "$W_ON" fail 0 0

  # D2 归因判据的反向控制（V181）：判据只看"同一条用例在对照遍是否也红"，文本签名一律不做判据
  dv_bad=0; dv_total=0
  dv_check() { # $1=描述 $2=退出码 $3=D2日志内容(NA=不建文件) $4=D日志内容(NA=不建) $5=期望
    local desc="$1" code="$2" jc="$3" dc="$4" want="$5" jf="$tmpd/d2.log" df="$tmpd/d.log" got
    dv_total=$((dv_total+1))
    if [ "$jc" = "NA" ]; then rm -f "$jf"; else printf '%s\n' "$jc" > "$jf"; fi
    if [ "$dc" = "NA" ]; then rm -f "$df"; else printf '%s\n' "$dc" > "$df"; fi
    got="$(d2_verdict "$code" "$jf" "$df")"
    if [ "$got" != "$want" ]; then
      echo "  ✕ D2 归因错位：$desc ⇒ 判成 ${got}（期望 ${want}）"; dv_bad=$((dv_bad+1)); sc_bad=$((sc_bad+1))
    fi
  }
  AVX='  ✕ AV-01 锚点取证：通过时间=建行时刻 (1837 ms)'
  dv_check "退出 0 ⇒ green（红才谈归因）" 0 'Tests: 70 passed' 'Tests: 70 passed' green
  dv_check "只在带开关这遍红 ⇒ this_only（V181a 第一遍的实测形状）" 1 "Tests: 2 failed
$AVX" 'Tests: 70 passed' this_only
  dv_check "两遍同红（V181 变异轮实测形状）⇒ case_both，与开关无关" 1 "Tests: 2 failed
$AVX" "Tests: 2 failed
$AVX" case_both
  dv_check "非零但取不到用例名 ⇒ unknown（不判绿、不归因）" 1 'Tests: 2 failed
Error: worker exited' 'Tests: 70 passed' unknown
  dv_check "D2 日志不存在 ⇒ unknown（没有证据不算过）" 1 NA 'Tests: 70 passed' unknown
  dv_check "两份日志都塞满泛词与抛点文本、用例集合却相同 ⇒ 仍判 case_both（证明文本已不做判据）" 1 "Tests: 2 failed
[RequestDatabaseContext] NEST-504: 无事务 store，回落根句柄（无 GUC/RLS）
WARN 投影状态非契约词表，显式按 UNKNOWN（fail-closed）
$AVX" "Tests: 2 failed
[RequestDatabaseContext] NEST-504: 无事务 store，回落根句柄（无 GUC/RLS）
$AVX" case_both

  # ── GATE-26（V194）反向控制：差分只到"分布"为止 ──────────────────────────
  # 夹具形状取自 V192 的真实红日志（tmp/v192-flake-repro.log:493）：✕ 出现在**它自己那条
  # FAIL 头之后**，标题带 `(186 ms)` 尾巴。判据必须按这个形状归属，不能按"文件里任一 FAIL"。
  gz_total=0; gz_bad=0
  gz_check() { # $1=描述 $2=实际 $3=期望
    gz_total=$((gz_total+1))
    if [ "$2" != "$3" ]; then
      echo "  ✕ GATE-26 判据错位：$1 ⇒ 得到「${2}」（期望「${3}」）"
      gz_bad=$((gz_bad+1)); sc_bad=$((sc_bad+1))
    fi
  }
  gz_log='PASS test/e2e/alpha.e2e.spec.ts
  组 A
    ✓ 别的用例一 (5 ms)
FAIL test/e2e/pg-temporary-failure.e2e.spec.ts (39.7 s)
  PostgreSQL 临时故障（Task 15.2 fault-injection）
    ✕ 终止应用 DB 后端连接 → 结构化 5xx（不 hang、不吞错）；下一请求自动恢复 (186 ms)
    ✓ S-01 run 执行中途崩溃 (86 ms)
  console.log
    正文里也提了一句 ✕ 但这不是用例头 (1 ms)'
  printf '%s\n' "$gz_log" > "$tmpd/gz.log"
  gz_rows="$(d2_case_specs "$tmpd/gz.log")"
  gz_check "✕ 只算用例头那一种形状（正文里的 ✕ 不算）⇒ 1 行" \
    "$(printf '%s\n' "$gz_rows" | grep -c .)" "1"
  gz_check "该 ✕ 归到它上面最近的 FAIL 头，不是文件里第一个套件" \
    "$(printf '%s' "$gz_rows" | cut -f1)" "test/e2e/pg-temporary-failure.e2e.spec.ts"
  gz_check "用例标题剥掉 (186 ms) 尾巴（与 d2_cases 同口径，否则两遍无法比对）" \
    "$(printf '%s' "$gz_rows" | cut -f2)" \
    '终止应用 DB 后端连接 → 结构化 5xx（不 hang、不吞错）；下一请求自动恢复'
  printf '%s\n' '  ✕ 没有套件头在前 (3 ms)' > "$tmpd/gz2.log"
  gz_check "✕ 之前没有任何 PASS/FAIL 头 ⇒ 不凭空归属（0 行）" \
    "$(d2_case_specs "$tmpd/gz2.log" | grep -c .)" "0"
  printf '%s\n' 'PASS test/e2e/alpha.e2e.spec.ts
  组 A
    ✓ 全绿的一条 (5 ms)' > "$tmpd/gz3.log"
  gz_check "全绿日志 ⇒ 0 行（不得把整个套件当成红）" \
    "$(d2_case_specs "$tmpd/gz3.log" | grep -c .)" "0"

  gz_check "每档复跑 0 次 ⇒ no_repro（有计数也不许印成因）" \
    "$(d2_cause_token 3 0 0)" "no_repro"
  gz_check "两档各 3/3 红 ⇒ both" "$(d2_cause_token 3 3 3)" "both"
  gz_check "只带开关档红 ⇒ only_on" "$(d2_cause_token 3 0 3)" "only_on"
  gz_check "只对照档能复现 ⇒ only_off（这一档旧判据根本没有出口）" \
    "$(d2_cause_token 0 2 3)" "only_off"
  gz_check "两档都复现不出来 ⇒ none" "$(d2_cause_token 0 0 3)" "none"
  gz_line_both="$(d2_cause_line both 3 3 3 '')"
  gz_line_on="$(d2_cause_line only_on 3 0 3 '')"
  gz_check "分布进措辞：both 与 only_on 必须是两句话（否则分布没有通道影响结论）" \
    "$([ "$gz_line_both" != "$gz_line_on" ] && echo differ || echo same)" "differ"
  gz_check "措辞必须带出 X/N 分布（不许只给结论不给复现率）" \
    "$(printf '%s\n' "$gz_line_both" "$gz_line_on" | grep -c '3/3')" "2"
  for gz_tok in both only_on only_off none no_repro; do
    gz_check "元反证：任何一档措辞都不得出现「与开关相关」这句由退出码推成的成因" \
      "$(d2_cause_line "$gz_tok" 3 3 3 '关闭' | grep -c '与开关相关')" "0"
  done
  gz_check "复跑未执行 ⇒ 明说「不印成因」而不是沉默" \
    "$(d2_cause_line no_repro 0 0 0 'D2_REPRO=0（复跑被关闭）' | grep -c '不印成因')" "1"

  # 接线（不是措辞）也要可测：复跑**选到哪些 spec、两档各跑几次、数的是不是"带开关档独红"
  # 那几条用例**。用 D2_REPRO_RUNNER 接缝注入假 jest 产物 ⇒ 不碰数据库也能把这条路径跑通。
  gz_d2="$tmpd/gz-d2.log"; gz_d="$tmpd/gz-d.log"
  printf '%s\n' 'FAIL test/e2e/pg-temporary-failure.e2e.spec.ts (39.7 s)
  PostgreSQL 临时故障
    ✕ 终止应用 DB 后端连接 → 结构化 5xx（不 hang、不吞错）；下一请求自动恢复 (186 ms)
    ✕ SH 两遍同红的一条 (7 ms)' > "$gz_d2"
  printf '%s\n' 'FAIL test/e2e/pg-temporary-failure.e2e.spec.ts (38.0 s)
  PostgreSQL 临时故障
    ✕ SH 两遍同红的一条 (6 ms)' > "$gz_d"
  cat > "$tmpd/gz-runner.sh" <<'GZR'
#!/usr/bin/env bash
# $1=spec $2=arm $3=log。GZ_MODE：ononly=只带开关档写回独红用例；both=两档都写回；
# none=都不写回；shared=退出码非零但日志里只有"两遍同红"那条（不该算复现）。
spec="$1"; arm="$2"; log="$3"
printf '%s %s\n' "$spec" "$arm" >> "$GZ_CALLED"
red=0
case "$GZ_MODE" in
  ononly) [ "$arm" = ON ] && red=1 ;;
  both) red=1 ;;
  none) red=0 ;;
  shared) red=1 ;;
esac
{
  printf 'FAIL %s (1.0 s)\n' "$spec"
  if [ "$GZ_MODE" = shared ]; then
    printf '    ✕ SH 两遍同红的一条 (5 ms)\n'
  elif [ "$red" = 1 ]; then
    printf '    ✕ %s (5 ms)\n' "$GZ_TITLE"
  fi
} > "$log"
if [ "$red" = 1 ] || [ "$GZ_MODE" = shared ]; then exit 1; fi
exit 0
GZR
  chmod +x "$tmpd/gz-runner.sh"
  export D2_REPRO_RUNNER="$tmpd/gz-runner.sh" D2_REPRO_RUNS=3
  export GZ_CALLED="$tmpd/gz-called.txt" \
    GZ_TITLE='终止应用 DB 后端连接 → 结构化 5xx（不 hang、不吞错）；下一请求自动恢复'
  gz_split() { export GZ_MODE="$1"; : > "$GZ_CALLED"; d2_repro_split "$gz_d2" "$gz_d" this_only; }
  gz_out_on="$(gz_split ononly)"
  gz_out_both="$(gz_split both)"
  gz_out_none="$(gz_split none)"
  gz_out_sh="$(gz_split shared)"
  gz_check "接线·只带开关档能复现 ⇒ 计数 3 0 3" "$(printf '%s' "$gz_out_on" | cut -d' ' -f1-3)" "3 0 3"
  gz_check "接线·两档都复现 ⇒ 3 3 3" "$(printf '%s' "$gz_out_both" | cut -d' ' -f1-3)" "3 3 3"
  gz_check "接线·都不复现 ⇒ 0 0 3" "$(printf '%s' "$gz_out_none" | cut -d' ' -f1-3)" "0 0 3"
  gz_check "接线·退出码非零但红的不是独红用例 ⇒ 仍算没复现（ naive 版会数成 3 3）" \
    "$(printf '%s' "$gz_out_sh" | cut -d' ' -f1-3)" "0 0 3"
  gz_check "复跑确实两档各 3 次、且只跑失败例所在那一个 spec" \
    "$(sort "$GZ_CALLED" | awk '{print $2" "$1}' | sort -u | paste -sd'; ' -)" \
    "OFF test/e2e/pg-temporary-failure.e2e.spec.ts;ON test/e2e/pg-temporary-failure.e2e.spec.ts"
  # 三元组按空格拆成三个参数是故意的（计数各占一参）
  gz_tuple="$(printf '%s' "$gz_out_on" | cut -d' ' -f1-3)"
  gz_tok2="$(d2_cause_token $gz_tuple)"
  gz_check "计数落到措辞：only_on 的分布印成「带开关 3/3 · 对照 0/3」" \
    "$(d2_cause_line "$gz_tok2" $gz_tuple '' | grep -c '带开关 3/3 · 对照 0/3')" "1"

  # 调用点（报告体）也要过一遍：测的是** shipped 的 d2_report_failure**，含 `read <<<"$(…)"`
  # 的三元组解析与"两遍同红不再跑"的分叉——只测措辞函数的话，接线错了照样一路绿灯。
  gz_rep() { : > "$GZ_CALLED"; export GZ_MODE="$1"; d2_report_failure "$gz_d2" "$gz_d" "${2:-this_only}" 1 0 1 D2; }
  gz_rep_on="$(gz_rep ononly)"
  gz_rep_sh="$(gz_rep shared)"
  gz_rep_both="$(gz_rep none case_both)"
  gz_check "报告体·独红且只带开关档复现 ⇒ 打印的分布是 3/3 对 0/3" \
    "$(printf '%s' "$gz_rep_on" | grep -c '带开关 3/3 · 对照 0/3')" "1"
  gz_check "报告体·退出码非零但红的不是独红用例 ⇒ 打印 0/3 对 0/3 而不是任何成因" \
    "$(printf '%s' "$gz_rep_sh" | grep -c '带开关 0/3 · 对照 0/3')" "1"
  gz_check "报告体·两遍同红 ⇒ 直接判「与开关无关」且一次都不复跑" \
    "$(printf '%s' "$gz_rep_both" | grep -c '与开关无关')/$(wc -c < "$GZ_CALLED" | tr -d ' ')" "1/0"
  gz_check "报告体·任何分叉都不许再印「与开关相关」" \
    "$(printf '%s\n' "$gz_rep_on" "$gz_rep_sh" "$gz_rep_both" | grep -c '与开关相关')" "0"
  # ── FLAKE-07（V199）：方向对称化——对照档独红也必须走同一套分布判据 ──────────
  # V198b 实测：D 段 1 failed、D2 段 74/74 全绿 ⇒ 旧代码只在 D2 遍失败时进报告体，
  # 对照档独红那一形只留下退出码，没有任何两档分布读数（登记为 FLAKE-07）。
  gz_cd="$tmpd/gz-control-red.log"; gz_cg="$tmpd/gz-control-clean.log"
  printf '%s\n' "FAIL test/e2e/pg-temporary-failure.e2e.spec.ts (30.4 s)
  PostgreSQL 临时故障
    ✕ ${GZ_TITLE} (30426 ms)" > "$gz_cd"
  printf '%s\n' 'PASS test/e2e/pg-temporary-failure.e2e.spec.ts (12.0 s)' > "$gz_cg"
  gz_splitc() { export GZ_MODE="$1"; : > "$GZ_CALLED"; d2_repro_split "$gz_cd" "$gz_cg" this_only; }
  gz_ct_on="$(gz_splitc ononly)"; gz_ct_both="$(gz_splitc both)"; gz_ct_none="$(gz_splitc none)"
  gz_ct_called="$(sort "$GZ_CALLED" | awk '{print $2" "$1}' | sort -u | paste -sd'; ' -)"
  gz_check "对称·对照档独红被收集，只有带开关档再现 ⇒ 3 0 3" "$(printf '%s' "$gz_ct_on" | cut -d' ' -f1-3)" "3 0 3"
  gz_check "对称·对照档独红被收集，两档都再现 ⇒ 3 3 3" "$(printf '%s' "$gz_ct_both" | cut -d' ' -f1-3)" "3 3 3"
  gz_check "对称·对照档独红被收集，两档都不再现 ⇒ 0 0 3" "$(printf '%s' "$gz_ct_none" | cut -d' ' -f1-3)" "0 0 3"
  gz_check "对称·复跑仍是两档各 3 次且只跑失败例所在那一个 spec" "$gz_ct_called" \
    "OFF test/e2e/pg-temporary-failure.e2e.spec.ts;ON test/e2e/pg-temporary-failure.e2e.spec.ts"
  # 极性对照：把方向写反（拿"本遍没有独红"的那一遍当本遍）必须收不到用例、计数归零——
  # 它证明"收集"真的按本遍走，而不是任何一侧红都算（那会把两档混成一档）。
  gz_rev="$(d2_repro_split "$gz_cg" "$gz_cd" this_only)"
  gz_check "极性·方向写反 ⇒ 收集 0 条且明确报「本遍没有独红用例」" \
    "$(printf '%s' "$gz_rev" | cut -d' ' -f1-3)|$(printf '%s' "$gz_rev" | cut -d' ' -f4-)" \
    "0 0 0|本遍没有独红用例（两遍同红或取不到名）"
  # 接线决策（本遍归谁）单独测：旧代码把这个判断硬编成"只有 D2 红才报告"，
  # 所以四格必须逐格钉住，否则分叉写回旧形状没人发现。
  gz_check "分叉·两遍都绿 ⇒ none（不报告、不复跑）" "$(d2_focus_arm 0 0)" "none"
  gz_check "分叉·只 D2 红 ⇒ D2（V194 既有形状）" "$(d2_focus_arm 0 1)" "D2"
  gz_check "分叉·只 D 红 ⇒ D（FLAKE-07 补的那一格）" "$(d2_focus_arm 1 0)" "D"
  gz_check "分叉·两遍都红 ⇒ 归 D2（case_both 不再复跑，与 V194 一致）" "$(d2_focus_arm 1 1)" "D2"
  # 报告体在对照遍这一侧调用时：档名必须写 D、措辞仍只由分布选
  gz_rep_d() { : > "$GZ_CALLED"; export GZ_MODE="$1"; d2_report_failure "$gz_cd" "$gz_cg" this_only 1 0 2 D; }
  gz_rep_d_on="$(gz_rep_d ononly)"
  gz_check "报告体·本遍=D 时抬头写「D 遍退出码」" "$(printf '%s' "$gz_rep_d_on" | grep -c 'FAIL D 遍退出码 2')" "1"
  gz_check "报告体·对照档独红也打印两档分布（带开关 3/3 · 对照 0/3）" \
    "$(printf '%s' "$gz_rep_d_on" | grep -c '带开关 3/3 · 对照 0/3')" "1"
  gz_check "报告体·镜像路径同样不许印「与开关相关」" "$(printf '%s' "$gz_rep_d_on" | grep -c '与开关相关')" "0"
  # 合成后的接线本体（分叉＋传哪些日志一起走）：这是 FLAKE-07 真正要钉的那一格。
  gz_wire() { : > "$GZ_CALLED"; export GZ_MODE="$3"; d2_run_report "$1" "$2" "$gz_cd" "$gz_cg" >/tmp/gz-wire.txt; echo "$D2_FOCUS|$(grep -c 'FAIL D 遍退出码' /tmp/gz-wire.txt)|$(grep -c . "$GZ_CALLED")"; }
  # 复跑次数＝两档 × 每档 3 次＝6 条调用记录（D2_REPRO_RUNS=3 由上面 export）
  gz_check "接线·D 红 D2 绿 ⇒ 本遍＝D、报告写「FAIL D 遍退出码」、且两档各复跑 3 次" \
    "$(gz_wire 2 0 ononly)" "D|1|6"
  gz_check "接线·两遍都绿 ⇒ 本遍＝none、不报告、一次都不复跑" "$(gz_wire 0 0 none)" "none|0|0"
  gz_check "接线·D2 红 ⇒ 本遍＝D2（旧形状没被改坏）" \
    "$( : > "$GZ_CALLED"; export GZ_MODE=ononly; d2_run_report 0 2 "$gz_cd" "$gz_cg" >/dev/null; echo "$D2_FOCUS")" "D2"
  rm -f /tmp/gz-wire.txt
  unset D2_REPRO_RUNNER D2_REPRO_RUNS GZ_CALLED GZ_TITLE GZ_MODE

  if [ "$sc_bad" != "0" ]; then echo "场景判据自测：不通过（$sc_bad 项）"; exit 3; fi
  echo "场景/开关留痕/D2归因/GATE-26 分布判据自测：通过（6+4+${dv_total}+${gz_total} 项：场景判决 6 项 + D/D2 开关留痕 4 项 + D2 归因 ${dv_total} 项 + 差分到分布 ${gz_total} 项，条数由计数器给出）"
  exit 0
fi


# 预检（DEP-01）：把"依赖没登记"与"链跑红了"分成两种退出码。
# CI 接入（CI-01b）必须有这个区分：环境不可用如果报成失败，是噪声；
# 若被 continue-on-error 吞掉，就更糟——它会变成一次"通过"。
PROVISION_STATE="$(pg_provision_state)"
if [ "$PROVISION_STATE" != "ok" ]; then
  log "不可用(DEP-01)：PostgreSQL 二进制分类=${PROVISION_STATE}（不是链上的问题）"
  bash "$HERE/doctor.sh" >&2 || true
  exit 3
fi

# 预检②（V79）：本脚本不负责起集群（起停归 chain-baseline-up / -down），但缺集群时它会
# 一路 FAIL 到 A/B/C 各段——「环境没准备好」不能伪装成「链跑红了」。与 DEP-01 同一约定：
# 不可用 = 退出码 3，不是失败，更不是通过。
if ! port_busy; then
  log "不可用：127.0.0.1:$PGPORT 上没有本套脚本管理的集群——先跑 make chain-baseline-up 再重放"
  exit 3
fi

guard_port

# ── 重放互斥锁：一次只允许一个重放在跑（V75b）────────────────────────────
# 为什么必须有它（实测教训，不是假想）：本套脚本的 C 段与 D 段把中间产物写到**固定路径**
# （`e2e-logs/chain-specs.log`、`server.log`），后端端口也固定（3100），集群只有一个。
# 两次重放重叠时会出现三类互相纠缠的假象：
#  ① 第二个后端的 3100 绑定失败或被第一个后端接管，D 段拿到 500 + NEST-504 根句柄回落；
#  ② 先结束的那次按 trap 杀掉 server，另一次正跑到一半 ⇒ 中途失去后端；
#  ③ 两方交替覆写同一个 jest 日志 ⇒ **失败被记到错误的那次运行上**（本轮就被坑过一次：
#     看到的 "1 failed" 其实是上一次残留进程的 D 段，而驱动器打印的 rc 又是 echo 的退出码）。
# 因此这里用 pid 文件锁拒绝重叠；持有者已死则视为残留并接管。
LOCK_FILE="$BASE_DIR/.replay.lock"
mkdir -p "$BASE_DIR"
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID="$(tr -dc '0-9' < "$LOCK_FILE" || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "不可用：另一次重放正在运行（pid=${LOCK_PID}，锁文件 ${LOCK_FILE}）——请先等它结束"
    exit 3
  fi
  log "接管残留锁（pid=${LOCK_PID:-?} 已不在运行）"
fi
echo "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT
# 链级场景需要三类互不相同的来源：本套脚本算出的库地址与口令、`.env.local-standalone` 里的
# JWT/`EWOH_CONTROL_FINGERPRINT_SECRET`/`INGEST_API_KEYS`（机器面网关必须与后端同一份密钥，
# 否则边缘 agent 全程 401，见基线文档 §7 V11）。先带进来，再强制覆盖数据库目标——
# 顺序与 scripts/local-up.sh 一致，绝不把后端打到别人配置的库上。
# 机器面网关的密钥只给「被测后端」和「链级场景脚本」用，绝不带进 D 段的 jest 进程：
# 进程内用例靠 startE2EApp 自设的 legacy 无绑定 key（`e2e-ingest-key`）跑，
# 一旦环境里存在 org 绑定的 INGEST_API_KEYS，网关会按绑定租户拒绝它（实测 403）。
CHAIN_FP=""; CHAIN_KEYS=""; CHAIN_ORG=""
if [ -f "$ROOT/ewoh-spark-app/.env.local-standalone" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/ewoh-spark-app/.env.local-standalone" || true
  set +a
  CHAIN_FP="$EWOH_CONTROL_FINGERPRINT_SECRET"
  CHAIN_KEYS="$INGEST_API_KEYS"
  CHAIN_ORG="$EWOH_INGEST_ORG_ID"
fi
unset EWOH_CONTROL_FINGERPRINT_SECRET INGEST_API_KEYS INGEST_API_KEY_MAP EWOH_INGEST_ORG_ID
export EWOH_PG_URL="$(owner_url "$BASE_DB")" EWOH_DATABASE_URL="$(owner_url "$BASE_DB")"
export EWOH_E2E_OWNER_DATABASE_URL="$(owner_url "$BASE_DB")" EWOH_E2E_RUNTIME_DATABASE_URL="$(runtime_url)"
export EWOH_E2E_ADMIN_USER=admin EWOH_E2E_ADMIN_PASS="$ADMIN_PASSWORD"
export EWOH_E2E_APPROVER_USER=approver.li EWOH_E2E_APPROVER_PASS="$APPROVER_PASSWORD"
export EWOH_E2E_OPERATOR_USER=approver.li EWOH_E2E_OPERATOR_PASS="$APPROVER_PASSWORD"
export EWOH_E2E_FIELD_USER=worker.zhangwei EWOH_E2E_FIELD_PASS="$WORKER_PASSWORD"
export EWOH_E2E_PERSON_ID="$PERSON_ID"
export EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100 EWOH_E2E_PG_URL="$(owner_url "$BASE_DB")"
# ingest key 是 JSON 映射 {"<key>":"<orgId>"}，必须取绑定到本租户的那个键，不能按逗号切。
export EWOH_E2E_INGEST_KEY="$(CHAIN_KEYS="$CHAIN_KEYS" CHAIN_ORG="$CHAIN_ORG" node -e '
try {
  const m = JSON.parse((process.env.CHAIN_KEYS || "").replace(/^["\x27]|["\x27]$/g, ""));
  const org = process.env.CHAIN_ORG;
  console.log(Object.keys(m).find((k) => m[k] === org) || Object.keys(m)[0] || "");
} catch { console.log(""); }
')"
export EWOH_API_DATABASE_PASSWORD EWOH_ALLOW_DDL=1
# 必须在 source 之后再覆盖：本地配置自带 DATABASE_URL，谁后定义谁赢。
export DATABASE_URL="$(runtime_url)"
export EWOH_E2E_LOG_DIR="${EWOH_E2E_LOG_DIR:-$BASE_DIR/e2e-logs}"
mkdir -p "$EWOH_E2E_LOG_DIR"
FAILED=0

reset_scenario() {
  (cd "$ROOT" && node db/runner/reset-scenario-data.js --org-id "$ORG_ID" --purge-derived --yes) >/dev/null 2>&1
}

if [ "$FRESH" = "1" ]; then
  log "A) 全新临时库跑完整迁移链 + 全量 verify"
  (cd "$ROOT" && node scripts/migration-fresh-chain-check.js) > "$EWOH_E2E_LOG_DIR/fresh-chain.log" 2>&1
  code=$?
  tail -2 "$EWOH_E2E_LOG_DIR/fresh-chain.log"
  [ "$code" = "0" ] || { log "  FAIL fresh-chain exit=$code"; FAILED=$((FAILED+1)); }
fi

log "B) 约束层事实采集（含 RLS 策略正文与表级授权）"
node "$HERE/schema-probe.mjs" > "$BASE_DIR/schema-facts.txt" 2>&1 \
  && log "  写入 $BASE_DIR/schema-facts.txt ($(grep -c '' "$BASE_DIR/schema-facts.txt") 行)" \
  || { log "  FAIL schema-probe"; FAILED=$((FAILED+1)); }

if [ "$WITH_SERVER" = "1" ]; then
  log "C) 链级场景（真实后端 + 真实 PostgreSQL）"
  # D 段的子进程用例（startStandaloneChild）跑的是 dist/server/**（tsc 逐文件产物，
  # 不是 bundle），而旧逻辑只在「文件不存在」时才构建 → 改了产品代码却测到旧构建，
  # 修复会被静默"退回"（实测：RUN-01 修复后 S-02 控制组仍 queued，因为 dist 早于修复）。
  # 默认每次重建；EWOH_SKIP_BUILD=1 才复用（本地赶时间用，CI 不带该变量）。
  if [ "${EWOH_SKIP_BUILD:-0}" = "1" ]; then
    log "  EWOH_SKIP_BUILD=1：复用现有 dist（若产品代码有改动，本段结论不成立）"
  else
    # 构建前先整份清掉 dist（不是只清 dist/server）。理由（V353 两遍实测）：
    #   ① nest-cli.json `deleteOutDir:false` ＋ tsc 增量 ⇒ "改了产品码"与"真的重新 emit"脱钩，
    #      陈旧文件带着**上一轮的模块说明符形状**留在产物里：dist/server 有 18 个文件仍写裸
    #      `require("@server/...")`（后端在 app.module → dashboard.service 处 MODULE_NOT_FOUND，
    #      /health/ready 30s 不就绪 ⇒ 本段按设计退 3，真因是产物没覆盖当前树，不是链坏了）；
    #   ② 只 `rm -rf dist/server` 会**更糟**——tsbuildinfo 还在，tsc 判定无变化而完全不 emit，
    #      于是 `dist/server/main.js` 直接缺席（本仓下一步那条存在性检查把它抓了出来）。
    # 清整份的代价实测很小：客户端 standalone 构建 3.17s、服务端 nest build 数秒，且 C 段本来就要重建。
    rm -rf "$ROOT/ewoh-spark-app/dist"
    (cd "$ROOT/ewoh-spark-app" && npm run --silent build:prod:standalone > "$BASE_DIR/build.log" 2>&1) \
      || { log "  FAIL 构建（见 $BASE_DIR/build.log）"; exit 1; }
  fi
  [ -f "$ROOT/ewoh-spark-app/dist/server/main.js" ] \
    || { log "  FAIL 缺少 dist/server/main.js"; FAILED=$((FAILED+1)); }
  # 陈旧产物自检：只认本仓三个本地别名前缀（`@nestjs/*` 这类真包不算）。复用 dist 的那一档不判，
  # 因为那一档的语义就是"我知道这可能是旧的"（上方 log 已声明本段结论不成立）。
  # 陈旧产物自检：只认本仓三个本地别名前缀（`@nestjs/*` 这类真包不算）。复用 dist 的那一档不判，
  # 因为那一档的语义就是"我知道这可能是旧的"（上方 log 已声明本段结论不成立）。
  # V356：判据从本文件的一行 grep 搬进可 require 的量具 `dist-alias-check.cjs`（判据自测条数由脚本自报），
  # 这样这道检查有常驻位点而不只是重放里的一句话；目录读不到判不可判，按 FAIL 计，不折成"干净"。
  if [ "${EWOH_SKIP_BUILD:-0}" != "1" ]; then
    node "$HERE/dist-alias-check.cjs" "$ROOT/ewoh-spark-app/dist/server" \
      || { log "  FAIL 服务端产物裸别名检查未过（构建输出见 $BASE_DIR/build.log）"; FAILED=$((FAILED+1)); }
  fi
  (
    cd "$ROOT/ewoh-spark-app" || exit 1
    if [ -f ./.env.local-standalone ]; then set -a; . ./.env.local-standalone; set +a; fi
    # 与 scripts/local-up.sh 同一顺序：先 source 本地配置，再强制覆盖为校验过的运行角色，
    # 否则 .env.local-standalone 自带的 DATABASE_URL 会把后端打到别人的库上。
    export DATABASE_URL EWOH_E2E_OWNER_DATABASE_URL EWOH_E2E_RUNTIME_DATABASE_URL EWOH_API_DATABASE_PASSWORD
    export EWOH_CONTROL_FINGERPRINT_SECRET="$CHAIN_FP" INGEST_API_KEYS="$CHAIN_KEYS" EWOH_INGEST_ORG_ID="$CHAIN_ORG"
    # 先收掉上一次遗留的后端（V75b）：`--with-server` 用 nohup 起进程，若那次重放是被信号
    # 打断而不是正常退出，trap 不会执行 ⇒ 孤儿进程占着 3100 与一批 DB 后端连接，
    # 下一次重放会"看起来正常、D 段偶发 500"。只信 pid 文件，不按进程名乱杀。
    if [ -f "$BASE_DIR/server.pid" ]; then
      STALE_PID="$(tr -dc '0-9' < "$BASE_DIR/server.pid" || true)"
      if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
        log "收掉上一次遗留的被测后端 pid=${STALE_PID}（pid 文件记录的正是本套脚本起的进程）"
        kill "$STALE_PID" 2>/dev/null || true
        for _ in $(seq 1 10); do kill -0 "$STALE_PID" 2>/dev/null || break; sleep 1; done
      fi
    fi
    # 显式指定部署目标：main.ts 已把 legacy 引导改成默认禁用（"Set EWOH_LEGACY_ENABLED=1 to opt in,
    # or use EWOH_DEPLOY_TARGET=standalone"），而这一段构建/测的就是 standalone 档
    # （build:prod:standalone）。此前该变量只由未入库的 `./.env.local-standalone` 提供 ⇒ 干净克隆上
    # 后端 exit 1、/health/ready 永不就绪。本机因该文件在位而从未暴露，属预防性加固，
    # 不是 V353 那遍 C 段退 3 的成因（成因是陈旧 dist，见上面 rebuild 档）。
    PORT=3100 NODE_ENV=production EWOH_DEPLOY_TARGET=standalone nohup node dist/server/main.js > "$BASE_DIR/server.log" 2>&1 &
    echo $! > "$BASE_DIR/server.pid"
    disown 2>/dev/null || true
  )
  SERVER_READY=0
  for _ in $(seq 1 30); do
    curl -sS -o /dev/null --max-time 2 http://127.0.0.1:3100/health/ready >/dev/null 2>&1 \
      && { SERVER_READY=1; break; }
    sleep 1
  done
  if [ "$SERVER_READY" != "1" ]; then
    log "不可用：被测后端 30s 内没有就绪（见 $BASE_DIR/server.log）——不带病跑场景"
    bash "$HERE/doctor.sh" >&2 || true
    exit 3
  fi
  # 收尾时同时摘锁与杀后端（两个动作必须都在，否则要么锁泄漏、要么留孤儿）。
  # V250：先判 pid 文件在不在再读。正常路径下 D 段开头就已经把后端关掉并 `rm -f` 了 pid 文件，
  # 而这个 EXIT trap 随后还会再跑一次——原写法 `kill "$(cat …)"` 里的 `2>/dev/null` 挂在 `kill` 上，
  # 救不到那个命令替换，于是每次正常收尾都往日志里打一行 `cat: …/server.pid: No such file or directory`。
  # 那行不是"后端没关成"的证据（真判据在上面：二十秒内杀不掉就 exit 3 判不可用），但它会被读成失败。
  trap 'if [ -f "'$BASE_DIR'/server.pid" ]; then kill "$(cat "'$BASE_DIR'/server.pid")" 2>/dev/null || true; fi; rm -f "'$BASE_DIR'/server.pid" "$LOCK_FILE"' EXIT
fi

for scenario in $SCENARIOS; do
  # 复位清单按"哪个场景会消费自己的前置事实"来定，不是按名字猜：
  # golden 也会（实测 V53：同一库连跑两次，第一次 22/22，第二次 17 PASS + 1 SKIP——
  # 任务被上一轮派工占掉后「候选方案均无可用 assignment」）。基线必须能连跑两次才对，
  # 否则"重放入口"只是一次性脚本。
  # V80/ENV-02 补的下半句：reset 只清派生数据，消费过头时救不回来，因此基线还必须**能从空库重建**——
  # `make chain-baseline-rebuild REBUILD=1 && make chain-baseline-seed`。这里不自动重建：那会把
  # "前提被消费"与"真有缺陷"混成一团。SKIP 在重建后仍复现，才算真缺陷。
  case "$scenario" in golden|wave|fault-replan) reset_scenario ;; esac
  out="$EWOH_E2E_LOG_DIR/$scenario.log"
  # 边缘 agent 的验签密钥必须与被测后端一致，因此只注入到场景脚本这一层。
  (cd "$ROOT/ewoh-spark-app" && env EWOH_CONTROL_FINGERPRINT_SECRET="$CHAIN_FP" \
    npm run --silent "e2e:$scenario") > "$out" 2>&1
  code=$?
  summary="$(grep -aE 'PASS / |Golden Path|全闭环' "$out" | tail -1)"
  case "$(scenario_verdict "$code" "$summary")" in
    OK) log "  OK   e2e:$scenario — $summary" ;;
    SKIP) log "  SKIP e2e:${scenario}（未验证，不算通过）— ${summary:-}"; FAILED=$((FAILED+1)) ;;
    NOSUMMARY) log "  FAIL e2e:$scenario 退出 0 但没有任何汇总行（跑了没留痕，不算过；V116 判据）"; FAILED=$((FAILED+1)) ;;
    *) log "  FAIL e2e:$scenario exit=$code — ${summary:-}"; FAILED=$((FAILED+1)) ;;
  esac
done

# 链级边界用例清单（D 与 D2 共用同一份，避免"只有一档覆盖全链"的错觉）。
# V82 起含 scheduling-plan-dispatch-tenant-cas：派工 CAS 的租户谓词归属（F-06 剩余面的常驻位点）。
# V105 起含 world-snapshot-collection-window：世界快照「采集 ↔ 版本分配」窗口（PROJ-01 第③项实测）。
# V106 起含 learning-override-copy：学习台账×人工覆盖副本断链（LRN-01 的常驻位点）。
# V107 起含 authorization-validity-anchor：授权有效期锚点 + 读侧不变量/词表漂移（AUTH-01 的常驻位点）。
# V189 起含 auth-org-scope-boundary：认证入口（Bearer→守卫→org 层级→userContext）挂进重放面（AUTH-02 的常驻位点）。
# V206 起含 control-backlog-worker-tick：投递积压 worker 的**周期触发**路径（RECOV-01 的常驻位点；自带 600s 默认间隔的反证一支）。
CHAIN_SPECS="control-receipt-boundary control-restart-boundary chain-idempotency-restart \
auth-org-scope-boundary control-delivery-race dispatch-receipt-concurrency dispatch-offline-heal pg-temporary-failure \
plan-reject-authority execution-offline-stuck health-ready-tx-guard approval-instance-uniqueness \
e2e-app-lifecycle scheduling-plan-dispatch-tenant-cas control-backlog-audit-trail control-verification-projection \
plan-cancel-execution-projection backlog-snapshot-failure-boundary world-snapshot-collection-window \
learning-override-copy authorization-validity-anchor agent-task-cas-window run-closure-state-guard \
control-backlog-worker-tick approval-expiry-worker-tick guc-read-write-split \
kpi-delivery-window-projection feedback-projection-reconciliation andon-notification-identity \
ctrl-notification-identity dq-notification-identity \
act-notification-identity retention-expire-concurrency"


if [ "$WITH_SERVER" = "1" ]; then
  log "D) 链级边界用例（真实 PostgreSQL，进程内后端）"
  # ISO-01（V207 实测顶出）：C 段的被测后端原本一直活到脚本 EXIT，而 D 段的进程内应用与它**共用同一个库**。
  # 它带着全部 worker 的默认间隔在跑（授权到期 300s、投递积压 600s…），于是"等 40s 不许出现某行"这类
  # 反证支会被它某一次 tick 打断——V207 第一遍重放里 AE-02 正是这么红的（两遍差分显示只有 D 遍红，
  # 不是代码回归）。D 段自己起应用、不需要 :3100，所以在这里就把后端关掉；关不掉就判不可用而不是带病跑。
  if [ -f "$BASE_DIR/server.pid" ]; then
    STALE_SERVER_PID="$(cat "$BASE_DIR/server.pid")"
    kill "$STALE_SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$STALE_SERVER_PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$STALE_SERVER_PID" 2>/dev/null; then
      log "  不可用：C 段后端 pid=$STALE_SERVER_PID 关不掉——它的 worker 会污染 D 段的反证支"
      exit 3
    fi
    rm -f "$BASE_DIR/server.pid"
    log "  已关停 C 段后端（D 段用进程内应用；共享库上留着它会替用例改掉『不该出现的行』）"
  fi
  # REPRO-03（V189）：两次重放（或同一遍里的再次调用）共用同一批日志路径，上一遍的
  # 失败明细会被这一遍覆盖 ⇒ 偶发红无法归因（本轮实测撞上一次：73/74 的失败例名随覆写丢失）。
  # 覆盖前把上一遍留档为 *.prev.log；文件名本体不变，inventory/freshness/一致性工具不受影响。
  for f in chain-specs chain-specs-requiretx; do
    [ -f "$EWOH_E2E_LOG_DIR/$f.log" ] && cp "$EWOH_E2E_LOG_DIR/$f.log" "$EWOH_E2E_LOG_DIR/$f.prev.log"
  done
  # shellcheck disable=SC2086
  (cd "$ROOT/ewoh-spark-app" && timeout 900 npx jest --config test/e2e/jest.config.js --runInBand $CHAIN_SPECS) \
    > "$EWOH_E2E_LOG_DIR/chain-specs.log" 2>&1
  code=$?
  grep -aE 'Tests:' "$EWOH_E2E_LOG_DIR/chain-specs.log" | tail -1
  D_CODE="$code"
  if [ "$code" = "0" ]; then
    assert_no_skips "chain specs" "$EWOH_E2E_LOG_DIR/chain-specs.log"
  else
    log "  FAIL chain specs"; FAILED=$((FAILED+1))
  fi
  assert_switch_evidence "D" "$EWOH_E2E_LOG_DIR/chain-specs.log" \
    "EWOH_DB_REQUIRE_TX=未设（对照遍）" "EWOH_DB_REQUIRE_TX=1（本遍在保护该不变量）"

  # D2) 租户隔离兜底开关（CFG-01，2026-09-22 修复后进入重放）。
  # EWOH_DB_REQUIRE_TX=1 是注释里写着「生产建议开启」的 fail-closed 兜底：
  # 请求上下文内回落根句柄（无 GUC/RLS）直接抛错。它此前**根本开不起来**
  # （登录发生在租户上下文建立之前 → 一开就 503，实测 D 段 10/10 红），
  # 于是这道兜底等于不存在。现在登录走显式系统事务，重放必须带着它跑一遍，
  # 否则"某次改动又把无事务回落引进来"不会有任何人发现。
  # V62 把范围从 1 个 spec 扩到全链 7 个：带开关的普查（cfg01-census）实测过全清单，
  # 只留 pg-temporary-failure 会让"审批/派工/回执路径重新出现无事务回落"无人发现。
  # 同一批普查还暴露出 F-10b（开关改变时序 ⇒ 事件重排撞 org 级守卫锁），现已由
  # 守卫锁有界等待缓解，故这一档同时是那条缓解的常驻回归位点。
  log "D2) 全链边界用例 + 租户隔离兜底（EWOH_DB_REQUIRE_TX=1）"
  # shellcheck disable=SC2086
  (cd "$ROOT/ewoh-spark-app" && EWOH_DB_REQUIRE_TX=1 timeout 900 npx jest --config test/e2e/jest.config.js --runInBand $CHAIN_SPECS) > "$EWOH_E2E_LOG_DIR/chain-specs-requiretx.log" 2>&1
  code=$?
  grep -aE 'Tests:' "$EWOH_E2E_LOG_DIR/chain-specs-requiretx.log" | tail -1
  D2LOG="$EWOH_E2E_LOG_DIR/chain-specs-requiretx.log"
  # 无论这一遍红或绿，都必须证明开关真在本遍生效（旧写法只在绿时证明 ⇒ 红的那遍连前提都没核）
  assert_switch_evidence "D2" "$D2LOG" \
    "EWOH_DB_REQUIRE_TX=1（本遍在保护该不变量）" "EWOH_DB_REQUIRE_TX=未设（对照遍）"
  DLOG="$EWOH_E2E_LOG_DIR/chain-specs.log"
  d2v="$(d2_verdict "$code" "$D2LOG" "$DLOG")"
  if [ "$d2v" = "green" ]; then
    log "  OK   EWOH_DB_REQUIRE_TX=1 下全链边界用例全绿（隔离兜底可用）"
  fi
  # FLAKE-07（V199）：接线合成成一处（旧写法硬编成"只有 D2 红才报告" ⇒ 对照档独红只剩退出码；
  # V198b 的 F-19 正是 D 段 1 failed、D2 段 74/74 全绿那一形）。GATE-26（V194）的规矩不变：
  # 措辞只由"两档复跑分布"选，不由"哪一遍红"选。D 遍红已在 D 段自己 +1，这里只补 D2 遍红的计数。
  d2_run_report "$D_CODE" "$code" "$DLOG" "$D2LOG"
  if [ "${D2_FOCUS:-none}" = "D2" ]; then FAILED=$((FAILED+1)); fi

  # D3) 用例存量对账（V110）：静态写下的用例数 ↔ 本次日志实到的用例数，逐套件核。
  # 为什么汇总行不够：`describe.skip(…)` 块里的 `it(` **不进** `Tests:` 汇总行，也不进 skipped 计数
  # ——一条被永久跳过的用例对 assert_no_skips 完全隐形。本轮实测 20 个 spec 共 64 个静态 it(，
  # 运行时 63 条，差的 1 条是 `scheduling-plan-dispatch-tenant-cas` 里 `if (!e2eConfig)` 的占位用例
  # （合法：配置在场就不注册）。这个"合法/不合法"的判定以前只能靠人再读一遍文件，这里固化成入口。
  # 只在 WITH_SERVER=1 时跑：不带服务时 D 段日志是上一次的，拿旧日志对账会造出假偏差。
  log "D3) 链级 spec 用例存量对账（含'判据看不见的永久跳过'）"
  # 显式传路径：脚本默认按 process.cwd() 解析，重放不能依赖调用者的当前目录
  node "$HERE/spec-case-inventory.cjs" \
    --verify "$HERE/verify.sh" \
    --specs "$ROOT/ewoh-spark-app/test/e2e" \
    --logs "$EWOH_E2E_LOG_DIR/chain-specs.log,$EWOH_E2E_LOG_DIR/chain-specs-requiretx.log" \
    > "$EWOH_E2E_LOG_DIR/spec-inventory.log" 2>&1
  code=$?
  grep -aE '^(用例存量对账|  ✕|  !|  静默占位|  ✅|  ❌)' "$EWOH_E2E_LOG_DIR/spec-inventory.log" | head -12
  if [ "$code" = "0" ]; then
    log "  OK   逐套件静态可注册数与实到数对上"
  elif [ "$code" = "3" ]; then
    log "  FAIL 用例存量对账不可判（日志自身不一致 ⇒ 仪器问题，不是链红，但本轮证据不可信）"
    FAILED=$((FAILED+1))
  else
    log "  FAIL 用例存量对账存在偏差（见 spec-inventory.log 的逐条 ✕）"
    FAILED=$((FAILED+1))
  fi
fi

log "边缘侧关停协议用例（Python，独立进程）"
(cd "$ROOT" && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m pytest \
  src/edge_platform/tests/test_run_shutdown_protocol.py -q) > "$EWOH_E2E_LOG_DIR/edge-shutdown.log" 2>&1
code=$?
tail -1 "$EWOH_E2E_LOG_DIR/edge-shutdown.log"
[ "$code" = "0" ] || { log "  FAIL edge shutdown"; FAILED=$((FAILED+1)); }

if [ "$FAILED" = "0" ]; then log "全部通过"; else log "有 $FAILED 项未通过（SKIP 也计入未通过）"; fi
exit "$((FAILED > 0 ? 1 : 0))"
