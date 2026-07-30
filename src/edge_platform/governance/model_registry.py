"""模型与规则版本治理：注册/影子/激活/退役/回滚，全链路审计。

对应 spec「算法分阶段实施」与「模型结果 100% 可追溯到模型和数据版本」：
- 模型/规则生命周期：CANDIDATE（候选）→ SHADOW（影子运行，只记录不执行）→ ACTIVE
  （建议模式）→ RETIRED（退役）；影子运行未达标不得进入建议模式（activate 需先经 SHADOW）。
- 每个模型记录携带 model_type / version / data_version / feature_version /
  threshold_version / model_card_uri，保证「模型结果 100% 可追溯到模型和数据版本」。
- 每次状态流转入审计（actor/ts/ref/from_status/to_status），支持 rollback 到曾
  ACTIVE/SHADOW 的历史版本。

纯 Python 标准库实现；沿用 edge_platform.spatial 的 new_id / now_iso 约定。
"""

import enum
from dataclasses import dataclass
from typing import Dict, List, Optional

from edge_platform.spatial import new_id, now_iso


class ModelStatus(enum.Enum):
    """模型/规则生命周期状态。"""
    CANDIDATE = "CANDIDATE"   # 候选：已登记，未上线
    SHADOW = "SHADOW"         # 影子运行：只记录不执行，与现行方案对比
    ACTIVE = "ACTIVE"         # 建议/生效模式
    RETIRED = "RETIRED"       # 退役


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
    threshold_version / model_card_uri 共同构成追溯链。
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
        }


class ModelRegistry:
    """模型/规则版本治理注册表。

    - register：默认 CANDIDATE（生命周期必须从候选开始）；
    - promote_to_shadow：CANDIDATE → SHADOW；
    - activate：必须先处于 SHADOW（spec「影子运行未达标不得进入建议模式」）→ ACTIVE，
      同时将同 model_type 的原 ACTIVE 自动置 RETIRED；
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
        """是否曾进入 ACTIVE/SHADOW（依据审计流转记录判定）。"""
        for e in self.audit_trail:
            if e["model_id"] == model_id and e["to_status"] in ("ACTIVE", "SHADOW"):
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

    def promote_to_shadow(self, model_id, audit_ref):
        """CANDIDATE → SHADOW；仅候选模型可进入影子运行。"""
        rec = self._require(model_id)
        if rec.status is not ModelStatus.CANDIDATE:
            raise ValueError("仅 CANDIDATE 可进入影子运行，当前状态: %s" % rec.status.value)
        old = rec.status
        rec.status = ModelStatus.SHADOW
        entry = self._log(model_id, "promote_to_shadow", "", audit_ref,
                          old, ModelStatus.SHADOW)
        rec.audit_ref = entry["log_id"]
        return rec

    def activate(self, model_id, audit_ref):
        """SHADOW → ACTIVE；影子运行未达标不得进入建议模式（需先经 SHADOW）。

        激活同时将同 model_type 的原 ACTIVE 自动置 RETIRED，保证每类至多一个生效模型。
        """
        rec = self._require(model_id)
        if rec.status is not ModelStatus.SHADOW:
            raise ValueError(
                "仅 SHADOW 可激活为建议模式，当前状态: %s（影子运行未达标不得进入建议模式）"
                % rec.status.value)
        cur = self.active(rec.model_type)
        if cur is not None and cur.model_id != model_id:
            old = cur.status
            cur.status = ModelStatus.RETIRED
            cur.retired_at = now_iso()
            self._log(cur.model_id, "retire(auto)", "", audit_ref,
                      old, ModelStatus.RETIRED, detail="被 %s 取代" % model_id)
        old = rec.status
        rec.status = ModelStatus.ACTIVE
        rec.activated_at = now_iso()
        entry = self._log(model_id, "activate", "", audit_ref, old, ModelStatus.ACTIVE)
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
