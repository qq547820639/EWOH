"""多车间与跨工厂协同扩展（V2.0 规划级骨架）。

对应 spec Task 35「多车间与跨工厂协同扩展」（V2.0 规划级）：
- 35.1 空间层级跨车间/跨工厂实体模型与拓扑
- 35.2 跨车间调度与仿真
- 35.3 多工厂世界模型联邦与数据隔离

实现范围（骨架契约，不实现完整跨工厂优化逻辑）：
- 跨工厂实体模型与拓扑骨架：FactoryNode / CrossFactoryLink / MultiFactoryRegistry
- 联邦策略骨架：FederationPolicy + validate_federation 校验
- 跨工厂调度 stub：CrossFactorySchedulerStub（聚合各本地 Scheduler.propose()，仅生成建议）

安全与隐私不变量（不可变）：
1. 联邦层默认只保留聚合数据，不长期保存原始个人数据（retention=aggregated-only）
2. 跨工厂共享需要联邦策略显式允许（无策略覆盖的数据类别一律拒绝共享）
3. 跨工厂调度只生成建议，不自动执行（status=STUB，需人工确认后由本地调度器执行）
4. 所有跨工厂操作入审计日志（registry 与 scheduler stub 均维护 _audit_log）

注：V2.0 阶段，本模块为骨架契约，不实现完整跨工厂优化逻辑（如全局负载均衡、
跨工厂路径规划、联邦学习等留待后续迭代）。纯 Python 标准库实现。
"""

from dataclasses import dataclass, field

from edge_platform.spatial import new_id, now_iso


# 工厂节点状态
FACTORY_ACTIVE = "ACTIVE"
FACTORY_MAINTENANCE = "MAINTENANCE"
FACTORY_DECOMMISSIONED = "DECOMMISSIONED"

# 跨工厂链接类型
LINK_SUPPLY = "SUPPLY"                            # 供应链上下游
LINK_SHARE_RESOURCE = "SHARE_RESOURCE"            # 共享资源（设备/人员）
LINK_COLLABORATIVE_TASK = "COLLABORATIVE_TASK"    # 协同任务
LINK_STANDBY_CAPACITY = "STANDBY_CAPACITY"        # 备用产能

# 跨工厂调度 stub 状态（V2.0 未实现完整逻辑）
CROSS_FACTORY_STUB = "STUB"

# 联邦层默认保留策略：只保留聚合数据
FEDERATION_RETENTION_DEFAULT = "aggregated-only"


def new_factory_id(prefix="FAC"):
    """生成工厂节点 ID，如 FAC-a1b2c3d4。"""
    return new_id(prefix)


def new_link_id(prefix="CFL"):
    """生成跨工厂链接 ID，如 CFL-a1b2c3d4。"""
    return new_id(prefix)


def new_policy_id(prefix="FED"):
    """生成联邦策略 ID，如 FED-a1b2c3d4。"""
    return new_id(prefix)


@dataclass
class FactoryNode:
    """工厂节点：跨工厂联邦中的成员工厂。

    factory_id 唯一；parent_group_id 指向所属集团；location 含经纬度与地址；
    timezone 为 IANA 时区（跨工厂协同需处理时区差）；capacity 描述工厂容量上限；
    data_isolation_policy 标识该工厂的数据隔离策略；status 标识运行状态。
    """
    factory_id: str
    name: str
    parent_group_id: str                                    # 所属集团 ID
    location: dict                                          # {"lat":..., "lng":..., "address":...}
    timezone: str                                           # IANA 时区，如 Asia/Shanghai
    capacity: dict                                          # {"workshops":..., "stations":..., "persons":...}
    data_isolation_policy: str                              # 数据隔离策略
    status: str = FACTORY_ACTIVE                            # ACTIVE/MAINTENANCE/DECOMMISSIONED
    created_at: str = ""

    def __post_init__(self):
        if not self.created_at:
            self.created_at = now_iso()

    def to_dict(self):
        return {
            "factory_id": self.factory_id,
            "name": self.name,
            "parent_group_id": self.parent_group_id,
            "location": dict(self.location),
            "timezone": self.timezone,
            "capacity": dict(self.capacity),
            "data_isolation_policy": self.data_isolation_policy,
            "status": self.status,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            factory_id=d["factory_id"],
            name=d["name"],
            parent_group_id=d["parent_group_id"],
            location=dict(d.get("location", {})),
            timezone=d["timezone"],
            capacity=dict(d.get("capacity", {})),
            data_isolation_policy=d["data_isolation_policy"],
            status=d.get("status", FACTORY_ACTIVE),
            created_at=d.get("created_at", ""),
        )


@dataclass
class CrossFactoryLink:
    """跨工厂链接：两工厂间的协同关系边。

    link_id 唯一；source/target 为工厂 ID；link_type 标识协同类型；
    topology_ref 引用跨工厂拓扑（如外部 Topology 的 dict 表示）；constraints 描述跨工厂约束。
    """
    link_id: str
    source_factory_id: str
    target_factory_id: str
    link_type: str                                          # SUPPLY/SHARE_RESOURCE/COLLABORATIVE_TASK/STANDBY_CAPACITY
    topology_ref: dict = field(default_factory=dict)        # 跨工厂拓扑引用
    constraints: dict = field(default_factory=dict)         # 跨工厂约束
    status: str = "ACTIVE"

    def to_dict(self):
        return {
            "link_id": self.link_id,
            "source_factory_id": self.source_factory_id,
            "target_factory_id": self.target_factory_id,
            "link_type": self.link_type,
            "topology_ref": dict(self.topology_ref),
            "constraints": dict(self.constraints),
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            link_id=d["link_id"],
            source_factory_id=d["source_factory_id"],
            target_factory_id=d["target_factory_id"],
            link_type=d["link_type"],
            topology_ref=dict(d.get("topology_ref", {})),
            constraints=dict(d.get("constraints", {})),
            status=d.get("status", "ACTIVE"),
        )


@dataclass
class FederationPolicy:
    """联邦策略：约束跨工厂数据共享的范围与隐私边界。

    data_sharing_scope 列出允许共享的数据类别（如聚合统计/事件摘要，不含原始个人数据）；
    privacy_constraints 列出隐私约束；consent_required 标识跨工厂共享是否需额外授权；
    audit_required 标识是否需审计；retention 默认 aggregated-only（联邦层只保留聚合数据）。
    """
    policy_id: str
    name: str
    data_sharing_scope: list = field(default_factory=list)     # 允许共享的数据类别
    privacy_constraints: list = field(default_factory=list)    # 隐私约束
    consent_required: bool = True                              # 跨工厂共享是否需要额外授权
    audit_required: bool = True
    retention: str = FEDERATION_RETENTION_DEFAULT              # 联邦层只保留聚合数据

    def to_dict(self):
        return {
            "policy_id": self.policy_id,
            "name": self.name,
            "data_sharing_scope": list(self.data_sharing_scope),
            "privacy_constraints": list(self.privacy_constraints),
            "consent_required": self.consent_required,
            "audit_required": self.audit_required,
            "retention": self.retention,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            policy_id=d["policy_id"],
            name=d["name"],
            data_sharing_scope=list(d.get("data_sharing_scope", [])),
            privacy_constraints=list(d.get("privacy_constraints", [])),
            consent_required=d.get("consent_required", True),
            audit_required=d.get("audit_required", True),
            retention=d.get("retention", FEDERATION_RETENTION_DEFAULT),
        )


class MultiFactoryRegistry:
    """多工厂联邦注册表：工厂节点 / 跨工厂链接 / 联邦策略 + 联邦校验。

    内存态存储，提供注册、查询、联邦共享校验与拓扑导出。所有跨工厂操作入审计日志
    （安全不变量 4）。联邦层默认只保留聚合数据，跨工厂共享需策略显式允许
    （安全不变量 1、2）。
    """

    def __init__(self):
        self._factories = {}     # factory_id -> FactoryNode
        self._links = {}         # link_id -> CrossFactoryLink
        self._policies = {}      # policy_id -> FederationPolicy
        self._audit_log = []     # 跨工厂操作审计日志

    # ---- 内部工具 ----

    def _audit(self, op, **detail):
        """记录跨工厂操作审计日志（安全不变量 4）。"""
        record = {"op": op, "ts": now_iso()}
        record.update(detail)
        self._audit_log.append(record)
        return record

    def _find_link(self, factory_id_a, factory_id_b):
        """查找两工厂间的 ACTIVE 链接（双向）。"""
        for link in self._links.values():
            if link.status != "ACTIVE":
                continue
            pair = {link.source_factory_id, link.target_factory_id}
            if {factory_id_a, factory_id_b} <= pair and factory_id_a != factory_id_b:
                return link
            # 同工厂自身视为存在联邦关系（同厂内共享不跨联邦边界）
            if factory_id_a == factory_id_b and factory_id_a in pair:
                return link
        return None

    def _find_policy_for_data_class(self, data_class):
        """查找首个允许共享指定数据类别的联邦策略。"""
        for policy in self._policies.values():
            if data_class in policy.data_sharing_scope:
                return policy
        return None

    # ---- 注册 ----

    def register_factory(self, factory_node):
        """注册工厂节点。"""
        self._factories[factory_node.factory_id] = factory_node
        self._audit("register_factory", factory_id=factory_node.factory_id,
                    parent_group_id=factory_node.parent_group_id,
                    status=factory_node.status)
        return factory_node

    def register_link(self, link):
        """注册跨工厂链接。"""
        self._links[link.link_id] = link
        self._audit("register_link", link_id=link.link_id,
                    source=link.source_factory_id, target=link.target_factory_id,
                    link_type=link.link_type, status=link.status)
        return link

    def register_policy(self, policy):
        """注册联邦策略。"""
        self._policies[policy.policy_id] = policy
        self._audit("register_policy", policy_id=policy.policy_id,
                    name=policy.name,
                    data_sharing_scope=list(policy.data_sharing_scope),
                    consent_required=policy.consent_required,
                    retention=policy.retention)
        return policy

    # ---- 查询 ----

    def get_factory(self, factory_id):
        """按 ID 查询工厂节点。"""
        return self._factories.get(factory_id)

    def list_factories(self, group_id=None):
        """列出工厂；group_id 非空时按集团过滤。"""
        if group_id is None:
            return list(self._factories.values())
        return [f for f in self._factories.values() if f.parent_group_id == group_id]

    def list_links(self, factory_id=None):
        """列出跨工厂链接；factory_id 非空时返回与该工厂相关的链接。"""
        if factory_id is None:
            return list(self._links.values())
        return [link for link in self._links.values()
                if link.source_factory_id == factory_id
                or link.target_factory_id == factory_id]

    def get_policy(self, policy_id):
        """按 ID 查询联邦策略。"""
        return self._policies.get(policy_id)

    # ---- 联邦校验 ----

    def validate_federation(self, factory_id_a, factory_id_b, data_class):
        """校验两工厂间是否可共享指定数据类别。

        检查顺序：工厂存在性 → 跨工厂链接存在 → 联邦策略允许数据类别。
        安全不变量 2：跨工厂共享需策略显式允许；无策略覆盖的数据类别一律拒绝。
        返回 (allowed: bool, reason: str)。consent_required/audit_required 记入 reason 但
        不阻断结构性校验（额外授权与审计为独立流程，由调用方落实）。
        """
        fa = self._factories.get(factory_id_a)
        fb = self._factories.get(factory_id_b)
        if fa is None or fb is None:
            reason = "工厂不存在: %s / %s" % (factory_id_a, factory_id_b)
            self._audit("validate_federation", factory_a=factory_id_a,
                        factory_b=factory_id_b, data_class=data_class,
                        allowed=False, reason=reason)
            return (False, reason)

        link = self._find_link(factory_id_a, factory_id_b)
        if link is None:
            reason = "无 ACTIVE 跨工厂链接: %s <-> %s" % (factory_id_a, factory_id_b)
            self._audit("validate_federation", factory_a=factory_id_a,
                        factory_b=factory_id_b, data_class=data_class,
                        allowed=False, reason=reason)
            return (False, reason)

        policy = self._find_policy_for_data_class(data_class)
        if policy is None:
            reason = "无联邦策略允许共享数据类别: %s" % data_class
            self._audit("validate_federation", factory_a=factory_id_a,
                        factory_b=factory_id_b, data_class=data_class,
                        link_id=link.link_id, allowed=False, reason=reason)
            return (False, reason)

        notes = ["策略: %s" % policy.name]
        if policy.consent_required:
            notes.append("需额外授权确认")
        if policy.audit_required:
            notes.append("需审计")
        if policy.retention != FEDERATION_RETENTION_DEFAULT:
            notes.append("保留策略: %s" % policy.retention)
        reason = "允许共享（" + "；".join(notes) + "）"
        self._audit("validate_federation", factory_a=factory_id_a,
                    factory_b=factory_id_b, data_class=data_class,
                    link_id=link.link_id, policy_id=policy.policy_id,
                    allowed=True, reason=reason)
        return (True, reason)

    # ---- 拓扑导出 ----

    def export_federation_topology(self):
        """导出联邦拓扑 JSON（工厂节点 / 链接 / 策略 / 不变量）。"""
        return {
            "factories": [f.to_dict() for f in self._factories.values()],
            "links": [link.to_dict() for link in self._links.values()],
            "policies": [p.to_dict() for p in self._policies.values()],
            "exported_at": now_iso(),
            "invariants": {
                "retention": FEDERATION_RETENTION_DEFAULT,
                "consent_required_default": True,
                "audit_required_default": True,
                "auto_execute": False,   # 跨工厂调度只生成建议，不自动执行
            },
        }

    def audit_log(self):
        """返回跨工厂操作审计日志副本。"""
        return list(self._audit_log)


class CrossFactorySchedulerStub:
    """跨工厂调度 stub（V2.0 规划级骨架，不实现完整逻辑）。

    聚合各本地 Scheduler.propose() 结果，标注 cross_factory=true、status=STUB。
    安全不变量 3：跨工厂调度只生成建议，不自动执行；实际执行须经人工确认后由本地调度器完成。
    """

    def __init__(self, registry, local_schedulers):
        """
        registry: MultiFactoryRegistry 实例
        local_schedulers: dict {factory_id: Scheduler}，各工厂本地调度器
        """
        self.registry = registry
        self.local_schedulers = dict(local_schedulers or {})
        self._audit_log = []

    def _audit(self, op, **detail):
        record = {"op": op, "ts": now_iso()}
        record.update(detail)
        self._audit_log.append(record)
        return record

    def propose_cross_factory(self, task, candidate_factories, ctx=None):
        """跨工厂调度建议（骨架）。

        骨架逻辑：列出可参与的 ACTIVE 工厂，调用各本地 Scheduler.propose()，聚合候选。
        每条候选标注 cross_factory=true、status=STUB（V2.0 未实现完整跨工厂优化逻辑）。
        返回聚合的候选列表（仅建议，不自动执行）。
        """
        ctx = ctx or {}
        persons = ctx.get("persons", [])
        devices = ctx.get("devices", [])
        aggregated = []

        for factory_id in candidate_factories:
            scheduler = self.local_schedulers.get(factory_id)
            if scheduler is None:
                continue
            factory = self.registry.get_factory(factory_id)
            if factory is None or factory.status != FACTORY_ACTIVE:
                continue
            try:
                req = scheduler.propose(task, persons, devices, ctx)
            except Exception as exc:   # 本地调度失败不阻断其他工厂
                self._audit("propose_cross_factory_local_error",
                            factory_id=factory_id, error=str(exc))
                continue
            candidates = getattr(req, "candidates", []) or []
            for cand in candidates:
                aggregated.append({
                    "factory_id": factory_id,
                    "candidate_id": getattr(cand, "candidate_id", None),
                    "candidate": cand,
                    "cross_factory": True,
                    "status": CROSS_FACTORY_STUB,   # V2.0 未实现完整逻辑
                    "ts": now_iso(),
                })

        self._audit("propose_cross_factory",
                    task=dict(task) if isinstance(task, dict) else task,
                    candidate_factories=list(candidate_factories),
                    result_count=len(aggregated),
                    status=CROSS_FACTORY_STUB)
        return aggregated

    def validate_isolation(self, plan):
        """校验跨工厂方案不违反数据隔离策略。

        plan 结构：{"factories": [...], "data_classes": [...]}。
        对所有工厂两两组合 × 数据类别调用 registry.validate_federation；
        返回 (ok: bool, violations: list)。violations 为不满足隔离的条目列表。
        """
        plan = plan or {}
        factories = list(plan.get("factories", []) or [])
        data_classes = list(plan.get("data_classes", []) or [])
        violations = []

        for i, fa in enumerate(factories):
            for fb in factories[i + 1:]:
                for dc in data_classes:
                    allowed, reason = self.registry.validate_federation(fa, fb, dc)
                    if not allowed:
                        violations.append({
                            "factory_a": fa,
                            "factory_b": fb,
                            "data_class": dc,
                            "reason": reason,
                        })

        ok = len(violations) == 0
        self._audit("validate_isolation",
                    factories=factories, data_classes=data_classes,
                    ok=ok, violation_count=len(violations))
        return (ok, violations)

    def audit_log(self):
        """返回跨工厂调度操作审计日志副本。"""
        return list(self._audit_log)
