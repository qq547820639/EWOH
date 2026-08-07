#!/usr/bin/env python3
"""EWOH 平台入口：按依赖契约装配真实模块；真实模块未就绪时回退到 stub（仅联调前自测/演示）。

用法：
  python -m edge_platform.run [--host 127.0.0.1] [--port 8765] [--db demo.db] [--stub]
"""

import argparse
import sys
from pathlib import Path

# 启动日志即时可见：非交互终端下 stdout 默认块缓冲，会让 make run 看似没有任何输出
try:
    sys.stdout.reconfigure(line_buffering=True)
except (AttributeError, ValueError):
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 支持 python src/edge_platform/run.py 直接运行

from edge_platform import server, stubs
from edge_platform.config import Settings
from edge_platform.monitoring import MetricsCollector


def build_components(db_path, force_stub, adapter_ports, metrics):
    """优先装配真实 edge/inference/collection 模块；缺失时回退 stub。"""
    if not force_stub:
        try:
            from edge.bus import Bus
            from edge.manager import AdapterManager
            from edge.storage import Storage
            from inference.model import ModelRegistry
            from inference.pipeline import InferencePipeline
            from inference.rules import RuleEngine

            storage = Storage(db_path)
            storage.init_db()
            bus = Bus()
            registry = ModelRegistry(Path(db_path).parent / "models")
            rules = RuleEngine("risk-rule-v0.2", {})
            pipeline = InferencePipeline(storage, bus, registry, rules, metrics_collector=metrics)
            manager = AdapterManager(storage, bus, adapter_ports)
            manager.start()
            pipeline.start()
            print("[EWOH] 真实模块装配完成（适配层+推理管线已启动）")
            return storage, bus, pipeline, registry, rules, manager, None
        except ImportError as e:
            print(f"[EWOH] 真实模块未就绪（{e}），回退到 stub 模式")
    storage = stubs.Storage(db_path)
    stubs.seed_base(storage)
    bus = stubs.Bus()
    registry = stubs.ModelRegistry(Path(db_path).parent / "models")
    rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
    pipeline = stubs.InferencePipeline(storage, bus, registry, rules, metrics_collector=metrics)
    manager = stubs.AdapterManager(storage, bus)
    manager.start()
    sim = stubs.DemoSimulator(storage)
    sim.start()
    print("[EWOH] stub 模式：数据源为 simulated（仅工程自测，不作为真机验收依据）")
    return storage, bus, pipeline, registry, rules, manager, sim


def build_scheduler(storage, repository, event_bus):
    """装配智能调度闭环组件（Phase 3/5/6 接线）。

    返回 (scheduler, resource_state_service)：
    - WorldStateService：聚合数据构建世界状态快照；
    - RoutePlanner：有拓扑走 GraphRoutePlanner，无拓扑退化 Euclidean；
    - ReservationService：资源预约与冲突检测；
    - Planner：Top-K 影子方案（GreedyOptimizer 实现）；
    - SchedulerService：请求→快照→生成→确认→派工→反馈闭环；
    - ResourceStateService：统一实时资源状态（GET /api/resources/state）。
    """
    from edge_platform.scheduler import (
        EffectivePriorityCalculator,
        GreedyOptimizer,
        Planner,
        ReservationService,
        ResourceStateService,
        SchedulerService,
        Scorer,
        ScoringWeights,
        WeightAuditLog,
        WorldStateService,
        build_route_planner,
    )

    world_state_service = WorldStateService()
    # 拓扑：storage 提供 get_topology 则用拓扑路径，否则退化空间距离
    topology = None
    try:
        if hasattr(storage, "get_topology"):
            topology = storage.get_topology()
    except Exception:
        topology = None
    route_planner = build_route_planner(topology)
    reservation_service = ReservationService()
    scorer = Scorer(ScoringWeights(), WeightAuditLog())
    effective_priority_calc = EffectivePriorityCalculator()
    optimizer = GreedyOptimizer(
        planner_route=route_planner,
        scorer=scorer,
        effective_priority_calc=effective_priority_calc,
        weights={},
    )
    planner = Planner(
        optimizer=optimizer,
        route_planner=route_planner,
        world_state_service=world_state_service,
    )
    scheduler = SchedulerService(
        world_state_service=world_state_service,
        planner=planner,
        reservation_service=reservation_service,
        audit=None,
        storage=storage,
        repository=repository,
        event_bus=event_bus,
    )
    resource_state_service = ResourceStateService()
    return scheduler, resource_state_service


def main():
    settings = Settings.load()
    ap = argparse.ArgumentParser(description="EWOH 平台服务")
    ap.add_argument("--host", default=settings.host)
    ap.add_argument("--port", type=int, default=settings.port)
    ap.add_argument("--db", default=settings.db_path)
    ap.add_argument("--stub", action="store_true", help="强制使用 stub（跳过真实模块）")
    args = ap.parse_args()
    # Task 33：创建可注入 MetricsCollector 单例，传入 pipeline 与 server
    metrics = MetricsCollector()
    storage, bus, pipeline, registry, rules, manager, sim = build_components(
        args.db, args.stub, settings.adapter_ports, metrics
    )
    # storage 就绪后绑定到 collector，用于 snapshot() 派生 db_counts / open_event_count
    metrics.bind_storage(storage)
    # 智能调度持久化仓储：调度数据落库，服务重启后不丢失（Phase 2，API 接线留到 Phase 6）
    scheduling_repository = None
    try:
        from edge_platform.scheduler.repository import SchedulingRepository

        scheduling_repository = SchedulingRepository(storage)
    except ImportError:
        scheduling_repository = None
    # Phase 5：实时事件总线（支撑 SSE /api/command-map/stream）
    from edge_platform.scheduler.events import EventBus

    event_bus = EventBus()
    # Phase 3/6：装配智能调度闭环服务 + 统一资源状态服务
    scheduler, resource_state_service = build_scheduler(storage, scheduling_repository, event_bus)
    # Task 6.3：注册调度服务到旧接口 Adapter（services.recommend/confirm_assignment）
    from edge_platform import services

    services.register_scheduler_hook(scheduler)
    ctx = server.Context(
        storage,
        bus=bus,
        pipeline=pipeline,
        registry=registry,
        rules=rules,
        manager=manager,
        metrics=metrics,
        scheduling_repository=scheduling_repository,
        event_bus=event_bus,
        scheduler=scheduler,
        resource_state_service=resource_state_service,
        kafka=event_bus,
    )
    httpd = server.build_server((args.host, args.port), ctx)
    print(f"[EWOH] 平台运行于 http://{args.host}:{int(args.port)} （无公网依赖，可离线演示）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        if sim:
            sim.stop()
        manager.stop()
        print("[EWOH] 已停止")


if __name__ == "__main__":
    main()
