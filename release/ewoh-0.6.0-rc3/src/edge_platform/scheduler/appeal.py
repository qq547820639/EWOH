"""员工申诉 / 标记误判 / 说明特殊情况通道。

对应 spec Task 25.4「员工申诉、标记误判、说明特殊情况通道」：
- 员工可对调度结果或风险事件判定提出申诉、标记误判或说明特殊情况；
- 申诉一经提交即入审计，由复核人 acknowledge → REVIEWING → resolve/reject 流转；
- 处理动作（resolution_action）显式分类，便于追溯是否触发数据更正/决策撤销/升级。

不变量：
- 申诉必须有 description（spec「确认时必须选择或填写理由」同理，申诉也必须有说明）；
- target_ref 必须含 kind 与 id，便于精确追溯申诉对象；
- 处理（resolve）必须有 resolution 与 resolution_action，且 resolution_action 取值受控；
- 所有操作（submit/acknowledge/resolve/reject）均入审计日志。

安全边界：
- 本通道只记录与流转，不直接修改已执行的调度结果（如需撤销已执行调度，走 Scheduler
  正式 reject/重新 propose 流程）；cancel_decision 仅作为处理动作标记，不在此处旁路执行。
- 申诉内容不直接触发设备安全控制；急停/限扭/关节实时控制等保留在设备控制器本地。

纯 Python 标准库实现；沿用 edge_platform.spatial 的 new_id / now_iso 约定。
"""

import enum
from dataclasses import dataclass, field
from typing import Optional

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import new_id, now_iso


class AppealType(enum.Enum):
    """申诉类型（spec Task 25.4）。"""

    MISJUDGEMENT = "misjudgement"  # 标记误判（动作识别错误、负荷评分不准等）
    SPECIAL_CIRCUMSTANCE = "special_circumstance"  # 说明特殊情况（临时身体不适、设备异常等）
    SCHEDULING_OBJECTION = "scheduling_objection"  # 对调度方案的异议
    DATA_DISPUTE = "data_dispute"  # 对传感器数据/识别结果的争议


# 申诉状态机
PENDING = "PENDING"  # 已提交，待复核
REVIEWING = "REVIEWING"  # 已被复核人认领，处理中
RESOLVED = "RESOLVED"  # 已处理（含数据更正/决策撤销/升级/确认）
REJECTED = "REJECTED"  # 复核人驳回申诉

# 处理动作（受控取值）
ACT_ACKNOWLEDGE = "acknowledge"  # 确认收到，无需更正
ACT_CORRECT_DATA = "correct_data"  # 更正数据/识别结果
ACT_CANCEL_DECISION = "cancel_decision"  # 撤销相关决策（标记，不旁路执行）
ACT_ESCALATE = "escalate"  # 升级处理
_VALID_RESOLUTION_ACTIONS = {
    ACT_ACKNOWLEDGE,
    ACT_CORRECT_DATA,
    ACT_CANCEL_DECISION,
    ACT_ESCALATE,
}


@dataclass
class AppealRecord:
    """申诉记录：申诉人 + 类型 + 对象引用 + 说明 + 证据 + 状态机 + 处理结果。

    target_ref 形如 {"kind":"schedule_request","id":"REQ-xxx"} 或
    {"kind":"risk_event","id":"EV-xxx"} 或 {"kind":"recognition_result","id":...}，
    用于精确追溯申诉对象（spec「对误判进行申诉」「对错误数据提出更正」）。
    """

    appeal_id: str
    ts: str
    appellant_id: str
    appeal_type: str
    target_ref: dict
    description: str
    evidence_refs: list[str] = field(default_factory=list)
    status: str = PENDING
    resolved_by: Optional[str] = None
    resolution: Optional[str] = None
    resolution_action: Optional[str] = None
    resolved_at: Optional[str] = None

    @property
    def ts_ms(self):
        """申诉提交时间戳（毫秒），便于排序与审计（复用 inference.ts_to_ms）。"""
        return ts_to_ms(self.ts)

    def to_dict(self):
        return {
            "appeal_id": self.appeal_id,
            "ts": self.ts,
            "ts_ms": self.ts_ms,
            "appellant_id": self.appellant_id,
            "appeal_type": self.appeal_type,
            "target_ref": dict(self.target_ref),
            "description": self.description,
            "evidence_refs": list(self.evidence_refs),
            "status": self.status,
            "resolved_by": self.resolved_by,
            "resolution": self.resolution,
            "resolution_action": self.resolution_action,
            "resolved_at": self.resolved_at,
        }


@dataclass
class AppealStats:
    """申诉统计：总数 / 待处理 / 已处理 / 已驳回 / 按类型 / 按处理动作。"""

    total: int
    pending: int
    resolved: int
    rejected: int
    by_type: dict[str, int] = field(default_factory=dict)
    by_resolution_action: dict[str, int] = field(default_factory=dict)

    def to_dict(self):
        return {
            "total": self.total,
            "pending": self.pending,
            "resolved": self.resolved,
            "rejected": self.rejected,
            "by_type": dict(self.by_type),
            "by_resolution_action": dict(self.by_resolution_action),
        }


class AppealChannel:
    """员工申诉通道：submit / acknowledge / resolve / reject / 查询 / 审计。

    - submit：员工提交申诉（校验类型/说明/对象引用），返回 PENDING 的 AppealRecord；
    - acknowledge：复核人认领，状态 PENDING → REVIEWING；
    - resolve：复核人处理，必须给出 resolution 与 resolution_action（受控取值）；
    - reject：复核人驳回申诉，记录理由；
    - list_by_target：按申诉对象追溯影响（spec「对误判进行申诉」「对错误数据提出更正」）。

    安全边界：本通道只记录与流转，不直接修改已执行的调度结果。
    """

    def __init__(self):
        self._appeals: dict[str, AppealRecord] = {}
        self._audit_log: list[dict] = []

    # ---- 内部工具 ----

    def _get(self, appeal_id):
        rec = self._appeals.get(appeal_id)
        if rec is None:
            raise KeyError(f"申诉记录不存在: {appeal_id}")
        return rec

    def _log(self, action, actor, appeal_id, details=""):
        entry = {
            "ts": now_iso(),
            "actor": actor,
            "action": action,
            "appeal_id": appeal_id,
            "details": details,
        }
        self._audit_log.append(entry)
        return entry

    @staticmethod
    def _normalize_appeal_type(appeal_type):
        """接受 AppealType 枚举或字符串，返回规范化的字符串取值；非法则抛错。"""
        if isinstance(appeal_type, AppealType):
            return appeal_type.value
        if isinstance(appeal_type, str) and appeal_type in AppealType._value2member_map_:
            return appeal_type
        raise ValueError(f"未知申诉类型: {appeal_type!r}（合法取值：{','.join(t.value for t in AppealType)}）")

    @staticmethod
    def _validate_target_ref(target_ref):
        if not isinstance(target_ref, dict):
            raise ValueError("target_ref 必须为字典（含 kind 与 id）")
        if not target_ref.get("kind") or not target_ref.get("id"):
            raise ValueError("target_ref 必须含 kind 与 id（用于精确追溯申诉对象）")

    # ---- 提交 ----

    def submit(self, appellant_id, appeal_type, target_ref, description, evidence_refs=None):
        """员工提交申诉，返回 PENDING 的 AppealRecord。

        校验（spec「申诉必须有说明」「对误判进行申诉」「对错误数据提出更正」）：
        - appeal_type 在 AppealType 中；
        - description 非空；
        - target_ref 含 kind 与 id。
        """
        atype_val = self._normalize_appeal_type(appeal_type)
        if not description or not str(description).strip():
            raise ValueError("申诉必须填写说明（description）")
        self._validate_target_ref(target_ref)

        appeal_id = new_id("APPEAL")
        ts = now_iso()
        rec = AppealRecord(
            appeal_id=appeal_id,
            ts=ts,
            appellant_id=appellant_id,
            appeal_type=atype_val,
            target_ref=dict(target_ref),
            description=str(description).strip(),
            evidence_refs=list(evidence_refs) if evidence_refs else [],
            status=PENDING,
        )
        self._appeals[appeal_id] = rec
        self._log(
            "submit",
            appellant_id,
            appeal_id,
            details=f"type={atype_val} target={target_ref.get('kind')}/{target_ref.get('id')}",
        )
        return rec

    # ---- 认领 / 处理 / 驳回 ----

    def acknowledge(self, appeal_id, reviewer_id):
        """复核人认领申诉：状态 PENDING → REVIEWING，记录 reviewer。"""
        rec = self._get(appeal_id)
        if rec.status != PENDING:
            raise ValueError(f"仅 PENDING 状态可认领，当前状态：{rec.status}")
        rec.status = REVIEWING
        rec.resolved_by = reviewer_id
        self._log("acknowledge", reviewer_id, appeal_id, details="status=REVIEWING")
        return rec

    def resolve(self, appeal_id, reviewer_id, resolution, resolution_action):
        """复核人处理申诉：状态 → RESOLVED，记录处理结果与处理动作。

        校验：
        - 当前状态为 PENDING 或 REVIEWING（已终态不可再处理）；
        - resolution 非空；
        - resolution_action 在受控取值集合中。
        """
        rec = self._get(appeal_id)
        if rec.status not in (PENDING, REVIEWING):
            raise ValueError(f"仅 PENDING/REVIEWING 状态可处理，当前状态：{rec.status}")
        if not resolution or not str(resolution).strip():
            raise ValueError("处理必须填写结果说明（resolution）")
        if resolution_action not in _VALID_RESOLUTION_ACTIONS:
            raise ValueError(
                "未知处理动作: {!r}（合法取值：{}）".format(
                    resolution_action,
                    ",".join(sorted(_VALID_RESOLUTION_ACTIONS)),
                )
            )
        rec.status = RESOLVED
        rec.resolved_by = reviewer_id
        rec.resolution = str(resolution).strip()
        rec.resolution_action = resolution_action
        rec.resolved_at = now_iso()
        self._log(
            "resolve",
            reviewer_id,
            appeal_id,
            details=f"action={resolution_action} resolution={rec.resolution}",
        )
        return rec

    def reject(self, appeal_id, reviewer_id, reason):
        """复核人驳回申诉：状态 → REJECTED，记录理由。"""
        rec = self._get(appeal_id)
        if rec.status in (RESOLVED, REJECTED):
            raise ValueError(f"已终态申诉不可驳回，当前状态：{rec.status}")
        rec.status = REJECTED
        rec.resolved_by = reviewer_id
        rec.resolution = str(reason or "").strip()
        rec.resolved_at = now_iso()
        self._log("reject", reviewer_id, appeal_id, details=f"reason={rec.resolution}")
        return rec

    # ---- 查询 ----

    def get(self, appeal_id):
        """按 ID 取申诉记录（供审计/回放使用）。"""
        return self._get(appeal_id)

    def list_by_appellant(self, appellant_id):
        """返回该员工提交的全部申诉（spec「员工应能申诉、标记误判或说明特殊情况」）。"""
        return [r for r in self._appeals.values() if r.appellant_id == appellant_id]

    def list_by_target(self, target_kind, target_id):
        """返回针对某对象的全部申诉（用于追溯影响，spec「对误判进行申诉」）。"""
        out = []
        for r in self._appeals.values():
            if r.target_ref.get("kind") == target_kind and r.target_ref.get("id") == target_id:
                out.append(r)
        return out

    def list_pending(self):
        """返回所有待处理申诉（PENDING 与 REVIEWING，即尚未终态）。"""
        return [r for r in self._appeals.values() if r.status in (PENDING, REVIEWING)]

    def stats(self):
        """返回 AppealStats：总数 / 待处理 / 已处理 / 已驳回 / 按类型 / 按处理动作。"""
        by_type: dict[str, int] = {}
        by_action: dict[str, int] = {}
        pending = 0
        resolved = 0
        rejected = 0
        for r in self._appeals.values():
            by_type[r.appeal_type] = by_type.get(r.appeal_type, 0) + 1
            if r.status in (PENDING, REVIEWING):
                pending += 1
            elif r.status == RESOLVED:
                resolved += 1
            elif r.status == REJECTED:
                rejected += 1
            if r.resolution_action:
                by_action[r.resolution_action] = by_action.get(r.resolution_action, 0) + 1
        return AppealStats(
            total=len(self._appeals),
            pending=pending,
            resolved=resolved,
            rejected=rejected,
            by_type=by_type,
            by_resolution_action=by_action,
        )

    def audit_log(self):
        """返回审计日志列表（每次 submit/acknowledge/resolve/reject 各一条）。"""
        return list(self._audit_log)
