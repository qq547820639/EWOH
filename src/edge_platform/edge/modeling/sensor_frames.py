"""多源传感器帧归一化：统一帧 → 本地存储行 + 平台上行载荷（纯函数）。

为什么需要这个模块
------------------
`AdapterManager._read_loop` 此前只对**分组外骨骼帧**调用
`unified_to_telemetry_row`，其它适配器（environment / camera / uwb）的帧原样
透传给 `storage.insert_telemetry`。而该函数要求 `record_id` / `device_id` /
`timestamp` / `source_type` 顶层键——环境帧给的是 `sensor_id` / `ts`、
摄像头帧给的是 `camera_id` / `persons`，于是必然 KeyError：帧只留在 ERROR 日志里，
本地库没有、平台也从未收到（`docs/architecture/data-flow.md` §4.4 记录的断点）。
本模块是该转换的**唯一入口**：每种 kind 显式映射，缺关键身份字段显式报
`FrameContractError`（调用方转死信留痕），既不静默丢弃，也不猜字段语义。

两套口径（刻意分离，跨运行时契约层映射的唯一落点）
--------------------------------------------------
- **本地行**（`local_row`）：写入边缘 SQLite `telemetry`，`telemetry` 字段保留
  *边缘统一帧* 自己的字段名（`temperature_c` / `vibration_mm_s` / …），
  并附带 `kind` 标记——边缘侧 API（`/api/devices/{id}/latest` 等）一直讲这套词汇。
- **上行载荷**（`uplink.payload`）：映射为*平台 DTO* 字段名（`temperature` /
  `event_time` / `detections` …），由 `sensor_uplink` 投递到对应 `/api/ingest/*`。
  `docs/architecture/data-flow.md` 治理规则 3 要求"跨运行时数据必须经过契约层
  映射，禁止运行时私造字段语义"——本模块就是那条映射。

幂等
----
`record_id` 缺失时按 `edge:<kind>:<device 摘要>:<ts_ms>:<载荷摘要>` 确定性生成：
同一帧重发得到同一 id，配合平台侧 `(org_id, scope, record_id)` 认领即"重放不双写"
（外骨骼路径另有 `raw_ref` 去重）。绝不使用随机 id 伪装新观测。

质量与来源
----------
`source_type` 原样透传，缺失时显式 `unknown`（绝不默认 `real`）；
`quality_status` 缺失时显式 `unknown`（绝不默认 `good`）。

纯 Python 标准库实现。
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from edge_platform.edge.frame_errors import FrameContractError
from edge_platform.edge.modeling.frame_adapter import (
    is_grouped_frame,
    unified_to_telemetry_row,
)

#: 支持归一化的帧类别（新增类别必须在此登记并在测试中覆盖，不允许"未登记透传"）。
FRAME_KIND_EXOSKELETON = "exoskeleton"
FRAME_KIND_ENVIRONMENT = "environment"
FRAME_KIND_CAMERA = "camera"
FRAME_KIND_LOCATION = "location"
#: 执行机构（AGV/PLC）状态帧（NO-59b）：边缘 actuator 适配器上行 → /api/ingest/actuator
FRAME_KIND_ACTUATOR = "actuator"

SUPPORTED_FRAME_KINDS: tuple[str, ...] = (
    FRAME_KIND_EXOSKELETON,
    FRAME_KIND_ENVIRONMENT,
    FRAME_KIND_CAMERA,
    FRAME_KIND_LOCATION,
    FRAME_KIND_ACTUATOR,
)

#: 平台上行端点（kind → `/api/ingest/<endpoint>`）。
UPLINK_ENDPOINTS: dict[str, str] = {
    FRAME_KIND_EXOSKELETON: "exoskeleton",
    FRAME_KIND_ENVIRONMENT: "environment",
    FRAME_KIND_CAMERA: "camera",
    FRAME_KIND_LOCATION: "location",
    FRAME_KIND_ACTUATOR: "actuator",
}

#: 平台 DTO 里 record_id 长度上限（ewoh_environment.record_id varchar(64)）；
#: 确定性 id 固定短于该上限（见 `_record_id` 的拼装长度）。
_MAX_RECORD_ID_LEN = 64


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha8(text: str) -> str:
    """短摘要（用于**确定性 id 生成**，非安全用途）。

    `usedforsecurity=False` 显式声明用途：避免被静态扫描当作密码学误用
    （bandit B324），同时不改变摘要值。
    """
    return hashlib.sha1(text.encode("utf-8"), usedforsecurity=False).hexdigest()[:8]


def _payload_digest(payload: Any) -> str:
    try:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        encoded = repr(payload)
    return _sha8(encoded)


def _ts_ms(ts: Any) -> int:
    """把统一帧的时间戳归一为毫秒整数（用于确定性 id；不可解析 → 0 并显式标注）。"""
    if isinstance(ts, (int, float)):
        value = float(ts)
        # 兼容秒级时间戳（< 10^11 视为秒）
        return int(value * 1000) if value < 1e11 else int(value)
    if isinstance(ts, str) and ts:
        text = ts.replace("Z", "+00:00")
        try:
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def _record_id(kind: str, device_id: str, ts: Any, payload: Any, seq: Any = None) -> str:
    """确定性 record_id（同一帧重发 → 同一 id）。

    拼装：``edge:<kind>:<device 摘要8>:<ts_ms>:<seq 或载荷摘要8>``，长度 ≤ 64。
    设备摘要而非全名：设备名可能很长（平台列宽 64），且摘要在同一时间戳下
    已足以区分设备；完整 device_id 仍在载荷里，可回溯。
    """
    seq_part = str(int(seq)) if isinstance(seq, (int, float)) and int(seq) > 0 else _payload_digest(payload)
    candidate = f"edge:{kind}:{_sha8(device_id)}:{_ts_ms(ts)}:{seq_part}"
    if len(candidate) <= _MAX_RECORD_ID_LEN:
        return candidate
    # 理论上不会到这里（各部分定长）；仍保留显式截断保护，避免超长写入失败。
    return candidate[:_MAX_RECORD_ID_LEN]


def _quality_status(frame: dict) -> str:
    """显式质量状态：缺失 → ``unknown``（绝不默认 good）。"""
    quality = frame.get("quality")
    if isinstance(quality, dict) and quality.get("status"):
        return str(quality["status"])
    if frame.get("quality_status"):
        return str(frame["quality_status"])
    return "unknown"


def _confidence(frame: dict) -> float | None:
    quality = frame.get("quality")
    if isinstance(quality, dict) and isinstance(quality.get("confidence"), (int, float)):
        return float(quality["confidence"])
    if isinstance(frame.get("confidence"), (int, float)):
        return float(frame["confidence"])
    return None


def _source_type(frame: dict) -> str:
    """来源显式化：缺失 → ``unknown``（绝不默认 real；模拟数据必须可识别）。"""
    value = frame.get("source_type")
    return str(value) if value else "unknown"


def detect_frame_kind(frame: Any) -> str | None:
    """识别帧类别；未登记类别返回 None（调用方转死信，绝不猜）。"""
    if not isinstance(frame, dict):
        return None
    # 已经是本地行（record_id + device_id + timestamp + telemetry）：外骨骼扁平行透传。
    if {"record_id", "device_id", "timestamp"} <= set(frame.keys()) and "telemetry" in frame:
        return FRAME_KIND_EXOSKELETON
    if is_grouped_frame(frame):
        return FRAME_KIND_EXOSKELETON
    if frame.get("sensor_id") and any(
        key in frame for key in ("temperature_c", "vibration_mm_s", "noise_db", "air_quality_pm25")
    ):
        return FRAME_KIND_ENVIRONMENT
    if frame.get("camera_id") and isinstance(frame.get("persons"), list):
        return FRAME_KIND_CAMERA
    if frame.get("tag_id") and ("x" in frame and "y" in frame):
        return FRAME_KIND_LOCATION
    # 执行机构状态帧：边缘 actuator 适配器统一帧带 mode=actuator（设备号 + 封闭词表状态）。
    if frame.get("mode") == "actuator" or (
        frame.get("device_id") and frame.get("state") in _ACTUATOR_STATES
    ):
        return FRAME_KIND_ACTUATOR
    return None


#: 执行机构状态封闭词表（与 edge/adapters/actuator/protocol.py 同一份；漂移由测试对账）。
_ACTUATOR_STATES = ("idle", "moving", "arrived", "paused", "fault", "offline")


def _actuator(frame: dict) -> dict:
    """执行机构统一帧 → 平台 ActuatorFrameDto 口径（位置/状态/任务/授权号）。"""
    device_id = frame.get("device_id")
    ts = frame.get("ts") or frame.get("event_time")
    missing = tuple(k for k, v in (("device_id", device_id), ("ts", ts)) if not v)
    if missing:
        raise FrameContractError(FRAME_KIND_ACTUATOR, "执行机构帧缺必填字段", missing)
    state = frame.get("state")
    issues: list[str] = []
    if state not in _ACTUATOR_STATES:
        # 状态不在词表内：显式标记（platform 侧 fail-closed 拒绝并回显），不猜成 idle。
        issues.append(f"unknown_state:{state}")
    record_id = frame.get("record_id") or _record_id(FRAME_KIND_ACTUATOR, str(device_id), ts, frame)
    motion = frame.get("motion") if isinstance(frame.get("motion"), dict) else {}
    business = frame.get("business") if isinstance(frame.get("business"), dict) else {}
    device = frame.get("device") if isinstance(frame.get("device"), dict) else {}
    status = _quality_status(frame)
    if issues and status == "unknown":
        status = "invalid"
    local_telemetry = {
        "kind": FRAME_KIND_ACTUATOR,
        "state": state,
        "x": motion.get("x", frame.get("x")),
        "y": motion.get("y", frame.get("y")),
        "battery_pct": device.get("battery_pct", frame.get("battery_pct")),
        "fault_code": device.get("fault_code", frame.get("fault_code")),
        "quality_status": status,
    }
    uplink = {
        "device_id": str(device_id),
        "event_time": ts,
        "state": state,
        "x": motion.get("x", frame.get("x")),
        "y": motion.get("y", frame.get("y")),
        "battery_pct": device.get("battery_pct", frame.get("battery_pct")),
        "fault_code": device.get("fault_code", frame.get("fault_code")),
        "current_task_id": business.get("current_task_id", frame.get("current_task_id")),
        "target_station_id": business.get("target_station_id", frame.get("target_station_id")),
        "last_authorization_ref": business.get("last_authorization_ref", frame.get("last_authorization_ref")),
        "station_id": frame.get("station_id"),
        "source_type": _source_type(frame),
        "record_id": record_id,
    }
    confidence = _confidence(frame)
    if confidence is not None:
        uplink["data_confidence"] = confidence
    # 执行机构状态帧**保持稳定形状**：可选字段显式传 null（不裁掉键）。
    # 状态机消费方（世界模型/页面）需要固定 schema 才能区分"该字段本帧没有值"与"字段不存在"；
    # 平台侧按 `?? null` 落库，语义一致（这是与其它帧类别不同的**有意**约定，见测试）。
    return {
        "device_id": str(device_id),
        "record_id": record_id,
        "ts": ts,
        "seq": frame.get("seq"),
        "person_id": None,
        "status": status,
        "confidence": confidence,
        "local_telemetry": local_telemetry,
        "uplink": uplink,
        "issues": issues,
    }


def _environment(frame: dict) -> dict:
    sensor_id = frame.get("sensor_id")
    ts = frame.get("ts")
    missing = tuple(k for k, v in (("sensor_id", sensor_id), ("ts", ts)) if not v)
    if missing:
        raise FrameContractError(FRAME_KIND_ENVIRONMENT, "环境帧缺必填字段", missing)
    record_id = frame.get("record_id") or _record_id(FRAME_KIND_ENVIRONMENT, str(sensor_id), ts, frame)
    measurements = {
        key: frame[key]
        for key in ("temperature_c", "vibration_mm_s", "noise_db", "air_quality_pm25")
        if key in frame
    }
    issues: list[str] = []
    if not any(value is not None for value in measurements.values()):
        # 无任何测量值：仍然落库（质量显式 unknown/invalid），但标记出来，
        # 避免"看起来是一条正常读数"。
        issues.append("no_measurements")
    status = _quality_status(frame)
    if status == "unknown" and issues:
        status = "invalid"
    local_telemetry = {
        "kind": FRAME_KIND_ENVIRONMENT,
        **measurements,
        "station_id": frame.get("station_id"),
        "quality_status": status,
    }
    uplink = {
        "sensor_id": sensor_id,
        # 语义映射（显式）：环境读数的"受影响对象"是工位，故 edge station_id → platform entity_id。
        "entity_id": frame.get("station_id") or None,
        "event_time": ts,
        "temperature": frame.get("temperature_c"),
        "vibration": frame.get("vibration_mm_s"),
        "noise": frame.get("noise_db"),
        "air_quality": frame.get("air_quality_pm25"),
        "source_type": _source_type(frame),
        "record_id": record_id,
    }
    confidence = _confidence(frame)
    if confidence is not None:
        uplink["data_confidence"] = confidence
    return {
        "device_id": str(sensor_id),
        "record_id": record_id,
        "ts": ts,
        "seq": frame.get("seq"),
        "person_id": None,
        "status": status,
        "confidence": confidence,
        "local_telemetry": local_telemetry,
        "uplink": {k: v for k, v in uplink.items() if v is not None},
        "issues": issues,
    }


def _bbox_from_xyxy(bbox: Any) -> dict | None:
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        try:
            x1, y1, x2, y2 = (float(v) for v in bbox)
        except (TypeError, ValueError):
            return None
        return {"x": x1, "y": y1, "w": max(0.0, x2 - x1), "h": max(0.0, y2 - y1)}
    if isinstance(bbox, dict) and {"x", "y", "w", "h"} <= set(bbox.keys()):
        return {k: bbox[k] for k in ("x", "y", "w", "h")}
    return None


def _skeleton(value: Any) -> dict | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _camera(frame: dict) -> dict:
    camera_id = frame.get("camera_id")
    ts = frame.get("ts")
    missing = tuple(k for k, v in (("camera_id", camera_id), ("ts", ts)) if not v)
    if missing:
        raise FrameContractError(FRAME_KIND_CAMERA, "摄像头帧缺必填字段", missing)
    record_id = frame.get("record_id") or _record_id(FRAME_KIND_CAMERA, str(camera_id), ts, frame)
    issues: list[str] = []
    detections: list[dict] = []
    for person in frame.get("persons") or []:
        if not isinstance(person, dict):
            issues.append("invalid_person_entry")
            continue
        entry: dict[str, Any] = {
            # 统一帧的 persons 结构本身即"人员检测"语义（非猜测）；若厂商给出
            # 明确类别则采用之。
            "class_name": person.get("class_name") or "person",
        }
        if person.get("track_id"):
            entry["track_id"] = person["track_id"]
        if isinstance(person.get("confidence"), (int, float)):
            entry["confidence"] = float(person["confidence"])
        else:
            issues.append("missing_confidence")
        bbox = _bbox_from_xyxy(person.get("bbox_xyxy") or person.get("bbox"))
        if bbox:
            entry["bbox"] = bbox
        skeleton = _skeleton(person.get("skeleton_json") or person.get("skeleton"))
        if skeleton:
            entry["skeleton"] = skeleton
        if person.get("action"):
            entry["action"] = person["action"]
        detections.append(entry)
    status = _quality_status(frame)
    local_telemetry = {
        "kind": FRAME_KIND_CAMERA,
        "person_count": len(detections),
        "model_version": frame.get("model_version"),
        "quality_status": status,
    }
    uplink = {
        "camera_id": camera_id,
        "event_time": ts,
        "detections": detections,
        "source_type": _source_type(frame),
        "record_id": record_id,
    }
    return {
        "device_id": str(camera_id),
        "record_id": record_id,
        "ts": ts,
        "seq": frame.get("seq"),
        "person_id": None,
        "status": status,
        "confidence": _confidence(frame),
        "local_telemetry": local_telemetry,
        "uplink": uplink,
        "issues": issues,
    }


def _location(frame: dict) -> dict:
    tag_id = frame.get("tag_id")
    ts = frame.get("ts")
    missing = tuple(
        k for k, v in (("tag_id", tag_id), ("ts", ts)) if not v
    ) + tuple(k for k in ("x", "y") if not isinstance(frame.get(k), (int, float)))
    if missing:
        raise FrameContractError(FRAME_KIND_LOCATION, "定位帧缺必填字段", missing)
    record_id = frame.get("record_id") or _record_id(FRAME_KIND_LOCATION, str(tag_id), ts, frame)
    issues: list[str] = []
    person_id = frame.get("person_id")
    if not person_id:
        # 未绑定人员的标签仍然上行（否则定位数据丢失），但显式标注为未归属，
        # 平台据此可区分"某标签在动"与"某人在这里"。
        issues.append("unattributed_tag")
    entity_id = str(person_id) if person_id else f"tag:{tag_id}"
    status = _quality_status(frame)
    local_telemetry = {
        "kind": FRAME_KIND_LOCATION,
        "tag_id": tag_id,
        "person_id": person_id,
        "x": frame.get("x"),
        "y": frame.get("y"),
        "z": frame.get("z"),
        "beacon_ids": frame.get("beacon_ids") or [],
        "quality_status": status,
    }
    uplink = {
        "entity_id": entity_id,
        # 物理设备 id 上行（平台据此登记设备台账；此前只发 entity_id 会丢设备身份）
        "tag_id": str(tag_id),
        "locator": "uwb",
        "confidence": float(frame["confidence"]) if isinstance(frame.get("confidence"), (int, float)) else 0.0,
        "x": float(frame["x"]),
        "y": float(frame["y"]),
        "z": float(frame["z"]) if isinstance(frame.get("z"), (int, float)) else 0.0,
        "ts": ts,
        "source_type": _source_type(frame),
        "record_id": record_id,
    }
    return {
        "device_id": str(tag_id),
        "record_id": record_id,
        "ts": ts,
        "seq": frame.get("seq"),
        "person_id": person_id,
        "status": status,
        "confidence": _confidence(frame),
        "local_telemetry": local_telemetry,
        "uplink": uplink,
        "issues": issues,
    }


def _exoskeleton(frame: dict) -> dict:
    # 已是本地行：直接透传（record_id/device_id/timestamp 齐备）。
    if {"record_id", "device_id", "timestamp"} <= set(frame.keys()) and "telemetry" in frame:
        row = dict(frame)
        record_id = str(row.get("record_id") or _record_id(
            FRAME_KIND_EXOSKELETON, str(row.get("device_id") or ""), row.get("timestamp"), row
        ))
        row["record_id"] = record_id
        return {
            "device_id": str(row.get("device_id") or ""),
            "record_id": record_id,
            "ts": row.get("timestamp"),
            "seq": row.get("sequence"),
            "person_id": row.get("person_id"),
            "status": (row.get("quality") or {}).get("status", "unknown"),
            "confidence": (row.get("quality") or {}).get("confidence"),
            "local_telemetry": row.get("telemetry") or {},
            "uplink": row,
            "issues": [],
        }
    # 分组帧：本地行走既有转换（保持推理管线字段不变）；上行仍用**原始分组帧**，
    # 因为平台 ExoskeletonFrameDto 讲的就是分组词汇（load/pose/device/quality）。
    row = unified_to_telemetry_row(frame)
    device_id = str(row.get("device_id") or "")
    ts = row.get("timestamp")
    if not device_id or not ts:
        missing = tuple(k for k, v in (("entity_id/device_id", device_id), ("event_time", ts)) if not v)
        raise FrameContractError(FRAME_KIND_EXOSKELETON, "外骨骼帧缺必填字段", missing)
    record_id = str(frame.get("record_id") or _record_id(
        FRAME_KIND_EXOSKELETON, device_id, ts, frame, seq=frame.get("sequence")
    ))
    row["record_id"] = record_id
    status = (row.get("quality") or {}).get("status") or "unknown"
    row["quality"] = {**(row.get("quality") or {}), "status": status}
    uplink = {**frame}
    uplink["record_id"] = record_id
    uplink["event_time"] = uplink.get("event_time") or ts
    uplink["device_id"] = uplink.get("device_id") or device_id
    issues: list[str] = []
    if not frame.get("source_type"):
        issues.append("source_type_missing")
    return {
        "device_id": device_id,
        "record_id": record_id,
        "ts": ts,
        "seq": row.get("sequence"),
        "person_id": row.get("person_id"),
        "status": status,
        "confidence": (row.get("quality") or {}).get("confidence"),
        "local_telemetry": row.get("telemetry") or {},
        "uplink": uplink,
        "issues": issues,
    }


_NORMALIZERS = {
    FRAME_KIND_EXOSKELETON: _exoskeleton,
    FRAME_KIND_ENVIRONMENT: _environment,
    FRAME_KIND_CAMERA: _camera,
    FRAME_KIND_LOCATION: _location,
    FRAME_KIND_ACTUATOR: _actuator,
}


def normalize_frame(frame: Any, *, now: str | None = None) -> dict:
    """统一帧 → ``{kind, device_id, record_id, local_row, uplink, issues}``。

    未登记类别或缺必填字段 → :class:`FrameContractError`（调用方转死信）。
    `local_row` 可直接交给 ``storage.insert_telemetry``；
    `uplink` = ``{endpoint, payload, batch}`` 交给 ``sensor_uplink``。

    `now` 仅用于诊断标注（不参与 id 生成），保证同帧在任何时刻得到同一 record_id。
    """
    kind = detect_frame_kind(frame)
    if kind is None:
        raise FrameContractError(None, "未登记的帧类别（拒绝猜测语义）")
    if not isinstance(frame, dict):
        raise FrameContractError(kind, "帧必须是 dict")
    normalized = _NORMALIZERS[kind](frame)
    status = normalized.get("status") or "unknown"
    confidence = normalized.get("confidence")
    quality: dict[str, Any] = {"status": status}
    if confidence is not None:
        quality["confidence"] = confidence
    local_row = {
        "record_id": normalized["record_id"],
        "device_id": normalized["device_id"],
        "timestamp": normalized["ts"],
        "sequence": normalized.get("seq") or 0,
        "source_type": _source_type(frame),
        "telemetry": normalized["local_telemetry"],
        "quality": quality,
    }
    if normalized.get("person_id"):
        local_row["person_id"] = normalized["person_id"]
    return {
        "kind": kind,
        "device_id": normalized["device_id"],
        "record_id": normalized["record_id"],
        "normalized_at": now or _now_iso(),
        "local_row": local_row,
        "uplink": {
            "endpoint": UPLINK_ENDPOINTS[kind],
            # 外骨骼批量端点接受 frames 数组；其余端点逐帧 POST。
            "batch": kind == FRAME_KIND_EXOSKELETON,
            "payload": normalized["uplink"],
        },
        "issues": list(normalized.get("issues") or []),
    }


__all__ = [
    "FRAME_KIND_ACTUATOR",
    "FRAME_KIND_CAMERA",
    "FRAME_KIND_ENVIRONMENT",
    "FRAME_KIND_EXOSKELETON",
    "FRAME_KIND_LOCATION",
    "SUPPORTED_FRAME_KINDS",
    "UPLINK_ENDPOINTS",
    "FrameContractError",
    "detect_frame_kind",
    "normalize_frame",
]
