# Week 1 — Edge Runtime + No Silent Stub + Feishu Security

## Finding: P0-EDGE-001 修复 Python Production Runtime 装配

- **Old Evidence**：`run.py:29-34` 使用 `from edge.bus import Bus` 等 6 条顶层 import，
  `src/edge_platform/edge/manager.py`、`edge/storage.py` 不存在；真实 `Storage`/`AdapterManager`
  仅存在于 `stubs.py`。`python run.py` 实测永远打印 `[EWOH] 真实模块未就绪（No module named 'edge'）`。
- **Current Evidence**（修复后）：`edge_platform/runtime/dependencies.py` 按真实路径装配；
  `edge_platform/edge/storage.py`（真实 SQLite Storage，提升自完整实现）、
  `edge_platform/edge/manager.py`（真实 AdapterManager，管理 BaseAdapter 生命周期）。
- **Fix**：
  1. 新建 `edge_platform/runtime/{__init__,protocols,dependencies,bootstrap}.py`；
  2. 提升 Storage 完整实现至 `edge/storage.py`，`stubs.py` 保留兼容引用；
  3. 新建真实 `edge/manager.py` AdapterManager；
  4. `run.py` 改为 `RuntimeFactory` 装配，清除顶层 import。
- **Tests**：`tests/test_production_assembly.py`（5 项）。
- **Result**：`EWOH_RUNTIME_MODE=production python run.py` 实测真实装配成功（rules=risk-rule-v0.2）。

## Finding: P0-EDGE-002 Production 禁止 Silent Stub

- **Fix**：`EWOH_RUNTIME_MODE`（production/development/simulation）+ `EWOH_ALLOW_STUB`；
  production 装配失败抛 `RealAssemblyError`（fail-fast），development 默认真实装配、
  显式 `EWOH_ALLOW_STUB=1` 才允许 stub，simulation 显式 stub。
- **Result**：production 装配失败实测抛错；无任何静默回退路径。

## Finding: P0-EDGE-003 统一 MessageBus 契约（双总线职责，2026-08-09 修订）

- **Fix（原始）**：数据通道唯一正式契约 = handler 回调（`subscribe(stream, handler)->sub_id`）；
  `stubs.Bus` 对齐为同一契约；`InferencePipeline.start()` 改为 handler 语义。
- **双总线职责（2026-08-09 契约修订，P1-1 关闭）**：全仓存在两条职责不同的总线，
  均属正式契约，按通道类型选择语义：
  1. `MessageBus`（`edge/bus.py`）：**流式数据通道**，`publish/subscribe(stream, handler)`
     回调语义——承载遥测/推理数据流（STREAM_* 常量，见 P0-EDGE-004）。
  2. `SchedulerEventBus`（`edge/scheduler/events.py`）：**调度事件 SSE 广播通道**，
     queue 语义（多个 SSE 连接各自消费；慢消费者丢弃最旧事件不阻塞发布者）；
     `kafka` 为历史兼容命名别名（`run.py` 注入 `kafka=event_bus`，`server.py`
     `self.kafka = kafka if kafka is not None else event_bus`），并非独立第三方消息系统。
  3. 云侧 `OutboxService`（ewoh-spark-app）：可靠领域事件（先写后发，outbox 表 +
     DB 序列）不在本契约范围。
  **语义规则**：queue 语义仅允许用于 SSE 广播通道；数据通道必须使用 handler 回调语义。
  禁止在数据流（telemetry/inference/world_state）上使用 queue 语义；禁止在 SSE 广播
  通道上假设 handler 回调。
- **Tests**：`tests/test_bus_contract.py`（含 stub/real 契约一致性）。

## Finding: P0-EDGE-004 统一 Stream / Topic

- **Fix**：`runtime/protocols.py` 定义 `STREAM_*` 常量与 `ALL_STREAMS`；
  `MessageBus.STREAMS = ALL_STREAMS`（含 inference/device_status/world_state）；
  pipeline/events 统一使用常量；`test_adapters_bus.test_streams` 更新断言。
- **Tests**：`test_all_production_streams_are_supported`。

## Finding: P0-EDGE-005 禁止吞 Bus Subscriber 异常

- **Fix**：`MessageBus.publish` 捕获 handler 异常后 `logger.exception`（stream/sub_id/handler/
  event_id/message keys）+ 计数 `event_bus_handler_errors_total`（MetricsCollector 注入）。
- **Tests**：`test_subscriber_exception_is_observed_not_silent`。

## Finding: P0-EDGE-006 Production Assembly Smoke Test

- **Fix**：`tests/test_production_assembly.py`（不 mock 装配）；`Makefile production-smoke` target。
- **Result**：`make production-smoke` → 11 passed。

## Phase Status

| Command | Exit Code | Result |
| ------- | --------: | ------ |
| `python3 -m unittest discover -s src/edge_platform/tests` | 0 | 731 passed |
| `python3 -m pytest tests/` | 0 | 135 passed, 1 skipped |
| `make production-smoke` | 0 | 11 passed |
| `EWOH_RUNTIME_MODE=production python3 run.py` | 0 | real assembly |
| `ruff check`（改动文件） | 0 | All checks passed |

## Remaining Risks
- `edge_to_spark.py` bridge 仍是独立脚本（真机接入未在本次改动范围，保持原状）。
- 调度/SSE 的 `scheduler/events.py EventBus` 是独立 SSE 事件总线（queue 语义，仅允许
  用于 SSE 广播通道），与 edge MessageBus（handler 语义，数据通道）职责不同，均保留；
  两者边界已在 P0-EDGE-003 契约中明确（见上）。
