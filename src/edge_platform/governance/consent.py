"""授权管理：员工数据授权的授予、撤回、查询与访问审计。

对应 spec「数据治理与隐私扩展」与「授权撤回」场景：
- 默认不采集强身份信息/长期精确轨迹/持续原始视频/非必要生理数据；每类用途（遥测/视频/
  骨架/位置/任务绑定/训练/跨天追踪）均需员工显式授权（spec「员工应能知道采集哪些数据、
  知道数据用途」）。
- 员工数据权利：知情、查看与自身有关的主要结论、对错误数据提出更正、对误判进行申诉、
  查询谁访问过敏感数据、在政策允许范围内撤回授权。
- 授权撤回：平台停止该人员新增采集，按既定流程执行删除/匿名化/移交，全过程入审计
  （spec 场景「授权撤回」）。

纯 Python 标准库实现；沿用 edge_platform.spatial 的 new_id / now_iso 约定。
"""

import enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from edge_platform.spatial import new_id, now_iso


class ConsentPurpose(enum.Enum):
    """数据采集用途；每类用途均需员工显式授权。

    取值对应 spec「数据治理与隐私扩展」中需单独授权的数据类别：
    遥测 / 视频 / 骨架 / 位置 / 任务绑定 / 训练 / 跨天身份追踪。
    """
    TELEMETRY = "TELEMETRY"                       # 外骨骼遥测（设备/运动/负荷级）
    VIDEO = "VIDEO"                               # 原始视频/事件短视频证据
    SKELETON = "SKELETON"                         # 视觉骨架/姿态（边缘推理产物）
    LOCATION = "LOCATION"                         # 人员位置/UWB 定位
    TASK_BINDING = "TASK_BINDING"                 # 人员—设备—任务绑定关系
    TRAINING = "TRAINING"                         # 模型训练数据（单独授权）
    CROSS_DAY_TRACKING = "CROSS_DAY_TRACKING"     # 跨天身份追踪（非必要不开）


# 授权记录状态
ACTIVE = "ACTIVE"
REVOKED = "REVOKED"
EXPIRED = "EXPIRED"

# 撤回动作类型（spec「按既定流程执行删除/匿名化/移交」）
DELETE = "delete"
ANONYMIZE = "anonymize"
HANDOVER = "handover"

# 访问审计动作
ACT_GRANT = "grant"
ACT_REVOKE = "revoke"
ACT_CHECK = "check"


# 各用途默认撤回动作（spec「按既定流程执行删除/匿名化/移交」）
_DEFAULT_REVOCATION_ACTION = {
    ConsentPurpose.TELEMETRY: DELETE,            # 高频遥测：删除（短保留）
    ConsentPurpose.VIDEO: DELETE,                # 原始视频：删除（短缓存本就自动覆盖）
    ConsentPurpose.SKELETON: ANONYMIZE,          # 骨架事件：匿名化（保留聚合统计）
    ConsentPurpose.LOCATION: ANONYMIZE,          # 位置轨迹：匿名化
    ConsentPurpose.TASK_BINDING: HANDOVER,       # 任务绑定：移交给班组长/生产审计
    ConsentPurpose.TRAINING: ANONYMIZE,          # 训练数据：匿名化（版本化数据集则标记）
    ConsentPurpose.CROSS_DAY_TRACKING: DELETE,   # 跨天追踪：删除
}


@dataclass
class ConsentRecord:
    """授权记录：某人员对若干用途与字段范围的授权。

    purposes: 已授权用途列表（ConsentPurpose）；
    fields: 允许采集/使用的字段路径列表（数据最小化，spec「默认不采集…非必要…信息」）；
    retention_rule: 该授权对应数据的保留规则引用（与 retention 模块衔接）；
    audit_ref: 关联的审计条目引用；status 取 ACTIVE/REVOKED/EXPIRED。
    """
    person_id: str
    record_id: str = ""
    purposes: List[ConsentPurpose] = field(default_factory=list)
    fields: List[str] = field(default_factory=list)
    granted_at: str = ""
    granted_by: str = ""
    revoked_at: Optional[str] = None
    revocation_reason: str = ""
    retention_rule: str = ""
    audit_ref: str = ""
    status: str = ACTIVE

    def __post_init__(self):
        if not self.record_id:
            self.record_id = new_id("CONSENT")
        if not self.granted_at:
            self.granted_at = now_iso()
        # 字符串用途 → 枚举（便于从外部数据恢复）
        self.purposes = [
            p if isinstance(p, ConsentPurpose) else ConsentPurpose(p)
            for p in self.purposes
        ]
        if self.status not in (ACTIVE, REVOKED, EXPIRED):
            raise ValueError("未知授权状态: %r" % (self.status,))

    def to_dict(self):
        return {
            "record_id": self.record_id,
            "person_id": self.person_id,
            "purposes": [p.value for p in self.purposes],
            "fields": list(self.fields),
            "granted_at": self.granted_at,
            "granted_by": self.granted_by,
            "revoked_at": self.revoked_at,
            "revocation_reason": self.revocation_reason,
            "retention_rule": self.retention_rule,
            "audit_ref": self.audit_ref,
            "status": self.status,
        }


@dataclass
class RevocationJob:
    """授权撤回作业：描述对该人员相关数据需执行的删除/匿名化/移交动作。

    actions: [{"data_class", "action": delete/anonymize/handover, "target"}]；
    对应 spec「按既定流程执行删除/匿名化/移交」。
    """
    person_id: str
    job_id: str = ""
    actions: List[Dict] = field(default_factory=list)
    created_at: str = ""
    status: str = "PENDING"

    def __post_init__(self):
        if not self.job_id:
            self.job_id = new_id("REV")
        if not self.created_at:
            self.created_at = now_iso()
        for a in self.actions:
            if a.get("action") not in (DELETE, ANONYMIZE, HANDOVER):
                raise ValueError("未知撤回动作: %r" % (a.get("action"),))


class ConsentManager:
    """授权管理器：授予 / 撤回 / 查询 / 访问审计。

    - grant：授予某人员若干用途与字段范围（status ACTIVE）；
    - revoke：撤回授权（status REVOKED），并触发删除/匿名化/移交作业（RevocationJob）；
    - is_allowed：依据当前有效授权判定 (person, purpose, field) 是否被允许；
    - list_for_person：返回该人员全部授权记录（供员工知情/查看）；
    - access_log：每次 grant/revoke/check 均入审计（spec「查询谁访问过敏感数据」）。
    """

    def __init__(self):
        self._by_id: Dict[str, ConsentRecord] = {}
        self._by_person: Dict[str, List[str]] = {}
        # 访问审计：每次 grant/revoke/check 追加一条
        self.access_log: List[Dict] = []

    # ---- 审计 ----
    def _log(self, action, person_id, actor_id, ref, detail=""):
        entry = {
            "log_id": new_id("ACC"),
            "action": action,
            "person_id": person_id,
            "actor_id": actor_id,
            "ts": now_iso(),
            "ref": ref,
            "detail": detail,
        }
        self.access_log.append(entry)
        return entry

    # ---- 授予 ----
    def grant(self, person_id, purposes, fields, granted_by, retention_rule=""):
        """授予某人员若干用途与字段范围，返回 ACTIVE 的 ConsentRecord。

        per spec「员工应能知道采集哪些数据、知道数据用途」：用途与字段均显式记录，
        字段范围体现数据最小化。
        """
        purposes = [
            p if isinstance(p, ConsentPurpose) else ConsentPurpose(p)
            for p in purposes
        ]
        rec = ConsentRecord(
            person_id=person_id,
            purposes=purposes,
            fields=list(fields),
            granted_by=granted_by,
            retention_rule=retention_rule,
            status=ACTIVE,
        )
        self._by_id[rec.record_id] = rec
        self._by_person.setdefault(person_id, []).append(rec.record_id)
        entry = self._log(
            ACT_GRANT, person_id, granted_by, rec.record_id,
            detail="用途=%s" % ",".join(p.value for p in purposes),
        )
        rec.audit_ref = entry["log_id"]
        return rec

    # ---- 撤回 ----
    def revoke(self, record_id, reason, actor_id):
        """撤回授权：置 status REVOKED，并产出 RevocationJob（删除/匿名化/移交）。

        per spec 场景「授权撤回」：平台停止该人员新增采集，按既定流程执行删除/匿名化/移交，
        全过程入审计。
        """
        rec = self._by_id.get(record_id)
        if rec is None:
            raise KeyError("授权记录不存在: %s" % record_id)
        if rec.status == REVOKED:
            raise ValueError("授权记录已撤回: %s" % record_id)
        rec.revoked_at = now_iso()
        rec.revocation_reason = reason
        rec.status = REVOKED
        self._log(ACT_REVOKE, rec.person_id, actor_id, rec.record_id, detail=reason)
        return self._build_revocation_job(rec, actor_id)

    def _build_revocation_job(self, rec, actor_id):
        """按授权用途与字段范围，构造删除/匿名化/移交动作清单。"""
        actions = []
        # 用途级动作（按默认撤回动作映射）
        for purpose in rec.purposes:
            action = _DEFAULT_REVOCATION_ACTION.get(purpose, DELETE)
            actions.append({
                "data_class": purpose.value,
                "action": action,
                "target": "person:%s/purpose:%s" % (rec.person_id, purpose.value),
            })
        # 字段级动作：对授权字段范围产出匿名化（数据最小化回退）
        for f in rec.fields:
            actions.append({
                "data_class": "field",
                "action": ANONYMIZE,
                "target": "person:%s/field:%s" % (rec.person_id, f),
            })
        job = RevocationJob(
            person_id=rec.person_id,
            actions=actions,
            status="PENDING",
        )
        self._log("revocation_job", rec.person_id, actor_id, job.job_id,
                  detail="actions=%d" % len(actions))
        return job

    # ---- 查询 ----
    def is_allowed(self, person_id, purpose, field=None):
        """判定 (person, purpose, field) 是否被当前有效授权允许。

        字段级校验：若指定 field 且授权记录 fields 非空，则 field 必须在授权字段范围内；
        授权记录 fields 为空表示不限字段。每次查询入访问审计。
        """
        purpose = purpose if isinstance(purpose, ConsentPurpose) else ConsentPurpose(purpose)
        allowed = False
        ref = ""
        for rid in self._by_person.get(person_id, []):
            rec = self._by_id[rid]
            if rec.status != ACTIVE:
                continue
            if purpose not in rec.purposes:
                continue
            if field is not None and rec.fields and field not in rec.fields:
                continue
            allowed = True
            ref = rec.record_id
            break
        self._log(
            ACT_CHECK, person_id, "", ref,
            detail="purpose=%s field=%s allowed=%s" % (
                purpose.value, field, allowed),
        )
        return allowed

    def list_for_person(self, person_id):
        """返回该人员全部授权记录（供员工知情/查看，spec「员工应能知道采集哪些数据」）。"""
        return [self._by_id[rid] for rid in self._by_person.get(person_id, [])]

    def get(self, record_id):
        """按 record_id 取授权记录。"""
        return self._by_id.get(record_id)
