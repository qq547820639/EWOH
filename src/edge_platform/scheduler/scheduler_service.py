"""联合调度闭环编排：请求 → 生成影子方案 → 确认（重新校验世界状态 + 预约） → 派工。

安全不变量（本模块不可破坏）：
- 调度只产出 建议/计划/派工；绝不写急停/限扭/关节实时控制等安全参数；
- 未经人工确认不得执行（execute 仅 PLAN_APPROVED 可执行，非 approved 抛异常）；
- 所有确认/驳回/覆盖/策略变更必须可审计（写 audit 记录）；
- learning_loop 只产生校准建议，不得自动改权重或安全规则（本模块不调用）。

Plan 状态机：shadow → simulating → pending_review → approved → dispatched（+expired/archived），
非法转换由 validate_plan_transition 拒绝。

纯 Python 标准库实现。
"""

import logging

from edge_platform.spatial import new_id, now_iso

from .models import (
    PLAN_APPROVED,
    PLAN_ARCHIVED,
    PLAN_DISPATCHED,
    PLAN_PENDING_REVIEW,
    TASK_DISPATCHED,
    TASK_EXECUTING,
    Assignment,
    CandidateAssignment,
    ScheduleFeedback,
    ScheduleRequestMW,
    validate_plan_transition,
)
from .replanner import Replanner
from .reservation import ReservationConflictError

logger = logging.getLogger(__name__)


class PlanStaleError(ValueError):
    """方案基于过期/已变化的世界状态，禁止确认。"""

    code = "PLAN_STALE"


class PlanConflictError(ValueError):
    """方案冲突（如资源预约冲突之外的冲突）。"""

    code = "PLAN_CONFLICT"


class IllegalStateError(ValueError):
    """非法状态转换（未确认不得执行等）。"""

    code = "ILLEGAL_STATE"


class AdvisoryOnlyError(RuntimeError):
    """Edge 处于 advisory 模式（connected production / development 默认）：

    调度写权限归 NestJS 控制面，Edge 拒绝 confirm/execute/replan/写库，
    避免 split-brain、double dispatch 与 policy divergence。
    仅在 simulation 模式或显式 EWOH_EDGE_SCHEDULING_WRITE=1 时可写。
    """

    code = "SCHEDULING_READ_ONLY"


def _serialize_task(task):
    """把任务对象/dict 序列化为 dict（dict 原样返回）。"""
    if isinstance(task, dict):
        return task
    to_dict = getattr(task, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return task


def shortest_task_path(from_state, to_state):
    """返回状态机中 from_state→to_state 的最短中间状态序列（不含首尾）。

    用于派工状态自动补全（如 dispatched→received→executing、paused→executing→completed）。
    无合法路径（含 to_state==from_state、或目标为 cancelled 走契约特例）返回空列表，
    由调用方 validate_task_transition 兜底拒绝/放行。
    """
    from .models import TASK_TRANSITIONS

    if from_state == to_state:
        return []
    prev = {from_state: None}
    queue = [from_state]
    while queue:
        cur = queue.pop(0)
        if cur == to_state:
            break
        for nxt in TASK_TRANSITIONS.get(cur, set()):
            if nxt not in prev:
                prev[nxt] = cur
                queue.append(nxt)
    if to_state not in prev:
        return []
    full = []
    node = to_state
    while node is not None:
        full.append(node)
        node = prev[node]
    full.reverse()
    return full[1:-1]


class SchedulerService:
    """联合调度闭环编排服务。

    Ownership 语义（P0-SCHED-OWNERSHIP）：
    - advisory_only=True（connected production / development 默认）：
      Edge 只产出 advisory 建议，confirm/execute/replan/set_assignment_status/
      feedback 写路径一律拒绝（AdvisoryOnlyError），绝不写正式 plan/task/
      assignment/reservation——避免与 NestJS 控制面 split-brain / double dispatch。
      生成方案（generate_plans）保持可用，但方案与响应带 advisory 标记。
    - advisory_only=False（simulation / EWOH_EDGE_SCHEDULING_WRITE=1）：
      允许完整模拟闭环（仅限仿真环境或显式授权）。
    """

    def __init__(
        self,
        world_state_service,
        planner,
        reservation_service,
        audit=None,
        storage=None,
        replanner=None,
        repository=None,
        event_bus=None,
        advisory_only=False,
    ):
        self.world_state_service = world_state_service
        self.planner = planner
        self.reservation_service = reservation_service
        self.audit = audit
        self.storage = storage
        self.replanner = replanner or Replanner(planner)
        self.repository = repository
        self.event_bus = event_bus
        self.advisory_only = bool(advisory_only)
        self._requests = {}
        self._plans = {}
        self._assignments = {}
        self._feedback = {}

    # ---- ownership guard ----

    def _assert_writable(self):
        """正式写路径守卫：advisory 模式禁止 confirm/execute/replan 等正式写操作。

        注意：advisory 模式下 generate_plans 仍被允许（内存态 advisory 建议），
        仅落库被 _persist_* 跳过；本守卫拦截的是"正式事实变更"路径。
        """
        if self.advisory_only:
            raise AdvisoryOnlyError(
                "Edge 处于 advisory 模式（connected production）："
                "调度写权限归 NestJS 控制面，Edge 不得 confirm/execute/replan/写库"
            )

    def advisory_plan(self, plan):
        """把方案标记为 advisory（不可被误认为正式 approved/dispatched plan）。"""
        plan.advisory = True
        return plan

    def reconcile_from_cloud(self):
        """恢复连接后的 reconcile 机制（P0-SCHED-OWNERSHIP）：

        - advisory 模式下：丢弃本地全部内存调度状态（pending plans/requests/
          assignments/reservations）与持久化的 Edge 本地调度记录——云端 NestJS
          是唯一事实来源，本地状态一律失效，防止陈旧建议被继续使用；
        - 非 advisory（simulation）模式：仅清空内存（模拟数据无需保留），
          **不删除**已持久化的正式 plan（批准链/审计回溯/重启 hydrate 数据源）。

        EDGE-115（2026-08-17 审计整改说明）：本方法删除持久化 plan 属 reconcile
        语义的**显式例外**——它不是"正式写路径"（confirm/execute/replan），而是
        云重连后对本地建议缓存的失效清理（P0-SCHED-OWNERSHIP 的核心动作），
        因此不经过 _assert_writable；此处文档化该例外，防止被误读为绕过守卫。

        R2-ESC-008（裁决：按 docstring 承诺收敛实现，而非改文档）：删除分支
        增加 advisory_only 条件——simulation（显式 EWOH_EDGE_SCHEDULING_WRITE=1
        完整写）模式下云重连不得删除已批准/已派工的持久化方案；删除动作逐条
        记审计日志（plan_id 清单），失败不静默。
        """
        self._requests.clear()
        self._plans.clear()
        self._assignments.clear()
        self._feedback.clear()
        deleted_plan_ids: list[str] = []
        # R2-ESC-008：仅 advisory 模式删除持久化 plan（本地建议缓存失效清理）；
        # simulation 模式的持久化 plan 是正式调度事实，云重连不删。
        if self.advisory_only and self.repository is not None:
            try:
                for plan in self.repository.list_plans() or []:
                    plan_id = plan.get("plan_id")
                    if plan_id:
                        if hasattr(self.storage, "delete_schedule_plan"):
                            self.storage.delete_schedule_plan(plan_id)
                            deleted_plan_ids.append(plan_id)
                if deleted_plan_ids:
                    # R2-ESC-008：删除动作留审计痕迹（删了哪些 plan_id）
                    logger.warning(
                        "reconcile_from_cloud(advisory): 已删除本地持久化方案 %d 个: %s",
                        len(deleted_plan_ids),
                        deleted_plan_ids,
                    )
            except Exception as e:  # noqa: BLE001 - reconcile 失败不阻断启动
                logger.warning("reconcile_from_cloud: 清理本地方案失败: %s", e)
        self._publish(
            "schedule.reconciled",
            entity_id="cloud",
            version=1,
            payload={
                "reason": "cloud reconnected; edge local scheduling state discarded",
                "advisory_only": self.advisory_only,
                "deleted_plan_ids": deleted_plan_ids,
                "persisted_plans_kept": not self.advisory_only,
            },
        )
        return {
            "discarded": True,
            "advisory_only": self.advisory_only,
            "deleted_plan_ids": deleted_plan_ids,
        }

    def _publish(self, event_type, entity_id="", version=1, payload=None):
        """把事件发布到事件总线（SSE 实时同步，Phase 5）。未注入总线则忽略。"""
        if self.event_bus is None:
            return None
        try:
            return self.event_bus.publish(
                event_type, entity_id=entity_id, version=version or 1, payload=payload or {}
            )
        except Exception:
            return None

    # ---- 持久化（repository 注入后启用；为 None 时保持纯内存、向后兼容） ----

    def hydrate_from_repository(self):
        """启动时从 repository 恢复已持久化的调度状态到内存。

        P1（上线验收发现）：此前 plan/request/assignment/reservation 仅存内存 +
        落盘，但重启后不加载，导致 approved plan 在 API 重启后不可见/不可继续派工。
        本方法把磁盘上已持久化的对象重新装入 _requests/_plans/_assignments/
        _feedback + ReservationService，使调度闭环在进程重启后仍可继续。
        R-3 补齐：assignments（派工可查/可续状态流转）、feedback（学习闭环）、
        reservations（confirm 冲突检测跨重启有效，防双预约）。
        """
        if self.repository is None:
            return
        from dataclasses import fields as dc_fields

        from .models import Assignment, ScheduleFeedback, SchedulePlan, ScheduleRequestMW

        # 存储行含额外列（recommended_by/created_at 等）——只取模型字段构造对象。
        assignment_fields = {f.name for f in dc_fields(Assignment)}
        feedback_fields = {f.name for f in dc_fields(ScheduleFeedback)}

        # 恢复请求
        for d in self.repository.list_requests() or []:
            try:
                req = ScheduleRequestMW(**{k: v for k, v in d.items() if k != "id"})
                self._requests[req.request_id] = req
            except Exception as e:  # noqa: BLE001 - 单条损坏不影响整体恢复
                logger.warning(
                "hydrate_from_repository: 跳过损坏的调度请求 %r: %s", d.get("request_id"), e
            )
                continue
        # 恢复方案（含 assignments：必须还原为 CandidateAssignment 对象，
        # confirm/execute 按属性访问 planned_end/person_id/task_id/route 等）。
        for d in self.repository.list_plans() or []:
            try:
                plan = SchedulePlan(**{k: v for k, v in d.items() if k != "id"})
                plan.assignments = [
                    CandidateAssignment(**a) for a in (d.get("assignments") or []) if isinstance(a, dict)
                ]
                self._plans[plan.plan_id] = plan
            except Exception as e:  # noqa: BLE001 - 单条损坏不影响整体恢复
                logger.warning("hydrate_from_repository: 跳过损坏的调度方案 %r: %s", d.get("plan_id"), e)
                continue
        # R-3：恢复正式派工（重启后 /api/assignments 可查、set_assignment_status 可续）。
        for d in self.repository.list_assignments() or []:
            try:
                a = Assignment(**{k: d[k] for k in assignment_fields if k in d})
                self._assignments[a.assignment_id] = a
            except Exception as e:  # noqa: BLE001 - 单条损坏不影响整体恢复
                logger.warning("hydrate_from_repository: 跳过损坏的派工 %r: %s", d.get("assignment_id"), e)
                continue
        # R-3：恢复执行反馈（学习闭环跨重启保留）。
        for d in self.repository.list_feedback() or []:
            try:
                fb = ScheduleFeedback(**{k: d[k] for k in feedback_fields if k in d})
                self._feedback[fb.feedback_id] = fb
            except Exception as e:  # noqa: BLE001 - 单条损坏不影响整体恢复
                logger.warning("hydrate_from_repository: 跳过损坏的反馈 %r: %s", d.get("feedback_id"), e)
                continue
        # R-3：恢复 active 预约（confirm 冲突检测跨重启有效，防双预约）。
        try:
            restored = self.reservation_service.restore(
                self.repository.list_reservations(status="active") or []
            )
            if restored:
                logger.info("hydrate_from_repository: 恢复 active 预约 %d 条", restored)
        except Exception as e:  # noqa: BLE001 - 预约恢复失败不阻断整体 hydrate
            logger.warning("hydrate_from_repository: 恢复预约失败: %s", e)

    def _persist_request(self, req):
        if self.repository is None:
            return
        if self.advisory_only:
            logger.info("advisory 模式：跳过调度请求落库（request=%s）", getattr(req, "request_id", "?"))
            return
        self.repository.save_request(req)

    def _persist_plan(self, plan):
        if self.repository is None:
            return
        if self.advisory_only:
            logger.info(
                "advisory 模式：跳过方案落库（plan=%s，advisory 建议不写正式事实）",
                getattr(plan, "plan_id", "?"),
            )
            return
        self.repository.save_plan(plan)

    def _persist_assignment(self, a):
        if self.repository is None:
            return
        if self.advisory_only:
            logger.info("advisory 模式：跳过派工落库（assignment=%s）", getattr(a, "assignment_id", "?"))
            return
        self.repository.save_assignment(a)

    def _persist_feedback(self, fb):
        if self.repository is None:
            return
        if self.advisory_only:
            logger.info("advisory 模式：跳过反馈落库（feedback=%s）", getattr(fb, "feedback_id", "?"))
            return
        self.repository.save_feedback(fb)

    def _persist_reservation(self, res):
        if self.repository is None:
            return
        if self.advisory_only:
            logger.info("advisory 模式：跳过预约落库（reservation=%s）", getattr(res, "reservation_id", "?"))
            return
        self.repository.save_reservation(res)

    def _persist_snapshot(self, snapshot):
        if self.repository is None:
            return
        if snapshot is None:
            return
        if self.advisory_only:
            logger.info("advisory 模式：跳过快照落库")
            return
        self.repository.save_snapshot(snapshot)

    def _record_decision(self, plan, action, actor_id, reason):
        if self.repository is None:
            return
        if self.advisory_only:
            logger.info("advisory 模式：跳过决策审计落库（plan=%s action=%s）", getattr(plan, "plan_id", "?"), action)
            return
        version = getattr(plan, "version", 1) or 1
        self.repository.record_decision(
            plan.plan_id,
            version,
            action,
            actor_id,
            reason,
            None,
            plan.to_dict(),
        )

    # ---- 审计 ----

    def _audit(self, actor, action, target_type, target_id, before, after, reason):
        if self.audit is None:
            return None
        return self.audit(actor, action, target_type, target_id, before, after, reason)

    # ---- 请求 ----

    def create_request(self, task_ids, trigger_type, policy_id, created_by):
        """创建调度请求（status=pending）。"""
        req = ScheduleRequestMW(
            request_id=new_id("REQMW"),
            trigger_type=trigger_type,
            task_ids=list(task_ids),
            policy_id=policy_id,
            created_by=created_by,
            status="pending",
        )
        self._requests[req.request_id] = req
        self._persist_request(req)
        self._audit(
            created_by,
            "create_request",
            "request",
            req.request_id,
            None,
            req.to_dict(),
            trigger_type,
        )
        return req

    def get_request(self, request_id):
        req = self._requests.get(request_id)
        if req is None:
            raise KeyError(f"调度请求不存在: {request_id}")
        return req

    # ---- 生成方案 ----

    def generate_plans(self, request_id, storage=None):
        """先 build_snapshot → 生成 k 份影子方案 → 存入 registry → 审计。"""
        req = self.get_request(request_id)
        storage = storage or self.storage
        snapshot = self.world_state_service.build_snapshot(storage)
        tasks = list(getattr(snapshot, "tasks", []) or [])
        if not tasks:
            # 用请求中的任务 id 兜底，构造最小任务描述
            tasks = [{"task_id": tid} for tid in req.task_ids]
        policy = {"request_id": req.request_id, "policy_id": req.policy_id}
        plans = self.planner.generate_top_k(snapshot, tasks, policy, k=3)
        for plan in plans:
            plan.request_id = req.request_id
            plan._world_snapshot = snapshot
            plan._all_tasks = tasks
            # P0-SCHED-OWNERSHIP：advisory 模式下方案显式标记 advisory=true，
            # 调用方/API 层必须把它展示为"建议"，绝不可呈现为正式 approved/dispatched。
            if self.advisory_only:
                plan.advisory = True
            self._plans[plan.plan_id] = plan
            self._persist_plan(plan)
            self._persist_snapshot(plan._world_snapshot)
            self._publish(
                "schedule.proposed",
                entity_id=plan.plan_id,
                version=plan.version,
                payload={"request_id": req.request_id, "status": plan.status},
            )
            self._audit(
                req.created_by,
                "generate_plan",
                "plan",
                plan.plan_id,
                None,
                plan.to_dict(),
                f"request={req.request_id} world_state={snapshot.snapshot_id}",
            )
        return plans

    # ---- 确认 / 驳回 ----

    def confirm(self, plan_id, actor_id, reason, world_state_version=None):
        """确认方案：校验理由、状态、世界状态新鲜度，并为每个 assignment 做预约。

        成功后 plan.status=PLAN_APPROVED，写入 confirmed_at/by/reason；写审计。
        P0-SCHED-OWNERSHIP：advisory 模式（connected production）下拒绝——
        正式审批归 NestJS 控制面。
        """
        self._assert_writable()
        plan = self._get_plan(plan_id)
        if not reason or not str(reason).strip():
            raise ValueError("确认必须填写理由（spec：班组长确认时必须填写理由）")
        # R2-ESC-002：白名单收敛到 PLAN_PENDING_REVIEW——PLAN_TRANSITIONS/plan.yaml
        # 中 shadow 仅可达 simulating（shadow→approved 为契约外转换），影子方案
        # 必须经 simulating→pending_review 评审环节后方可确认。
        if plan.status != PLAN_PENDING_REVIEW:
            raise IllegalStateError(
                f"仅 {PLAN_PENDING_REVIEW} 状态可确认（shadow 需先推进到 "
                f"pending_review），当前：{plan.status}"
            )
        # 重新校验世界状态
        self._validate_world_state(plan, world_state_version)
        # 为每个 assignment 做预约（person/device 均在时间窗内唯一）
        # EDGE-109：逐条预约中途冲突时反向释放已建预约（内存 + 持久化），
        # 消除"部分预约残留导致资源被永久占用"的半提交状态。
        reservations = []
        try:
            for assignment in plan.assignments:
                end = assignment.planned_end or ""
                for resource_id in (assignment.person_id, assignment.device_id):
                    if not resource_id:
                        continue
                    if self.reservation_service.check_conflict(
                        resource_id, assignment.planned_start, end
                    ):
                        raise ReservationConflictError(
                            f"资源 {resource_id} 在 {assignment.planned_start}~{end} 已被预约"
                        )
                    res = self.reservation_service.reserve(
                        resource_id,
                        getattr(assignment, "task_id", ""),
                        plan_id,
                        assignment.planned_start,
                        end,
                        end,
                    )
                    reservations.append(res)
                    self._persist_reservation(res)
        except Exception:
            for res in reservations:
                try:
                    released = self.reservation_service.release(res.reservation_id)
                    self._persist_reservation(released)  # 反向释放同步落库（status=released）
                except Exception as e:  # noqa: BLE001 - 释放失败留痕不掩盖原始冲突
                    logger.warning(
                        "confirm 回滚释放预约 %s 失败: %s", res.reservation_id, e
                    )
            raise
        before = plan.to_dict()
        # R2-ESC-002：confirm 与 reject/execute 对称——状态写入前走统一转移校验
        # （validate_plan_transition，单一事实源 PLAN_TRANSITIONS/plan.yaml）。
        validate_plan_transition(plan.status, PLAN_APPROVED)
        plan.status = PLAN_APPROVED
        plan.confirmed_at = now_iso()
        plan.confirmed_by = actor_id
        plan.confirm_reason = str(reason).strip()
        plan._reservations = [r.to_dict() for r in reservations]
        self._persist_plan(plan)
        self._record_decision(plan, "confirm", actor_id, reason)
        self._publish(
            "schedule.confirmed",
            entity_id=plan.plan_id,
            version=plan.version,
            payload={"request_id": plan.request_id, "confirmed_by": actor_id},
        )
        self._audit(
            actor_id,
            "confirm_plan",
            "plan",
            plan_id,
            before,
            plan.to_dict(),
            reason,
        )
        return plan

    def _validate_world_state(self, plan, world_state_version):
        """确认前校验世界状态：版本匹配、不过期、关键未变化。"""
        if world_state_version and world_state_version != plan.world_state_version:
            raise PlanStaleError(
                f"传入世界状态版本 {world_state_version} 与方案版本 "
                f"{plan.world_state_version} 不符"
            )
        ref_snapshot = getattr(plan, "_world_snapshot", None)
        if ref_snapshot is None:
            return
        if self.world_state_service.is_stale(ref_snapshot):
            raise PlanStaleError("方案基于的世界状态已过期，请重新生成方案")
        if self.storage is not None:
            current = self.world_state_service.build_snapshot(self.storage)
            if self.world_state_service.key_changed(ref_snapshot, current):
                raise PlanStaleError("确认前检测到世界状态关键变化，请重新规划")

    def reject(self, plan_id, actor_id, reason):
        """驳回方案：状态 → archived，并写审计。"""
        plan = self._get_plan(plan_id)
        before = plan.to_dict()
        validate_plan_transition(plan.status, PLAN_ARCHIVED)
        plan.status = PLAN_ARCHIVED
        plan.reject_reason = str(reason or "").strip()
        self._persist_plan(plan)
        self._record_decision(plan, "reject", actor_id, reason)
        self._publish(
            "schedule.conflict",
            entity_id=plan.plan_id,
            version=plan.version,
            payload={"action": "reject", "reason": reason},
        )
        self._audit(
            actor_id, "reject_plan", "plan", plan_id, before, plan.to_dict(), reason
        )
        return plan

    # ---- 执行（派工） ----

    def execute(self, plan_id):
        """仅 PLAN_APPROVED 可执行 → 生成正式 Assignment（status=dispatched），
        标记 PLAN_DISPATCHED；非 approved 抛异常（未确认不得执行）。
        P0-SCHED-OWNERSHIP：advisory 模式（connected production）下拒绝——
        正式派工归 NestJS 控制面，避免 double dispatch。
        """
        self._assert_writable()
        plan = self._get_plan(plan_id)
        if plan.status != PLAN_APPROVED:
            raise IllegalStateError(
                f"未经确认不得执行（当前状态：{plan.status}）"
            )
        # EDGE-110：先做状态机校验再创建/持久化 assignments——
        # 原实现先生成派工落库后校验，验证失败时派工已泄露到存储。
        validate_plan_transition(plan.status, PLAN_DISPATCHED)
        assignments = []
        for ca in plan.assignments:
            assignment = Assignment(
                assignment_id=new_id("ASN"),
                task_id=ca.task_id,
                plan_id=plan_id,
                person_id=ca.person_id,
                device_id=ca.device_id,
                station_id=ca.station_id,
                route=dict(ca.route),
                planned_start=ca.planned_start,
                planned_end=ca.planned_end,
                status=TASK_DISPATCHED,
            )
            self._assignments[assignment.assignment_id] = assignment
            self._persist_assignment(assignment)
            self._sync_task_status_on_dispatch(assignment)
            self._publish(
                "assignment.updated",
                entity_id=assignment.assignment_id,
                version=assignment.version,
                payload={"task_id": assignment.task_id, "plan_id": plan_id, "status": assignment.status},
            )
            assignments.append(assignment)
        before = plan.to_dict()
        plan.status = PLAN_DISPATCHED
        plan.executed_at = now_iso()
        self._persist_plan(plan)
        self._audit(
            "system",
            "execute_plan",
            "plan",
            plan_id,
            before,
            plan.to_dict(),
            "approval 已确认，生成正式派工",
        )
        return assignments

    # ---- 反馈 / 重排 ----

    def feedback(self, plan_id, actual_outcome):
        """记录执行结果回流（ScheduleFeedback），供学习闭环使用。

        P0-SCHED-OWNERSHIP：advisory 模式（connected production）下拒绝——
        执行反馈事实由 NestJS 控制面统一落库（ewohSchedulingFeedback）。
        """
        self._assert_writable()
        plan = self._get_plan(plan_id)
        predicted = {}
        for a in plan.assignments:
            predicted.setdefault(a.task_id, a.to_dict())
        fb = ScheduleFeedback(
            feedback_id=new_id("FB"),
            plan_id=plan_id,
            predicted=predicted,
            actual=dict(actual_outcome or {}),
        )
        self._feedback[fb.feedback_id] = fb
        self._persist_feedback(fb)
        self._audit(
            "system", "feedback_plan", "plan", plan_id, None, fb.to_dict(), "execution feedback"
        )
        return fb

    def replan(self, plan_id, trigger_type, actor_id, reason):
        """局部重调度：冻结 executing/locked 分配，生成新版本方案（version+1）。

        P0-SCHED-OWNERSHIP：advisory 模式（connected production）下拒绝——
        重排写路径归 NestJS 控制面。
        """
        self._assert_writable()
        plan = self._get_plan(plan_id)
        # EDGE-117：Task 状态机（task.yaml canonical）无 executing_locked/locked
        # 状态——冻结集合只取契约内的 executing（派工中不可移动的既成事实）。
        frozen = [
            a for a in self._assignments.values()
            if getattr(a, "status", "") == TASK_EXECUTING
        ]
        tasks = [_serialize_task(t) for t in getattr(plan, "_all_tasks", [])]
        policy = {"request_id": plan.request_id, "policy_id": ""}
        world_state = getattr(plan, "_world_snapshot", None)
        if world_state is None and self.storage is not None:
            world_state = self.world_state_service.build_snapshot(self.storage)
        new_plan = self.replanner.replan(
            world_state,
            tasks,
            frozen,
            policy,
            {"prev_version": int(plan.version)},
        )
        if new_plan is None:
            raise PlanConflictError("重排未产出新方案")
        new_plan.request_id = plan.request_id
        new_plan._world_snapshot = world_state
        new_plan._all_tasks = tasks
        self._plans[new_plan.plan_id] = new_plan
        self._persist_plan(new_plan)
        self._publish(
            "schedule.proposed",
            entity_id=new_plan.plan_id,
            version=new_plan.version,
            payload={"request_id": new_plan.request_id, "status": new_plan.status, "replan_of": plan.plan_id},
        )
        self._audit(
            actor_id,
            "replan",
            "plan",
            plan_id,
            plan.to_dict(),
            new_plan.to_dict(),
            reason,
        )
        return new_plan

    # ---- 查询 ----

    def get_plan(self, plan_id):
        return self._get_plan(plan_id)

    def list_plans(self):
        return list(self._plans.values())

    def _get_plan(self, plan_id):
        plan = self._plans.get(plan_id)
        if plan is None:
            raise KeyError(f"方案不存在: {plan_id}")
        return plan

    # ---- 派工生命周期（Phase 6 API） ----

    def get_assignment(self, assignment_id):
        a = self._assignments.get(assignment_id)
        if a is None:
            raise KeyError(f"派工不存在: {assignment_id}")
        return a

    def list_assignments(self, status=None):
        items = list(self._assignments.values())
        if status:
            items = [a for a in items if getattr(a, "status", "") == status]
        return items

    def list_feedback(self, plan_id=None):
        """列出执行反馈（内存态；hydrate 后含历史记录，供学习闭环查询）。"""
        items = list(self._feedback.values())
        if plan_id:
            items = [f for f in items if getattr(f, "plan_id", "") == plan_id]
        return items

    def list_requests(self, status=None):
        items = list(self._requests.values())
        if status:
            items = [r for r in items if getattr(r, "status", "") == status]
        return items

    def set_assignment_status(self, assignment_id, new_status, actor_id, reason="", force=False):
        """校验合法的派工状态转换并落地（start/pause/complete/cancel/override）。

        new_status 为 Task 状态机中的可执行节点（received/executing/paused/completed/
        cancelled 等）；非法转换由 validate_task_transition 拒绝。

        force=True：人工 override，跳过状态机校验直接落地（仅在 override 场景使用）。

        P0-SCHED-OWNERSHIP：advisory 模式（connected production）下拒绝——
        执行状态更新由 NestJS 控制面经 execution feedback 统一收集。
        """
        self._assert_writable()
        a = self.get_assignment(assignment_id)
        before = a.to_dict()
        self._apply_assignment_transition(a, new_status, force=force)
        self._persist_assignment(a)
        # 同步任务状态（若任务存在；ADR-029 决策 2：Task 事实与派工同状态机收敛）
        self._sync_task_status(a.task_id, new_status, a.assignment_id, force=force)
        self._publish(
            "assignment.updated",
            entity_id=a.assignment_id,
            version=a.version,
            payload={"task_id": a.task_id, "status": new_status, "reason": reason},
        )
        self._audit(
            actor_id,
            "assignment_" + new_status,
            "assignment",
            assignment_id,
            before,
            a.to_dict(),
            reason,
        )
        return a

    # ---- 任务↔派工状态机同步（ADR-029 / R-3 收口） ----

    def _apply_assignment_transition(self, a, new_status, force=False):
        """共享转换器：沿任务状态机推进派工状态（含最短合法链补全）。

        与 set_assignment_status / update_task 复用（§31 消除内联重复）；
        同步异常在调用方显式留痕，绝不静默。
        """
        from .models import validate_task_transition

        if not force:
            # 沿任务状态机自动推进最短合法链（如 dispatched→received→executing、
            # paused→executing→completed），非法终点仍由 validate_task_transition 拒绝。
            for mid in shortest_task_path(a.status, new_status):
                validate_task_transition(a.status, mid)
                a.status = mid
            validate_task_transition(a.status, new_status)
        a.status = new_status
        if new_status in ("executing", "received"):
            a.actual_start = a.actual_start or now_iso()
        elif new_status in ("completed", "cancelled"):
            a.actual_end = now_iso()
        a.version = int(a.version or 1) + 1

    def _sync_task_status(self, task_id, new_status, assignment_id="", force=False):
        """派工推进 → 同步 Task 状态（乐观锁；失败显式留痕不阻断派工主流程）。"""
        if self.repository is None:
            return
        try:
            if self.repository.get_task(task_id) is None:
                return
            task = self.repository.get_task(task_id)
            current = task.get("status")
            if current == new_status:
                return  # 已一致（幂等），不重复更新
            if not force:
                from .models import validate_task_transition

                for mid in shortest_task_path(current, new_status):
                    validate_task_transition(current, mid)
                    current = mid
                validate_task_transition(current, new_status)
            self.repository.update_task(
                task_id, int(task.get("version") or 1), status=new_status
            )
        except Exception as e:  # noqa: BLE001 - 同步失败显式留痕不影响主事实
            logger.warning(
                "task↔assignment 同步任务 %s → %s 失败（%s%s）: %s",
                task_id, new_status,
                "assignment=" + assignment_id if assignment_id else "",
                "", e,
            )

    def _sync_task_status_on_dispatch(self, assignment):
        """execute() 派工落账后推进 Task（pending_dispatch → dispatched，ADR-029 决策 2）。"""
        self._sync_task_status(assignment.task_id, TASK_DISPATCHED, assignment.assignment_id)

    def _sync_assignments_for_task(self, task_id, new_status):
        """任务 API 推进 → 同步其派工（ADR-029 决策 3；不回调任务防递归）。"""
        for a in list(self._assignments.values()):
            if getattr(a, "task_id", "") != task_id:
                continue
            if getattr(a, "status", "") == new_status:
                continue
            try:
                self._apply_assignment_transition(a, new_status)
                self._persist_assignment(a)
                self._publish(
                    "assignment.updated",
                    entity_id=a.assignment_id,
                    version=a.version,
                    payload={"task_id": task_id, "status": new_status, "reason": "task.synced"},
                )
            except Exception as e:  # noqa: BLE001 - 派工无法跟随（终态/非法）显式留痕
                logger.warning(
                    "task↔assignment 同步派工 %s → %s 失败（任务 %s）: %s",
                    getattr(a, "assignment_id", "?"), new_status, task_id, e,
                )

    # ---- 任务（Phase 6 API） ----

    def create_task(self, actor_id="", **fields):
        """创建任务（Task 模型），持久化并发布 task.created 事件，返回 Task。"""
        from .models import Task

        task_id = fields.pop("task_id", None) or new_id("TASK")
        task = Task(task_id=task_id, **fields)
        if self.repository is not None:
            self.repository.save_task(task)
        self._publish(
            "task.created",
            entity_id=task.task_id,
            version=task.version,
            payload={"task_type": task.task_type, "priority": task.priority, "status": task.status},
        )
        self._audit(actor_id, "create_task", "task", task.task_id, None, task.to_dict(), "create")
        return task

    def get_task(self, task_id):
        if self.repository is None:
            raise KeyError(f"任务不存在: {task_id}")
        t = self.repository.get_task(task_id)
        if t is None:
            raise KeyError(f"任务不存在: {task_id}")
        return t

    def list_tasks(self, status=None):
        if self.repository is None:
            return []
        return self.repository.list_tasks(status=status)

    def update_task(self, task_id, actor_id="", expected_version=None, reason="", **fields):
        """乐观锁更新任务：字段含 status 时做状态机校验。返回更新后的 dict。"""
        if self.repository is None:
            raise KeyError(f"任务不存在: {task_id}")
        current = self.repository.get_task(task_id)
        if current is None:
            raise KeyError(f"任务不存在: {task_id}")
        ver = int(expected_version) if expected_version is not None else int(current.get("version") or 1)
        new_status = fields.get("status")
        if new_status and new_status != current.get("status"):
            # ADR-029：任务推进与派工同状态机（最短合法链补全，非法终点仍拒绝）
            from .models import validate_task_transition

            walked = current.get("status", "")
            for mid in shortest_task_path(walked, new_status):
                validate_task_transition(walked, mid)
                walked = mid
            validate_task_transition(walked, new_status)
        updated = self.repository.update_task(task_id, ver, **fields)
        # ADR-029 决策 3：任务推进 → 其派工同状态机收敛（不回调任务防递归）
        if new_status and new_status != current.get("status"):
            self._sync_assignments_for_task(task_id, new_status)
        self._publish(
            "task.updated",
            entity_id=task_id,
            version=int(updated.get("version") or ver + 1),
            payload={"status": new_status or current.get("status"), "reason": reason},
        )
        self._audit(actor_id, "update_task", "task", task_id, current, updated, reason)
        return updated
