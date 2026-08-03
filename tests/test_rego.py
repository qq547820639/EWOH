"""Rego policy-as-code subset contract tests (Final 5.0 AA-10)."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.policy.rego import (  # noqa: E402
    RegoEvalError,
    RegoParseError,
    evaluate_rego,
    parse_rego,
)

DEPLOY_GATE = (
    REPO_ROOT / "contracts" / "policy" / "deploy-gate.rego"
).read_text(encoding="utf-8")


class TestRegoParse(unittest.TestCase):
    def test_parses_package_default_and_rules(self):
        module = parse_rego(DEPLOY_GATE)
        self.assertEqual(module.package, "ewoh.deploy")
        self.assertEqual(module.defaults, {"allow": False})
        self.assertEqual(
            {rule.name for rule in module.rules},
            {"allow", "deny"},
        )
        self.assertTrue(any(rule.capture == "msg" for rule in module.rules))

    def test_rejects_missing_package(self):
        with self.assertRaises(RegoParseError):
            parse_rego("default allow = false\nallow { true }")

    def test_rejects_no_rules(self):
        with self.assertRaises(RegoParseError):
            parse_rego("package test\n")


class TestRegoEvaluate(unittest.TestCase):
    def test_allows_when_all_conditions_met(self):
        result = evaluate_rego(
            DEPLOY_GATE,
            {
                "artifacts_present": True,
                "checks_passed": 4,
                "missing_contracts": 0,
            },
        )
        self.assertTrue(result["allowed"])
        self.assertFalse(result["denied"])
        self.assertEqual(result["decision"], "allow")

    def test_denies_with_message_for_missing_contracts(self):
        result = evaluate_rego(
            DEPLOY_GATE,
            {
                "artifacts_present": True,
                "checks_passed": 4,
                "missing_contracts": 2,
            },
        )
        self.assertFalse(result["allowed"])
        self.assertTrue(result["denied"])
        self.assertIn("missing contracts", result["messages"])
        self.assertEqual(result["decision"], "deny")

    def test_denies_when_checks_insufficient(self):
        result = evaluate_rego(
            DEPLOY_GATE,
            {
                "artifacts_present": True,
                "checks_passed": 2,
                "missing_contracts": 0,
            },
        )
        self.assertFalse(result["allowed"])
        self.assertIn("not enough checks passed", result["messages"])

    def test_supports_not_and_in(self):
        source = """
package test
default allow = false
allow {
  not input.blocked
  input.env in ["dev", "shadow"]
}
"""
        self.assertTrue(
            evaluate_rego(
                source,
                {"blocked": False, "env": "shadow"},
            )["allowed"]
        )
        self.assertFalse(
            evaluate_rego(
                source,
                {"blocked": True, "env": "shadow"},
            )["allowed"]
        )

    def test_rejects_non_object_input(self):
        with self.assertRaises(RegoEvalError):
            evaluate_rego(DEPLOY_GATE, [])


if __name__ == "__main__":
    unittest.main()
