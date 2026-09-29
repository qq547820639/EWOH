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


def strip_comment(raw: str) -> str:
    """按 YAML 规范判定注释起点：`#` 只有在**行首**或**前面是空白**时才开启注释。

    YLOAD-03（V332）：旧写法 `raw.split("#", 1)[0]` 把值里的 `#` 也当注释 ⇒
    `writer: 路径#标识符` 这类带锚点的值会在行中间被截断，内联映射丢掉右花括号后
    fail-closed 抛 ValueError（V332 实测：`plan`／`alert` 两份契约整体读不到，5 条常驻用例红）。
    js-yaml 侧一直按规范处理，所以这是两个运行时解析同一份契约的真实分歧，不是契约写错了
    ——修在解析器，契约里的 `#` 写法保留。
    """
    if "#" not in raw:
        return raw
    for i, ch in enumerate(raw):
        if ch == "#" and (i == 0 or raw[i - 1].isspace()):
            return raw[:i]
    return raw


def parse_simple_yaml(text: str) -> dict:
    """极简 YAML 子集解析器（仅支持本仓库 state-machines 的结构）。

    支持：顶层 key: value、列表项 "- { ... }"、内联 dict "{k: v, k: [v1, v2]}"、
    注释行。仅用于状态机契约（无嵌套复杂结构）。不适用于一般 YAML。

    EDGE-230 文档化限制：transitions 仅识别**内联 dict** 条目
    （``- {from: a, to: b}``）；多行块样式 dict（``- from: a`` 换行续写）
    不支持，遇到即抛 ValueError（fail-closed，绝不猜结构）。
    contracts/state-machines/*.yaml 全部使用内联格式，为既定约定。

    YLOAD-01（V331）：状态机文件里还有**与状态机无关的兄弟块**（派生投影口径、通知身份、
    波次判据这类），它们是嵌套 mapping/list，本加载器不建模。原先这些行会一路走到
    else 分支抛 ValueError ⇒ 契约每加一个兄弟块，边缘侧就读不到状态机（V331 实测：
    plan/alert/approval/control 四个文件全读不到，`tests/test_state_machine_contract.py`
    两条用例红）。现在的规则：顶层不认识的键 ⇒ 连它缩进的子行一起跳过，并把键名记进
    `sibling_top_level_keys` 供调用方核对"跳过了什么"——跳过是**可见**的，不是静默丢。
    fail-closed 只保留在被建模的三键（states/transitions/terminal）内部。

    YLOAD-03（V332）：行内注释一律由 `strip_comment` 按规范判定后剥离，值里的 `#`
    （如 `writer: 路径#标识符`）不再截行——本函数的 fail-closed 判据本身没有放宽。
    """
    MODELED = ("states", "transitions", "terminal")
    META = ("version", "owner")
    result: dict[str, object] = {}
    states: list[str] = []
    transitions: list[dict] = []
    terminal: list[str] = []
    meta: dict[str, str] = {}
    siblings: list[str] = []
    current_top: str | None = None

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
        body = strip_comment(raw)
        line = body.strip()
        if not line:
            continue
        indent = len(body) - len(body.lstrip())
        top_key = line.split(":", 1)[0].strip() if indent == 0 and ":" in line else None
        if indent == 0 and top_key is not None and top_key not in MODELED and top_key not in META:
            current_top = top_key
            if top_key not in siblings:
                siblings.append(top_key)
            continue          # 兄弟块的顶层键（无论 `k:` 还是 `k: v`）都不建模
        if indent > 0 and current_top is not None and current_top not in MODELED:
            continue          # 兄弟块的缩进子行／续行，随它一起跳过
        if line.startswith("version:") or line.startswith("owner:"):
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
        elif line.startswith("states:"):
            current_top = "states"
            continue
        elif line.startswith("transitions:"):
            current_top = "transitions"
            continue
        elif line.startswith("terminal:"):
            current_top = "terminal"
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
    result["sibling_top_level_keys"] = siblings
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
