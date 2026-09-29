# EWOH 走读提示词编写前核查

本文件记录编写 `repository-systematic-walkthrough-prompt.md` 时实际核查的边界，不是全仓逐行审计完成报告。

## 当前基线

- 工作区：`/Volumes/Extra/CodeProj/EWOH`。
- 核查时 HEAD：`c4133284204f3b1f6bccc33653ae2ca6d76a7649`，存在大量原有未提交修改；本任务未改业务代码。
- Git 跟踪文件：3829。该数包含文档、历史资料和流程制品，不是活跃源码文件数。
- `node scripts/audit-file-ledger.js stats` 现场结果：账本范围 2730 文件，其中 711 份审阅记录当前仍有效，2019 份未满足当前验证条件，missing=0。
- 旧 `docs/audit/current/coverage-report.md` 显示 712/2730；读取时 Edge 文件已变化，不能直接沿用旧统计。
- 账本字段合法、哈希一致和区间完整只能验证记录的时效及形式，不能替代人的实际阅读与理解证据；上述 711 也不是本任务新读完的文件数。
- 未重新生成或合并旧账本，未把本次结构扫描标为完整审阅。

## 根目录结构

| 层次 | 路径 | 当前核查的职责 |
| --- | --- | --- |
| 边缘运行时 | `src/edge_platform/` | Python 标准库基础服务、适配/采集/推理、SQLite、世界投影、辅助调度、桥接 |
| 主产品 | `ewoh-spark-app/server/`、`client/` | NestJS 控制面、React 业务界面、PostgreSQL 持久化 |
| 跨端代码 | `ewoh-spark-app/shared/` | 类型、契约、校验器、状态机和测试向量 |
| 集成侧车 | `ewoh-feishu-app/` | Express、SQLite、飞书 CLI/API、同步和回调 |
| 契约与数据 | `contracts/`、`openapi/`、`db/`、`catalog/` | 规范、接口、迁移/验证/种子、工厂及连接器资产 |
| 工程运行 | `scripts/`、`tools/`、`deploy/`、`.github/` | 运行和审计门禁、Work Graph、仿真、打包与部署 |
| 文档与历史 | `docs/`、`deliverables/`、`delivery/`、`release/`、`ui/command_map/` | 活跃文档、成果、冻结副本、发布清单与历史原型；应逐项确认是否仍被消费 |
| 本地及流程 | `.codex/`、`.trae/`、`output/`、`tmp/` 等 | 任务状态、历史资料、运行产物；不能自动作为当前验证结果 |

## 已核对的入口和调用边界

1. 根 `run.py:17` 导入 `edge_platform.run.main`；`src/edge_platform/run.py:165` 开始装配。基础 Python 声明不依赖第三方库，不能扩展为整个仓库无依赖：CP-SAT worker 可选 OR-Tools，主应用和侧车有独立 Node 依赖。
2. `ewoh-spark-app/server/main.ts:66` 决定启动模式；独立入口是 `server/standalone-main.ts:103`，并非 `server/standalone/main.ts`。模块分别在 `app.module.ts` 和 `standalone-app.module.ts` 注册。
3. 后端鉴权/数据链为 `AccessTokenGuard` → 身份/组织上下文 → `OrgContextInterceptor` → `RequestDatabaseContext` → Drizzle/PostgreSQL。流式端点、后台任务和系统事务需单独核查组织过滤与事务边界。
4. 调度主链为 controller → `SchedulerService` → `SchedulerRunOrchestrator` → 世界快照/约束 → solver → plan 持久化；审批和派工进入 application/coordinator。HTTP 审批实际使用 `ApprovalPersistenceService`，不能选错同目录内存实现。
5. 设备命令由 `ControlService` 处理请求、授权、排队、交付、ACK 和回执；独立 `tools/edge_control_agent.py` 装配边缘代理。派工、ACK、执行回执和业务完成不能合并描述。
6. Edge `edge/manager.py:352` 对各类帧归一化并持久化；全部类别发布 sensor frames，只有外骨骼进入 telemetry 流。推理和世界投影并行消费，不应画成必然串行。`scheduler/world_state.py:74` 从 Storage 构造快照，并不直接读 `ContractWorldStore`。
7. React `client/src/index.tsx:28` 设置路由基路径，入口安装认证、离线和观测生命周期；`app.tsx:10` 起按页懒加载并应用认证/角色守卫。API、hooks、lib 与页面一起决定行为。
8. 侧车 `ewoh-feishu-app/server/index.js:25` 初始化 SQLite、注册 API/回调并监听。HTTP 启动后会按配置同步设备、启动轮询与定时同步；因此真实配置下启动有外部写入副作用。
9. OpenAPI 输入位于根 `openapi/ewoh.yaml`、`openapi/work-orchestration.yaml`，由应用生成脚本消费。`db/contracts/schema-manifest.yaml` 自身说明后续新增表未全部收入，不能把其中数量当当前数据库全貌。

## 已证实的事实及待验证问题

| 类型 | 证据 | 对正式走读的影响 |
| --- | --- | --- |
| 统计已过期 | 旧 coverage-report 712 vs 现场 stats 711 | 所有阅读/测试证据绑定当前内容，执行结束再核对 |
| 文档/代码漂移 | `server/main.ts:33` legacy 注释仍称缺少 RateLimit/Metrics，而 `server/app.module.ts:125` 已注册相关 provider | 源码和实际装配优先，旧注释只能作为线索 |
| 启动副作用 | `ewoh-spark-app/scripts/dev.sh:22` 本地分支执行 miaoda app sync；侧车入口按配置外部同步 | 运行验证前检查脚本，采用隔离路径 |
| 遗留编排 | `deploy/docker-compose.yml:2` 明示 deprecated；`deploy/cloud/docker-compose.standalone.yml:1` 定义当前独立运行栈 | 不能根据文件名选错部署方案 |
| 待复现风险 | Edge projection/pipeline 永久消费者与 `run.py` 关闭顺序；调度快照 `_safe_call` 返回默认集合 | 验证关停一致性、队列上界及错误可观测性；未实测数据丢失 |
| 待复现风险 | scheduler 手动构造应用服务、访问私有事务 storage，嵌套 GUC/失败留痕 | 验证 DI 生命周期和真实事务，不仅依赖单测替身 |
| 复杂度热点 | `control.service.ts` 约2853行、heuristic solver约2140行、`edge/storage.py` 约1571行 | 大文件分段完整阅读；行数本身不作为缺陷 |

## 本次验证与阅读边界

实际执行：

```sh
node scripts/audit-file-ledger.js stats
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_audit_file_ledger.py -v
```

账本自测 21 项通过，使用临时仓库 fixture 验证哈希失效、行区间、增删文件、非法记录和原子合并等行为。不代表主产品测试通过。本次未启动业务服务、连接业务数据库、控制设备、外部同步或重跑主产品全套测试。

完整阅读与重点片段阅读并用：Edge 入口/装配/config/pipeline/projection/world_state 由分工阅读；后端入口/事务/调度/控制链为定向阅读；前端路由与入口、侧车入口、根配置/脚本为重点阅读；其他目录主要完成结构定位。不能称所有3829文件或账本2730文件已被本次读完。

使用三个探索子 Agent：Edge、后端完成交接；前端/侧车返回阶段发现后遭遇429重试上限，主 Agent 接管该部分入口核查。未经根 Agent 核实或实测的前端疑点没有写为已证实缺陷。独立复核专用模型503不可用后由默认模型接管，结果无P0/P1/P2，唯一P3是专用任务状态未更新，已在交付前更新；复核确认62条核心文件/目录路径、9项npm脚本和13个Make目标存在。独立复核不代表重新逐行审计全部代码。

本次产物仅为仓库定制提示词、核查备忘录和专用任务状态。下一入口：`docs/agent/repository-systematic-walkthrough-prompt.md`。

## 用户追加的架构判断要求

提示词第十二、十三节增加通用工程知识与仓库事实的区分、暂定重构裁决、保留边界、三种演进方向、负责人实施顺序、兼容/回滚/停止条件及收益基线。当前倾向为保留运行时分层并按证据做局部模块化重构，置信度中等，允许后续实验推翻。合理多投影可共存，手动构造不自动构成缺陷，影子对照不能重复执行真实副作用。

新增部分经独立复核修订后 PASS；本次追加仅修改文档与任务状态，没有实施业务重构，也没有声称完成外部组件选型调研。
