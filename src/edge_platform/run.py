#!/usr/bin/env python3
"""EWOH 平台入口：按 RuntimeMode 装配运行时（P0-EDGE-001/002）。

运行模式（EWOH_RUNTIME_MODE，默认 development）：
- production：只允许真实组件；真实装配失败 → log ERROR + 退出非零；
  绝不允许回退 stub / simulator。
- development：默认真实组件；需要 stub 必须显式配置 EWOH_ALLOW_STUB=1。
- simulation：显式 stub + simulator（--stub 等价）。

用法：
  python -m edge_platform.run [--host 127.0.0.1] [--port 8765] [--db demo.db] [--stub]
"""

import argparse
import os
import sys
from pathlib import Path

# 启动日志即时可见：非交互终端下 stdout 默认块缓冲，会让 make run 看似没有任何输出
try:
    sys.stdout.reconfigure(line_buffering=True)
except (AttributeError, ValueError):
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 支持 python src/edge_platform/run.py 直接运行

from edge_platform import server
from edge_platform.config import Settings
from edge_platform.monitoring import MetricsCollector
from edge_platform.runtime.bootstrap import (
    RuntimeFactory,
    resolve_runtime_mode,
)


def build_components(db_path, force_stub, adapter_ports, metrics):
    """按运行模式装配 Edge 运行时组件（真实组件优先，禁止静默 stub）。

    返回 (components, mode)：
    - components：RuntimeComponents（含 storage/bus/pipeline/.../simulator）
    - mode：production/development/simulation
    """

    mode = resolve_runtime_mode(force_simulation=force_stub)
    factory = RuntimeFactory(db_path=db_path, adapter_ports=adapter_ports, metrics=metrics)
    components = factory.assemble(mode)
    return components, mode


# ---- P0-SCHED-OWNERSHIP 13.1：production 写禁止（fail-closed）----
# 运行模式取自 EWOH_RUNTIME_MODE（见 edge_platform.runtime.bootstrap.resolve_runtime_mode）；
# EWOH_EDGE_SCHEDULING_WRITE=1 仅允许在显式非生产模式（development/test/simulation）生效。
SCHEDULING_WRITE_ALLOWED_MODES = ("simulation", "development", "test")


class SchedulingWriteProhibitedError(RuntimeError):
    """production 下显式开启调度写权限被拒绝（fail-closed 配置错误）。"""


def scheduling_write_allowed_in_mode(mode: str) -> bool:
    """EWOH_EDGE_SCHEDULING_WRITE=1 是否允许在当前运行模式生效。"""
    return (mode or "").strip().lower() in SCHEDULING_WRITE_ALLOWED_MODES


def ensure_scheduling_write_permitted(mode: str) -> None:
    """production（非 simulation/development/test）+ EWOH_EDGE_SCHEDULING_WRITE=1 → 启动即报错。

    不静默降级为 advisory：配置错误必须显式失败，避免 operator 误以为写权限已生效。
    """
    if os.environ.get("EWOH_EDGE_SCHEDULING_WRITE") == "1" and not scheduling_write_allowed_in_mode(mode):
        raise SchedulingWriteProhibitedError(
            f"EWOH_EDGE_SCHEDULING_WRITE=1 被拒绝（runtime mode={mode or 'production'}）："
            "正式调度写权限归 NestJS 控制面，Edge 在 production 下禁止写入调度数据（fail-closed）。"
            "EWOH_EDGE_SCHEDULING_WRITE=1 仅允许 development/test/simulation 模式使用。"
        )


def build_scheduler(storage, repository, event_bus, mode="production", advisory_only=True):
    """装配智能调度闭环组件（Phase 3/5/6 接线，保持既有实现）。

    返回 (scheduler, resource_state_service)：
    - WorldStateService：聚合数据构建世界状态快照；
    - RoutePlanner：有拓扑走 GraphRoutePlanner，无拓扑退化 Euclidean；
    - ReservationService：资源预约与冲突检测；
    - Planner：Top-K 影子方案（GreedyOptimizer 实现）；
    - SchedulerService：请求→快照→生成→确认→派工→反馈闭环；
    - ResourceStateService：统一实时资源状态（GET /api/resources/state）。

    Ownership（P0-SCHED-OWNERSHIP）：
    - connected production / development 默认：advisory_only=True —— Edge 只产出
      advisory 建议，confirm/execute/replan/写库被拒绝，正式调度写权限唯一归
      NestJS 控制面（避免 split-brain / double dispatch / policy divergence）；
    - simulation：advisory_only=False —— 允许 Edge 完整模拟闭环；
    - 显式 EWOH_EDGE_SCHEDULING_WRITE=1（仅限 development/test/simulation/本地联调）
      可强制可写；production + EWOH_EDGE_SCHEDULING_WRITE=1 → fail-closed 抛
      SchedulingWriteProhibitedError（不允许静默降级，见 ensure_scheduling_write_permitted）。
    """
    import os

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

    effective_advisory = bool(advisory_only)
    # 13.1 fail-closed：production（非 simulation/development/test）+ EWOH_EDGE_SCHEDULING_WRITE=1
    # → 启动即抛配置错误，禁止静默降级为 advisory（正式调度写权限归 NestJS 控制面）。
    ensure_scheduling_write_permitted(mode)
    if mode == "simulation":
        effective_advisory = False
    elif os.environ.get("EWOH_EDGE_SCHEDULING_WRITE") == "1":
        effective_advisory = False

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
        advisory_only=effective_advisory,
    )
    resource_state_service = ResourceStateService()
    if effective_advisory:
        print(
            "[EWOH] 调度 ownership: Edge 仅 advisory（connected production，"
            "正式调度写权限归 NestJS 控制面）"
        )
    return scheduler, resource_state_service


def main():
    settings = Settings.load()
    ap = argparse.ArgumentParser(description="EWOH 平台服务")
    ap.add_argument("--host", default=settings.host)
    ap.add_argument("--port", type=int, default=settings.port)
    ap.add_argument("--db", default=settings.db_path)
    ap.add_argument("--stub", action="store_true", help="等价 EWOH_RUNTIME_MODE=simulation（显式 stub）")
    args = ap.parse_args()
    # Task 33：创建可注入 MetricsCollector 单例，传入 pipeline 与 server
    metrics = MetricsCollector()
    components, mode = build_components(args.db, args.stub, settings.adapter_ports, metrics)
    # 13.1：production 下禁止调度写（fail-closed）——在构造任何可写仓储之前即拒绝启动。
    ensure_scheduling_write_permitted(mode)
    storage = components.storage
    bus = components.bus
    pipeline = components.pipeline
    registry = components.registry
    rules = components.rules
    manager = components.manager
    sim = components.simulator

    # NO-03b：边缘本地认知层持久化（离线重启恢复）——世界状态 + 实体声明 + 因果
    # 事件整体落盘 JSON；加载失败显式 ERROR（本地认知可由云端权威投影 reconcile
    # 重建），保存失败显式 ERROR（绝不静默吞异常）。
    world_store = components.world_store
    world_state_path = str(Path(args.db).with_suffix(".worldstate.json"))
    if world_store is not None and Path(world_state_path).exists():
        try:
            import json as _json

            with open(world_state_path, encoding="utf-8") as fh:
                world_store = type(world_store).from_dict(_json.load(fh))
            print(f"[EWOH] 本地世界状态已恢复: {world_state_path}")
        except Exception as exc:  # 显式记录，不静默吞
            print(f"[EWOH] ERROR: 本地世界状态恢复失败（以空认知启动）: {exc}")

    # storage 就绪后绑定到 collector，用于 snapshot() 派生 db_counts / open_event_count
    metrics.bind_storage(storage)

    # v0.7 修复（走读发现）：真实模式（production/development）下适配器采集与推理管线
    # 从未启动 —— manager.start()/pipeline.start() 仅在 simulation 路径被调用，
    # 导致遥测→推理→事件闭环静默失效（数据只读不增）。此处显式启动：
    # - manager.start()：启动已注册适配器的后台读取线程（写 storage + bus）；
    # - pipeline.start()：订阅 STREAM_TELEMETRY，启动推理/规则/事件链路。
    # 真实装配下启动失败 → fail-fast（不静默降级，与 production 装配语义一致）。
    if mode != "simulation":
        # NO-03c（E-03 修复）：config 驱动的适配器注册入口——EWOH_ADAPTERS 指定
        # kind+参数；未知 kind/参数/构造失败 fail-closed 抛错（绝不静默跳过设备）。
        from edge_platform.edge.adapter_factory import build_adapters

        adapters = build_adapters(settings.adapters)
        for adapter in adapters:
            manager.register(adapter)
        print(f"[EWOH] 适配器注册: {len(adapters)} 个（EWOH_ADAPTERS）")
        if hasattr(manager, "start") and callable(manager.start):
            manager.start()
        if hasattr(pipeline, "start") and callable(pipeline.start):
            pipeline.start()
        # 启动即输出每适配器 health（E-03 防"真实模式空转"无感）
        try:
            for entry in manager.health() or []:
                print(
                    "[EWOH] adapter health: device=%s type=%s status=%s",
                    entry.get("device_id"),
                    entry.get("type"),
                    entry.get("status"),
                )
        except Exception:
            print("[EWOH] adapter health 汇总失败（详见日志）")
        print("[EWOH] 真实模式：适配器采集与推理管线已启动")

    # 智能调度持久化仓储：调度数据落库，服务重启后不丢失（Phase 2，API 接线留到 Phase 6）。
    # P0-SCHED-OWNERSHIP：connected production（production/development）下仓储只读
    # （readonly=True）——Edge 不得写正式 plan/task/assignment/reservation；
    # simulation 模式（或 EWOH_EDGE_SCHEDULING_WRITE=1，且非 production——production 下
    # 该变量已在 ensure_scheduling_write_permitted fail-closed 拒绝）才启用完整写。
    scheduling_repository = None
    repository_readonly = mode != "simulation" and os.environ.get(
        "EWOH_EDGE_SCHEDULING_WRITE"
    ) != "1"
    try:
        from edge_platform.scheduler.repository import SchedulingRepository

        scheduling_repository = SchedulingRepository(storage, readonly=repository_readonly)
    except ImportError:
        scheduling_repository = None
    # Phase 5：实时事件总线（支撑 SSE /api/command-map/stream）
    from edge_platform.scheduler.events import EventBus

    event_bus = EventBus()
    # Phase 3/6：装配智能调度闭环服务 + 统一资源状态服务
    # （advisory_only 由 build_scheduler 依据 mode/环境变量解析）
    scheduler, resource_state_service = build_scheduler(
        storage, scheduling_repository, event_bus, mode=mode
    )
    # P1（上线验收发现）：从 repository 恢复已持久化的调度状态（approved plan 等），
    # 使进程重启后调度闭环可继续，而不是丢失内存态。
    if scheduling_repository is not None:
        scheduler.hydrate_from_repository()
    # Task 6.3：注册调度服务到旧接口 Adapter（services.recommend/confirm_assignment）
    from edge_platform import services

    services.register_scheduler_hook(scheduler)
    # NO-03c：遥测 → 世界模型自动投影（感知自动接线）——配置驱动（EWOH_WORLD_TENANT_ID/
    # EWOH_WORLD_FACTORY_ID/EWOH_WORLD_KIND_MAP），缺配置显式关闭并打印原因（绝不猜测
    # 实体类别）；启用后订阅 STREAM_TELEMETRY 后台投影声明/状态/因果事件。
    world_projection = None
    if world_store is not None:
        from edge_platform.world_model.projection import TelemetryWorldProjector

        world_projection = TelemetryWorldProjector(
            world_store,
            bus,
            tenant_id=settings.world_tenant_id,
            factory_id=settings.world_factory_id,
            kind_map=settings.world_kind_map,
            storage=storage,
        )
        if world_projection.enabled:
            world_projection.start()
            print(
                "[EWOH] 遥测→世界模型投影已启用"
                f"（kind_map={settings.world_kind_map}）"
            )
        else:
            print(
                "[EWOH] 遥测→世界模型投影未启用（需 EWOH_WORLD_TENANT_ID / "
                "EWOH_WORLD_FACTORY_ID / EWOH_WORLD_KIND_MAP；绝不猜测实体类别）"
            )
    # NO-04b：Edge→Cloud 事件上行（Catalog 信封批量上行 + 离线缓冲）。
    # EWOH_EVENT_UPLINK_URL 为空 = 显式关闭（启动打印原因，不静默）。
    event_uplink = None
    if settings.event_uplink_url:
        from edge_platform.edge.bridge.event_uplink import EventUplink

        event_uplink = EventUplink(
            bus,
            settings.event_uplink_url,
            ingest_key=settings.event_uplink_key,
            org_id=settings.event_uplink_org_id,
            # NO-04c：断点续传队列（未发送信封跨重启保留，发送成功即截断）
            queue_path=str(Path(args.db).with_suffix(".uplink-queue.json")),
        )
        event_uplink.start()
        print(f"[EWOH] 事件上行已启用 → {settings.event_uplink_url}/api/ingest/events")
    else:
        print("[EWOH] 事件上行未启用（需 EWOH_EVENT_UPLINK_URL）")
    # NO-12d：Edge→Cloud 指标上行（周期快照，ADR-028）。
    # EWOH_METRICS_UPLINK_URL 为空 = 显式关闭（启动打印原因，不静默）。
    metrics_uplink = None
    if settings.metrics_uplink_url:
        from edge_platform.edge.bridge.metrics_uplink import MetricsUplink

        metrics_uplink = MetricsUplink(
            metrics,
            settings.metrics_uplink_url,
            ingest_key=settings.metrics_uplink_key,
            org_id=settings.metrics_uplink_org_id,
            edge_id=settings.edge_id,
            interval_sec=settings.metrics_uplink_interval_sec,
        )
        metrics_uplink.start()
        print(
            f"[EWOH] 指标上行已启用 → {settings.metrics_uplink_url}/api/observability/edge-metrics"
            f"（edge_id={settings.edge_id}，周期 {settings.metrics_uplink_interval_sec}s）"
        )
    else:
        print("[EWOH] 指标上行未启用（需 EWOH_METRICS_UPLINK_URL）")
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
        world_store=world_store,
        world_projection=world_projection,
        event_uplink=event_uplink,
        metrics_uplink=metrics_uplink,
    )
    httpd = server.build_server((args.host, args.port), ctx)
    print(f"[EWOH] 平台运行于 http://{args.host}:{int(args.port)} （无公网依赖，可离线演示）")
    print(f"[EWOH] runtime mode: {mode}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        if world_store is not None:
            try:
                import json as _json
                import os as _os

                # P1（2026-08-19 审计）：原子写（tmp + rename）——直接以 "w" 打开
                # 目标文件时，持久化中途崩溃（断电/OOM）会留下截断的半份 JSON，
                # 下次启动加载即损坏。与 event_uplink._persist 同款模式。
                _tmp = f"{world_state_path}.tmp"
                with open(_tmp, "w", encoding="utf-8") as fh:
                    _json.dump(world_store.to_dict(), fh, ensure_ascii=False)
                _os.replace(_tmp, world_state_path)
                print(f"[EWOH] 本地世界状态已持久化: {world_state_path}")
            except Exception as exc:  # 显式记录，不静默吞
                print(f"[EWOH] ERROR: 本地世界状态持久化失败: {exc}")
        if sim:
            sim.stop()
        manager.stop()
        print("[EWOH] 已停止")


if __name__ == "__main__":
    main()
