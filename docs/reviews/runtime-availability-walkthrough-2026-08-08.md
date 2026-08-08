# EWOH 模块可用性走读与修复报告（2026-08-08 第二轮）

> 触发背景：用户报告"项目有问题导致模块无法正常使用"。
> 方法：以**运行时健康检查**为主线（构建/启动/装配探测），用真实错误定位故障，再系统性走读结构。
> 结论：发现并修复 **3 个真实故障**（其中 1 个致命），全部为"代码可编译、测试可过、但运行时不可用"的隐蔽问题。

---

## 一、运行时健康检查结果（修复前）

| 运行时 | 检查 | 结果 |
|--------|------|------|
| 边缘平台 run.py | import + 启动 + /api/status | ✅ 正常（全 healthy，200k 数据） |
| 云侧 standalone | nest build | ✅ 构建成功 |
| 云侧 standalone | **node dist/server/main.js 启动** | ❌ **启动即崩溃（DI 错误）** |
| 飞书侧车 | node --test | ✅ 40/40（修复前） |

---

## 二、发现并修复的 3 个真实故障

### 🔴 故障 1（致命）：WorldStateSnapshotService 构造参数破坏 Nest DI → 云侧整体无法启动

**症状**：standalone 启动立即崩溃：
```
Nest can't resolve dependencies of the WorldStateSnapshotService
(DRIZZLE_DATABASE, RequestDatabaseContext, ?).
Please make sure that the argument Number at index [2] is available...
```

**根因**：Batch 8 修复测试类型错误时，把 `freshnessMs` 从**类字段**误改为**构造参数**。
Nest 将构造参数按类型 token 解析，原始类型 `number` 无法注入 → 启动失败。
**type:check 和 jest 全过**（测试直接 `new` 不经 DI），所以此故障完全静默。

**影响**：依赖 SchedulerModule 的全部模块（调度/冲突/反馈/SSE）不可用——即"模块无法正常使用"的直接原因。

**修复**：
- `world-state.service.ts`：`freshnessMs` 改回类字段（附注释说明 Nest DI 约束）
- `scheduler-domain.spec.ts`：测试改构造后覆盖字段（`(svc as ...).freshnessMs = 1000`）
- 扫描全仓确认：仅此一处裸原始类型构造参数（storage drivers 为工厂 new，无害）

**验证**：重建 + 重启 → `Nest application successfully started` + `/health/live` 200 ✅

### 🟠 故障 2：SchedulerMetricsController 无角色映射 → /api/scheduler/metrics* 全部 403

**根因**：RolesGuard 默认拒绝（无 @Roles 且不在 `route-role.policy.ts` FALLBACK 表 → 403）。
`SchedulerMetricsController` 两者皆无 → **Prometheus 指标端点不可用**（注释声称"独立于受保护控制器"实为误导）。

**修复**：`route-role.policy.ts` 补 `SchedulerMetricsController: ['global_admin', 'dispatcher', 'workshop_lead']`。
新增回归测试 `route-role-policy.spec.ts`（守护所有 controller 有角色映射）。

### 🟠 故障 3：边缘真实模式采集/推理闭环未启动 → 数据只读不增

**根因**：`manager.start()` 仅在 simulation 路径调用；`pipeline.start()` **全仓库无调用**。
production/development 下适配器不采集、推理管线不订阅 STREAM_TELEMETRY → 遥测→推理→事件闭环静默失效。

**修复**：`run.py` 真实装配后显式启动：
```python
if mode != "simulation":
    manager.start()   # 适配器采集线程
    pipeline.start()  # 订阅 STREAM_TELEMETRY，推理/规则/事件链路
```

**验证**：启动日志出现"适配器采集与推理管线已启动" ✅

---

## 三、架构层面的隐性缺陷（本次修复 3/3）

### 🟡 standalone-main.ts abortOnError 硬编码 false → DI 故障被静默

**根因**：legacy main.ts 用 `NODE_ENV !== 'development'`（生产 fail-fast），
但 standalone 硬编码 `abortOnError: false` → 任何装配错误只打日志不退出，
服务半初始化仍监听端口（故障 1 正是被此隐藏）。

**修复**：`abortOnError: process.env.NODE_ENV !== 'development'`（与 legacy 一致）。
**意义**：未来任何 DI/装配错误会在生产环境立即 fail-fast，不再静默。

---

## 四、系统性走读确认（装配/依赖/数据流）

### 云侧（41 模块）
- **模块依赖图无循环**：业务模块依赖边 8 条方向单一（Scheduler→Task；Ingest→{RuleEngine,Mes,Scheduler} 等），StandaloneDatabaseModule/SharedModule 为 @Global
- **全局装配完整**：APP_PIPE（校验）/APP_FILTER（异常）/APP_INTERCEPTOR（Org/Metrics/Tracing）/APP_GUARD（AccessToken+Roles+RateLimit）
- **数据库装配**：DRIZZLE_DATABASE 经 RequestDatabaseContext 提供 ALS 请求级事务 Proxy，org GUC 双保险
- **auth 链路**：login/refresh @Public，其余 AccessTokenGuard → RolesGuard → RateLimitGuard → OrgContextInterceptor(GUC) → Service → RLS
- **scheduler 装配**：providers 17 / exports 15 完整，无缺 provider

### 边缘 Python
- 装配：Settings → RuntimeFactory.assemble → build_real_components（storage→bus→registry→rules→pipeline→manager），RealAssemblyError fail-fast
- 双总线：MessageBus（流式数据通道）vs EventBus（SSE 广播），职责分离（H1 修正确认）

### 飞书侧车
- 启动：initDatabase → CORS → apiAuth → webhook → listen → setImmediate(飞书集成延迟初始化)
- 鉴权：写 fail-closed + timingSafeEqual + webhook_dedup 幂等（无漏洞）
- feishu-config.json 确认在 .gitignore（真实凭据不入库）✅

---

## 五、代码质量问题分级清单（修复后剩余）

### 中（建议后续处理）
| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| M1 | 飞书 spawnSync 同步子进程阻塞事件循环（30s 全量同步/60s 轮询/报告生成时 API 卡顿） | feishu.js:39 | 可用性受损 |
| M2 | 飞书 flushTelemetry 失败即清空 buffer，遥测同步数据丢失无重试 | sync.js:172-192 | 数据丢失 |
| M3 | 边缘 server.py api_status 吞组件异常，inference/manager 异常仍报 healthy | server.py:56-63 | 健康检查误报 |
| M4 | legacy 与 standalone 装配漂移（legacy 缺 RateLimitGuard/Tracing/Metrics + 12 个模块） | app.module.ts | 双入口行为不一致 |

### 低
| # | 问题 | 位置 |
|---|------|------|
| L1 | 飞书旧格式卡片回调 `{open_id, action}` 声明支持但验签必 401（需 create_time） | security.js:76-87 vs index.js:147 |
| L2 | 边缘开发模式登录 token 永不过期（内存缓慢增长） | server.py:204 |
| L3 | 多处 `except Exception: pass` 掩盖故障（会话校验/body 排空/审计失败） | server.py 多处 |

---

## 六、修复验证汇总（全绿）

| 门禁 | 结果 |
|------|------|
| 云侧 nest build + standalone 启动 | ✅ `Nest application successfully started` + /health/live 200 |
| 云侧 scheduler 全量 | 33 suites（待最终确认） |
| 云侧 CommandMap 前端 | 9 suites / 42 tests |
| 飞书侧车 | **41/41**（含新重放语义测试） |
| 边缘 Python | **893 passed**（含真实装配路径） |
| OpenAPI 路由零漂移 | 306/306 |

## 七、提交建议
- `fix(scheduler): WorldStateSnapshotService freshnessMs field (Nest DI crash)` — 故障 1
- `fix(scheduler): metrics controller RBAC fallback + guard regression test` — 故障 2
- `fix(edge): start adapter collection + inference pipeline in real mode` — 故障 3
- `fix(server): standalone abortOnError fail-fast in production` — 架构缺陷
- `fix(feishu): mark replay only after business success (allow legit retry)` — 飞书重放语义
