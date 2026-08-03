# EWOH 产品定义评审（2026-07-31）

评审对象：用户提供的《工厂具身智能操作系统（Embodied Factory OS）产品定义》（1.1–十七节）
评审基线：仓库 `origin/main` @ `50d7785`（V0.6 受控试点系统活跃开发基线）
评审人：产品负责人（PM 视角）

## 1. 执行摘要

这是一份异常成熟的产品定义（17 节，覆盖产品/原则/架构/3D/数据/算法/UI/治理/改造/路线/团队/基建/验收/风险/30天/预算/边界）。最突出的优点是**文档驱动开发已经落地**——第九章「仓库改造建议」的目录树与当前 `src/edge_platform/` 几乎一一对应，`docs/`、`ui/command_map/` 也按建议清单建立。

整体结论：**战略清晰、架构自洽、执行纪律强**；三处待修：(1) 文档个别章节存在编号/文字残损（仅存在于未提交草稿，仓库活动文档已干净）；(2) 验收文档点名 WebSocket，实现为 1s 轮询，存在文档-实现偏差；(3) 「可插拔接口 + 零依赖」目前仅写在 `bus.py` docstring，未上升为架构硬约束，有回归风险。

## 2. 架构九层 ↔ 仓库现状对照

| 层 | spec 章节 | 现有仓库模块 | 状态 |
| --- | --- | --- | --- |
| 3.1 设备与现场层 | 3.1 | `edge/adapters/{ny_exo_a1,uwb,camera,environment,mes}` | ✅ 适配器+样例 fixture 就绪 |
| 3.2 边缘适配层 | 3.2 | `edge/{base,bus,exo_semantic}.py` + adapters | ✅ 协议/身份/心跳/质量/来源隔离 |
| 3.3 流处理层 | 3.3 | `edge/bus.py`（进程内 pub/sub+环形缓冲） | ✅ 参考实现 ⚠️ 实为轮询非 WS |
| 3.4 空间数字底座 | 3.4 | `spatial/{coordinate,entities,topology,asset_registry,multi_factory}` | ✅ 坐标系/实体/拓扑/资产/多厂 |
| 3.5 感知融合层 | 3.5 | `perception/{uwb_fusion,vision_adapter,pose_fusion,quality}` | ✅ 框架（含 `degrade_on_camera_lost`） |
| 3.6 世界模型层 | 3.6 | `world_model/{state_store,event_graph,prediction,replay}` | ✅ 四模块齐全可导入 |
| 3.7 决策与调度层 | 3.7 | `scheduler/{constraints,candidate,scoring,explanation,appeal,learning_loop,orchestrator}` | ✅ 框架 |
| 3.8 场景仿真层 | 3.8 | `scenario/{simulator,metrics,comparison}` | ✅ 框架 |
| 3.9 指挥地图与本地助手 | 3.9 | `ui/command_map/*` + `assistant/local_llm` | ✅ 九页骨架 + 助手白名单 |

九层全部有对应模块，对齐度极高；多数处于「框架 + stub/样例」态，真机接入、实景标定、现场数据尚未触及。

## 3. 详细链式分析

**A. 对齐度**——文档第九章目录树 ↔ `src/edge_platform` 基本一致，`docs/`、`ui/command_map/` 按清单建立。执行力强。

**B. 架构决策质量**——`bus.py` 用可插拔接口化解零依赖矛盾（进程内 `threading.Lock + deque` 参考实现，生产同接口换 Redis/NATS/Postgres），是成熟做法；但该规则仅存在于 docstring，未写成架构硬约束，也无 CI 守护（已通过 P0-1 补充）。

**C. 验收 vs 实现偏差**——验收指标表 L11 原写「WebSocket 推送」，实现是 `ui` 侧 `setInterval(CM.tick,1000)` 轮询。功能上 ≤2s 已满足（单节点试点足够），但措辞会误导评审/采购；已改为「V0.6 为 1s HTTP 轮询，V0.8 引入 SSE，规模化再 WebSocket」。

**D. 功能缺口（路线图阶段态）**——当前多为框架+样例；真机契约测试（`ny_exo_a1` 有 fixture 待真机）、实景标定（CAD/扫描/UWB/摄像头内参）、现场数据均属阶段 1–2 待办。调度/仿真/世界模型骨架已可运行，权重配置与多目标优化需阶段 3–4 填充。

**E. 安全边界**——`server.py` 不提供安全控制写入；`Context.assignments` 仅人工确认派工；`scheduler.execute` 仅 `CONFIRMED` 可执行；`consent` 模块存在。代码级审计见 `docs/operations/security_boundary_audit.md`，结论：安全边界在代码层成立。

**F. 文档缺陷（仅存在于用户未提交草稿，仓库活动文档已干净）**——见第 4 节修订清单。

## 4. 草稿文档修订清单（供作者回填）

| 位置 | 缺陷 | 修正 |
| --- | --- | --- |
| 3.3 节标题 | 写成「流处理层」，缺编号 | 改为「### 3.3 流处理层」 |
| 5.3 节 | 悬空片段「：受控动作」，批次 A 标签丢失 | 补全为「批次A：受控动作（12—20 人，在安全环境中采集标准动作、不同重量、不同台面高度和不同助力等级）」 |
| 开头「术架构」 | 「三、技术架构」标题截断为「术架构」 | 恢复「### 三、技术架构」 |
| 5.1 节 | 「  -任务进度；」缩进错位 | 调整为与同层列表一致的缩进 |

## 5. 已执行的 P0 行动

- **P0-1 架构护栏**：`docs/architecture/embodied_factory.md` 新增 §10.6 硬约束（零依赖 / 可插拔 / 安全控制不进入平台 / 来源隔离），CI `test.yml` 增加 `dependencies == []` 断言。
- **P0-2 文档-实现对齐**：验收指标 L11 WebSocket → 轮询/SSE 措辞修正；草稿缺陷修正稿见第 4 节。
- **P0-3 30 天首切片验证**：`python run.py --stub` 成功运行，`/api/status` 五项 healthy，`/api/devices` 返回 3 套外骨骼，`/api/people` 返回 3 名人员，状态接口直接暴露 `safety_boundary` 声明。「看得见」闭环可演示。
- **P0-4 安全边界审计**：`docs/operations/security_boundary_audit.md` 完成 8 项检查 + 全仓危险模式扫描，结论 PASS。
- **P0-5 本评审报告**：即本文档。

## 6. 后续建议

1. 将草稿修订清单回填后，把完整产品定义提交为 `docs/architecture/product_definition.md`，与 `embodied_factory.md`（架构）、`embodied_factory_acceptance.md`（验收）形成三件套。
2. 阶段 1 优先级：真机 `ny_exo_a1` 契约测试 + 实景 CAD/扫描底图 + UWB 场强标定，以兑现「看得见」的真机版。
3. 阶段 2–3 再填充感知融合真值、世界模型回放、调度多目标权重配置。
