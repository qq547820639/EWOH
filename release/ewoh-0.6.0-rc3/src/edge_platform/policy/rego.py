"""Small dependency-free Rego subset for EWOH policy-as-code gates.

Final 5.0 AA-10: Open Policy Agent semantics are used for deployment and
package verification. This module implements the subset EWOH needs for its
own CI/deploy gates: package/default declarations plus `allow` and `deny[msg]`
rules with dot-path input access, comparisons, `in` membership, `not`, and
message capture.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

PACKAGE_PATTERN = re.compile(
    r"^\s*package\s+([A-Za-z_][\w.]*)\s*$", re.MULTILINE
)
DEFAULT_PATTERN = re.compile(
    r"^\s*default\s+(allow|deny)\s*=\s*(true|false)\s*$", re.MULTILINE
)
RULE_PATTERN = re.compile(r"\b(allow|deny)(?:\[([A-Za-z_]\w*)\])?\s*\{")


class RegoParseError(ValueError):
    """Raised when Rego source cannot be parsed."""


class RegoEvalError(ValueError):
    """Raised when a Rego expression cannot be evaluated."""


@dataclass
class RegoRule:
    """One Rego rule body."""

    name: str
    capture: str | None
    expressions: list[str] = field(default_factory=list)
    assignments: dict[str, str] = field(default_factory=dict)


@dataclass
class RegoModule:
    """Parsed Rego module."""

    package: str
    defaults: dict[str, bool] = field(default_factory=dict)
    rules: list[RegoRule] = field(default_factory=list)


def _extract_body(source: str, start: int) -> tuple[str, int]:
    open_idx = source.find("{", start)
    if open_idx < 0:
        raise RegoParseError("rule body is missing opening brace")
    depth = 0
    pos = open_idx
    while pos < len(source):
        char = source[pos]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_idx + 1 : pos], pos + 1
        pos += 1
    raise RegoParseError("rule body is missing closing brace")


def _clean_expression(line: str) -> str:
    value = line.strip()
    if "#" in value:
        value = value.split("#", 1)[0].strip()
    return value


def parse_rego(source: str) -> RegoModule:
    """Parse a Rego source into a module."""
    if not isinstance(source, str) or not source.strip():
        raise RegoParseError("Rego source must be a non-empty string")
    package_match = PACKAGE_PATTERN.search(source)
    if not package_match:
        raise RegoParseError("Rego module requires a package declaration")
    module = RegoModule(package=package_match.group(1))
    for match in DEFAULT_PATTERN.finditer(source):
        module.defaults[match.group(1)] = match.group(2) == "true"
    for match in RULE_PATTERN.finditer(source):
        body, _ = _extract_body(source, match.start())
        name = match.group(1)
        capture = match.group(2)
        expressions: list[str] = []
        assignments: dict[str, str] = {}
        for raw_line in body.splitlines():
            line = _clean_expression(raw_line)
            if not line:
                continue
            assignment = re.match(r"^([A-Za-z_]\w*)\s*:=\s*(.+)$", line)
            if assignment and assignment.group(1) == capture:
                assignments[assignment.group(1)] = assignment.group(2).strip()
            else:
                expressions.append(line)
        module.rules.append(
            RegoRule(
                name=name,
                capture=capture,
                expressions=expressions,
                assignments=assignments,
            )
        )
    if not module.rules:
        raise RegoParseError("Rego module has no allow/deny rules")
    return module


def _resolve_path(value: Any, path: str) -> Any:
    current = value
    for segment in path.split("."):
        if current is None:
            return None
        if isinstance(current, list) and segment.isdigit():
            current = current[int(segment)]
        elif isinstance(current, dict):
            current = current.get(segment)
        else:
            return None
    return current


def _parse_literal(text: str) -> Any:
    value = text.strip()
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered == "null":
        return None
    if value.startswith(("[", "{", '"')):
        return json.loads(value)
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    raise RegoEvalError(f"cannot parse literal: {text}")


def _eval_atom(expression: str, input_data: dict[str, Any]) -> Any:
    value = expression.strip()
    if value.startswith("input."):
        return _resolve_path(input_data, value[len("input.") :])
    return _parse_literal(value)


def _eval_expression(expression: str, input_data: dict[str, Any]) -> bool:
    value = expression.strip()
    if value.startswith("not "):
        return not bool(_eval_atom(value[4:], input_data))
    if " in " in value:
        left, right = value.split(" in ", 1)
        actual = _eval_atom(left, input_data)
        candidates = _parse_literal(right)
        if not isinstance(candidates, list):
            raise RegoEvalError("in operator requires a list literal")
        return actual in candidates
    for operator in ("==", "!=", ">=", "<=", ">", "<"):
        if operator in value:
            left, right = value.split(operator, 1)
            actual = _eval_atom(left, input_data)
            expected = _parse_literal(right)
            if operator == "==":
                return actual == expected
            if operator == "!=":
                return actual != expected
            if actual is None or expected is None:
                return False
            if operator == ">=":
                return actual >= expected
            if operator == "<=":
                return actual <= expected
            if operator == ">":
                return actual > expected
            return actual < expected
    return bool(_eval_atom(value, input_data))


def evaluate_rego(source: str, input_data: dict[str, Any]) -> dict[str, Any]:
    """Evaluate a Rego module against an input object."""
    if not isinstance(input_data, dict):
        raise RegoEvalError("input must be an object")
    module = parse_rego(source)
    allow_matched: list[dict[str, Any]] = []
    deny_matched: list[dict[str, Any]] = []
    messages: list[str] = []
    for rule in module.rules:
        matched = True
        for expression in rule.expressions:
            try:
                if not _eval_expression(expression, input_data):
                    matched = False
                    break
            except RegoEvalError:
                matched = False
                break
        if not matched:
            continue
        message = None
        if rule.capture and rule.capture in rule.assignments:
            try:
                message = _parse_literal(rule.assignments[rule.capture])
            except RegoEvalError:
                message = rule.assignments[rule.capture]
        detail = {
            "rule": rule.name,
            "capture": rule.capture,
            "message": message,
        }
        if rule.name == "allow":
            allow_matched.append(detail)
        else:
            deny_matched.append(detail)
            if message is not None:
                messages.append(str(message))
    denied = len(deny_matched) > 0
    allowed = len(allow_matched) > 0 or (
        module.defaults.get("allow", False) and not denied
    )
    decision = "deny" if denied or not allowed else "allow"
    return {
        "allowed": allowed,
        "denied": denied,
        "decision": decision,
        "messages": messages,
        "reasons": allow_matched + deny_matched,
    }
