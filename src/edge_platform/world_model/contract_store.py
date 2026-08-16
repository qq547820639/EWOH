"""契约校验的世界状态存储（ADR-008 / NO-03b：world_model 进入运行时装配链）。

ContractWorldStore 包装 world_model.StateStore，把 Canonical World State 契约
（contracts/world/world-state.schema.json）的校验语义接入 set/snapshot 路径：

- set_state：entityId 必须是规范身份（kind:value，ADR-006）、entityType 命中注册表、
  sourceType ∈ real/simulated/derived、confidence ∈ [0,1]——非法即拒绝
  （fail-closed，绝不把脏状态写入本地世界状态）；
- declare_entity（ADR-015 / NO-03b）：实体声明契约校验接入——声明必须通过
  validate_entity_declaration（含 kind 前缀一致性）；同一 entityId 重复声明时
  kind/tenant/factory 不可变、版本严格递增、来源不可变、时间不回拨；已声明实体
  的 set_state 交叉校验（kind 必须可状态投影、entityType 必须等于声明 kind、
  状态生效时间不得早于声明生效时间）；
- 双时态/版本单调由底层 StateStore 的 set() 语义保证（关闭旧 valid_to + 版本 +1）；
- snapshot()：输出契约形状快照（snapshotId/snapshotVersion/ts/worldVersion/
  entityVersions（规范身份键）/states/source），返回前整体 validate_snapshot 自检；
- 模拟隔离：snapshot 附带 sourceProfile（simulatedOnly/hasReal），供上层判定
  （simulated 状态绝不参与 real 投影，§13）；
- to_dict/from_dict：状态 + 声明整体持久化（离线重启可恢复，可审计）。

纯 Python 标准库实现（零第三方依赖）。
"""

from __future__ import annotations

from typing import Any

from edge_platform.contracts import entity_model
from edge_platform.contracts import world as world_contract
from edge_platform.contracts.identity import is_canonical_identity
from edge_platform.spatial import new_id, now_iso

from .event_graph import EventGraph, validate_event_entity_refs
from .prediction import Predictor
from .replay import Replay
from .state_store import StateStore, WorldState


class WorldStoreContractError(ValueError):
    """世界状态违反 Canonical World State 契约（fail-closed）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ContractWorldStore:
    """契约校验的世界状态存储（运行时组件）。"""

    def __init__(self):
        self._store = StateStore()
        self._declarations: dict[str, dict] = {}
        self._events = EventGraph()
        self._predictor = Predictor()

    # ── 实体声明（ADR-015 / NO-03b：Entity Model 运行时接线）────────────────

    def declare_entity(self, declaration: dict) -> dict:
        """契约校验后登记实体声明（fail-closed）。

        规则（与 contracts/entity/entity-model.schema.json + ADR-015 一致）：
        - validate_entity_declaration 全量校验（含 kind 前缀一致性）；
        - 同一 entityId 重复声明：kind/tenantId/factoryId 不可变（身份稳定）、
          source 不可变（来源不可回改）、version 严格大于上次、validFrom 不得
          早于上次声明（时间不回拨）；
        - 返回登记后的声明副本。
        """
        errors = entity_model.validate_entity_declaration(declaration)
        if errors:
            raise WorldStoreContractError(errors[0], f"实体声明契约校验失败: {errors}")
        entity_id = declaration["entityId"]
        prev = self._declarations.get(entity_id)
        if prev is not None:
            for field in ("kind", "tenantId", "factoryId"):
                if declaration[field] != prev[field]:
                    raise WorldStoreContractError(
                        "declaration_immutable", f"{field} 不可变: {prev[field]} -> {declaration[field]}"
                    )
            if declaration["source"] != prev["source"]:
                raise WorldStoreContractError(
                    "source_change_rejected",
                    f"来源不可回改: {prev['source']} -> {declaration['source']}",
                )
            if declaration["version"] <= prev["version"]:
                raise WorldStoreContractError(
                    "declaration_version_not_increasing",
                    f"版本必须严格递增: {prev['version']} -> {declaration['version']}",
                )
            prev_valid_from_ms = entity_model.parse_iso(prev["timeSemantics"]["validFrom"])
            new_valid_from_ms = entity_model.parse_iso(declaration["timeSemantics"]["validFrom"])
            if new_valid_from_ms < prev_valid_from_ms:
                raise WorldStoreContractError(
                    "declaration_time_regression",
                    f"声明生效时间不得早于上次: {prev['timeSemantics']['validFrom']}",
                )
        self._declarations[entity_id] = dict(declaration)
        return dict(declaration)

    def declaration(self, entity_id: str) -> dict | None:
        """返回实体最新声明副本（未声明返回 None）。"""
        decl = self._declarations.get(entity_id)
        return dict(decl) if decl is not None else None

    def declarations(self) -> list[dict]:
        """返回全部最新实体声明（entityId 升序）。"""
        return [dict(self._declarations[k]) for k in sorted(self._declarations)]

    def set_state(
        self,
        entity_id: str,
        entity_type: str,
        state_json: dict | None = None,
        source_type: str = "real",
        confidence: float = 1.0,
        ts: str | None = None,
    ) -> WorldState:
        """契约校验后写入状态（关闭旧状态 + 版本 +1）。非法输入拒绝（fail-closed）。"""
        decl = self._declarations.get(entity_id)
        if decl is not None:
            # 已声明实体的状态写入交叉校验（ADR-015 权威投影分工的可执行面）：
            # 声明 kind 必须可状态投影；entityType 必须等于声明 kind；状态生效时间
            # 不得早于声明生效时间。
            if not entity_model.is_state_projectable(decl["kind"]):
                raise WorldStoreContractError(
                    "entity_not_state_projectable",
                    f"kind {decl['kind']} 无状态投影（声明型实体）",
                )
            if entity_type != decl["kind"]:
                raise WorldStoreContractError(
                    "entity_type_mismatch",
                    f"entityType {entity_type} 与声明 kind {decl['kind']} 不一致",
                )
            valid_from_ms = entity_model.parse_iso(ts) if ts else None
            decl_from_ms = entity_model.parse_iso(decl["timeSemantics"]["validFrom"])
            if valid_from_ms is not None and decl_from_ms is not None and valid_from_ms < decl_from_ms:
                raise WorldStoreContractError(
                    "state_precedes_declaration",
                    f"状态生效时间 {ts} 早于声明生效时间 {decl['timeSemantics']['validFrom']}",
                )
        record = {
            "stateId": new_id("STS"),
            "entityId": entity_id,
            "entityType": entity_type,
            "stateJson": state_json or {},
            "validFrom": ts or now_iso(),
            "validTo": None,
            "sourceType": source_type,
            "confidence": confidence,
            "version": 1,  # 仅用于形状校验；真实版本由 StateStore.set 递增
        }
        errors = world_contract.validate_state_record(record)
        if errors:
            raise WorldStoreContractError(errors[0], f"契约校验失败: {errors}")
        return self._store.set(
            entity_id=entity_id,
            state_type=entity_type,
            state_json=state_json or {},
            source_type=source_type,
            confidence=confidence,
            ts=record["validFrom"],
        )

    def current(self, entity_id: str, state_type: str) -> WorldState | None:
        return self._store.current(entity_id, state_type)

    def history(self, entity_id: str, state_type: str, from_ts=None, to_ts=None):
        return self._store.history(entity_id, state_type, from_ts=from_ts, to_ts=to_ts)

    def at_time(self, entity_id: str, state_type: str, ts: str) -> WorldState | None:
        return self._store.at_time(entity_id, state_type, ts)

    def snapshot(self) -> dict[str, Any]:
        """契约形状快照（输出前整体自检 validate_snapshot）。"""
        ts = now_iso()
        states: list[dict] = []
        max_version = 0
        for group in self._store._history.values():
            for s in group:
                states.append(
                    {
                        "stateId": s.state_id,
                        "entityId": s.entity_id,
                        "entityType": s.state_type,
                        "stateJson": s.state_json,
                        "validFrom": s.valid_from,
                        "validTo": s.valid_to,
                        "sourceType": s.source_type,
                        "confidence": s.confidence,
                        "version": s.version,
                    }
                )
                if s.version > max_version:
                    max_version = s.version
        entity_versions: dict[str, int] = {}
        for s in states:
            entity_versions[s["entityId"]] = s["version"]
        snapshot = {
            "snapshotId": new_id("WS"),
            "snapshotVersion": new_id("WS"),
            "ts": ts,
            "worldVersion": max_version,
            "entityVersions": entity_versions,
            "states": states,
            "source": "AUTHORITATIVE",
        }
        errors = world_contract.validate_snapshot(snapshot)
        if errors:
            raise WorldStoreContractError(errors[0], f"快照自检失败: {errors}")
        snapshot["sourceProfile"] = world_contract.snapshot_source_profile(states)
        return snapshot

    # ── 因果事件（NO-03b：event_graph 生产接线）──────────────────────────────

    def record_event(
        self,
        entity_id: str,
        node_type: str,
        payload: dict | None = None,
        ts: str | None = None,
        parent_id: str | None = None,
        source_type: str = "real",
        confidence: float = 1.0,
    ):
        """登记因果事件节点（fail-closed）。

        entity_id 必须是规范身份（kind:value，ADR-006）；载荷中的实体引用键
        （person_id/device_id/task_id/station_id/zone_id）必须是规范身份；
        parent_id 存在时必须指向已登记节点。返回 EventNode。
        """
        if not isinstance(entity_id, str) or not is_canonical_identity(entity_id):
            raise WorldStoreContractError(
                "bad_event_entity_ref", f"因果事件主体必须是规范身份: {entity_id!r}"
            )
        ref_errors = validate_event_entity_refs(person_id=None, payload=payload)
        if ref_errors:
            raise WorldStoreContractError(ref_errors[0], f"因果事件实体引用非法: {ref_errors}")
        if parent_id is not None and self._events.get(parent_id) is None:
            raise WorldStoreContractError("unknown_event_parent", f"因果前驱不存在: {parent_id}")
        payload = dict(payload or {})
        payload.setdefault("entity_id", entity_id)
        return self._events.add_node(
            node_type, payload, ts or now_iso(),
            parent_id=parent_id, source_type=source_type, confidence=confidence,
        )

    def replay(self, ts: str) -> dict[str, Any]:
        """重建 ts 时刻世界状态快照 + 因果事件流（Replay.at，读路径）。"""
        return Replay(self._store, self._events).at(ts)

    def event_graph(self) -> EventGraph:
        """因果事件图访问器（只读用途）。"""
        return self._events

    # ── 短期预测（NO-03b：prediction 生产接线）───────────────────────────────

    # kind -> (predictor 方法名, 必填参数键)；目标实体由 Predictor 规范身份校验 fail-closed。
    PREDICTION_DISPATCH: dict[str, tuple] = {
        "fatigue": ("predict_fatigue", ("personId", "currentLoadScore", "loadTrendPerMin")),
        "low_battery": ("predict_low_battery", ("deviceId", "batteryPct", "drainPerMin")),
        "task_delay": ("predict_task_delay", ("taskId", "progressPct", "elapsedMin", "slaMin")),
        "zone_congestion": ("predict_zone_congestion", ("stationId", "currentOccupancy", "trend", "capacity")),
        "device_offline": ("predict_device_offline", ("deviceId", "lastSeenTs", "packetLossPct")),
    }

    def predict(self, kind: str, params: dict | None = None):
        """规则式短期预测（predict 返回 Prediction 或 None——未触发阈值即无预测）。

        kind ∈ PREDICTION_DISPATCH；params 缺必填参数/目标实体非规范身份均
        fail-closed（KeyError/ValueError）。可选参数（horizon_min/threshold）
        透传 predictor。
        """
        params = dict(params or {})
        if kind not in self.PREDICTION_DISPATCH:
            raise ValueError(f"未知预测类型: {kind!r}")
        method_name, required = self.PREDICTION_DISPATCH[kind]
        for key in required:
            if key not in params:
                raise KeyError(f"缺少必填参数: {key}")
        method = getattr(self._predictor, method_name)
        # 可选参数按 predictor 签名显式透传（不存在的签名参数绝不误传）
        if kind == "fatigue":
            return method(
                params["personId"],
                params["currentLoadScore"],
                params["loadTrendPerMin"],
                **({"horizon_min": params["horizonMin"]} if "horizonMin" in params else {}),
            )
        if kind == "low_battery":
            opts = {}
            if "threshold" in params:
                opts["threshold"] = params["threshold"]
            if "horizonMin" in params:
                opts["horizon_min"] = params["horizonMin"]
            return method(
                params["deviceId"],
                params["batteryPct"],
                params["drainPerMin"],
                **opts,
            )
        if kind == "task_delay":
            return method(
                params["taskId"],
                params["progressPct"],
                params["elapsedMin"],
                params["slaMin"],
            )
        if kind == "zone_congestion":
            return method(
                params["stationId"],
                params["currentOccupancy"],
                params["trend"],
                params["capacity"],
            )
        return method(params["deviceId"], params["lastSeenTs"], params["packetLossPct"])

    # ── 持久化（离线重启恢复 / 可审计）───────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        """状态 + 实体声明 + 因果事件整体序列化。"""
        return {
            "declarations": self.declarations(),
            "store": self._store.to_dict(),
            "events": self._events.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ContractWorldStore:
        """从 to_dict 输出恢复；声明恢复前逐条重校验（fail-closed）。"""
        store = cls()
        for decl in d.get("declarations", []):
            store.declare_entity(decl)
        store._store = StateStore.from_dict(d.get("store") or {"states": []})
        store._events = EventGraph.from_dict(d.get("events") or {"nodes": [], "edges": []})
        return store
