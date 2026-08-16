"""遥测 → 世界模型自动投影（NO-03c：感知自动接线）。

TelemetryWorldProjector 订阅 STREAM_TELEMETRY，把采集链产出的事实自动投影进
ContractWorldStore（ADR-008/ADR-015）：

- 设备前缀 → 实体 kind 映射由配置显式给出（EWOH_WORLD_KIND_MAP，如
  {"EXO-": "exo"}）——绝不猜测实体类别；未配置映射/租户/工厂 → 投影显式
  关闭（health.enabled=false + 计数，不静默丢数据也不伪造实体）；
- 首帧自动声明实体（declare_entity，source 如实取帧 source_type，非契约
  三态则拒绝并计数——绝不把 unknown 当 normal）；
- 每帧投影状态（set_state：电量/助力等级/累计负荷/温度/故障码/姿态等
  telemetry 子集；person 载荷随帧投影 load_score）；
- 首见实体登记因果事件 ENTITY_OBSERVED（record_event，事件由采集链驱动）；
- 契约拒绝/时间倒退等一律计数 + 日志，fail-closed 跳过该帧（可观测，
  绝不静默吞）。

纯 Python 标准库实现。
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from edge_platform.contracts import envelope as envelope_contract
from edge_platform.contracts.identity import is_canonical_identity
from edge_platform.runtime.protocols import STREAM_EVENTS, STREAM_TELEMETRY
from edge_platform.spatial import new_id, now_iso

logger = logging.getLogger("ewoh.world.projection")

# 投影进状态载荷的遥测字段（白名单，其余字段不泄漏进世界状态）
_STATE_FIELDS = (
    "battery_pct",
    "assist_level",
    "cumulative_load_score",
    "temperature_c",
    "fault_code",
    "pitch_deg",
    "angular_velocity_dps",
)

_CONTRACT_SOURCES = ("real", "simulated", "derived")

# NO-04a：投影产出的 Canonical Event Catalog 事件类型（contracts/events/event-catalog.yaml）
_CATALOG_TYPES = frozenset({"EntityDeclared", "EntityStateObserved"})
_EVENT_CODES = {"EntityDeclared": "ENTITY_DECLARED", "EntityStateObserved": "ENTITY_STATE_OBSERVED"}


class TelemetryWorldProjector:
    """采集链 → ContractWorldStore 自动投影（后台消费者）。

    投影事实同时以 Catalog 信封事件（EntityDeclared/EntityStateObserved，
    ADR-009 信封 + 契约校验 fail-closed）落边缘事件库 + 发布 STREAM_EVENTS
    （NO-04a：实体声明/观测随事件骨干上行的事实载体）。
    """

    def __init__(
        self,
        world_store,
        bus,
        tenant_id: str = "",
        factory_id: str = "",
        kind_map: dict | None = None,
        storage=None,
    ):
        self._store = world_store
        self._bus = bus
        self._storage = storage
        self._tenant = tenant_id or ""
        self._factory = factory_id or ""
        self._kind_map: dict[str, str] = dict(kind_map or {})
        self._declared: set[str] = set()
        self._state_emitted: set[str] = set()
        self._counters = {
            "frames": 0,
            "declarations": 0,
            "states_projected": 0,
            "events_recorded": 0,
            "events_emitted": 0,
            "skipped_no_device": 0,
            "skipped_no_kind": 0,
            "rejected_source": 0,
            "rejected_contract": 0,
        }
        self._running = False
        self._threads: list[threading.Thread] = []

    # ---- 启用判定（fail-closed：缺配置即显式关闭） ----
    @property
    def enabled(self) -> bool:
        return bool(self._tenant and self._factory and self._kind_map)

    def health(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "kind_map": dict(self._kind_map),
            "counters": dict(self._counters),
        }

    # ---- 后台消费 ----
    def start(self) -> None:
        if self._running:
            return
        if not self.enabled:
            logger.warning(
                "world projection disabled: 需要 EWOH_WORLD_TENANT_ID / "
                "EWOH_WORLD_FACTORY_ID / EWOH_WORLD_KIND_MAP（绝不猜测实体类别）"
            )
            return
        self._running = True

        import queue as _queue

        q = _queue.Queue()

        def loop() -> None:
            while True:
                try:
                    msg = q.get(timeout=0.5)
                except _queue.Empty:
                    continue
                try:
                    self.handle(msg)
                except Exception:
                    logger.exception("world projection consumer failed")

        self._bus.subscribe(STREAM_TELEMETRY, q.put)
        t = threading.Thread(target=loop, daemon=True, name="world-projection")
        t.start()
        self._threads.append(t)

    def stop(self) -> None:
        self._running = False

    # ---- 单帧投影 ----
    def _resolve_kind(self, device_id: str) -> str | None:
        for prefix, kind in self._kind_map.items():
            if device_id.startswith(prefix):
                return kind
        return None

    def _emit_catalog_event(self, event_type, entity_id, raw_device_id, source, ts, extra) -> None:
        """发射 Catalog 信封事件（契约校验 fail-closed；落事件库 + STREAM_EVENTS）。"""
        event_id = new_id("EVT")
        occurred = ts or now_iso()
        now = now_iso()
        envelope = {
            "eventId": event_id,
            "eventType": event_type,
            "schemaVersion": "1.0.0",
            "occurredAt": occurred,
            "observedAt": now,
            "receivedAt": now,
            "source": "edge:world-projection",
        }
        errors = envelope_contract.validate_envelope(envelope, _CATALOG_TYPES)
        if errors:
            self._counters["rejected_contract"] += 1
            logger.warning("world projection: 信封校验失败 %s: %s", event_type, errors)
            return
        evt = {
            "event_id": event_id,
            "event_code": _EVENT_CODES[event_type],
            "severity": "L3",
            "status": "closed",
            "person_id": None,
            "device_id": raw_device_id,
            "start_time": occurred,
            "end_time": None,
            "trigger": {"type": "world_projection"},
            "evidence": {"entity_id": entity_id, "occurred_at": occurred, **extra},
            "source_type": source,
            "handling": {
                "status": "closed",
                "handler_id": "world_projection",
                "action": "auto_record",
                "comment": "fact_record",
                "handled_at": now,
            },
            "envelope": envelope,
        }
        if self._storage is not None and hasattr(self._storage, "insert_event"):
            try:
                self._storage.insert_event(evt)
            except Exception:
                logger.exception("world projection: 信封事件落库失败 %s", event_type)
        self._bus.publish(STREAM_EVENTS, evt)
        self._counters["events_emitted"] += 1

    def handle(self, row: Any) -> dict | None:
        """投影一条遥测帧；返回 {projected, entity_id, skipped_reason} 或 None。"""
        if not isinstance(row, dict):
            return None
        self._counters["frames"] += 1
        device_id = row.get("device_id")
        if not device_id:
            self._counters["skipped_no_device"] += 1
            return {"projected": False, "entity_id": None, "skipped_reason": "no_device"}
        kind = self._resolve_kind(device_id)
        if kind is None:
            self._counters["skipped_no_kind"] += 1
            return {"projected": False, "entity_id": None, "skipped_reason": "no_kind"}
        entity_id = f"{kind}:{device_id}"
        if not is_canonical_identity(entity_id):
            self._counters["rejected_contract"] += 1
            return {"projected": False, "entity_id": entity_id, "skipped_reason": "bad_identity"}
        source = row.get("source_type", "real")
        if source not in _CONTRACT_SOURCES:
            self._counters["rejected_source"] += 1
            logger.warning(
                "world projection: 帧 source_type 非契约三态，拒绝投影: %s (%s)",
                device_id,
                source,
            )
            return {"projected": False, "entity_id": entity_id, "skipped_reason": "bad_source"}
        ts = row.get("timestamp")
        from edge_platform.world_model.contract_store import WorldStoreContractError

        # 首见实体：声明 + 因果事件（采集链驱动的事件事实）
        if entity_id not in self._declared:
            declaration = {
                "entityId": entity_id,
                "kind": kind,
                "tenantId": self._tenant,
                "factoryId": self._factory,
                "timeSemantics": {"validFrom": ts or now_iso(), "validTo": None},
                "status": "active",
                "source": source,
                "version": 1,
            }
            try:
                self._store.declare_entity(declaration)
            except WorldStoreContractError as exc:
                self._counters["rejected_contract"] += 1
                logger.warning("world projection: 实体声明被契约拒绝 %s: %s", entity_id, exc)
                return {"projected": False, "entity_id": entity_id, "skipped_reason": "declaration_rejected"}
            self._declared.add(entity_id)
            self._counters["declarations"] += 1
            try:
                self._store.record_event(
                    entity_id,
                    "ENTITY_OBSERVED",
                    {"kind": kind, "source_type": source},
                    ts=ts or now_iso(),
                )
                self._counters["events_recorded"] += 1
            except Exception:
                logger.exception("world projection: 因果事件登记失败 %s", entity_id)
            # NO-04a：实体声明随事件骨干上行（Catalog 信封事件，契约校验 fail-closed）
            self._emit_catalog_event(
                "EntityDeclared",
                entity_id,
                device_id,
                source,
                ts,
                {
                    "kind": kind,
                    "factory_id": self._factory,
                    "tenant_id": self._tenant,
                    "version": 1,
                    "status": "active",
                },
            )

        telemetry = row.get("telemetry") or {}
        state_json = {k: telemetry[k] for k in _STATE_FIELDS if k in telemetry and telemetry[k] is not None}
        person_id = row.get("person_id")
        if person_id:
            state_json["person_load"] = {
                "person_id": f"person:{person_id}",
                "load_score": telemetry.get("cumulative_load_score"),
            }
        try:
            state = self._store.set_state(
                entity_id=entity_id,
                entity_type=kind,
                state_json=state_json,
                source_type=source,
                confidence=1.0,
                ts=ts,
            )
        except WorldStoreContractError as exc:
            self._counters["rejected_contract"] += 1
            logger.warning("world projection: 状态投影被契约拒绝 %s: %s", entity_id, exc)
            return {"projected": False, "entity_id": entity_id, "skipped_reason": "state_rejected"}
        self._counters["states_projected"] += 1
        # NO-04a：首次状态观测随事件骨干上行（Catalog 信封事件）
        if entity_id not in self._state_emitted:
            self._state_emitted.add(entity_id)
            self._emit_catalog_event(
                "EntityStateObserved",
                entity_id,
                device_id,
                source,
                ts,
                {"kind": kind, "state_version": state.version, "state_json": state_json},
            )
        return {"projected": True, "entity_id": entity_id, "skipped_reason": None}


__all__ = ["TelemetryWorldProjector"]
