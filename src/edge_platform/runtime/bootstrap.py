"""RuntimeMode 与 RuntimeFactory（P0-EDGE-002：Production 禁止 Silent Stub）。

运行模式（环境变量 EWOH_RUNTIME_MODE，默认 development）：

- production：只允许真实组件；任何真实装配错误必须：
    * log ERROR
    * 进程退出非零
    * 绝不回退 stub / simulator
- development：默认真实组件；如需 stub 必须显式配置（EWOH_ALLOW_STUB=1 或 --stub）。
- simulation：显式运行 Stub/Simulator（仅工程自测/演示）。

历史兼容：
- 旧 `--stub` 参数等价于 `EWOH_RUNTIME_MODE=simulation`（显式）；
- 旧行为「ImportError 后自动回退 stub」在 development/production 下被移除：
  真实装配失败在 development 下抛异常（除非显式 EWOH_ALLOW_STUB=1），
  production 下抛异常并退出非零。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger("ewoh.runtime")

RUNTIME_MODE_ENV = "EWOH_RUNTIME_MODE"
ALLOW_STUB_ENV = "EWOH_ALLOW_STUB"

MODE_PRODUCTION = "production"
MODE_DEVELOPMENT = "development"
MODE_SIMULATION = "simulation"

VALID_MODES = (MODE_PRODUCTION, MODE_DEVELOPMENT, MODE_SIMULATION)


def resolve_runtime_mode(force_simulation: bool = False) -> str:
    """解析运行模式。

    - ``--stub`` 或 ``EWOH_RUNTIME_MODE=simulation`` → simulation（显式）；
    - ``EWOH_RUNTIME_MODE=production`` → production；
    - 其他（含未设置）→ development（默认真实组件）。
    """
    if force_simulation:
        return MODE_SIMULATION
    raw = (os.environ.get(RUNTIME_MODE_ENV) or "").strip().lower()
    if raw in VALID_MODES:
        return raw
    return MODE_DEVELOPMENT


def allow_stub_explicitly() -> bool:
    """development 模式下是否显式允许 stub（EWOH_ALLOW_STUB=1）。"""
    return (os.environ.get(ALLOW_STUB_ENV) or "").strip().lower() in ("1", "true", "yes")


@dataclass
class RuntimeComponents:
    """一次装配的运行时组件集合。"""

    mode: str
    storage: object = None
    bus: object = None
    registry: object = None
    rules: object = None
    pipeline: object = None
    manager: object = None
    simulator: object = None  # 仅 simulation 模式非空
    is_simulation: bool = False
    warnings: list = field(default_factory=list)

    @property
    def real_components(self) -> dict:
        """真实组件快照（用于装配 smoke test 断言：不得存在 stub 组件）。"""
        return {
            "storage": self.storage,
            "bus": self.bus,
            "registry": self.registry,
            "rules": self.rules,
            "pipeline": self.pipeline,
            "manager": self.manager,
        }


class RuntimeFactory:
    """按 RuntimeMode 装配 Edge 运行时。"""

    def __init__(self, db_path, adapter_ports=None, metrics=None, models_dir=None):
        self.db_path = str(db_path)
        self.adapter_ports = dict(adapter_ports or {})
        self.metrics = metrics
        self.models_dir = models_dir

    # ---- 装配 ----
    def assemble(self, mode: str) -> RuntimeComponents:
        if mode == MODE_SIMULATION:
            return self._assemble_simulation()
        if mode == MODE_PRODUCTION:
            return self._assemble_production()
        return self._assemble_development()

    def _assemble_production(self) -> RuntimeComponents:
        """production：真实组件唯一，失败即抛异常（调用方负责 exit non-zero）。"""
        from .dependencies import build_real_components

        logger.info("[EWOH] runtime mode=production: assembling real components")
        comps = build_real_components(
            self.db_path, self.adapter_ports, self.metrics, self.models_dir
        )
        # production 下不启动 simulator（P0-SEC-002 对应 edge 侧原则）
        return RuntimeComponents(
            mode=MODE_PRODUCTION,
            storage=comps["storage"],
            bus=comps["bus"],
            registry=comps["registry"],
            rules=comps["rules"],
            pipeline=comps["pipeline"],
            manager=comps["manager"],
            is_simulation=False,
        )

    def _assemble_development(self) -> RuntimeComponents:
        """development：默认真实组件；真实装配失败时仅当显式允许才回退 stub。"""
        from .dependencies import RealAssemblyError, build_real_components

        if allow_stub_explicitly():
            logger.warning(
                "[EWOH] runtime mode=development with EWOH_ALLOW_STUB=1: "
                "real components attempted, stub allowed explicitly"
            )
            try:
                comps = build_real_components(
                    self.db_path, self.adapter_ports, self.metrics, self.models_dir
                )
                return RuntimeComponents(
                    mode=MODE_DEVELOPMENT,
                    storage=comps["storage"],
                    bus=comps["bus"],
                    registry=comps["registry"],
                    rules=comps["rules"],
                    pipeline=comps["pipeline"],
                    manager=comps["manager"],
                    is_simulation=False,
                )
            except RealAssemblyError as exc:
                logger.error("real assembly failed (stub allowed explicitly): %s", exc)
                return self._build_stub_components(warn=exc)
        # 默认真实组件；失败即失败，不回退 stub（旧「ImportError 自动回退」已移除）
        try:
            comps = build_real_components(
                self.db_path, self.adapter_ports, self.metrics, self.models_dir
            )
        except RealAssemblyError as exc:
            logger.error(
                "[EWOH] runtime mode=development: real component assembly failed and "
                "stub is NOT allowed (set EWOH_ALLOW_STUB=1 to opt in): %s",
                exc,
            )
            raise
        return RuntimeComponents(
            mode=MODE_DEVELOPMENT,
            storage=comps["storage"],
            bus=comps["bus"],
            registry=comps["registry"],
            rules=comps["rules"],
            pipeline=comps["pipeline"],
            manager=comps["manager"],
            is_simulation=False,
        )

    def _assemble_simulation(self) -> RuntimeComponents:
        """simulation：显式 stub + simulator（仅工程自测/演示）。"""
        logger.warning("[EWOH] runtime mode=simulation: stub components + simulator")
        return self._build_stub_components()

    def _build_stub_components(self, warn=None) -> RuntimeComponents:
        from edge_platform import stubs

        storage = stubs.Storage(self.db_path)
        stubs.seed_base(storage)
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(self.models_dir or (self.db_path and "models"))
        rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
        pipeline = stubs.InferencePipeline(storage, bus, registry, rules, metrics_collector=self.metrics)
        manager = stubs.AdapterManager(storage, bus)
        manager.start()
        sim = stubs.DemoSimulator(storage)
        sim.start()
        warnings = [str(warn)] if warn else []
        return RuntimeComponents(
            mode=MODE_SIMULATION,
            storage=storage,
            bus=bus,
            registry=registry,
            rules=rules,
            pipeline=pipeline,
            manager=manager,
            simulator=sim,
            is_simulation=True,
            warnings=warnings,
        )
