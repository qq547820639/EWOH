# 边缘双总线统一与遥测帧对齐技术方案（Batch 8.3/8.4）

> 制定日期：2026-08-08 | 状态：**评估完成，待边缘验收环境实施**
> 结论：边缘 Python 运行时改造风险高（核心数据链），且当前无真机验收环境，
> 本批次输出技术方案与实施步骤，待 `make production-smoke` 可全量验证时执行。

---

## 8.3 双总线统一（走读 H1）

### 现状

| 总线 | 文件 | 语义 | 消费方 |
|------|------|------|--------|
| `edge/bus.py` MessageBus | `src/edge_platform/edge/bus.py` | handler 回调注册式（subscribe(fn) → publish 调用所有 handler） | `run.py` 装配的实时数据链（遥测/推理） |
| `scheduler/events.py` EventBus | `src/edge_platform/scheduler/events.py` | queue 语义（put/get） | SchedulerService 事件驱动 |

两者在 `run.py:140-165` 同时注入 server.Context（`event_bus` 与 `kafka=event_bus` 同一对象），协议声明"唯一正式契约"但实现不一致。

### 方案（收敛到 edge/bus.py 单一契约）

1. **统一接口**：`edge/bus.py` MessageBus 增加 `put(event)`（queue 语义）与 `stream()`（迭代器），兼容两种消费模式
2. **scheduler/events.py 改为薄适配器**：`EventBus` 内部委托 MessageBus，保留 `put/get` 签名（SchedulerService 无感）
3. **契约测试**：`tests/test_bus_contract.py` 扩展双语义断言（handler 回调 + queue 消费）
4. **门禁**：`make production-smoke`（P0-EDGE-006）+ `make test`

### 风险

- 运行时数据链改造，任何语义偏差影响遥测/推理/事件全链路
- 需 `make test`（unittest 全量）+ production-smoke + connector-tck 全绿后才可合入

## 8.4 遥测帧格式对齐（走读 H2）

### 现状

- `edge/exo_semantic.py` UnifiedExoFrame：`entity_id / event_time / pose{...} / load{...}` 分组结构
- `edge/storage.py insert_telemetry`：期望扁平 `device_id / timestamp / telemetry{...} / quality`
- `inference/features.py`：消费扁平信封

三者字段不对齐 → adapter 产出 UnifiedExoFrame 后直连 storage 存在 KeyError 隐患。

### 方案（适配层转换，不重构三端）

1. **新增 `edge/modeling/frame_adapter.py`**（或复用 exo_semantic）：提供 `unified_to_legacy(frame) -> storage_row` 显式映射（含默认值兜底）
2. **manager._read_loop** 在 adapter → storage 之间插入转换（单点修改）
3. **connectors/modbus、opcua** 产出统一帧后走同一转换（消除双轨信封）
4. **契约测试**：`tests/test_edge_backfill.py` / `test_ny_exo_a1_contract.py` 扩展帧映射断言

### 风险

- KeyError 隐患存在于热路径；转换必须纯函数 + 完整字段映射表
- 依赖 8.3 的 bus 统一先落地（同一批验证环境）

---

## 实施前提（Gate）

- [ ] 具备可运行的边缘验收环境（真机/模拟器 + `make production-smoke` 可执行）
- [ ] `make test` + `make production-smoke` + `make connector-tck` 全绿基线已建立
- [ ] 完成后提交独立 commit（`refactor(edge): unify event bus + align telemetry frames`）
