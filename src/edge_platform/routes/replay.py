#!/usr/bin/env python3
"""回放域路由（Task 9 / P2）——NO-03b：World Model 运行时接线。

本模块承载契约世界状态存储（ContractWorldStore，ADR-008/ADR-015）的 HTTP 端点：

- GET  /api/world/snapshot     契约形状世界快照（含 sourceProfile 模拟隔离画像）
- POST /api/world/entities     实体声明登记（declare_entity，fail-closed）
- POST /api/world/states       状态写入（set_state，契约校验 + 声明交叉校验）
- GET  /api/world/replay       时间轴回放（Replay.at：状态快照 + 因果事件流）
- POST /api/world/events       因果事件登记（record_event，规范实体引用）
- POST /api/world/predictions  短期预测（规则模型，目标实体规范身份 fail-closed）

world_store 未装配时全部 fail-closed 返回 503（绝不静默降级/伪造空数据）。
"""

from ..world_model.contract_store import WorldStoreContractError
from . import Route, dispatch_routes, exact
from ._util import now_iso


def _world_store_or_error(ctx, h):
    """取 world_store；未装配返回 (None, 503 响应)。"""
    ws = getattr(ctx, "world_store", None)
    if ws is None:
        # send_json/_new_error intentionally return None. Return a separate
        # handled marker so the caller stops dispatching after the 503 and
        # never dereferences the absent store or emits a second response.
        h._new_error("world_store_unavailable", "契约世界状态存储未装配", 503)
        return None, True
    return ws, None


def api_world_snapshot(ctx, h, req_meta):
    """GET /api/world/snapshot — 契约形状世界快照（整体自检后输出）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    try:
        return h.send_json(ws.snapshot())
    except WorldStoreContractError as exc:
        return h._new_error(exc.code, f"快照自检失败: {exc}", 500)


def api_world_entities(ctx, h, req_meta):
    """POST /api/world/entities — 实体声明登记（契约校验 fail-closed）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    payload = req_meta.body or {}
    try:
        declaration = ws.declare_entity(payload)
    except WorldStoreContractError as exc:
        return h._new_error(exc.code, str(exc), 400)
    h._audit_target_type = "entity_declaration"
    h._audit_target_id = declaration["entityId"]
    return h.send_json({"ok": True, "declaration": declaration})


def api_world_states(ctx, h, req_meta):
    """POST /api/world/states — 状态写入（契约 + 声明交叉校验 fail-closed）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    payload = req_meta.body or {}
    if not payload.get("entityId") or not payload.get("entityType"):
        return h._new_error("invalid_params", "entityId/entityType 必填", 400)
    try:
        state = ws.set_state(
            entity_id=payload["entityId"],
            entity_type=payload["entityType"],
            state_json=payload.get("stateJson") or {},
            source_type=payload.get("sourceType", "real"),
            confidence=float(payload.get("confidence", 1.0)),
            ts=payload.get("validFrom"),
        )
    except WorldStoreContractError as exc:
        return h._new_error(exc.code, str(exc), 400)
    except (TypeError, ValueError) as exc:
        return h._new_error("invalid_params", str(exc), 400)
    h._audit_target_type = "world_state"
    h._audit_target_id = state.entity_id
    return h.send_json({"ok": True, "state": state.to_dict()})


def api_world_replay(ctx, h, req_meta):
    """GET /api/world/replay?ts=... — 时间轴回放（状态快照 + 因果事件流）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    try:
        return h.send_json(ws.replay(h.arg("ts") or now_iso()))
    except WorldStoreContractError as exc:
        return h._new_error(exc.code, str(exc), 500)


def api_world_events(ctx, h, req_meta):
    """POST /api/world/events — 因果事件登记（规范实体引用 fail-closed）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    payload = req_meta.body or {}
    if not payload.get("entityId") or not payload.get("nodeType"):
        return h._new_error("invalid_params", "entityId/nodeType 必填", 400)
    try:
        node = ws.record_event(
            entity_id=payload["entityId"],
            node_type=payload["nodeType"],
            payload=payload.get("payload") or {},
            ts=payload.get("ts"),
            parent_id=payload.get("parentId"),
            source_type=payload.get("sourceType", "real"),
            confidence=float(payload.get("confidence", 1.0)),
        )
    except WorldStoreContractError as exc:
        return h._new_error(exc.code, str(exc), 400)
    except (TypeError, ValueError) as exc:
        return h._new_error("invalid_params", str(exc), 400)
    h._audit_target_type = "world_event"
    h._audit_target_id = node.node_id
    return h.send_json({"ok": True, "event": node.to_dict()})


def api_world_predictions(ctx, h, req_meta):
    """POST /api/world/predictions — 短期预测（规则模型；未触发阈值返回 null）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    payload = req_meta.body or {}
    try:
        prediction = ws.predict(payload.get("kind"), payload.get("params") or {})
    except (ValueError, KeyError, TypeError) as exc:
        return h._new_error("invalid_params", str(exc), 400)
    return h.send_json({"ok": True, "prediction": prediction.to_dict() if prediction else None})


DOMAIN_ROUTES = [
    Route("GET", "/api/world/snapshot", exact("/api/world/snapshot"), api_world_snapshot),
    Route("POST", "/api/world/entities", exact("/api/world/entities"), api_world_entities),
    Route("POST", "/api/world/states", exact("/api/world/states"), api_world_states),
    Route("GET", "/api/world/replay", exact("/api/world/replay"), api_world_replay),
    Route("POST", "/api/world/events", exact("/api/world/events"), api_world_events),
    Route("POST", "/api/world/predictions", exact("/api/world/predictions"), api_world_predictions),
]


def handle_replay(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
