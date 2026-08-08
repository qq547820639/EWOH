"""Edge Runtime 真实依赖装配（P0-EDGE-001/002）。

从**真实生产路径**构造组件（不经过 `edge.*` / `inference.*` 顶层别名，
避免测试环境 sys.path 掩盖生产装配失败）：
- Storage：`edge_platform.edge.storage.Storage`（完整 SQLite 实现）；
- MessageBus：`edge_platform.edge.bus.MessageBus`（唯一正式契约，handler 回调）；
- AdapterManager：`edge_platform.edge.manager.AdapterManager`（真实适配器管理）；
- RuleEngine / InferencePipeline / ModelRegistry：`edge_platform.inference.*`。

装配失败必须抛出（raise），由 bootstrap 按 RuntimeMode 决定是否允许回退；
绝不允许在 production 下静默 fallback stub。
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("ewoh.runtime.dependencies")


class RealAssemblyError(RuntimeError):
    """真实组件装配失败（不可静默回退）。"""


def build_storage(db_path):
    """构造真实 SQLite Storage。"""
    from edge_platform.edge.storage import Storage

    storage = Storage(db_path)
    storage.init_db()
    return storage


def build_bus(metrics=None):
    """构造真实 MessageBus（唯一正式契约）。"""
    from edge_platform.edge.bus import MessageBus

    return MessageBus(metrics_collector=metrics)


def build_model_registry(models_dir):
    from edge_platform.inference.model import ModelRegistry

    return ModelRegistry(str(models_dir))


def build_rule_engine():
    from edge_platform.inference.rules import RuleEngine

    return RuleEngine("risk-rule-v0.2", {})


def build_inference_pipeline(storage, bus, registry, rules, metrics=None):
    from edge_platform.inference.pipeline import InferencePipeline

    return InferencePipeline(
        storage,
        bus,
        registry,
        rules,
        metrics_collector=metrics,
    )


def build_adapter_manager(storage, bus, adapter_ports=None):
    from edge_platform.edge.manager import AdapterManager

    return AdapterManager(storage, bus, adapter_ports)


def build_real_components(db_path, adapter_ports=None, metrics=None, models_dir=None):
    """按真实生产路径装配全部 Edge 组件。

    Returns: dict with storage/bus/registry/rules/pipeline/manager.
    Raises: RealAssemblyError on any real-component failure.
    """
    if models_dir is None:
        models_dir = Path(db_path).parent / "models"
    try:
        storage = build_storage(db_path)
        bus = build_bus(metrics=metrics)
        registry = build_model_registry(models_dir)
        rules = build_rule_engine()
        pipeline = build_inference_pipeline(storage, bus, registry, rules, metrics=metrics)
        manager = build_adapter_manager(storage, bus, adapter_ports)
    except Exception as exc:  # noqa: BLE001 - 任何真实装配失败都必须显式暴露
        raise RealAssemblyError(
            f"real edge component assembly failed: {exc!r}"
        ) from exc
    return {
        "storage": storage,
        "bus": bus,
        "registry": registry,
        "rules": rules,
        "pipeline": pipeline,
        "manager": manager,
    }
