"""模型与规则版本治理：注册/评审/影子/受控验证/灰度/激活/退役/回滚，全链路审计。

对应 spec「算法分阶段实施」与「模型结果 100% 可追溯到模型和数据版本」：
- Task 25 模型上线流程增强：生命周期
  CANDIDATE（候选）→ REVIEWING（安全评审中）→ SHADOW（影子运行，只记录不执行）→
  CONTROLLED_VALIDATION（受控验证中）→ CANARY（小范围启用中）→ ACTIVE（建议模式）→
  RETIRED（退役）；激活需人工批准（approver_id），禁止模型自动在线学习直接覆盖生产模型
  （spec「禁止模型自动在线学习直接覆盖生产模型」）。
- 每个模型记录携带 model_type / version / data_version / feature_version /
  threshold_version / model_card_uri，保证「模型结果 100% 可追溯到模型和数据版本」。
- 每次状态流转入审计（actor/ts/ref/from_status/to_status），支持 rollback 到曾
  ACTIVE/SHADOW 的历史版本。

注：promote_to_shadow 作为 CANDIDATE→SHADOW 的便捷捷径保留（兼容已有调用）；
规范上线路径为 submit_for_review → approve_review → start_controlled_validation →
start_canary → activate。

纯 Python 标准库实现；沿用 edge_platform.spatial 的 new_id / now_iso 约定。
"""

import enum
from dataclasses import dataclass
from typing import Dict, List, Optional

from edge_platform.spatial import new_id, now_iso


class ModelStatus(enum.Enum):
    """模型/规则生命周期状态。"""
    CANDIDATE = "CANDIDATE"                       # 候选：已登记，未上线
    REVIEWING = "REVIEWING"                       # 安全评审中
    SHADOW = "SHADOW"                             # 影子运行：只记录不执行，与现行方案对比
    CONTROLLED_VALIDATION = "CONTROLLED_VALIDATION"  # 受控验证中
    CANARY = "CANARY"                             # 小范围启用中（灰度）
    ACTIVE = "ACTIVE"                             # 建议/生效模式
    RETIRED = "RETIRED"                           # 退役


# 合法模型类型（spec「算法分阶段实施」涉及的模型/规则类别）
ACTION_CLASSIFIER = "action_classifier"
FATIGUE_SCORER = "fatigue_scorer"
SCHEDULER = "scheduler"
RULE_SET = "rule_set"
VISION_DETECTOR = "vision_detector"

VALID_MODEL_TYPES = frozenset({
    ACTION_CLASSIFIER, FATIGUE_SCORER, SCHEDULER, RULE_SET, VISION_DETECTOR,
})


@dataclass
class ModelRecord:
    """模型/规则版本记录：携带数据/特征/阈值版本与模型卡，保证可追溯。

    spec「模型结果 100% 可追溯到模型和数据版本」：data_version / feature_version /
    threshold_version / model_card_uri 共同构成追溯链。Task 25 新增上线流程字段：
    canary_ratio（灰度比例）/ approver_id（激活批准人）/ safety_reviewer_id（安全评审人）。
    """
    model_type: str
    version: str
    model_id: str = ""
    status: ModelStatus = ModelStatus.CANDIDATE
    data_version: str = ""
    feature_version: str = ""
    threshold_version: str = ""
    model_card_uri: str = ""
    activated_at: Optional[str] = None
    retired_at: Optional[str] = None
    audit_ref: str = ""
    # Task 25：上线流程增强字段
    canary_ratio: Optional[float] = None       # 灰度比例（CANARY 阶段记录）
    approver_id: Optional[str] = None          # 激活批准人（ACTIVE 阶段记录）
    safety_reviewer_id: Optional[str] = None   # 安全评审人（REVIEWING→SHADOW 记录）

    def __post_init__(self):
        if not self.model_id:
            self.model_id = new_id("MODEL")
        if self.model_type not in VALID_MODEL_TYPES:
            raise ValueError("未知模型类型: %r" % (self.model_type,))
        if isinstance(self.status, str):
            self.status = ModelStatus(self.status)

    def to_dict(self):
        return {
            "model_id": self.model_id,
            "model_type": self.model_type,
            "version": self.version,
            "status": self.status.value,
            "data_version": self.data_version,
            "feature_version": self.feature_version,
            "threshold_version": self.threshold_version,
            "model_card_uri": self.model_card_uri,
            "activated_at": self.activated_at,
            "retired_at": self.retired_at,
            "audit_ref": self.audit_ref,
            "canary_ratio": self.canary_ratio,
            "approver_id": self.approver_id,
            "safety_reviewer_id": self.safety_reviewer_id,
        }


class ModelRegistry:
    """模型/规则版本治理注册表。

    Task 25 上线流程增强后的规范生命周期：
    CANDIDATE →（submit_for_review）→ REVIEWING →（approve_review）→ SHADOW →
    （start_controlled_validation）→ CONTROLLED_VALIDATION →（start_canary）→
    CANARY →（activate，需 approver_id 人工批准）→ ACTIVE →（retire）→ RETIRED。

    - register：默认 CANDIDATE（生命周期必须从候选开始）；
    - submit_for_review：CANDIDATE → REVIEWING（安全评审中）；
    - approve_review：REVIEWING → SHADOW（需 reviewer_id，记录 safety_reviewer_id）；
    - promote_to_shadow：CANDIDATE → SHADOW 的便捷捷径（兼容已有调用）；
    - start_controlled_validation：SHADOW → CONTROLLED_VALIDATION；
    - start_canary：CONTROLLED_VALIDATION → CANARY（记录 canary_ratio）；
    - activate：必须先处于 CANARY（spec「禁止模型自动在线学习直接覆盖生产模型」，
      需人工 approver_id 批准）→ ACTIVE，同时将同 model_type 的原 ACTIVE 自动置 RETIRED；
    - retire：→ RETIRED；
    - active(model_type)：当前生效模型（每个 model_type 至多一个 ACTIVE）；
    - rollback：将当前 ACTIVE 置 RETIRED，把目标历史版本（曾 ACTIVE/SHADOW）重新置 ACTIVE。
    每次流转入审计（actor/ts/ref/from_status/to_status）。
    """

    def __init__(self):
        self._by_id: Dict[str, ModelRecord] = {}
        # model_type -> [model_id]（按注册顺序）
        self._by_type: Dict[str, List[str]] = {}
        # 状态流转审计
        self.audit_trail: List[Dict] = []

    # ---- 审计 ----
    def _log(self, model_id, action, actor_id, audit_ref,
             from_status, to_status, detail=""):
        entry = {
            "log_id": new_id("MAUD"),
            "model_id": model_id,
            "action": action,
            "actor_id": actor_id,
            "ts": now_iso(),
            "ref": audit_ref,
            "from_status": (from_status.value
                            if isinstance(from_status, ModelStatus) else from_status),
            "to_status": (to_status.value
                          if isinstance(to_status, ModelStatus) else to_status),
            "detail": detail,
        }
        self.audit_trail.append(entry)
        return entry

    def _require(self, model_id):
        rec = self._by_id.get(model_id)
        if rec is None:
            raise KeyError("模型未注册: %s" % model_id)
        return rec

    def _was_active_or_shadow(self, model_id):
        """是否曾进入 ACTIVE/SHADOW（依据审计流转记录判定）。

        Task 25：CANARY 也视为可回滚目标（灰度阶段已通过影子运行）。
        """
        for e in self.audit_trail:
            if e["model_id"] == model_id and e["to_status"] in (
                    "ACTIVE", "SHADOW", "CANARY"):
                return True
        return False

    # ---- 变更 ----
    def register(self, model_record):
        """登记模型/规则版本；生命周期从 CANDIDATE 开始。"""
        if not isinstance(model_record, ModelRecord):
            raise TypeError("只接受 ModelRecord 实例")
        # 强制从候选开始，避免绕过影子运行直接生效
        model_record.status = ModelStatus.CANDIDATE
        self._by_id[model_record.model_id] = model_record
        self._by_type.setdefault(model_record.model_type, []).append(model_record.model_id)
        self._log(
            model_record.model_id, "register", "", "", None, ModelStatus.CANDIDATE,
            detail="version=%s data=%s feature=%s threshold=%s" % (
                model_record.version, model_record.data_version,
                model_record.feature_version, model_record.threshold_version),
        )
        return model_record

    # ---- Task 25：上线流程增强 ----
    def submit_for_review(self, model_id, submitter_id):
        """CANDIDATE → REVIEWING（提交安全评审）。

        spec Task 25.1「安全评审」步骤：候选模型须先进入安全评审。
        """
        rec = self._require(model_id)
        if rec.status is not ModelStatus.CANDIDATE:
            raise ValueError(f"仅 CANDIDATE 可提交评审，当前状态: {rec.status.value}")
        old = rec.status
        rec.status = ModelStatus.REVIEWING
        entry = self._log(model_id, "submit_for_review", submitter_id, "",
                          old, ModelStatus.REVIEWING)
        rec.audit_ref = entry["log_id"]
        return rec

    def approve_review(self, model_id, reviewer_id):
        """REVIEWING → SHADOW（安全评审通过，需 reviewer_id）。

        reviewer_id 记录于 ModelRecord.safety_reviewer_id，保证评审可追溯。
        """
        if not reviewer_id:
            raise ValueError("approve_review 需要 reviewer_id（安全评审人）")
        rec = self._require(model_id)
        if rec.status is not ModelStatus.REVIEWING:
            raise ValueError(f"仅 REVIEWING 可通过评审进入影子运行，当前状态: {rec.status.value}")
        old = rec.status
        rec.status = ModelStatus.SHADOW
        rec.safety_reviewer_id = reviewer_id
        entry = self._log(model_id, "approve_review", reviewer_id, "",
                          old, ModelStatus.SHADOW)
        rec.audit_ref = entry["log_id"]
        return rec

    def start_controlled_validation(self, model_id):
        """SHADOW → CONTROLLED_VALIDATION（受控验证）。

        spec Task 25.1「受控验证」步骤：影子运行达标后进入受控验证。
        """
        rec = self._require(model_id)
        if rec.status is not ModelStatus.SHADOW:
            raise ValueError(f"仅 SHADOW 可进入受控验证，当前状态: {rec.status.value}")
        old = rec.status
        rec.status = ModelStatus.CONTROLLED_VALIDATION
        entry = self._log(model_id, "start_controlled_validation", "", "",
                          old, ModelStatus.CONTROLLED_VALIDATION)
        rec.audit_ref = entry["log_id"]
        return rec

    def start_canary(self, model_id, canary_ratio=0.1):
        """CONTROLLED_VALIDATION → CANARY（小范围灰度启用）。

        canary_ratio 记录于 ModelRecord.canary_ratio；spec Task 25.1「小范围启用」步骤。
        """
        rec = self._require(model_id)
        if rec.status is not ModelStatus.CONTROLLED_VALIDATION:
            raise ValueError(f"仅 CONTROLLED_VALIDATION 可进入灰度，当前状态: {rec.status.value}")
        old = rec.status
        rec.status = ModelStatus.CANARY
        rec.canary_ratio = canary_ratio
        entry = self._log(model_id, "start_canary", "", "",
                          old, ModelStatus.CANARY,
                          detail=f"canary_ratio={canary_ratio}")
        rec.audit_ref = entry["log_id"]
        return rec

    def promote_to_shadow(self, model_id, audit_ref):
        """CANDIDATE → SHADOW 的便捷捷径（兼容已有调用）。

        规范上线路径为 submit_for_review → approve_review；本方法保留以兼容既有调用，
        允许跳过评审直接进入影子运行。
        """
        rec = self._require(model_id)
        if rec.status is not ModelStatus.CANDIDATE:
            raise ValueError("仅 CANDIDATE 可进入影子运行，当前状态: %s" % rec.status.value)
        old = rec.status
        rec.status = ModelStatus.SHADOW
        entry = self._log(model_id, "promote_to_shadow", "", audit_ref,
                          old, ModelStatus.SHADOW)
        rec.audit_ref = entry["log_id"]
        return rec

    def activate(self, model_id, approver_id):
        """CANARY → ACTIVE；需人工 approver_id 批准（spec「禁止模型自动在线学习直接覆盖生产模型」）。

        激活同时将同 model_type 的原 ACTIVE 自动置 RETIRED，保证每类至多一个生效模型。
        approver_id 记录于 ModelRecord.approver_id，保证激活可追溯。
        """
        if not approver_id:
            raise ValueError("activate 需要 approver_id（人工批准）")
        rec = self._require(model_id)
        if rec.status is not ModelStatus.CANARY:
            raise ValueError(
                "仅 CANARY 可激活为建议模式（需人工批准），当前状态: %s"
                % rec.status.value)
        cur = self.active(rec.model_type)
        if cur is not None and cur.model_id != model_id:
            old = cur.status
            cur.status = ModelStatus.RETIRED
            cur.retired_at = now_iso()
            self._log(cur.model_id, "retire(auto)", "", "",
                      old, ModelStatus.RETIRED, detail="被 %s 取代" % model_id)
        old = rec.status
        rec.status = ModelStatus.ACTIVE
        rec.activated_at = now_iso()
        rec.approver_id = approver_id
        entry = self._log(model_id, "activate", approver_id, "", old, ModelStatus.ACTIVE)
        rec.audit_ref = entry["log_id"]
        return rec

    def retire(self, model_id, audit_ref):
        """任意状态 → RETIRED。"""
        rec = self._require(model_id)
        old = rec.status
        rec.status = ModelStatus.RETIRED
        rec.retired_at = now_iso()
        entry = self._log(model_id, "retire", "", audit_ref, old, ModelStatus.RETIRED)
        rec.audit_ref = entry["log_id"]
        return rec

    # ---- 查询 ----
    def active(self, model_type):
        """返回某 model_type 的当前生效模型（ACTIVE）；无则 None。"""
        for mid in self._by_type.get(model_type, []):
            rec = self._by_id[mid]
            if rec.status is ModelStatus.ACTIVE:
                return rec
        return None

    def history(self, model_type):
        """返回某 model_type 的全部版本记录（按注册顺序）。"""
        return [self._by_id[mid] for mid in self._by_type.get(model_type, [])]

    def get(self, model_id):
        """按 model_id 取模型记录。"""
        return self._by_id.get(model_id)

    def rollback(self, model_type, to_model_id, audit_ref):
        """回滚：将当前 ACTIVE 置 RETIRED，把目标历史版本重新置 ACTIVE。

        仅允许回滚到曾 ACTIVE/SHADOW 的版本（spec 模型回滚）。
        返回重新生效的模型记录。
        """
        target = self._require(to_model_id)
        if target.model_type != model_type:
            raise ValueError("目标模型类型不匹配: %s vs %s"
                             % (target.model_type, model_type))
        if not self._was_active_or_shadow(to_model_id):
            raise ValueError("仅可回滚到曾 ACTIVE/SHADOW 的版本: %s" % to_model_id)
        # 将当前 ACTIVE 置 RETIRED
        cur = self.active(model_type)
        if cur is not None and cur.model_id != to_model_id:
            old = cur.status
            cur.status = ModelStatus.RETIRED
            cur.retired_at = now_iso()
            self._log(cur.model_id, "retire(rollback)", "", audit_ref,
                      old, ModelStatus.RETIRED, detail="回滚让位 %s" % to_model_id)
        old = target.status
        target.status = ModelStatus.ACTIVE
        target.activated_at = now_iso()
        entry = self._log(to_model_id, "rollback", "", audit_ref,
                          old, ModelStatus.ACTIVE, detail="回滚到该版本")
        target.audit_ref = entry["log_id"]
        return target
