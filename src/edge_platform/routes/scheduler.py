#!/usr/bin/env python3
"""智能调度域路由（Task 9 / P2）。

GET /api/tasks、/api/tasks/assignments、/api/tasks/{id}、/api/scheduling/requests、
/api/scheduling/requests/{id}、/api/scheduling/plans、/api/scheduling/plans/{id}、
/api/assignments、/api/resources/state、/api/command-map/stream（SSE）；
POST /api/tasks、/api/tasks/recommend、/api/tasks/confirm、/api/scheduling/requests、
/api/scheduling/plans/{id}/confirm|execute|reject|replan、
/api/assignments/{id}/start|pause|complete|cancel|override、/api/scheduler/v2/solve；
PATCH /api/tasks/{id}。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

import json

from edge_platform import server
from edge_platform import services
from edge_platform.scheduler.cpsat import solver as cpsat_solver
from edge_platform.scheduler.cpsat.contract import SolverRequest

from . import NOT_HANDLED, STREAM, Route, affix, dispatch_routes, exact, sub_path
from ._util import now_iso


def _sched(ctx, h):
    """返回调度服务；未接线时抛 503。"""
    if ctx.scheduler is None:
        raise RuntimeError("调度服务未启用")
    return ctx.scheduler


def api_resource_state(ctx, h, req_meta):
    """GET /api/resources/state — 统一实时资源状态（Phase 3）。"""
    if ctx.resource_state_service is None:
        return h.send_json({"items": [], "now": now_iso(), "note": "资源状态服务未启用"})
    items = ctx.resource_state_service.build_resource_states(ctx.storage, ctx)
    return h.send_json({"items": items, "now": now_iso()})


def api_command_map_stream(ctx, h, req_meta):
    """GET /api/command-map/stream — SSE 实时事件流（Phase 5）。"""
    bus = ctx.event_bus
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream; charset=utf-8")
    h.send_header("Cache-Control", "no-cache")
    h.send_header("X-Accel-Buffering", "no")
    h.end_headers()
    try:
        h.wfile.write(b"retry: 3000\n\n")
        h.wfile.flush()
    except Exception:
        return STREAM
    if bus is None:
        return STREAM
    sub = bus.subscribe()
    try:
        while True:
            try:
                event = sub.get(timeout=15)
            except Exception:
                # 心跳：保持连接存活
                try:
                    h.wfile.write(b": ping\n\n")
                    h.wfile.flush()
                except Exception:
                    break
                continue
            data = json.dumps(event, ensure_ascii=False)
            try:
                h.wfile.write(f"event: {event['event_type']}\ndata: {data}\n\n".encode())
                h.wfile.flush()
            except Exception:
                break
    finally:
        bus.unsubscribe(sub)
    return STREAM


def api_tasks(ctx, h, req_meta):
    """GET /api/tasks — 任务列表（?status= 过滤）。"""
    try:
        sched = _sched(ctx, h)
        status = h.arg("status") or None
        items = sched.list_tasks(status=status)
        return h.send_json({"items": items, "now": now_iso()})
    except RuntimeError as e:
        return h._new_error("not_ready", str(e), 503)


def api_task_detail(ctx, h, task_id):
    """GET /api/tasks/{id} — 单任务详情。"""
    try:
        sched = _sched(ctx, h)
        item = sched.get_task(task_id)
        return h.send_json({"task": item, "now": now_iso()})
    except KeyError:
        return h._new_error("not_found", "任务不存在", 404)
    except RuntimeError as e:
        return h._new_error("not_ready", str(e), 503)


def _task_field(payload, key):
    v = payload.get(key)
    if v is None:
        return None
    if key in (
        "required_skills",
        "required_device_capabilities",
        "predecessor_task_ids",
        "exclusive_resource_ids",
    ):
        return list(v) if isinstance(v, list) else []
    if key in ("priority", "estimated_duration_sec"):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    if key in ("load_level",):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    if key == "safety_critical":
        return bool(v)
    return v


def api_create_task(ctx, h, payload):
    """POST /api/tasks — 创建任务。"""
    try:
        sched = _sched(ctx, h)
    except RuntimeError as e:
        return h._new_error("not_ready", str(e), 503)
    actor = h._actor()
    fields = {}
    for key in (
        "task_id", "task_type", "priority", "status", "station_id", "zone_id",
        "required_skills", "required_device_capabilities", "release_at", "earliest_start",
        "due_at", "estimated_duration_sec", "predecessor_task_ids", "exclusive_resource_ids",
        "load_level", "safety_critical",
    ):
        v = _task_field(payload, key)
        if v is not None:
            fields[key] = v
    task = sched.create_task(actor_id=actor, **fields)
    return h.send_json({"ok": True, "task": task.to_dict()})


def api_update_task(ctx, h, task_id, payload):
    """PATCH /api/tasks/{id} — 乐观锁局部更新任务。"""
    try:
        sched = _sched(ctx, h)
    except RuntimeError as e:
        return h._new_error("not_ready", str(e), 503)
    actor = h._actor()
    expected_version = payload.get("version")
    reason = payload.get("reason", "")
    fields = {}
    for key in (
        "task_type", "priority", "status", "station_id", "zone_id",
        "required_skills", "required_device_capabilities", "release_at", "earliest_start",
        "due_at", "estimated_duration_sec", "predecessor_task_ids", "exclusive_resource_ids",
        "load_level", "safety_critical",
    ):
        v = _task_field(payload, key)
        if v is not None:
            fields[key] = v
    if not fields:
        return h._new_error("invalid_params", "无可更新字段", 400)
    try:
        updated = sched.update_task(
            task_id, actor_id=actor, expected_version=expected_version, reason=reason, **fields
        )
    except KeyError:
        return h._new_error("not_found", "任务不存在", 404)
    except ValueError as e:
        return h._new_error("invalid_state", str(e), 409)
    except Exception as e:
        if getattr(e, "__class__", None) and e.__class__.__name__ == "VersionConflictError":
            return h._new_error("VERSION_CONFLICT", str(e), 409)
        return h._new_error("invalid_request", str(e), 400)
    return h.send_json({"ok": True, "task": updated})


def api_create_scheduling_request(ctx, h, payload):
    """POST /api/scheduling/requests — 创建调度请求并生成影子方案（闭环入口）。"""
    try:
        sched = _sched(ctx, h)
    except RuntimeError as e:
        return h._new_error("not_ready", str(e), 503)
    task_ids = payload.get("task_ids") or []
    trigger_type = payload.get("trigger_type") or "manual"
    policy_id = payload.get("policy_id") or ""
    created_by = payload.get("created_by") or h._actor()
    if not task_ids:
        return h._new_error("invalid_params", "task_ids 不能为空", 400)
    req = sched.create_request(task_ids, trigger_type, policy_id, created_by)
    plans = sched.generate_plans(req.request_id, storage=ctx.storage)
    return h.send_json(
        {
            "ok": True,
            "request": req.to_dict(),
            "plans": [p.to_dict() for p in plans],
        }
    )


def api_scheduling_request_detail(ctx, h, request_id):
    """GET /api/scheduling/requests/{id} — 调度请求详情。"""
    if ctx.scheduler is None:
        return h._new_error("not_ready", "调度服务未启用", 503)
    try:
        req = ctx.scheduler.get_request(request_id)
    except KeyError:
        return h._new_error("not_found", "请求不存在", 404)
    plans = [p.to_dict() for p in ctx.scheduler.list_plans() if p.request_id == request_id]
    return h.send_json({"request": req.to_dict(), "plans": plans})


def api_scheduling_plans(ctx, h, req_meta):
    """GET /api/scheduling/plans — 方案列表（?status= 过滤）。"""
    if ctx.scheduler is None:
        return h.send_json({"items": [], "now": now_iso()})
    status = h.arg("status") or None
    items = [
        p.to_dict()
        for p in ctx.scheduler.list_plans()
        if not status or p.status == status
    ]
    return h.send_json({"items": items, "now": now_iso()})


def api_scheduling_plan_detail(ctx, h, plan_id):
    """GET /api/scheduling/plans/{id} — 方案详情。"""
    if ctx.scheduler is None:
        return h._new_error("not_ready", "调度服务未启用", 503)
    try:
        plan = ctx.scheduler.get_plan(plan_id)
    except KeyError:
        return h._new_error("not_found", "方案不存在", 404)
    return h.send_json({"plan": plan.to_dict()})


def _plan_action(ctx, h, plan_id, action, payload):
    """POST /api/scheduling/plans/{id}/{action} — 确认/驳回/重排。"""
    if ctx.scheduler is None:
        return h._new_error("not_ready", "调度服务未启用", 503)
    actor = payload.get("actor_id") or h._actor()
    reason = payload.get("reason", "")
    try:
        if action == "confirm":
            plan = ctx.scheduler.confirm(
                plan_id,
                actor,
                reason,
                world_state_version=payload.get("world_state_version"),
            )
        elif action == "reject":
            plan = ctx.scheduler.reject(plan_id, actor, reason)
        elif action == "replan":
            plan = ctx.scheduler.replan(
                plan_id,
                payload.get("trigger_type") or "manual",
                actor,
                reason,
            )
        else:
            return h._new_error("not_found", "路径不存在", 404)
    except KeyError:
        return h._new_error("not_found", "方案不存在", 404)
    except Exception as e:
        code = getattr(e, "code", None) or "INVALID_REQUEST"
        status = 403 if code == "SCHEDULING_READ_ONLY" else 409
        return h._new_error(code, str(e), status)
    return h.send_json({"ok": True, "plan": plan.to_dict()})


def api_confirm_plan(ctx, h, plan_id, payload):
    return _plan_action(ctx, h, plan_id, "confirm", payload)


def api_execute_plan(ctx, h, plan_id, payload):
    """POST /api/scheduling/plans/{id}/execute — 已批准方案正式派工。

    生成 Assignment（status=dispatched）并将方案标记 dispatched；
    非 approved 状态抛 ILLEGAL_STATE（未经确认不得执行）。
    """
    if ctx.scheduler is None:
        return h._new_error("not_ready", "调度服务未启用", 503)
    try:
        assignments = ctx.scheduler.execute(plan_id)
    except KeyError:
        return h._new_error("not_found", "方案不存在", 404)
    except Exception as e:
        code = getattr(e, "code", None) or "INVALID_REQUEST"
        status = 403 if code == "SCHEDULING_READ_ONLY" else 409
        return h._new_error(code, str(e), status)
    return h.send_json(
        {"ok": True, "assignments": [a.to_dict() for a in assignments]}
    )


def api_reject_plan(ctx, h, plan_id, payload):
    return _plan_action(ctx, h, plan_id, "reject", payload)


def api_replan_plan(ctx, h, plan_id, payload):
    return _plan_action(ctx, h, plan_id, "replan", payload)


def api_assignments(ctx, h, req_meta):
    """GET /api/assignments — 派工列表（?status= 过滤）。"""
    if ctx.scheduler is None:
        return h.send_json({"items": [], "now": now_iso()})
    status = h.arg("status") or None
    items = [a.to_dict() for a in ctx.scheduler.list_assignments(status=status)]
    return h.send_json({"items": items, "now": now_iso()})


def api_assignment_status(ctx, h, assignment_id, new_status, payload):
    """POST /api/assignments/{id}/{start|pause|complete|cancel} — 派工状态转换。"""
    if ctx.scheduler is None:
        return h._new_error("not_ready", "调度服务未启用", 503)
    actor = payload.get("actor_id") or h._actor()
    reason = payload.get("reason", "")
    try:
        a = ctx.scheduler.set_assignment_status(assignment_id, new_status, actor, reason)
    except KeyError:
        return h._new_error("not_found", "派工不存在", 404)
    except ValueError as e:
        return h._new_error("ILLEGAL_STATE", str(e), 409)
    except RuntimeError as e:
        code = getattr(e, "code", None) or "INTERNAL"
        return h._new_error(code, str(e), 403 if code == "SCHEDULING_READ_ONLY" else 500)
    return h.send_json({"ok": True, "assignment": a.to_dict()})


def api_assignment_override(ctx, h, assignment_id, payload):
    """POST /api/assignments/{id}/override — 人工覆盖派工（重排/改派）。"""
    if ctx.scheduler is None:
        return h._new_error("not_ready", "调度服务未启用", 503)
    actor = payload.get("actor_id") or h._actor()
    reason = payload.get("reason", "")
    new_status = payload.get("status") or "executing"
    try:
        a = ctx.scheduler.set_assignment_status(assignment_id, new_status, actor, reason, force=True)
    except KeyError:
        return h._new_error("not_found", "派工不存在", 404)
    except ValueError as e:
        return h._new_error("ILLEGAL_STATE", str(e), 409)
    except RuntimeError as e:
        code = getattr(e, "code", None) or "INTERNAL"
        return h._new_error(code, str(e), 403 if code == "SCHEDULING_READ_ONLY" else 500)
    return h.send_json({"ok": True, "assignment": a.to_dict()})


# ---- 路由包装（原 do_GET/do_POST/do_PATCH 内联分支，逐字抽取） ----

def route_tasks_assignments(ctx, h, req_meta):
    return h.send_json({"items": ctx.assignments})


def route_sched_requests_list(ctx, h, req_meta):
    items = [r.to_dict() for r in ctx.scheduler.list_requests()] if ctx.scheduler else []
    return h.send_json({"items": items})


def route_recommend(ctx, h, req_meta):
    res = services.recommend(ctx.storage, ctx.assignments, req_meta.body, ctx.device_online)
    if ctx.metrics is not None:
        ctx.metrics.record_recommendation()
    return h.send_json(res)


def route_confirm(ctx, h, req_meta):
    res = services.confirm_assignment(ctx.storage, ctx.assignments, req_meta.body, ctx.device_online)
    if res.get("ok") and ctx.metrics is not None:
        ctx.metrics.record_assignment_confirmed()
    return h.send_json(res, 200 if res.get("ok") else 409)


def route_create_task(ctx, h, req_meta):
    return api_create_task(ctx, h, req_meta.body)


def route_create_sched_request(ctx, h, req_meta):
    return api_create_scheduling_request(ctx, h, req_meta.body)


def route_tasks_detail(ctx, h, req_meta):
    p = req_meta.path
    parts = p[len("/api/tasks/") :].split("/")
    if len(parts) == 1 and parts[0]:
        return api_task_detail(ctx, h, parts[0])
    return h._new_error("not_found", "路径不存在", 404)


def route_sched_request_detail(ctx, h, req_meta):
    p = req_meta.path
    parts = p[len("/api/scheduling/requests/") :].split("/")
    if len(parts) == 1 and parts[0]:
        return api_scheduling_request_detail(ctx, h, parts[0])
    return h._new_error("not_found", "路径不存在", 404)


def route_sched_plan_detail(ctx, h, req_meta):
    p = req_meta.path
    parts = p[len("/api/scheduling/plans/") :].split("/")
    if len(parts) == 1 and parts[0]:
        return api_scheduling_plan_detail(ctx, h, parts[0])
    return h._new_error("not_found", "路径不存在", 404)


def route_plan_confirm(ctx, h, req_meta):
    p = req_meta.path
    return api_confirm_plan(ctx, h, p[len("/api/scheduling/plans/") : -len("/confirm")], req_meta.body)


def route_plan_execute(ctx, h, req_meta):
    p = req_meta.path
    return api_execute_plan(ctx, h, p[len("/api/scheduling/plans/") : -len("/execute")], req_meta.body)


def route_plan_reject(ctx, h, req_meta):
    p = req_meta.path
    return api_reject_plan(ctx, h, p[len("/api/scheduling/plans/") : -len("/reject")], req_meta.body)


def route_plan_replan(ctx, h, req_meta):
    p = req_meta.path
    return api_replan_plan(ctx, h, p[len("/api/scheduling/plans/") : -len("/replan")], req_meta.body)


def route_assignment_start(ctx, h, req_meta):
    p = req_meta.path
    return api_assignment_status(ctx, h, p[len("/api/assignments/") : -len("/start")], "executing", req_meta.body)


def route_assignment_pause(ctx, h, req_meta):
    p = req_meta.path
    return api_assignment_status(ctx, h, p[len("/api/assignments/") : -len("/pause")], "paused", req_meta.body)


def route_assignment_complete(ctx, h, req_meta):
    p = req_meta.path
    return api_assignment_status(ctx, h, p[len("/api/assignments/") : -len("/complete")], "completed", req_meta.body)


def route_assignment_cancel(ctx, h, req_meta):
    p = req_meta.path
    return api_assignment_status(ctx, h, p[len("/api/assignments/") : -len("/cancel")], "cancelled", req_meta.body)


def route_assignment_override(ctx, h, req_meta):
    p = req_meta.path
    return api_assignment_override(ctx, h, p[len("/api/assignments/") : -len("/override")], req_meta.body)


def route_solve(ctx, h, req_meta):
    p = req_meta.path
    try:
        resp = cpsat_solver.solve(SolverRequest.from_dict(req_meta.body))
        return h.send_json({"ok": True, "response": resp.to_dict()})
    except Exception as e:
        server._log_internal_error("POST", p, h._request_id, e)
        return h._new_error("solver_error", "求解器调用失败", 500)


def route_update_task(ctx, h, req_meta):
    p = req_meta.path
    task_id = p[len("/api/tasks/") :].split("/")[0]
    if not task_id:
        return h.send_json({"error": "not found"}, 404)
    return api_update_task(ctx, h, task_id, req_meta.body)


DOMAIN_ROUTES = [
    # ---- GET（与原 do_GET 分支顺序一致） ----
    Route("GET", "/api/tasks/assignments", exact("/api/tasks/assignments"), route_tasks_assignments),
    Route("GET", "/api/resources/state", exact("/api/resources/state"), api_resource_state),
    Route("GET", "/api/command-map/stream", exact("/api/command-map/stream"), api_command_map_stream),
    Route("GET", "/api/tasks", exact("/api/tasks"), api_tasks),
    Route("GET", "/api/scheduling/requests", exact("/api/scheduling/requests"), route_sched_requests_list),
    Route("GET", "/api/scheduling/plans", exact("/api/scheduling/plans"), api_scheduling_plans),
    Route("GET", "/api/assignments", exact("/api/assignments"), api_assignments),
    Route("GET", "/api/tasks/{id}*", sub_path("/api/tasks/"), route_tasks_detail),
    Route("GET", "/api/scheduling/requests/{id}*", sub_path("/api/scheduling/requests/"), route_sched_request_detail),
    Route("GET", "/api/scheduling/plans/{id}*", sub_path("/api/scheduling/plans/"), route_sched_plan_detail),
    # ---- POST（与原 do_POST 分支顺序一致） ----
    Route("POST", "/api/tasks/recommend", exact("/api/tasks/recommend"), route_recommend),
    Route("POST", "/api/tasks/confirm", exact("/api/tasks/confirm"), route_confirm),
    Route("POST", "/api/tasks", exact("/api/tasks"), route_create_task),
    Route("POST", "/api/scheduling/requests", exact("/api/scheduling/requests"), route_create_sched_request),
    Route("POST", "/api/scheduling/plans/{id}/confirm", affix("/api/scheduling/plans/", "/confirm"), route_plan_confirm),
    Route("POST", "/api/scheduling/plans/{id}/execute", affix("/api/scheduling/plans/", "/execute"), route_plan_execute),
    Route("POST", "/api/scheduling/plans/{id}/reject", affix("/api/scheduling/plans/", "/reject"), route_plan_reject),
    Route("POST", "/api/scheduling/plans/{id}/replan", affix("/api/scheduling/plans/", "/replan"), route_plan_replan),
    Route("POST", "/api/assignments/{id}/start", affix("/api/assignments/", "/start"), route_assignment_start),
    Route("POST", "/api/assignments/{id}/pause", affix("/api/assignments/", "/pause"), route_assignment_pause),
    Route("POST", "/api/assignments/{id}/complete", affix("/api/assignments/", "/complete"), route_assignment_complete),
    Route("POST", "/api/assignments/{id}/cancel", affix("/api/assignments/", "/cancel"), route_assignment_cancel),
    Route("POST", "/api/assignments/{id}/override", affix("/api/assignments/", "/override"), route_assignment_override),
    Route("POST", "/api/scheduler/v2/solve", exact("/api/scheduler/v2/solve"), route_solve),
    # ---- PATCH（对应原 do_PATCH：/api/tasks/{id}） ----
    Route("PATCH", "/api/tasks/{id}*", sub_path("/api/tasks/"), route_update_task),
]


def handle_scheduler(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
