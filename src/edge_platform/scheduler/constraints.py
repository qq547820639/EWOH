"""硬约束过滤（技能/工位授权/健康禁忌/禁区/班次休息/外骨骼型号兼容/设备故障/安全规则）。

对应 spec「决策与调度层」与「人在回路与调度纪律」：不具备技能或资质的人员不进入候选，
评分明细体现拦截原因；任意硬约束违规即取消候选资格（验收要求"硬约束违规为 0"）。

约束对象约定（dict，键均可缺省）：
- person: {"person_id", "shift_id"?, "current_zone"?, "safety_hold"?}
- task:   {"task_id", "required_skills"?, "station_id"?, "zone_id"?,
           "load_level"?, "action_type"?, "exo_requirements"?, "safety_critical"?}
- device: {"device_id", "model", "station_id"?, "status"?}
- ctx:    {"continuous_minutes"?, "minutes_worked_current_hour"?,
           "person_forbidden_zones"?: {person_id: set(zone_id)},
           "safety_block"?, "safety_block_persons"?: set(person_id),
           "safety_approved_persons"?: set(person_id)}

纯 Python 标准库实现；不依赖 OR-tools / pulp 等求解器，约束过滤为逐条规则判定。
"""

from dataclasses import dataclass


# 硬约束类型常量（取值与 spec 列出一致）
SKILL = "SKILL"
STATION_AUTH = "STATION_AUTH"
HEALTH_TABOO = "HEALTH禁忌"
FORBIDDEN_ZONE = "FORBIDDEN_ZONE"
SHIFT_REST = "SHIFT_REST"
EXO_MODEL_COMPAT = "EXO_MODEL_COMPAT"
DEVICE_FAULT = "DEVICE_FAULT"
SAFETY = "SAFETY"

# 合法约束类型集合（用于校验）
VALID_CONSTRAINT_TYPES = frozenset({
    SKILL, STATION_AUTH, HEALTH_TABOO, FORBIDDEN_ZONE,
    SHIFT_REST, EXO_MODEL_COMPAT, DEVICE_FAULT, SAFETY,
})


@dataclass
class ConstraintViolation:
    """硬约束违规记录。

    constraint_type 取值见上方常量；person_id 指被拦截人员；reason 为中文说明，
    用于评分明细/理由生成中体现拦截原因（spec："评分明细中体现拦截原因"）。
    """
    constraint_type: str
    person_id: str
    reason: str

    def __post_init__(self):
        if self.constraint_type not in VALID_CONSTRAINT_TYPES:
            raise ValueError("未知硬约束类型: %r" % (self.constraint_type,))

    def to_dict(self):
        return {
            "constraint_type": self.constraint_type,
            "person_id": self.person_id,
            "reason": self.reason,
        }

    def __str__(self):
        return "[%s] %s" % (self.constraint_type, self.reason)


class HardConstraints:
    """硬约束集合：技能注册表 / 工位授权 / 健康禁忌 / 禁区 / 班次规则 / 外骨骼型号兼容 / 设备故障。

    check(person, task, device, ctx) 逐条判定，返回 ConstraintViolation 列表；
    空列表表示通过全部硬约束。任意一条违规即取消候选资格（"硬约束违规为 0"）。
    """

    def __init__(
        self,
        skills_registry=None,
        station_auth=None,
        health_restrictions=None,
        forbidden_zones=None,
        shift_rules=None,
        exo_compat=None,
        device_faults=None,
    ):
        # person_id -> set(skill)
        self.skills_registry = skills_registry or {}
        # person_id -> set(station_id)
        self.station_auth = station_auth or {}
        # person_id -> set(forbidden load_level / action_type)
        self.health_restrictions = health_restrictions or {}
        # set(zone_id) 全员禁区
        self.forbidden_zones = set(forbidden_zones or ())
        # shift_id -> {"rest_minutes_per_hour", "max_continuous_minutes"}
        self.shift_rules = shift_rules or {}
        # exo_model -> set(compatible requirement tag)
        self.exo_compat = exo_compat or {}
        # set(device_id) 当前故障设备
        self.device_faults = set(device_faults or ())

    # ---- 单条约束判定（返回 ConstraintViolation 或 None） ----

    def _check_skill(self, person, task):
        pid = person.get("person_id", "")
        required = set(task.get("required_skills") or ())
        have = set(self.skills_registry.get(pid, set()))
        missing = required - have
        if missing:
            return ConstraintViolation(
                SKILL, pid,
                "人员 %s 缺少任务所需技能：%s" % (pid, "、".join(sorted(missing))),
            )
        return None

    def _check_station_auth(self, person, task):
        pid = person.get("person_id", "")
        station_id = task.get("station_id", "")
        authorized = self.station_auth.get(pid, set())
        if station_id and station_id not in authorized:
            return ConstraintViolation(
                STATION_AUTH, pid,
                "人员 %s 未取得工位 %s 的作业授权" % (pid, station_id),
            )
        return None

    def _check_health(self, person, task):
        pid = person.get("person_id", "")
        forbidden = set(self.health_restrictions.get(pid, set()))
        if not forbidden:
            return None
        hits = []
        load_level = task.get("load_level")
        if load_level and load_level in forbidden:
            hits.append("负荷等级 %s" % load_level)
        action_type = task.get("action_type")
        if action_type and action_type in forbidden:
            hits.append("动作类型 %s" % action_type)
        if hits:
            return ConstraintViolation(
                HEALTH_TABOO, pid,
                "人员 %s 健康禁忌命中：%s" % (pid, "、".join(hits)),
            )
        return None

    def _check_forbidden_zone(self, person, task, ctx):
        pid = person.get("person_id", "")
        zone_id = task.get("zone_id") or task.get("station_zone_id")
        # 全员禁区（如封锁的危险区域）
        if zone_id and zone_id in self.forbidden_zones:
            return ConstraintViolation(
                FORBIDDEN_ZONE, pid,
                "任务工位所在区域 %s 为禁区，禁止安排作业" % zone_id,
            )
        # 人员专属禁区（由 ctx 提供，如医疗限制不得进入冷库等）
        person_zones = set((ctx or {}).get("person_forbidden_zones", {}).get(pid, set()))
        if zone_id and zone_id in person_zones:
            return ConstraintViolation(
                FORBIDDEN_ZONE, pid,
                "人员 %s 禁止进入区域 %s（个人限制）" % (pid, zone_id),
            )
        return None

    def _check_shift_rest(self, person, task, ctx):
        pid = person.get("person_id", "")
        shift_id = person.get("shift_id")
        if not shift_id or shift_id not in self.shift_rules:
            return None
        rule = self.shift_rules[shift_id]
        ctx = ctx or {}
        # 连续作业时长超过班次上限 → 需休息，不可再派新任务
        continuous = float(ctx.get("continuous_minutes", 0.0) or 0.0)
        max_continuous = float(rule.get("max_continuous_minutes", 0.0) or 0.0)
        if max_continuous and continuous > max_continuous:
            return ConstraintViolation(
                SHIFT_REST, pid,
                "人员 %s 连续作业 %.0f 分钟超过班次上限 %.0f 分钟，需休息" % (
                    pid, continuous, max_continuous),
            )
        # 每小时应休息 rest_per_hour 分钟：本小时已工作超过 (60 - rest_per_hour) 分钟且未休息 → 违规
        rest_per_hour = float(rule.get("rest_minutes_per_hour", 0.0) or 0.0)
        worked_hour = float(ctx.get("minutes_worked_current_hour", 0.0) or 0.0)
        if rest_per_hour and worked_hour > (60.0 - rest_per_hour) + 1e-9:
            return ConstraintViolation(
                SHIFT_REST, pid,
                "人员 %s 本小时已工作 %.0f 分钟，未满足每小时休息 %d 分钟的规则" % (
                    pid, worked_hour, int(rest_per_hour)),
            )
        return None

    def _check_exo_compat(self, person, task, device):
        pid = person.get("person_id", "")
        model = (device or {}).get("model")
        required = set(task.get("exo_requirements") or ())
        if not model or not required:
            return None
        compatible = set(self.exo_compat.get(model, set()))
        missing = required - compatible
        if missing:
            return ConstraintViolation(
                EXO_MODEL_COMPAT, pid,
                "外骨骼型号 %s 不满足任务要求：%s" % (model, "、".join(sorted(missing))),
            )
        return None

    def _check_device_fault(self, person, task, device):
        pid = person.get("person_id", "")
        did = (device or {}).get("device_id", "")
        if did and did in self.device_faults:
            return ConstraintViolation(
                DEVICE_FAULT, pid,
                "设备 %s 当前故障，不可调度" % did,
            )
        return None

    def _check_safety(self, person, task, ctx):
        pid = person.get("person_id", "")
        ctx = ctx or {}
        if person.get("safety_hold"):
            return ConstraintViolation(
                SAFETY, pid,
                "人员 %s 处于安全冻结状态，需人工解除后方可调度" % pid,
            )
        if ctx.get("safety_block"):
            return ConstraintViolation(
                SAFETY, pid,
                "当前安全态势触发整体冻结（ctx.safety_block），暂停调度建议",
            )
        block_persons = set(ctx.get("safety_block_persons", set()))
        if pid in block_persons:
            return ConstraintViolation(
                SAFETY, pid,
                "人员 %s 被安全规则单独拦截，需复核" % pid,
            )
        # 安全关键作业需特别授权
        if task.get("safety_critical"):
            approved = set(ctx.get("safety_approved_persons", set()))
            if pid not in approved:
                return ConstraintViolation(
                    SAFETY, pid,
                    "任务为安全关键作业，人员 %s 未取得安全授权" % pid,
                )
        return None

    def check(self, person, task, device, ctx=None):
        """对 (person, task, device) 逐条判定硬约束，返回违规列表（空表示全部通过）。

        per spec "硬约束违规为 0"：任意一条违规即取消候选资格。
        """
        violations = []
        for v in (
            self._check_skill(person, task),
            self._check_station_auth(person, task),
            self._check_health(person, task),
            self._check_forbidden_zone(person, task, ctx),
            self._check_shift_rest(person, task, ctx),
            self._check_exo_compat(person, task, device),
            self._check_device_fault(person, task, device),
            self._check_safety(person, task, ctx),
        ):
            if v is not None:
                violations.append(v)
        return violations
