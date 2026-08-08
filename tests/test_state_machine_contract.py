"""Contract-driven state machine 校验测试（P1-contract）。

验证：
1. contracts/state-machines/{task,plan}.yaml 可被极简解析器加载；
2. Python scheduler.models 的 TASK_TRANSITIONS / PLAN_TRANSITIONS 与契约一致；
3. 契约漂移可被检测（负测试：人为修改后 validate 必须报差异）。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from edge_platform.contracts import state_machine_loader as sml  # noqa: E402
from edge_platform.scheduler import models  # noqa: E402


class StateMachineContractTest(unittest.TestCase):
    def test_parse_task_contract(self):
        sm = sml.load_state_machine("task")
        self.assertEqual(len(sm["states"]), 11)
        self.assertEqual(len(sm["transitions"]), 14)
        self.assertEqual(sm["terminal"], ["completed", "cancelled"])
        # 关键转换存在
        trans = {(t["from"], t["to"]) for t in sm["transitions"]}
        self.assertIn(("executing", "paused"), trans)
        self.assertIn(("any_non_terminal", "cancelled"), trans)

    def test_parse_plan_contract(self):
        sm = sml.load_state_machine("plan")
        self.assertEqual(len(sm["states"]), 7)
        self.assertEqual(len(sm["transitions"]), 8)
        self.assertEqual(sm["terminal"], ["dispatched", "expired", "archived"])

    def test_task_transitions_match_contract(self):
        errors = sml.validate_task_against_models(models)
        self.assertEqual(errors, [], "Python TASK_TRANSITIONS 与 task.yaml 漂移:\n" + "\n".join(errors))

    def test_plan_transitions_match_contract(self):
        errors = sml.validate_plan_against_models(models)
        self.assertEqual(errors, [], "Python PLAN_TRANSITIONS 与 plan.yaml 漂移:\n" + "\n".join(errors))

    def test_contract_drift_is_detected(self):
        """负测试：人为引入契约差异，校验器必须报告（证明可执行性）。"""
        fake_models = type(
            "FakeModels",
            (),
            {
                "TASK_TRANSITIONS": {
                    # 契约要求 executing->completed；此处故意缺失
                    "TASK_EXECUTING": {"TASK_PAUSED", "TASK_EXCEPTION"},
                    "TASK_DRAFT": {"TASK_PENDING_CONFIRM"},
                    "TASK_PENDING_CONFIRM": {"TASK_PENDING_APPROVAL", "TASK_PENDING_DISPATCH"},
                    "TASK_PENDING_APPROVAL": {"TASK_PENDING_DISPATCH", "TASK_DRAFT"},
                    "TASK_PENDING_DISPATCH": {"TASK_DISPATCHED"},
                    "TASK_DISPATCHED": {"TASK_RECEIVED"},
                    "TASK_RECEIVED": {"TASK_EXECUTING"},
                    "TASK_PAUSED": {"TASK_EXECUTING"},
                    "TASK_EXCEPTION": {"TASK_EXECUTING"},
                },
                "PLAN_TRANSITIONS": {},
            },
        )
        errors = sml.validate_task_against_models(fake_models)
        self.assertTrue(any("executing -> ['completed']" in e for e in errors),
                        f"应检测到 missing completed 转换: {errors}")


if __name__ == "__main__":
    unittest.main()
