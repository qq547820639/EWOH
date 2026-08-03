#!/usr/bin/env python3
"""Rego policy-as-code TCK (Final 5.0 AA-10).

Evaluates the canonical deployment gate policy against allow and deny
scenarios using the dependency-free EWOH Rego subset.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.policy.rego import evaluate_rego, parse_rego  # noqa: E402

POLICY = ROOT / "contracts" / "policy" / "deploy-gate.rego"
source = POLICY.read_text(encoding="utf-8")
checks: list[tuple[str, bool]] = []


def check(name: str, condition: bool) -> None:
    checks.append((name, bool(condition)))


module = parse_rego(source)
check("rego package", module.package == "ewoh.deploy")
check("rego default deny", module.defaults.get("allow") is False)

allow = evaluate_rego(
    source,
    {"artifacts_present": True, "checks_passed": 4, "missing_contracts": 0},
)
check("rego allow", allow["decision"] == "allow" and allow["denied"] is False)

deny = evaluate_rego(
    source,
    {"artifacts_present": True, "checks_passed": 4, "missing_contracts": 2},
)
check(
    "rego deny message",
    deny["decision"] == "deny" and "missing contracts" in deny["messages"],
)

failed = [name for name, ok in checks if not ok]
if failed:
    print(f"REGO TCK FAILED: {', '.join(failed)}")
    sys.exit(1)

print(f"REGO TCK PASSED ({len(checks)} checks)")
