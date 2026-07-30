"""兼容入口：re-export NYExoA1Adapter 等到 edge.adapter 命名空间。

run.py / manager.py 历史导入兼容（from edge.adapter import NYExoA1Adapter）。
真实实现位于 edge.adapters.ny_exo_a1.adapter。
"""
from .adapters.ny_exo_a1.adapter import (
    NYExoA1Adapter, RealClock, ts_to_ms, _online_state, _online_lock)

__all__ = ["NYExoA1Adapter", "RealClock", "ts_to_ms", "_online_state", "_online_lock"]
