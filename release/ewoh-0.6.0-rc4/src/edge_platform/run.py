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
    ctx = server.Context(
        storage, bus=bus, pipeline=pipeline, registry=registry, rules=rules, manager=manager, metrics=metrics
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
