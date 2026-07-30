"""候选生成：(person, device) 笛卡尔积 + 硬约束违规填充。

对应 spec「决策与调度层」：硬约束过滤→候选人员生成。失败候选不删除，标记 passed=False
并保留违规原因，供理由生成解释"为何某人被排除"（spec："评分明细中体现拦截原因"）。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field
from typing import Any

from edge_platform.spatial import new_id
from .constraints import HardConstraints


@dataclass
class Candidate:
    """调度候选：(人员, 设备, 任务, 工位) 组合 + 评分 + 违规。

    score 为 None 表示尚未评分；passed 为 False 表示被硬约束拦截（违规原因见 violations）。
    explanation 由编排器在评分后挂载（explain_candidate 产出）。
    """
    person_id: str = ""
    device_id: str = ""
    task_id: str = ""
    station_id: str = ""
    score: float = None
    score_breakdown: dict = field(default_factory=dict)
    violations: list = field(default_factory=list)
    passed: bool = False
    candidate_id: str = ""
    explanation: Any = None

    def __post_init__(self):
        if not self.candidate_id:
            self.candidate_id = new_id("CAND")

    def to_dict(self):
        return {
            "candidate_id": self.candidate_id,
            "person_id": self.person_id,
            "device_id": self.device_id,
            "task_id": self.task_id,
            "station_id": self.station_id,
            "score": self.score,
            "score_breakdown": dict(self.score_breakdown),
            "violations": [v.to_dict() if hasattr(v, "to_dict") else v
                           for v in self.violations],
            "passed": self.passed,
        }


class CandidateGenerator:
    """候选生成器：遍历 persons × devices，调用 HardConstraints.check 填充违规。"""

    def generate(self, task, persons, devices, constraints, ctx=None):
        """生成候选列表，每个 (person, device) 对一个 Candidate。

        失败候选保留（passed=False）以便解释拦截原因；调用方排序时仅取 passed=True。
        per spec "评分明细中体现拦截原因"：被排除人员及其违规原因可在候选列表中查到。
        """
        task_id = task.get("task_id", "")
        station_id = task.get("station_id", "")
        candidates = []
        for person in persons:
            pid = person.get("person_id", "")
            for device in devices:
                did = device.get("device_id", "")
                violations = constraints.check(person, task, device, ctx)
                cand = Candidate(
                    person_id=pid,
                    device_id=did,
                    task_id=task_id,
                    station_id=station_id,
                    violations=violations,
                    passed=(len(violations) == 0),
                )
                candidates.append(cand)
        return candidates
