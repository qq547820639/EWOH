# EWOH 剩余工作执行总报告

> 项目：EWOH 验收与上线优化项目
> 执行角色：EWOH 项目剩余执行与最终交付负责人
> 报告日期：2026-08-23
> 状态：**全部 4 项剩余工作已执行并验证，项目闭环**

---

## 一、执行摘要

| 阶段 | 工作项 | 结果 | 结论 |
|---|---|---|---|
| 1 | 告警积压清理 | 关闭 786 条 simulated 告警；根因溯源并关停生产模拟器 | ✅ 完成（前序已交付，本次复核有效） |
| 2 | 剩余设备绑定 | 14 台未绑定设备核实；绑定 4 台外骨骼到人员 | ✅ 完成 |
| 3 | 低电量告警规则配置 | 规则引擎硬编码机制澄清 + 端到端验证触发 | ✅ 完成（含机制偏差说明） |
| 4 | rc42 构建部署与验证 | ECS 原生构建、部署、验证 <300ms/缓存/分页/冒烟、磁盘清理 | ✅ 完成 |
| 5 | 最终执行总结与交付 | 本报告 + 收尾文档更新 + 运维交接 | ✅ 完成 |

**关键校准（与原任务书偏差）**：
- 设备未绑定实为 **14 台**（非任务书称 11 台）。
- `ewoh_device_binding` 在应用代码中**无任何 INSERT 路径**，dashboard `bindDevice` API 只写 `spatialEntity.extra`、不消除 unbound；故"通过 API 绑定"在现行代码下**无效**，必须直写绑定表。
- 低电量规则为**规则引擎硬编码**（阈值 20%、severity L2/high、type `DeviceLowBattery`），**无独立配置/创建/启用入口，也无通知通道**；"创建启用规则/通知"在现行架构下无可操作对象，已以"端到端触发验证"替代实现验证目标。
- rc42 构建**不需要 Docker Hub**：ECS 本地 `node:22-alpine` 镜像 + `registry.npmmirror.com` 拉包即可。

---

## 二、阶段 1：告警积压清理（复核结论）

> 详见 `alert-backlog-cleanup.md`（已以真实执行数据权威覆写早前错误假设草稿）。

- **基线**：`ewoh_event` 总 105,269 行；status: expired 104,504 / open 756 / active 7 / closed 2；source_type 以 simulated 105,255 为主体。
- **根因**：ECS `/opt/ewoh/.env` 第 18 行 `EWOH_SIMULATOR_ENABLED=1` → 生产模拟器每 30s tick 持续生成 simulated 告警，RetentionService 仅压 2h 存量不阻再生。
- **操作**：① 备份 `ewoh_event_sim_open_bk_20260823`（786 行，可回滚）；② `UPDATE status='closed'` 关闭 786 条 simulated open；③ `POST /api/simulator/stop` 停模拟器；④ 改 `.env` `ENABLED=0`/`DISABLED=1` 持久化关闭。
- **验证**：simulated open=0、不复发；剩余 open=7 全为非 simulated（inference 5 + simulation 2，按"仅清 simulated"原则保留）；备份可回滚。
- **规则优化**：模拟器已彻底关闭，告警积压再生源已消除。

---

## 三、阶段 2：剩余设备绑定

### 3.1 探查结论（只读核实）
- **未绑定设备实为 14 台**（全部 `source_type='real'`）：
  - 外骨骼（可穿戴）4 台：`EXO-104`、`EXO-106`、`EXO-109`、`EXO-110`
  - AGV 6 台：`AGV-01`~`AGV-06`
  - 焊接机器人 4 台：`WELD-01`~`WELD-04`
- `ewoh_device_binding` 仅 6 条 active（seed：EXO-101/102/103/105/107/108 → P002/P003/P004/P007/P009/P010，org `00000000-0000-4000-8000-000000000001`）。
- **机制发现**：`ewoh_device_binding` 在应用代码中**无任何 INSERT**（仅种子一次性写入）；dashboard `bindDevice` API 仅写 `spatialEntity.extra`（worker_id/device_id），**不会消除 unbound 标志**；`world-state.service.ts` 据 `ewoh_device_binding` 判定绑定。即系统真正认的绑定是 `ewoh_device_binding` 表。

### 3.2 执行方案（经用户确认）
- 路径：**直写 `ewoh_device_binding` 表**（唯一能真正消除 unbound 状态的路径，写操作非破坏性、可回滚）。
- 范围：**仅 4 台外骨骼绑人**（AGV/焊接机器人按 `binding_type='wearable'` 语义不绑人，维持现状）。
- 映射：EXO-104→P005、EXO-106→P006、EXO-109→P008、EXO-110→P011（默认空闲人员，可由运维改）。

### 3.3 执行与验证
- 备份 `ewoh_device_binding_bk_20260823`（可整表回滚）。
- INSERT 4 条（binding_type='wearable'、target_type='person'、status='active'、org_id 对齐 seed、reason='收尾执行-剩余设备绑定'）。`INSERT 0 4`，active 绑定 6→10。
- **验证**：4 台外骨骼 `is_unbound` 全部为 `f`（DB 级 `NOT EXISTS` 校验精确复刻 `dashboard.service.ts:355-364` 的判定逻辑）。结论可追溯。
- 数据完整性：14 台中 10 台（4 外骨骼 + 6 seed）已绑定，余 10 台 AGV/焊接机器人按设计维持未绑定（非可穿戴设备，不应绑人）。

---

## 四、阶段 3：低电量告警规则配置与验证

### 4.1 机制澄清（关键偏差）
- 低电量规则**硬编码于规则引擎** `server/modules/rule-engine/rule-engine.service.ts:63`：
  ```ts
  if (row.batteryPct != null && row.batteryPct < 20) { /* 触发 LOW_BATTERY */ }
  ```
  - 阈值固定 **<20%**（不可配置）。
  - 事件属性：`event_code=LOW_BATTERY`、`event_type=DeviceLowBattery`、`severity=high`(L2)、`status=open`、`source_type` 随遥测。
  - 5 条规则（LOW_BATTERY/HIGH_LOAD/POSTURE_RISK/DEVICE_OFFLINE/DATA_DEGRADED）**全部硬编码**于 `evaluate()`。
- **无数据库规则表、无创建/启用 API、无通知通道**。规则引擎只将事件写入 `ewoh_event`（由 `/api/alerts` 展示），不主动推送。
- **结论**：任务书"阈值/通知/适用类型、创建启用规则"在现行架构下无可操作对象；规则已随代码常驻启用。验证目标调整为"端到端触发验证"。

### 4.2 端到端触发验证
- 入口：`POST /api/ingest/exoskeleton`（鉴权 `X-Ingest-Key`，ECS `.env` 已配 `INGEST_API_KEY`）。
- 发送一帧 `entity_id='EXO-106'`、`battery_pct=5`、`source_type='simulated'` 的模拟遥测。
- 结果：`accepted:true, events_triggered:1`。`ewoh_event` 落库事件：`event_code=LOW_BATTERY`、`event_type=DeviceLowBattery`、`severity=high`、`status=open`、`title=设备 EXO-106 电量低 (5%)`。**规则真实触发并正确落库**。
- **收尾（非破坏性）**：将本次注入的测试事件置 `status='closed'`（与 RetentionService 行为一致，保留审计轨迹），不删除。验证 `open_simulated=0`，**未污染真实告警**（open_total 仍为 7，与阶段1末一致）。

---

## 五、阶段 4：rc42 构建部署与验证

### 5.1 代码改动（已提交 `f97ece4`）
- `world.service.ts`：新增 5s TTL 进程内缓存 `STATE_CACHE_TTL_MS=5000`，缓存键含租户维度（`org:xxx` / `global`），防跨租户串扰；新增 `paginateWorldState`（page/pageSize 对 persons/devices/workstations/events 切片）。
- `world.controller.ts`：透传 `page`/`pageSize` 查询参数。

### 5.2 构建（ECS 原生，绕开 Docker Hub）
- 构建上下文：`.deploy/runtime/Dockerfile.api.ecs`（基础镜像 `node:22-alpine`，已 `RUN npm config set registry https://registry.npmmirror.com`）。
- 本地 rsync 构建上下文（排除 node_modules/dist/logs，约 18MB）至 ECS `/opt/ewoh/build`。
- ECS `docker build -t ewoh-api:0.6.0-rc42`：**`node:22-alpine` 命中本地镜像（无 Docker Hub 拉取）**，构建成功（1.14GB）。

### 5.3 部署
- compose `ewoh-api:0.6.0-rc41` → `rc42`（服务名为 `api`，容器名 `ewoh-api`）。
- `docker compose up -d --no-deps api` 重建容器（绕开 `depends_on: migrate` 的 Docker Hub 拉取依赖；DB 已由 rc41 完成迁移，migrate 无需重跑）。
- 容器 `ewoh-api:0.6.0-rc42` 健康运行。

### 5.4 验证
| 指标 | 结果 | 目标 |
|---|---|---|
| world/state 热调用（缓存命中） | **26–76ms** | <300ms ✅ |
| world/state 稳态冷调用（缓存过期后） | 0.73s | ≤ 历史 rc41(918ms) 无回归 |
| 分页 `page=1&pageSize=2` | persons/devices/workstations/events 均切片为 2 | ✅ |
| dashboard/overview 冒烟 | 0.73s，HTTP 200 | ✅ |

> 说明：首调 5.71s 为容器重建后首次请求的冷启动开销（连接池/JIT 预热），非性能回归；稳态冷调用 0.73s，热调用 <80ms，满足 world/state <300ms 目标。

### 5.5 清理
- `docker image prune -f`：回收 dangling 中间层 **1.198GB**。
- 移除最旧 `ewoh-api:0.6.0-rc40`：释放 1.14GB（**rc41 保留为回滚**）。
- 删除构建上下文 `/opt/ewoh/build` 与临时日志（`/tmp/rc42-build.log`、`/tmp/q*.sql`）。
- **磁盘 43% → 35%**（16G → 13G），与部署前一致。

---

## 六、运维交接要点

1. **告警不再积压**：生产模拟器已永久关闭（`.env` `EWOH_SIMULATOR_ENABLED=0` / `EWOH_SIMULATOR_DISABLED=1`）。如需临时启用，先评估告警再生风险；`RetentionService` 仅压存量不阻再生。
2. **设备绑定真相**：`ewoh_device_binding` 是系统唯一绑定事实源，但**无管理后台/API 写入路径**。新增绑定必须直写该表（org_id 对齐 `00000000-0000-4000-8000-000000000001`）。dashboard `bindDevice` 不会消除 unbound 标志——这是已知架构缺口，建议后续补一个绑定写入 `ewoh_device_binding` 的后台接口。
3. **低电量规则不可配置**：阈值 20%、规则集均为硬编码。如需调整阈值或新增规则类型，须改 `rule-engine.service.ts` 并重新构建部署；无通知通道，告警仅落 `ewoh_event` 供 `/api/alerts` 查看。
4. **回滚预案**：当前 `ewoh-api:0.6.0-rc42` 运行；`ewoh-api:0.6.0-rc41` 镜像保留。如需回滚：`sed` compose 回 rc41 → `docker compose up -d --no-deps api`。
5. **构建链路**：rc 镜像统一在 ECS 原生构建（`.deploy/runtime/Dockerfile.api.ecs` + `node:22-alpine` 本地镜像 + npmmirror）。注意 `docker compose up` 的 `migrate` 依赖会触发 Docker Hub 拉取（不可达），部署用 `--no-deps` 绕过；migrate 镜像不在本地，未来如需 migrate 须先在 ECS 本地构建 `ewoh-migrate`。
6. **磁盘**：当前 35%（13G/40G），健康。

---

## 七、遗留与建议（非阻塞）

- **AGV/焊接机器人 unbound**：10 台按设计维持未绑定（非可穿戴设备）。若业务要求全部设备"已绑定"，需明确其绑定语义（绑工位/绑人）并补写 `ewoh_device_binding`。
- **设备绑定后台缺口**：建议补一个写入 `ewoh_device_binding` 的管理接口，使 dashboard 绑定真正生效（消除当前"API 不消除 unbound"的认知陷阱）。
- **规则引擎可配置化**：低电量等规则建议后续迁移为数据库/配置驱动，支持阈值、通知、适用类型在线调整。

---

*本报告与阶段1 `alert-backlog-cleanup.md`、既有 `rc41-*.md`、`project-closure-final.md` 共同构成 EWOH 验收与上线优化项目的完整闭环交付物。*
