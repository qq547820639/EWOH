"""环境传感器适配器包。

提供 EnvSensorAsset 资产、EnvSensorAdapter 基类与 SimulatedEnvSensorAdapter 模拟实现，
以及 protocol.parse_env_reading 厂商读数解析为统一语义环境读数。
"""

from edge_platform.edge.adapters.environment.adapter import (
    EnvSensorAdapter,
    EnvSensorAsset,
    SimulatedEnvSensorAdapter,
)
from edge_platform.edge.adapters.environment.protocol import parse_env_reading

__all__ = [
    "EnvSensorAsset",
    "EnvSensorAdapter",
    "SimulatedEnvSensorAdapter",
    "parse_env_reading",
]
