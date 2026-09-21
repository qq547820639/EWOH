"""Config 驱动的适配器工厂（NO-03c / E-03 修复）。

E-03（走读 08-14 发现）：生产装配从不 register 任何适配器——run.py 只 start
manager/pipeline，真实模式遥测永不产生（链路性失效）。本模块提供 config 驱动
的注册入口：`build_adapters(settings.adapters)` 按 kind 分派构造适配器实例，
run.py 注册后启动；启动即输出每适配器 health，/api/status 暴露 ingest_chain
（ok = 已注册且有 healthy 适配器，无注册如实 false）。

Spec 语义（EWOH_ADAPTERS，JSON 列表，每项含 kind + 参数）：
- ny_exo_a1：{kind, deviceId 必填, sourceType, workerId, firmwareVersion,
  tzOffsetHours} → NyExoA1Adapter
- ny_exo_a1_tcp：同上 + {listenHost, listenPort} → NyExoA1TcpAdapter
  （G8 补链：内层 NyExoA1Adapter + 真实 TCP 接收端，现场显式启用真机/回放接入。
   监听失败/端口占用在装配期抛 ValueError，不静默）
- camera：{kind, cameraId 必填, sourceType} → CameraAdapter（真实驱动基类）
- environment：{kind, sensorId 必填, stationId, sourceType} → EnvSensorAdapter
- mes：{kind, deviceId 必填, sourceType, systemName} → MESAdapter
- agv：{kind, deviceId 必填, sourceType, stationId, model, firmwareVersion,
  lowBatteryPct, batteryPct, tickOnRead} → ActuatorAdapter（执行机构；缺省回环模拟器）
- uwb：需要 beacon/tag 对象图配置，本轮未纳入（未知/未支持 kind fail-closed
  抛 ValueError，绝不静默跳过）

纯 Python 标准库实现。
"""

from __future__ import annotations

from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter

# kind → 构造器 + 必填参数 + 可选参数（白名单，未知参数拒绝——配置错误显式失败）
_ADAPTER_KINDS: dict[str, dict] = {
    "ny_exo_a1": {
        "factory": "edge_platform.edge.adapters.ny_exo_a1.adapter:NyExoA1Adapter",
        "required": ("deviceId",),
        "optional": ("sourceType", "workerId", "firmwareVersion", "tzOffsetHours"),
    },
    # G8：真机/回放接入的 TCP 接收端。与 ny_exo_a1 同参数，外加监听地址/端口；
    # 绑定失败在构造期抛错（fail-closed），不会"启动成功但没在收数据"。
    "ny_exo_a1_tcp": {
        "factory": "edge_platform.edge.device_driver:NyExoA1TcpAdapter",
        "required": ("deviceId",),
        "optional": (
            "sourceType",
            "workerId",
            "firmwareVersion",
            "tzOffsetHours",
            "listenHost",
            "listenPort",
        ),
    },
    "camera": {
        "factory": "edge_platform.edge.adapters.camera.adapter:CameraAdapter",
        "asset_cls": "edge_platform.edge.adapters.camera.adapter:CameraAsset",
        "asset_keys": ("cameraId",),
        "optional": ("sourceType",),
    },
    "environment": {
        "factory": "edge_platform.edge.adapters.environment.adapter:EnvSensorAdapter",
        "asset_cls": "edge_platform.edge.adapters.environment.adapter:EnvSensorAsset",
        "asset_keys": ("sensorId", "stationId"),
        "optional": ("sourceType",),
    },
    "mes": {
        "factory": "edge_platform.edge.adapters.mes.adapter:MESAdapter",
        "required": ("deviceId",),
        "optional": ("sourceType", "systemName"),
    },
    # NO-59b：执行机构（AGV/PLC）。缺省用确定性回环模拟器（无硬件也能跑通命令→状态→回执）；
    # 真机接入时把 transport 换成 Modbus/OPC-UA/厂商 API 实现即可，本工厂参数不变。
    "agv": {
        "factory": "edge_platform.edge.adapters.actuator.adapter:ActuatorAdapter",
        "required": ("deviceId",),
        "optional": (
            "sourceType",
            "stationId",
            "model",
            "firmwareVersion",
            "lowBatteryPct",
            "batteryPct",
            "tickOnRead",
        ),
    },
}

# 构造参数名（spec）→ 适配器构造参数名
_IDENTITY_KEYS = ("deviceId", "cameraId", "sensorId")
_KWARG_MAP = {
    "deviceId": "device_id",
    "cameraId": "camera_id",
    "sensorId": "sensor_id",
    "stationId": "station_id",
    "sourceType": "source_type",
    "workerId": "worker_id",
    "firmwareVersion": "firmware_version",
    "tzOffsetHours": "tz_offset_hours",
    "listenHost": "host",
    "listenPort": "port",
    "systemName": "system_name",
    "model": "model",
    "lowBatteryPct": "low_battery_pct",
    "batteryPct": "battery_pct",
    "tickOnRead": "tick_on_read",
}


def _import_factory(ref: str):
    """按 'module:Class' 延迟导入构造器（导入失败/符号缺失均显式抛错）。"""
    module_name, class_name = ref.split(":", 1)
    import importlib

    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise ValueError(f"适配器模块导入失败 {module_name}: {exc}") from exc
    cls = getattr(module, class_name, None)
    if cls is None:
        raise ValueError(f"适配器模块缺少类 {class_name}: {module_name}")
    return cls


def build_adapters(spec: list[dict[str, Any]]) -> list[BaseAdapter]:
    """按 spec 构造适配器实例列表（fail-closed：未知 kind/参数/构造失败均抛错）。

    spec 项格式：{"kind": <registered>, <params...>}；未知参数拒绝
    （配置错误显式失败，避免拼写错误被静默吞掉）。
    """
    adapters: list[BaseAdapter] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(spec):
        if not isinstance(item, dict):
            raise ValueError(f"EWOH_ADAPTERS[{index}] 必须是对象，实际: {type(item).__name__}")
        kind = item.get("kind")
        meta = _ADAPTER_KINDS.get(kind)
        if meta is None:
            raise ValueError(
                f"EWOH_ADAPTERS[{index}] 未知/未支持适配器 kind: {kind!r}"
                f"（已注册: {', '.join(sorted(_ADAPTER_KINDS))}）"
            )
        allowed = set(meta.get("required", ())) | set(meta.get("asset_keys", ())) | set(meta["optional"])
        unknown = [k for k in item if k != "kind" and k not in allowed]
        if unknown:
            raise ValueError(
                f"EWOH_ADAPTERS[{index}] kind={kind} 未知参数: {', '.join(sorted(unknown))}"
            )
        for field in meta.get("required", ()) + meta.get("asset_keys", ()):
            if not item.get(field):
                raise ValueError(f"EWOH_ADAPTERS[{index}] kind={kind} 缺少必填参数: {field}")
        identity_key = next((key for key in _IDENTITY_KEYS if item.get(key)), None)
        identity = str(item.get(identity_key)) if identity_key else ""
        if identity in seen_ids:
            raise ValueError(
                f"EWOH_ADAPTERS[{index}] 设备标识重复: {identity!r}"
                "（Manager 按标识路由命令，重复标识会导致数据/命令归属歧义）"
            )
        if identity:
            seen_ids.add(identity)
        cls = _import_factory(meta["factory"])
        kwargs = {
            _KWARG_MAP[k]: v
            for k, v in item.items()
            if k != "kind" and k not in (meta.get("asset_keys") or ())
        }
        if meta.get("asset_cls"):
            asset_cls = _import_factory(meta["asset_cls"])
            asset_kwargs = {_KWARG_MAP[k]: item[k] for k in meta["asset_keys"]}
            if "sourceType" in item and "source_type" not in asset_kwargs:
                asset_kwargs["source_type"] = item["sourceType"]
            kwargs["asset"] = asset_cls(**asset_kwargs)
        try:
            adapters.append(cls(**kwargs))
        except Exception as exc:
            raise ValueError(f"EWOH_ADAPTERS[{index}] kind={kind} 构造失败: {exc}") from exc
    return adapters


__all__ = ["build_adapters"]
