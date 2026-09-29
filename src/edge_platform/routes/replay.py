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

import math

from ..world_model.contract_store import WorldStoreContractError
from . import Route, dispatch_routes, exact
from ._util import now_iso

_ALLOWED_SOURCE_TYPES = frozenset({"real", "simulated", "derived"})


def _object_body(body):
    """Return a request object or raise a stable input-contract error."""
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    return body


def _provenance(payload):
    """Require explicit source and bounded confidence; never fabricate trust."""
    source_type = payload.get("sourceType")
    if source_type not in _ALLOWED_SOURCE_TYPES:
        raise ValueError("sourceType 必须显式为 real/simulated/derived")
    raw_confidence = payload.get("confidence")
    if raw_confidence is None or isinstance(raw_confidence, bool):
        raise ValueError("confidence 必须显式为 0..1 的有限数字")
    try:
        confidence = float(raw_confidence)
    except (TypeError, ValueError):
        raise ValueError("confidence 必须显式为 0..1 的有限数字") from None
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError("confidence 必须显式为 0..1 的有限数字")
    return source_type, confidence


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
    try:
        payload = _object_body(req_meta.body)
        declaration = ws.declare_entity(payload)
    except (WorldStoreContractError, ValueError) as exc:
        code = exc.code if isinstance(exc, WorldStoreContractError) else "invalid_params"
        return h._new_error(code, str(exc), 400)
    h._audit_target_type = "entity_declaration"
    h._audit_target_id = declaration["entityId"]
    return h.send_json({"ok": True, "declaration": declaration})


def api_world_states(ctx, h, req_meta):
    """POST /api/world/states — 状态写入（契约 + 声明交叉校验 fail-closed）。"""
    ws, err = _world_store_or_error(ctx, h)
    if err:
        return err
    try:
        payload = _object_body(req_meta.body)
        if not payload.get("entityId") or not payload.get("entityType"):
            return h._new_error("invalid_params", "entityId/entityType 必填", 400)
        source_type, confidence = _provenance(payload)
        state = ws.set_state(
            entity_id=payload["entityId"],
            entity_type=payload["entityType"],
            state_json=payload.get("stateJson") or {},
            source_type=source_type,
            confidence=confidence,
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
    try:
        payload = _object_body(req_meta.body)
        if not payload.get("entityId") or not payload.get("nodeType"):
            return h._new_error("invalid_params", "entityId/nodeType 必填", 400)
        source_type, confidence = _provenance(payload)
        params = payload.get("payload") or {}
        if not isinstance(params, dict):
            raise ValueError("payload 必须为 JSON 对象")
        node = ws.record_event(
            entity_id=payload["entityId"],
            node_type=payload["nodeType"],
            payload=params,
            ts=payload.get("ts"),
            parent_id=payload.get("parentId"),
            source_type=source_type,
            confidence=confidence,
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
    try:
        payload = _object_body(req_meta.body)
        params = payload.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("params 必须为 JSON 对象")
        prediction = ws.predict(payload.get("kind"), params)
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
