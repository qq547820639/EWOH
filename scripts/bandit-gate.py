#!/usr/bin/env python3
"""Bandit 静态安全扫描门禁（Task 7）。

用法：
    python3 scripts/bandit-gate.py <bandit-report.json> \
        [--suppressions security/bandit-suppressions.json]

行为：
- 读取 bandit `-f json` 输出，统计 HIGH 级发现数量。
- 对照豁免清单 security/bandit-suppressions.json 计算“未被豁免的 HIGH 数”。
- 任一 HIGH 未被豁免（unbounded HIGH > 0）即 exit 1，阻断合并。
- 若 bandit 报告缺失（视为工具未运行/未安装），直接失败，绝不假装通过。
- 豁免清单 schema 校验：每条豁免必须含非空 reason/owner/expiresAt，且
  expiresAt 为合法 ISO 日期且未过期；违反即 exit 3（配置错误）。

退出码：0=通过；1=存在未豁免 HIGH（阻断）；2=报告缺失/无法解析；3=豁免配置非法。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

SUPPRESSION_SCHEMA_FIELDS = ("reason", "owner", "expiresAt")


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
        raise SystemExit(2)
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
        raise SystemExit(3)
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
        except ValueError:
            print(f"::error::suppressions[{idx}].expiresAt 不是合法 ISO 日期：{entry['expiresAt']}")
            raise SystemExit(3)
        if str(entry["expiresAt"]) < today:
            print(f"::error::suppressions[{idx}].expiresAt 已过期：{entry['expiresAt']}")
            raise SystemExit(3)
    return entries


def _unbounded(findings: list, entries: list) -> list:
    """返回未被豁免覆盖的 HIGH 发现列表。"""
    covered_ids = set()
    for entry in entries:
        rule_id = str(entry.get("ruleId") or "").strip()
        path_sub = str(entry.get("path") or "").strip()
        if not rule_id:
            continue
        for idx, finding in enumerate(findings):
            if str(finding.get("test_id") or "") != rule_id:
                continue
            if path_sub and path_sub not in str(finding.get("filename") or ""):
                continue
            covered_ids.add(idx)
    return [f for i, f in enumerate(findings) if i not in covered_ids]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Bandit HIGH 门禁")
    parser.add_argument("report", help="bandit -f json 输出文件路径")
    parser.add_argument(
        "--suppressions",
        default="security/bandit-suppressions.json",
        help="豁免清单路径（默认 security/bandit-suppressions.json）",
    )
    args = parser.parse_args(argv)

    data = _load_bandit_report(Path(args.report))
    entries = load_suppressions(Path(args.suppressions))

    results = data.get("results", [])
    high_findings = [
        r for r in results if str(r.get("issue_severity", "")).upper() == "HIGH"
    ]
    unbounded = _unbounded(high_findings, entries)

    total = data.get("total_issues", len(results))
    print(f"bandit_gate: total_issues={total} high={len(high_findings)} "
          f"suppressed={len(high_findings) - len(unbounded)} "
          f"unbounded_high={len(unbounded)}")

    if unbounded:
        for f in unbounded:
            print(f"::error::未豁免 HIGH: {f.get('test_id')} "
                  f"{f.get('filename')}:{f.get('line_number')} "
                  f"{f.get('issue_text', '')[:120]}")
        print("::error::存在未豁免的 HIGH 级安全发现，阻断合并（Task 7 门禁）。")
        return 1

    print("bandit_gate: PASS —— 未发现未豁免的 HIGH 级安全问题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())