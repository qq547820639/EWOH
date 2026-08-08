"""Edge Runtime 组件契约（Protocol）。

所有生产组件必须满足这里声明的接口；测试替身（stubs）与生产组件共用同一契约，
防止"测试环境 import path 与真实启动路径不同"再次导致生产装配漂移。
"""

from __future__ import annotations

from typing import Any, Callable, Protocol, runtime_checkable

#: 流（Stream）名称常量——唯一 StreamName 定义（P0-EDGE-004）。
#: 业务代码不得使用裸字符串 topic，统一引用此处。
STREAM_TELEMETRY = "telemetry"
STREAM_STATE = "state"
STREAM_EVENTS = "events"
STREAM_ASSETS = "assets"
STREAM_INFERENCE = "inference"
STREAM_DEVICE_STATUS = "device_status"
STREAM_WORLD_STATE = "world_state"

#: 真实 MessageBus 支持的全部流。新增生产流必须先在此登记（装配 smoke test 校验）。
ALL_STREAMS: tuple[str, ...] = (
    STREAM_TELEMETRY,
    STREAM_STATE,
    STREAM_EVENTS,
    STREAM_ASSETS,
    STREAM_INFERENCE,
    STREAM_DEVICE_STATUS,
    STREAM_WORLD_STATE,
)

#: 消息信封最小字段（用于可观测性与追踪）。
REQUIRED_ENVELOPE_FIELDS = ("ts",)


@runtime_checkable
class EventBusProtocol(Protocol):
    """统一事件总线契约（P0-EDGE-003）。

    正式契约（handler 回调语义）：
      publish(stream, message)          -> None
      subscribe(stream, handler)        -> subscription_id (str)
      unsubscribe(stream, subscription_id) -> bool
      tail(stream, n)                   -> list[message]
    所有调用方（Inference / Event Engine / Scheduler / World Model / Test）必须
    使用同一契约，禁止部分调用方假设 queue 语义、部分假设 handler 语义。
    """

    def publish(self, stream: str, message: dict) -> None: ...

    def subscribe(self, stream: str, handler: Callable[[dict], None]) -> str: ...

    def unsubscribe(self, stream: str, subscription_id: str) -> bool: ...

    def tail(self, stream: str, n: int) -> list[dict]: ...


@runtime_checkable
class StorageProtocol(Protocol):
    """持久层契约（SQLite）。"""

    def init_db(self) -> None: ...

    def insert_telemetry(self, msg: dict) -> None: ...

    def latest_telemetry(self, device_id: str) -> dict | None: ...

    def query_telemetry(self, device_id: str, start: str, end: str, limit: int) -> list: ...

    def insert_inference(self, res: dict) -> None: ...

    def insert_event(self, evt: dict) -> None: ...

    def list_events(self, limit: int) -> list: ...

    def list_devices(self) -> list: ...

    def list_people(self) -> list: ...

    def counts(self) -> dict: ...


@runtime_checkable
class AdapterManagerProtocol(Protocol):
    """设备适配器生命周期管理契约。"""

    def start(self) -> None: ...

    def stop(self) -> None: ...


@runtime_checkable
class RuleEngineProtocol(Protocol):
    """规则引擎契约（on_telemetry / on_offline / on_recover / on_inference）。"""

    def on_telemetry(self, msg: dict) -> list: ...

    def on_offline(self, device_id: str, ts: str) -> dict | None: ...

    def on_recover(self, device_id: str, ts: str) -> None: ...

    def on_inference(self, res: dict) -> list: ...


@runtime_checkable
class InferencePipelineProtocol(Protocol):
    """推理管线契约。"""

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def handle_telemetry(self, msg: dict) -> dict | None: ...

    def handle_device_status(self, msg: dict) -> None: ...

    def metrics(self) -> dict: ...


@runtime_checkable
class ModelRegistryProtocol(Protocol):
    """模型注册表契约。"""

    def active(self) -> Any: ...

    def versions(self) -> list: ...

    def activate(self, version: str) -> None: ...

    def rollback(self) -> None: ...
