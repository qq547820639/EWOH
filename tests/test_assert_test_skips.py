"""`scripts/assert-test-skips.py` 的自测（CI-01 门禁自身必须有正反例）。

用轻量 fixture 而不是跑真 pytest：只验裁决语义。
运行：PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_assert_test_skips.py
"""
import importlib.util
import os
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "assert_test_skips", os.path.join(ROOT, "scripts", "assert-test-skips.py")
)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

SOLVER_REASON = "ortools 未安装，跳过真实求解 fixture 测试"


def one_skip(reason=SOLVER_REASON, path="tests/test_cpsat_solver_real.py"):
    return f"SKIPPED [1] {path}:65: {reason}\n1 skipped in 0.01s\n"


def run_main(text, baseline=os.devnull):
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8") as fh:
        fh.write(text)
        path = fh.name
    try:
        return gate.main(["--baseline", baseline, "--input", path])
    finally:
        os.unlink(path)


class SkipGateTest(unittest.TestCase):
    def test_parse_skips_aggregates_by_file_and_reason(self):
        text = (
            "SKIPPED [1] tests/test_a.py:10: 缺依赖\n"
            "SKIPPED [1] tests/test_a.py:22: 缺依赖\n"
            "SKIPPED [1] tests/test_b.py:7: 需要 X ≥ 2.0\n"
            "3 skipped in 0.01s\n"
        )
        counts = gate.parse_skips(text)
        self.assertEqual(counts[("tests/test_a.py", "缺依赖")], 2)
        self.assertEqual(counts[("tests/test_b.py", "需要 X ≥ 2.0")], 1)
        self.assertEqual(gate.count_from_summary(text), 3)

    def test_unregistered_skip_fails(self):
        observed = gate.parse_skips(one_skip())
        problems = gate.evaluate(observed, {})
        self.assertEqual(len(problems), 1)
        self.assertIn("不在基线内", problems[0])
        # 回归信息必须给出可直接粘贴的登记行
        self.assertIn(":: 1", problems[0])

    def test_registered_skip_within_budget_passes(self):
        observed = gate.parse_skips(one_skip())
        baseline = {("tests/test_cpsat_solver_real.py", SOLVER_REASON): 1}
        self.assertEqual(gate.evaluate(observed, baseline), [])

    def test_count_above_budget_fails(self):
        text = (
            "SKIPPED [1] tests/test_cpsat_solver_real.py:65: " + SOLVER_REASON + "\n"
            "SKIPPED [1] tests/test_cpsat_solver_real.py:99: " + SOLVER_REASON + "\n"
            "2 skipped in 0.01s\n"
        )
        baseline = {("tests/test_cpsat_solver_real.py", SOLVER_REASON): 1}
        problems = gate.evaluate(gate.parse_skips(text), baseline)
        self.assertEqual(len(problems), 1)
        self.assertIn("基线登记 1 次", problems[0])

    def test_disappearing_baseline_entry_is_hinted_not_failed(self):
        problems = gate.evaluate({}, {("tests/test_x.py", "原因"): 2})
        self.assertEqual(problems, [])

    def test_solver_mode_rejects_optional_dependency_skip(self):
        observed = gate.parse_skips(one_skip())
        baseline = {("tests/test_cpsat_solver_real.py", SOLVER_REASON): 1}
        problems = gate.evaluate(observed, baseline, require_solver=True)
        self.assertEqual(len(problems), 1)
        self.assertIn("求解 job 不允许可选依赖跳过", problems[0])

    def test_summary_without_parsed_lines_fails(self):
        """漏 `-rs` 时汇总说有跳过却解析不到行——必须判失败，不能判通过。"""
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8") as fh:
            fh.write("10 passed, 3 skipped in 1.00s\n")
            path = fh.name
        try:
            rc = gate.main(["--baseline", os.devnull, "--input", path])
        finally:
            os.unlink(path)
        self.assertEqual(rc, 1)

    def test_real_baseline_file_matches_repository_reality(self):
        """基线文件本身必须可解析，且计数与格式合法（防手改写坏）。"""
        baseline = gate.parse_baseline(os.path.join(ROOT, "tests", "ci-skip-baseline.txt"))
        self.assertGreater(sum(baseline.values()), 0)
        for (path, reason), count in baseline.items():
            self.assertTrue(path.endswith(".py"), path)
            self.assertTrue(reason, "原因不得为空")
            self.assertGreaterEqual(count, 1)

    # V41 实测：同一份用例在 pytest 9.1.1 + 缺 PyYAML 的解释器下于**收集期** ImportError，
    # 汇总只有 `2 errors in 0.74s`、SKIPPED 行 0 条。只看跳过清单会打印「OK：0 项跳过」，
    # 于是「一次什么都没跑成的运行」被当成通过证据——正是本门禁要消灭的形态，故先判运行健康。
    PY9_COLLECTION_ERRORS = (
        "_________________ ERROR collecting tests/test_event_envelope.py _________________\n"
        "ImportError while importing test module '/repo/tests/test_event_envelope.py'.\n"
        "E   ModuleNotFoundError: No module named 'yaml'\n"
        "Interrupted: 2 errors during collection\n"
        "2 errors in 0.74s\n"
    )

    def test_collection_errors_are_not_passing_evidence(self):
        self.assertTrue(gate.run_health(self.PY9_COLLECTION_ERRORS))
        self.assertEqual(run_main(self.PY9_COLLECTION_ERRORS), 1)

    def test_run_with_nothing_passed_is_not_passing_evidence(self):
        self.assertTrue(gate.run_health("no tests ran in 0.01s\n"))

    def test_body_mentioning_error_does_not_trip_health_check(self):
        """健康判定只看汇总行：正文里的 ERROR 字样不该把一次正常运行判死。"""
        text = (
            "ERROR root: captured log mentions errors while still passing\n"
            "SKIPPED [1] tests/test_cpsat_solver_real.py:65: " + SOLVER_REASON + "\n"
            "2068 passed, 1 skipped in 145.33s\n"
        )
        self.assertEqual(gate.run_health(text), [])


if __name__ == "__main__":
    unittest.main()
