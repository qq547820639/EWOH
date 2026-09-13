"""安全门禁自测：bandit-gate.py 必须区分「扫过且干净」与「根本没扫」。

背景（2026-09-10）：bandit 1.8.6 在 Python 3.14 上对每个文件抛
"exception while scanning file"，此时 `results` 为空且 bandit 退出码为 0。
原门禁只读 `results`，于是打印 "PASS —— 未发现未豁免的 CRITICAL/HIGH 级安全问题"，
而实际上一行代码都没扫到。这类"虚假绿灯"比没有门禁更危险，因此把行为钉死在测试里。

同时覆盖既有的 fail-closed 约定：报告缺失 → 2；豁免配置非法 → 3。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "bandit_gate", REPO_ROOT / "scripts" / "bandit-gate.py"
)
assert _SPEC and _SPEC.loader
bandit_gate = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(bandit_gate)


def _write_suppressions(tmp_path: Path, entries: list | None = None) -> Path:
    path = tmp_path / "suppressions.json"
    path.write_text(
        json.dumps({"schemaVersion": 1, "suppressions": entries or []}),
        encoding="utf-8",
    )
    return path


def _write_report(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "bandit.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_scan_errors_fail_instead_of_reporting_pass(tmp_path: Path) -> None:
    """报告 errors 非空（有文件未扫描）→ 退出码 4，绝不返回 PASS。"""
    report = _write_report(
        tmp_path,
        {
            "results": [],
            "errors": [
                {"filename": "src/a.py", "reason": "exception while scanning file"},
                {"filename": "src/b.py", "reason": "exception while scanning file"},
            ],
        },
    )
    code = bandit_gate.main([str(report), "--suppressions", str(_write_suppressions(tmp_path))])
    assert code == 4, "未扫描到任何文件时必须失败，而不是报告 PASS"


def test_clean_report_passes(tmp_path: Path) -> None:
    """无 errors 且无 CRITICAL/HIGH → 通过。"""
    report = _write_report(tmp_path, {"results": [], "errors": []})
    code = bandit_gate.main([str(report), "--suppressions", str(_write_suppressions(tmp_path))])
    assert code == 0


def test_critical_finding_blocks(tmp_path: Path) -> None:
    """未豁免的 CRITICAL → 退出码 1（不得因 errors 为空而放行）。"""
    report = _write_report(
        tmp_path,
        {
            "errors": [],
            "results": [
                {
                    "test_id": "B999",
                    "issue_severity": "CRITICAL",
                    "filename": "src/a.py",
                    "line_number": 1,
                    "issue_text": "boom",
                }
            ],
        },
    )
    code = bandit_gate.main([str(report), "--suppressions", str(_write_suppressions(tmp_path))])
    assert code == 1


def test_missing_report_fails_closed(tmp_path: Path) -> None:
    """报告缺失 → 2（工具未运行不得视为通过）。

    门禁对"配置/输入不可用"这类前置错误走 SystemExit，对"发现安全问题"走返回码；
    测试按真实契约断言，不把两种信号混为一谈。
    """
    with pytest.raises(SystemExit) as excinfo:
        bandit_gate.main(
            [str(tmp_path / "nope.json"), "--suppressions", str(_write_suppressions(tmp_path))]
        )
    assert excinfo.value.code == 2


def test_expired_suppression_is_config_error(tmp_path: Path) -> None:
    """豁免过期 → 3（配置错误，不得静默沿用）。"""
    suppressions = _write_suppressions(
        tmp_path,
        [{"ruleId": "B999", "path": "src/a.py", "reason": "r", "owner": "o", "expiresAt": "2000-01-01"}],
    )
    report = _write_report(tmp_path, {"results": [], "errors": []})
    with pytest.raises(SystemExit) as excinfo:
        bandit_gate.main([str(report), "--suppressions", str(suppressions)])
    assert excinfo.value.code == 3


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
