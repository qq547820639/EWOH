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
            "rejected_quality": 0,
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
        # EDGE-202（2026-08-17 审计整改）：采集面 sourceType 三态
        # （real/controlled_test/simulated，连接器 manifest enum）与世界契约
        # 三态（real/simulated/derived）不一致——受控采集（controlled_test，
        # 真机录制回放）在世界模型侧显式映射为 derived（推导/回放数据），
        # 消除"受控帧整类被拒投影"的静默数据缺口；real/simulated 原样透传。
        if source == "controlled_test":
            source = "derived"
        if source not in _CONTRACT_SOURCES:
            self._counters["rejected_source"] += 1
            logger.warning(
                "world projection: 帧 source_type 非契约三态，拒绝投影: %s (%s)",
                device_id,
                source,
            )
            return {"projected": False, "entity_id": entity_id, "skipped_reason": "bad_source"}
        # UR8（2026-09-13 审查）：帧质量是投影置信度的事实来源——此前无视 quality
        # 一律以 confidence=1.0 写入，invalid（越量程/非数值）帧的读数被伪造成
        # 满置信度的世界事实。现在：good→帧置信度（缺省 1.0）；degraded→帧置信度
        # （缺省 0.5）；invalid/unknown→fail-closed 拒绝（计数 + 留痕，绝不补投）。
        quality = row.get("quality") if isinstance(row.get("quality"), dict) else {}
        quality_status = str(quality.get("status") or "unknown")
        quality_confidence = quality.get("confidence")
        if quality_status == "good":
            confidence = (
                float(quality_confidence) if isinstance(quality_confidence, (int, float)) else 1.0
            )
        elif quality_status == "degraded":
            confidence = (
                float(quality_confidence) if isinstance(quality_confidence, (int, float)) else 0.5
            )
        else:
            self._counters["rejected_quality"] += 1
            logger.warning(
                "world projection: 帧质量不可信（%s），拒绝投影: %s",
                quality_status,
                device_id,
            )
            return {"projected": False, "entity_id": entity_id, "skipped_reason": "bad_quality"}
        confidence = max(0.0, min(1.0, confidence))
        ts = row.get("timestamp")
        from edge_platform.world_model.contract_store import WorldStoreContractError

        # 首见实体：声明 + 因果事件（采集链驱动的事件事实）
        if entity_id not in self._declared:
            # UR8（2026-09-13 审查）：重启恢复（run.py 用 worldstate.json from_dict
            # 还原 ContractWorldStore）后，声明已在持久层且 version≥1；投影器内存
            # _declared 集合却已清空。若照旧以 version=1 重复声明，会被
            # declaration_version_not_increasing 永久拒绝，重启后该实体所有帧
            # declaration_rejected——世界模型冻结在重启前（已实测复现）。
            # 故先查持久层：已存在且 kind/tenant/factory 与当前配置一致的声明
            # 直接采纳为"已声明"（与进程内第二帧起不再声明的语义对齐，不重放
            # EntityDeclared/ENTITY_OBSERVED）；配置变更（不同 tenant/factory/kind）
            # 则仍走 declare_entity，由契约不可变校验 fail-closed 拒绝。
            getter = getattr(self._store, "declaration", None)
            prev = getter(entity_id) if callable(getter) else None
            adopted = (
                isinstance(prev, dict)
                and prev.get("kind") == kind
                and prev.get("tenantId") == self._tenant
                and prev.get("factoryId") == self._factory
            )
            if adopted:
                self._declared.add(entity_id)
            else:
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
                confidence=confidence,  # UR8：帧质量决定投影置信度，不再恒 1.0
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
