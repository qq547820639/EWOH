#!/usr/bin/env python3
"""pytest skip 棘轮门禁：把「跳过」从假绿里摘出来（CI-01）。

背景：`pytest`/`unittest` 对被跳过的用例退出码仍为 0。本仓库的 CP-SAT 求解/预约用例
用 `@unittest.skipUnless(_ORT_TOOLS_AVAILABLE, ...)` 守卫，而 CI 的 Python job 不装
ortools → 求解路径在 CI 里**静默全跳仍然绿**（见 docs/audit/current/chain-behavior-baseline.md
§4.1）。本脚本不改变哪些用例该跳，只要求**每一次跳过都被显式登记**。

纪律与 `db/migration-verify-baseline.txt` 一致（只允许缩小）：
  · 基线外的 (文件, 原因) 组合，或某组合的跳过数量超过基线登记数 → 退出 1（回归）；
  · 基线里的组合这次一个都没跳到 → 打印 FIXED 提示，不失败（防基线变永久借口）；
  · EWOH_REQUIRE_SOLVER_TESTS=1 时，任何「可选依赖未安装」类跳过一律算失败
    （供声称覆盖求解器的 job 使用：那种 job 里依赖缺失不许当通过）。

用法：把带 `-rs` 的 pytest 输出喂进来
    python3 -m pytest -q -rs src/edge_platform tests tools 2>&1 \\
      | python3 scripts/assert-test-skips.py --baseline tests/ci-skip-baseline.txt
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

SKIPPED_RE = re.compile(r"^SKIPPED(?:\s+\[\d+\])?\s+(\S+?)(?::\d+)?:\s*(.+)$")
SUMMARY_RE = re.compile(r"(\d+) skipped")
SUMMARY_LINE_RE = re.compile(r"^(?:=+\s*)?(?P<body>.*\bin\s+\d+\.\d+s\b.*)$")
RESULT_TOKEN_RE = re.compile(r"\b(\d+) (passed|failed|error|errors|skipped|deselected|xfailed|xpassed)\b")
OPTIONAL_DEP_RE = re.compile(r"(未安装|需要\s|\bnot installed\b|requires\b)", re.I)


def summary_line(text: str):
    """取 pytest 的收尾汇总行（带 `in Xs` 的那行），避免把正文里的 error 字样当结论。"""
    for line in reversed(text.splitlines()):
        match = SUMMARY_LINE_RE.match(line.strip())
        if match:
            return match.group("body")
    return None


def run_health(text: str) -> list:
    """运行本身不成立时，「没有未登记跳过」不构成通过证据。

    实测反例（V41）：pytest 9.1.1 下两个测试模块因缺 PyYAML 在收集期 ImportError，
    汇总只有 `2 errors in 0.74s`、SKIPPED 行为 0 —— 只看跳过清单会打印 OK。
    """
    line = summary_line(text)
    if line is None:
        return ["没有可解析的 pytest 结果汇总行（pytest 未真正跑起来？-q 口径是否改变？）"]
    tokens = {name: int(count) for count, name in RESULT_TOKEN_RE.findall(line)}
    if tokens.get("error") or tokens.get("errors"):
        return [f"本次运行汇总报告 {tokens.get('error') or tokens.get('errors')} 个错误"
                "（收集/执行错误），跳过清单不能作为通过证据"]
    if not tokens.get("passed"):
        return [f"本次运行没有任何用例通过（汇总：{line.strip()}），跳过清单不能作为通过证据"]
    return []


def parse_skips(text: str) -> Counter:
    """把 pytest 输出折成 Counter{(文件, 规范化原因): 次数}。"""
    counts: Counter = Counter()
    for line in text.splitlines():
        match = SKIPPED_RE.match(line.strip())
        if not match:
            continue
        path, reason = match.group(1), match.group(2).strip()
        # 行号会随新增用例漂移，因此按 (文件, 原因) 聚合；原因去掉尾部句号差异。
        counts[(path, reason.rstrip("."))] += 1
    return counts


def parse_baseline(path: str) -> Counter:
    baseline: Counter = Counter()
    if not os.path.exists(path):
        return baseline
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = [part.strip() for part in line.split("::")]
            if len(parts) != 3:
                raise ValueError(f"基线行必须是 `文件 :: 原因 :: 次数`：{raw.strip()}")
            baseline[(parts[0], parts[1].rstrip("."))] = int(parts[2])
    return baseline


def evaluate(observed: Counter, baseline: Counter, require_solver: bool = False) -> list:
    problems = []
    for key, count in sorted(observed.items()):
        allowed = baseline.get(key, 0)
        if require_solver and OPTIONAL_DEP_RE.search(key[1]):
            problems.append(f"求解 job 不允许可选依赖跳过：{key[0]} :: {key[1]} × {count}")
            continue
        if count > allowed:
            hint = (
                f"基线登记 {allowed} 次" if allowed else "不在基线内（新增跳过）"
            )
            problems.append(
                f"未登记跳过：{key[0]} :: {key[1]} × {count}（{hint}）；"
                f"确认属实时把这一行加进基线：{key[0]} :: {key[1]} :: {count}"
            )
    for key, allowed in sorted(baseline.items()):
        if observed.get(key, 0) == 0:
            print(
                f"[skip-gate] NOTE：基线项 {key[0]} :: {key[1]} 本次无跳过——"
                "全量运行后确实不再跳则删该行；只跑子集时本条可忽略。"
            )
    return problems


def count_from_summary(text: str) -> int:
    total = 0
    for match in SUMMARY_RE.finditer(text):
        total += int(match.group(1))
    return total


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default="tests/ci-skip-baseline.txt")
    parser.add_argument("--require-solver-tests", action="store_true")
    parser.add_argument("--input", help="默认读 stdin")
    args = parser.parse_args(argv)

    raw = open(args.input, encoding="utf-8").read() if args.input else sys.stdin.read()
    health = run_health(raw)
    for problem in health:
        print(f"[skip-gate] FAIL：{problem}")
    if health:
        return 1
    observed = parse_skips(raw)
    summary_skips = count_from_summary(raw)
    if summary_skips != sum(observed.values()):
        print(
            f"[skip-gate] FAIL：汇总说 {summary_skips} 项跳过，但只解析到 {sum(observed.values())} 行"
            " SKIPPED（是否漏了 -rs？）"
        )
        return 1
    baseline = parse_baseline(args.baseline)
    problems = evaluate(
        observed, baseline,
        require_solver=args.require_solver_tests
        or os.environ.get("EWOH_REQUIRE_SOLVER_TESTS") == "1",
    )
    for problem in problems:
        print(f"[skip-gate] FAIL：{problem}")
    if problems:
        return 1
    print(
        f"[skip-gate] OK：{sum(observed.values())} 项跳过全部在基线内且未超数量"
        f"（基线合计 {sum(baseline.values())}）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
