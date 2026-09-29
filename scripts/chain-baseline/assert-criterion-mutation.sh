#!/usr/bin/env bash
# 判据自测的自测（V110）：把 assert_no_skips 的守卫逐条拔掉，看 `verify.sh --self-test` 能不能抓到。
# 为什么要有它：verify.sh --self-test 是一根"尺子"，它自己也可能是一把只有刻度的尺子。
# 本轮实测就撞见一次——拔掉「汇总行缺失」守卫后自测仍然全绿，说明这条守卫在**判决上**
# 与 0-passed 守卫重合（没有汇总行 ⇒ 必然没有 `N passed`），它只提供诊断文案的区分。
# 这类"看起来有、实际不承重"的位点必须被显式记录，否则日后删掉它没人发现判据已经变薄。
# 用法：bash scripts/chain-baseline/assert-criterion-mutation.sh   （退出码 0=预期表全对上 / 3=有偏差）
# 约定：变异体写在**本脚本同目录**（verify.sh 用 BASH_SOURCE 的 dirname 找 lib.sh，换目录会 source 失败），
#       跑完由 trap 删除；本脚本不碰真库、不起后端、不跑任何用例。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/verify.sh"
BAD=0
cleanup() { rm -f "$HERE"/.mutant-*.sh; }
trap cleanup EXIT

[ -f "$SRC" ] || { echo "✕ 找不到 $SRC"; exit 3; }

make_mutant() { # $1=名字 $2=要拔掉的守卫键
  python3 - "$SRC" "$HERE/.mutant-$1.sh" "$2" <<'PY'
import sys
src, dst, key = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding='utf-8').read()
blocks = {
  # 「汇总行缺失」守卫
  'summary': '''  if [ -z "$summary" ]; then
    log "  FAIL ${label}：汇总行缺失（一次什么都没跑成的运行不算通过证据）"
    FAILED=$((FAILED+1)); return 1
  fi
''',
  # 「SKIP/TODO 不得记为通过」守卫
  'skiptodo': '''  if [ "${nskip:-0}" != "0" ] || [ "${ntodo:-0}" != "0" ]; then
    log "  FAIL ${label}：有未运行的用例（SKIP/TODO 不得记为通过）— ${summary}"
    FAILED=$((FAILED+1)); return 1
  fi
''',
  # 「0 passed 不是通过证据」守卫（V110 新补的洞）
  'nopassed': '''  npass="$(printf '%s' "$summary" | sed -nE 's/.*[^0-9]([0-9]+) passed.*/\\1/p')"
  if [ -z "$npass" ] || [ "$npass" = "0" ]; then
    log "  FAIL ${label}：汇总行里没有任何通过用例（0 passed 不是通过证据）— ${summary}"
    FAILED=$((FAILED+1)); return 1
  fi
''',
}
keys = key.split('+')
for k in keys:
    if k not in blocks:
        sys.exit(f'未知守卫键 {k}')
    if blocks[k] not in s:
        sys.exit(f'注入无效：守卫 {k} 在 {src} 中不存在（判据被改写，先更新本脚本）')
    s = s.replace(blocks[k], '', 1)
if s == open(src, encoding='utf-8').read():
    sys.exit('注入未改变输入，拒绝产出变异体')
open(dst, 'w', encoding='utf-8').write(s)
PY
}

check() { # $1=守卫组合键 $2=名字 $3=期望 killed|benign
  local key="$1" name="$2" expect="$3" out rc nleak
  if ! make_mutant "$name" "$key"; then
    echo "  ✕ 变异体 $name 无法生成（守卫形状已变）"; BAD=$((BAD+1)); return
  fi
  out="$(bash "$HERE/.mutant-$name.sh" --self-test 2>&1)"; rc=$?
  nleak="$(printf '%s\n' "$out" | grep -c '判据漏网' || true)"
  if [ "$expect" = "killed" ]; then
    if [ "$rc" = 3 ] && [ "$nleak" != 0 ]; then
      echo "  ✓ 拔掉「${key}」被抓到（$nleak 条用例判据漏网，自测 rc=3）"
    else
      echo "  ✕ 拔掉「${key}」后自测仍判通过（rc=$rc 漏网=${nleak}）——判据变薄无人发现"; BAD=$((BAD+1))
    fi
  else
    if [ "$rc" = 0 ] && [ "$nleak" = 0 ]; then
      echo "  ✓ 拔掉「${key}」自测无变化 ⇒ 该守卫在判决上与 0-passed 重合，仅承重诊断文案（已登记）"
    else
      echo "  ✕ 拔掉「${key}」预期 benign 却 rc=$rc 漏网=${nleak}——重合关系已被破坏，需要重新判定"
      printf '%s\n' "$out" | sed -n '1,6p'; BAD=$((BAD+1))
    fi
  fi
}

echo "assert_no_skips 守卫变异对照（期望：承重守卫必须被抓，重合守卫必须无变化）"
check skiptodo  c  killed
check nopassed  a  killed
check summary   b  benign
check 'summary+nopassed' d killed   # 两条重合守卫一起拔 ⇒ 必须重新变得可抓
cleanup
if [ "$BAD" != 0 ]; then echo "守卫变异对照：不通过（$BAD 项偏差）"; exit 3; fi
echo "守卫变异对照：通过（3 条承重/重合预期全部对上）"
