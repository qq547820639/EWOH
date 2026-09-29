"""TEST-01 的守卫（V74）：边缘测试里"同进程调用 run.main()"只允许走自举子进程那条路。

为什么需要它（不是重复造轮子）：
  `edge_platform.run.main()` 会向进程级注册表写入调度钩子等全局状态，且**没有反注册入口**
  （TEST-01 的结构性成因，登记于 V25）。关停协议测试因此刻意把 `main()` 放在**子进程**里跑
  （`subprocess.run([sys.executable, __file__, "--probe"])`），同文件里那句
  `run_module.main()` 只有被重新执行为子进程时才会到达。
  问题在于：**这条隔离只是约定**，没有任何东西阻止后来的人在同进程的测试方法里
  直接调用那个探针函数——那样 TEST-01 会立刻复现，而且以"另一个文件的用例莫名变红"
  的形式出现（V25 当时就是 2 例假红，定位花了一轮）。

本守卫把约定变成棘轮，规则刻意可判定：
  1) 逐个解析 `src/edge_platform/tests/test_*.py` 的 AST，找出**函数体内**对 `*.main()` /
     `main()` 的调用，记下所在函数名；
  2) 对每个这样的函数，在本文件内找它的全部调用点；
  3) 只要有一个调用点**不在** `if __name__ == "__main__"` 块内，就判定为"同进程可达"→ 失败；
  4) 没有任何调用点的（只在子进程里被 `--probe` 分支调用）视为安全。
自检（同文件内）用合成源码证明它**能变红**：把探针函数从 `__main__` 分支挪进测试方法里，
必须被判为违规；留在 `__main__` 分支里必须通过。
"""

from __future__ import annotations

import ast
import pathlib
import unittest

TESTS_DIR = pathlib.Path(__file__).resolve().parent


def _is_main_call(node: ast.AST) -> bool:
    """`main()` / `anything.main()`：只认被调名字为 main 的直接调用。"""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Name):
        return func.id == "main"
    if isinstance(func, ast.Attribute):
        return func.attr == "main"
    return False


def _dunder_main_test(node: ast.AST) -> bool:
    """`__name__ == "__main__"` 这类判断（两侧顺序都认）。"""
    if not isinstance(node, ast.Compare):
        return False
    names = {
        n.id for n in (node.left, *node.comparators) if isinstance(n, ast.Name)
    }
    literals = {
        c.value for c in (node.left, *node.comparators) if isinstance(c, ast.Constant)
    }
    return "__name__" in names and "__main__" in literals


def _functions_calling_main(tree: ast.Module) -> set[str]:
    """返回函数体内出现 `main()` / `x.main()` 调用的函数名集合。"""
    names: set[str] = set()
    for fn in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
        if any(_is_main_call(node) for node in ast.walk(fn)):
            names.add(fn.name)
    return names


def _call_sites(tree: ast.Module, name: str) -> list[tuple[int, bool]]:
    """返回 name() 的所有调用点 (行号, 是否位于 `__main__` 分支内)。"""
    sites: list[tuple[int, bool]] = []

    def walk(node: ast.AST, in_main: bool) -> None:
        for child in ast.iter_child_nodes(node):
            child_in_main = in_main or (
                isinstance(child, ast.If) and any(_dunder_main_test(t) for t in ast.walk(child.test))
            )
            if isinstance(child, ast.Call):
                callee = child.func
                if (isinstance(callee, ast.Name) and callee.id == name) or (
                    isinstance(callee, ast.Attribute) and callee.attr == name
                ):
                    sites.append((child.lineno, child_in_main))
            walk(child, child_in_main)

    walk(tree, False)
    return sites


def in_process_main_violations(source: str) -> list[str]:
    """静态判据：返回"同进程可达的 main() 调用"违规描述列表（空 = 合规）。"""
    tree = ast.parse(source)
    violations: list[str] = []
    # 1) 顶层（不在任何函数里、也不在 __main__ 分支里）直接调 main()
    top_level_sites = [
        (n.lineno, False)
        for n in ast.iter_child_nodes(tree)
        if isinstance(n, ast.Expr) and _is_main_call(n.value)
    ]
    for lineno, in_main in top_level_sites:
        if not in_main:
            violations.append(f"顶层第 {lineno} 行同进程调用 main()")
    # 2) 函数内的 main() 调用：该函数必须只从 `__main__` 分支被可达
    for fn_name in _functions_calling_main(tree):
        sites = _call_sites(tree, fn_name)
        exposed = [ln for ln, in_main in sites if not in_main]
        if exposed:
            violations.append(
                f"{fn_name}() 内含 main() 调用，却在 __main__ 分支之外被调用（行 {exposed}）"
            )
    return violations


def _block_main_in_guard(source: str) -> bool:
    """自检用：本文件自己不得含有违规（它也 import 了 ast，但绝不调用任何 main()）。"""
    return not in_process_main_violations(source)


class RunMainProcessIsolationGuardTest(unittest.TestCase):
    """TEST-01 棘轮 + 自检（自检证明它**能变红**，不是永远绿的空扫）。"""

    def test_existing_edge_tests_have_no_in_process_main_call(self) -> None:
        offenders: dict[str, list[str]] = {}
        for path in sorted(TESTS_DIR.glob("test_*.py")):
            violations = in_process_main_violations(path.read_text(encoding="utf-8"))
            if violations:
                offenders[path.name] = violations
        self.assertEqual(
            offenders,
            {},
            "边缘测试出现同进程可达的 run.main() 调用（TEST-01：进程级注册不可重置，"
            "会把污染带到同 worker 的其它用例上）。关停探针必须走 "
            "`subprocess.run([sys.executable, __file__, '--probe'])` 那条自举子进程路径。",
        )

    def test_self_check_negative_control_can_go_red(self) -> None:
        """反向控制：把探针函数从 `__main__` 分支挪进测试方法，判据必须报违规。"""
        sanctioned = '''
import subprocess, sys

def _probe():
    run_module.main()

if __name__ == "__main__":
    _probe()
else:
    subprocess.run([sys.executable, __file__, "--probe"])
'''
        leaking = '''
import unittest

def _probe():
    run_module.main()

class T(unittest.TestCase):
    def test_it(self):
        _probe()
'''
        top_level = "import edge_platform.run as run_module\nrun_module.main()\n"
        self.assertEqual(in_process_main_violations(sanctioned), [], "合规形状被误报")
        self.assertTrue(
            in_process_main_violations(leaking), "违规形状没被抓到 ⇒ 这道门禁是假的"
        )
        self.assertTrue(
            any("顶层" in v for v in in_process_main_violations(top_level)),
            "顶层裸调用没被判违规 ⇒ 判据太弱",
        )

    def test_this_guard_file_itself_is_clean(self) -> None:
        self.assertTrue(
            _block_main_in_guard(pathlib.Path(__file__).read_text(encoding="utf-8")),
            "守卫文件自己引入了同进程 main() 调用",
        )


if __name__ == "__main__":
    unittest.main()
