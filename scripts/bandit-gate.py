#!/usr/bin/env python3
"""Bandit 静态安全扫描门禁（Task 7）。

用法：
    python3 scripts/bandit-gate.py <bandit-report.json> \
        [--suppressions security/bandit-suppressions.json]

行为：
- 读取 bandit `-f json` 输出，统计 CRITICAL/HIGH 级发现数量（SCR-018：CRITICAL 纳入门禁）。
- 对照豁免清单 security/bandit-suppressions.json 计算“未被豁免的 CRITICAL/HIGH 数”。
- 任一 CRITICAL/HIGH 未被豁免（unbounded > 0）即 exit 1，阻断合并。
- 若 bandit 报告缺失（视为工具未运行/未安装），直接失败，绝不假装通过。
- 豁免清单 schema 校验：每条豁免必须含非空 reason/owner/expiresAt，且
  expiresAt 为合法 ISO 日期且未过期；违反即 exit 3（配置错误）。
- 豁免路径匹配为精确匹配（SCR-017）：豁免 path 必须等于 finding 的仓库相对路径。

退出码：0=通过；1=存在未豁免 CRITICAL/HIGH（阻断）；2=报告缺失/无法解析；
        3=豁免配置非法；4=bandit 未能扫描文件（结果不构成安全结论）。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

SUPPRESSION_SCHEMA_FIELDS = ("reason", "owner", "expiresAt")
# SCR-018: 阻断级别同时覆盖 CRITICAL 与 HIGH。
BLOCKING_SEVERITIES = ("CRITICAL", "HIGH")
_REPO_ROOT = Path.cwd()


def _repo_relative(finding_path: str) -> str:
    """将 finding 文件名归一化为仓库相对路径（绝对路径尽可能转为相对）。"""
    p = Path(finding_path)
    if p.is_absolute():
        try:
            p = p.resolve().relative_to(_REPO_ROOT)
        except ValueError:
            return str(p)
    return str(p)


def _load_bandit_report(path: Path) -> dict:
    """读取并解析 bandit JSON 报告；缺失/非法一律视为失败。"""
    if not path.exists():
        print(f"::error::bandit JSON 报告不存在：{path} —— 无法判定通过，视为失败。")
        raise SystemExit(2)
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"::error::bandit JSON 报告无法解析 {path}: {exc}")
        raise SystemExit(2) from exc
    if not isinstance(data, dict):
        print("::error::bandit 报告顶层必须是 JSON 对象。")
        raise SystemExit(2)
    return data


def load_suppressions(path: Path) -> list:
    """加载并校验豁免清单；返回豁免条目列表。非法配置 exit 3。"""
    if not path.exists():
        print(f"::error::豁免清单不存在：{path}")
        raise SystemExit(3)
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"::error::豁免清单无法解析 {path}: {exc}")
        raise SystemExit(3) from exc
    if not isinstance(data, dict):
        print("::error::豁免清单顶层必须是 JSON 对象（含 schemaVersion 与 suppressions 数组）。")
        raise SystemExit(3)

    entries = data.get("suppressions", [])
    if not isinstance(entries, list):
        print("::error::豁免清单缺少 suppressions 数组。")
        raise SystemExit(3)

    today = date.today().isoformat()
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            print(f"::error::suppressions[{idx}] 必须是对象。")
            raise SystemExit(3)
        for field in SUPPRESSION_SCHEMA_FIELDS:
            if field not in entry or not str(entry[field]).strip():
                print(
                    f"::error::suppressions[{idx}] 必须包含非空字段 '{field}'"
                    f"（reason/owner/expiresAt 均为必填）。"
                )
                raise SystemExit(3)
        try:
            date.fromisoformat(str(entry["expiresAt"]))
        except ValueError as exc:
            print(f"::error::suppressions[{idx}].expiresAt 不是合法 ISO 日期：{entry['expiresAt']}")
            raise SystemExit(3) from exc
        if str(entry["expiresAt"]) < today:
            print(f"::error::suppressions[{idx}].expiresAt 已过期：{entry['expiresAt']}")
            raise SystemExit(3)
    return entries


def _unbounded(findings: list, entries: list) -> list:
    """返回未被豁免覆盖的 CRITICAL/HIGH 发现列表。"""
    covered_ids = set()
    for entry in entries:
        rule_id = str(entry.get("ruleId") or "").strip()
        path_sub = str(entry.get("path") or "").strip()
        if not rule_id:
            # SCR-035: 无 ruleId 的豁免条目无法定位发现，不再静默跳过——显式告警。
            print(f"::warning::豁免条目缺少 ruleId，未生效：{entry}")
            continue
        for idx, finding in enumerate(findings):
            if str(finding.get("test_id") or "") != rule_id:
                continue
            # SCR-017: 精确路径匹配（仓库相对路径相等），避免子串误匹配过宽抑制。
            if path_sub and _repo_relative(str(finding.get("filename") or "")) != path_sub:
                continue
            covered_ids.add(idx)
    return [f for i, f in enumerate(findings) if i not in covered_ids]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Bandit CRITICAL/HIGH 门禁")
    parser.add_argument("report", help="bandit -f json 输出文件路径")
    parser.add_argument(
        "--suppressions",
        default="security/bandit-suppressions.json",
        help="豁免清单路径（默认 security/bandit-suppressions.json）",
    )
    args = parser.parse_args(argv)

    data = _load_bandit_report(Path(args.report))
    entries = load_suppressions(Path(args.suppressions))

    # 2026-09-10（虚假绿灯修复）：bandit 在部分环境下会对**每一个文件**抛
    # "exception while scanning file"（例如 bandit 1.8.6 + Python 3.14 的
    # _parse_file 把 bytes 当文件对象调用 .read()）。此时 results 为空、
    # 退出码为 0，门禁会打印 "PASS —— 未发现未豁免的 CRITICAL/HIGH 级安全问题"，
    # 而实际上**一个文件都没扫**。空结果与"扫过且干净"是两件事，绝不能等价。
    # 因此：报告里出现扫描错误即视为门禁失败（退出码 4），并给出可执行的处置。
    scan_errors = data.get("errors") or []
    if scan_errors:
        sample = ", ".join(
            str(e.get("filename", "?")) for e in scan_errors[:5] if isinstance(e, dict)
        )
        print(
            f"::error::bandit 未能扫描 {len(scan_errors)} 个文件（报告 errors 非空）——"
            f"本次结果**不构成**安全结论，门禁失败。示例：{sample}"
        )
        print(
            "::error::处置：确认 bandit 与当前 Python 版本兼容"
            "（`python3 -m bandit --version`；已知 bandit 1.8.6 + Python 3.14 无法解析任何文件），"
            "或改用受支持的 Python 版本运行该门禁。"
        )
        return 4

    results = data.get("results", [])
    blocking_findings = [
        r for r in results if str(r.get("issue_severity", "")).upper() in BLOCKING_SEVERITIES
    ]
    unbounded = _unbounded(blocking_findings, entries)

    total = data.get("total_issues", len(results))
    print(f"bandit_gate: total_issues={total} critical+high={len(blocking_findings)} "
          f"suppressed={len(blocking_findings) - len(unbounded)} "
          f"unbounded={len(unbounded)}")

    if unbounded:
        for f in unbounded:
            print(f"::error::未豁免 {str(f.get('issue_severity', '')).upper()}: {f.get('test_id')} "
                  f"{f.get('filename')}:{f.get('line_number')} "
                  f"{f.get('issue_text', '')[:120]}")
        print("::error::存在未豁免的 CRITICAL/HIGH 级安全发现，阻断合并（Task 7 门禁）。")
        return 1

    print("bandit_gate: PASS —— 未发现未豁免的 CRITICAL/HIGH 级安全问题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
