"""Contract-driven state machines（P1-contract）。

从 `contracts/state-machines/{task,plan}.yaml` 加载权威状态机定义，并提供：
- `load_state_machine(name)`：解析 YAML（纯标准库，避免运行时第三方依赖；
  仅使用 yaml 兼容的简单解析器或调用方注入）。
- `validate_against_models()`：校验 Python `scheduler.models` 的
  TASK_TRANSITIONS / PLAN_TRANSITIONS 与 contract 一致（CI 门禁）。

设计目标：contract 成为可执行 source；Python 状态机不得在 contract 之外
自行漂移。后续可扩展为「由 YAML 生成 models.py 常量」，本阶段先做校验。

注意：Edge Runtime 承诺零第三方依赖（pyproject dependencies=[]），
因此本模块不 import PyYAML；校验由 CI/工具侧传入解析后的结构。
"""

from __future__ import annotations

import re

# contract 目录（相对仓库根）
CONTRACTS_DIR = "contracts/state-machines"


def parse_simple_yaml(text: str) -> dict:
    """极简 YAML 子集解析器（仅支持本仓库 state-machines 的结构）。

    支持：顶层 key: value、列表项 "- { ... }"、内联 dict "{k: v, k: [v1, v2]}"、
    注释行。仅用于状态机契约（无嵌套复杂结构）。不适用于一般 YAML。
    """
    result: dict[str, object] = {}
    states: list[str] = []
    transitions: list[dict] = []
    terminal: list[str] = []
    meta: dict[str, str] = {}

    def _parse_inline(line: str) -> dict:
        line = line.strip()
        line = line.lstrip("-").strip()
        if not (line.startswith("{") and line.endswith("}")):
            raise ValueError(f"无法解析内联映射: {line!r}")
        body = line[1:-1]
        out: dict[str, object] = {}
        for part in _split_top_level(body):
            if ":" not in part:
                raise ValueError(f"缺少冒号: {part!r}")
            k, _, v = part.partition(":")
            k = k.strip()
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                items = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
                out[k] = items
            else:
                out[k] = v.strip("'\"")
        return out

    def _split_top_level(body: str) -> list[str]:
        parts, depth, cur = [], 0, ""
        for ch in body:
            if ch in "[{(":
                depth += 1
            elif ch in "]})":
                depth -= 1
            if ch == "," and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
        if cur.strip():
            parts.append(cur)
        return parts

    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("version:") or line.startswith("owner:"):
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
        elif line.startswith("states:"):
            continue
        elif line.startswith("transitions:"):
            continue
        elif line.startswith("terminal:"):
            raw = line.split(":", 1)[1].strip()
            raw = raw.strip("[]").strip()
            terminal = [x.strip().strip('"').strip("'") for x in raw.split(",") if x.strip()]
        elif line.startswith("- {") or line.startswith("-{"):
            transitions.append(_parse_inline(line))
        elif line.startswith("- "):
            states.append(line[2:].strip().strip('"'))
        elif re.match(r"^[a-z_]+:$", line):
            continue  # 其他顶层 key
        else:
            raise ValueError(f"无法解析行: {line!r}")

    result["version"] = meta.get("version", "")
    result["owner"] = meta.get("owner", "")
    result["states"] = states
    result["transitions"] = transitions
    result["terminal"] = terminal
    return result


def load_state_machine(name: str, root: str = ".") -> dict:
    """从 contract 文件加载状态机定义。name ∈ {task, plan, alert, approval, control, fleet}。"""
    from pathlib import Path

    path = Path(root) / CONTRACTS_DIR / f"{name}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"state machine contract not found: {path}")
    return parse_simple_yaml(path.read_text(encoding="utf-8"))


def _contract_transitions(sm: dict) -> dict[str, set[str]]:
    """contract transitions → {from: {to...}}，含 any/any_non_terminal 特例展开。"""
    out: dict[str, set[str]] = {}
    for t in sm["transitions"]:
        frm = t["from"]
        to = t["to"]
        out.setdefault(frm, set()).add(to)
    return out


def validate_task_against_models(models_module) -> list:
    """校验 models.TASK_TRANSITIONS 与 contracts/state-machines/task.yaml 一致。"""
    sm = load_state_machine("task")
    contract = _contract_transitions(sm)
    impl = {
        k.replace("TASK_", "").lower(): {v.replace("TASK_", "").lower() for v in vs}
        for k, vs in models_module.TASK_TRANSITIONS.items()
    }
    errors = _diff(contract, impl, label="task")
    return errors


def validate_plan_against_models(models_module) -> list:
    """校验 models.PLAN_TRANSITIONS 与 contracts/state-machines/plan.yaml 一致。"""
    sm = load_state_machine("plan")
    contract = _contract_transitions(sm)
    impl = {
        k.replace("PLAN_", "").lower(): {v.replace("PLAN_", "").lower() for v in vs}
        for k, vs in models_module.PLAN_TRANSITIONS.items()
    }
    errors = _diff(contract, impl, label="plan")
    return errors


def _diff(contract: dict[str, set[str]], impl: dict[str, set[str]], label: str) -> list:
    """返回契约与实现的差异列表。any 特例（archive/cancel 通用路径）由实现侧自行放行，不判差异。"""
    errors = []
    # 实现必须在契约基础上完全一致（忽略 any/any_non_terminal 通用归档/取消键）
    for frm, tos in sorted(contract.items()):
        if frm in ("any", "any_non_terminal"):
            continue
        impl_tos = impl.get(frm, set())
        missing = tos - impl_tos
        extra = impl_tos - tos
        if missing:
            errors.append(f"{label}: 实现缺失 {frm} -> {sorted(missing)}（契约要求）")
        if extra:
            errors.append(f"{label}: 实现多余 {frm} -> {sorted(extra)}（契约未声明）")
    for frm in impl:
        if frm not in contract and frm not in ("any", "any_non_terminal"):
            errors.append(f"{label}: 实现含契约未声明的起始状态 {frm}")
    return errors


def validate_all(models_module) -> list:
    """校验全部支持的状态机（当前 task/plan）。"""
    return validate_task_against_models(models_module) + validate_plan_against_models(models_module)
