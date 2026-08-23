# EWOH rc41 部署完成 — 应用就绪后待办清单

> 生成时间：2026-08-23（rc41 已部署并 healthy）
> 范围说明：rc41 部署与 ECS 磁盘深度清理已由执行方完成。本清单为「应用就绪后仍需推进」的工作项，
> 供你或团队按阶段分派执行。执行方默认不再自主推进以下阶段，除非你另行指示。

---

## 0. 当前已确认基线（可追溯证据）

| 项 | 状态 | 证据 |
|---|---|---|
| 运行版本 | `ewoh-api:0.6.0-rc41` Up / health: starting→ok | `docker ps` + `/health/ready` 返回 200 |
| 依赖 | postgres / redis 均 healthy | `docker ps` |
| 连接池 | `DB_POOL_MAX=20` 已生效 | `docker inspect ewoh-api \| grep DB_POOL_MAX` |
| dashboard 缓存 | 5s 进程内缓存已编译进镜像 | 容器内 `/app/dist/server/modules/dashboard/dashboard.service.js` 含 `overviewCache` / `OVERVIEW_CACHE_TTL_MS=5000` / `Promise.all` 并行 + 缓存命中返回 |
| 磁盘 | 13G/40G = **35%**（清理后） | `df -h /` |
| 回滚镜像 | rc40 保留 | `docker images` |
| 构建基镜像 | node:22-alpine 保留（**勿 prune**，Docker Hub 不可达） | `docker images` |

### ⚠️ 关键校准（与原任务书不一致处）
- **「Docker Hub 不可用导致镜像构建受阻」是误判**：rc41 实际已成功构建。构建链路为
  本地基础镜像 `node:22-alpine`（已存在）+ `registry.npmmirror.com`（ECS 侧可达，200）。
  **构建与 Docker Hub 无关**，后续若要重建（如 rc42），只需本地有 `node:22-alpine` + npm 镜像可达即可。
- **world/state 根因修正**：实测端点 `/api/world/state` 走 `WorldService.getCurrentState()`
  （LATERAL JOIN 跨实体查询 + 事件表 RLS 扫描），**不是**重量级 `collectState()` 快照，
  瓶颈在查询开销而非响应体大小。→ **缓存（5s）是唯一能压到 <300ms 的杠杆**；
  分页对 CommandMap（指挥地图需全量实体）无意义，仅能作为可选向后兼容参数。
  rc42 的 world/state 缓存+可选分页代码**已在本地写好**（未提交未构建）。

---

## 1. 阶段1 收尾：性能验证（缓存达标确认）

> 代码已部署，但「实际响应时间是否达标」尚未采样验证。

- [ ] **dashboard/overview 实测**（部署后首次）：用 admin token 在 ECS 本机 `localhost:3000` 测
      `GET /api/dashboard/overview`，warmup 1 次 + 采样 5 次取均值，目标 **<200ms**。
      对比基线：rc39 ≈ 664ms、rc40 ≈ 700ms（连接池扩容后）。
- [ ] **缓存命中验证**：连续两次请求确认第二次命中缓存（响应骤降 + 无新 DB 查询）；
      确认租户维度键（`orgKey`）无数据串扰。
- [ ] **world/state 实测**（当前 rc41，未做缓存）：采样 5 次取均值，记录现状（预期仍 ~1148ms，待 rc42）。
- [ ] **核心链路冒烟**：`/health/ready`、`/api/devices`、`/api/alerts`、`/api/world/state`、
      `/api/scheduler/context` 等返回 200 且无回归。
- [ ] 输出《性能优化收尾实施与验证报告》 —— 含缓存部署状态、前后性能对比、达标判定、回归结论。

---

## 2. 阶段1.2：world/state 缓存+分页（rc42）

> 代码已在本地写好（`world.service.ts` 加 5s 缓存 + 可选 `page/pageSize`；`world.controller.ts` 透传参数），未提交未构建。

- [ ] 提交 rc42 改动（world/state 缓存+分页），做凭据扫描（确认无明文口令/私钥）。
- [ ] rsync 仓库根到 `/opt/ewoh/build`（排除 `.deploy/ssh`、`.git`、`node_modules`、`dist`、`release` 等）。
- [ ] ECS 构建 rc42：`docker build -f .deploy/runtime/Dockerfile.api.ecs -t ewoh-api:0.6.0-rc42 /opt/ewoh/build`
      （**单构建、勿中途杀**，避免孤儿 overlay 层）。
- [ ] 部署：备份 compose → `sed` 改 tag rc41→rc42 → `docker rm -f ewoh-api` → `docker compose up -d --no-deps api`。
- [ ] 实测 `world/state` <300ms（5 次均值）；确认地图（不传参）仍拿全量、传 `page/pageSize` 时切片正确。
- [ ] 清理：删 rc41 镜像（rc42 作当前、rc41 作回滚）、dangling、孤儿层、`/opt/ewoh/build`、构建日志。

---

## 3. 阶段2：告警积压清理与规则优化

- [ ] **直查 DB 精确计数**（API `limit` 硬上限 500 会截断）：实时 `/api/alerts` 返回 499 open / 1 closed，
      全部 `sourceType=simulated`，集中在 2026-08-22 一次约 43 分钟突发、此后 25h 无新告警 → 模拟测试数据。
- [ ] 分类处置：
  - 真实告警（如有）→ 关联工单或确认关闭；
  - 误报 → 调整规则/阈值；
  - `simulated` 测试数据 → 批量关闭/删除（**清理前 SELECT 核对范围，DELETE/UPDATE 前备份，仅处理测试数据，不动真实告警**）。
- [ ] 优化规则：去重、severity 阈值、模拟数据源开关/限流，避免再次堆积。
- [ ] 验证通知触达链路。
- [ ] 输出《告警积压清理与规则优化报告》。

---

## 4. 阶段3：P2/P3 整改执行与回归验证

- [ ] 从最终验收报告提取 P2(11)/P3(10) 清单，结合实时 DB/代码核实真实状态
      （注意 PROD-008 在最终验收 vs 上线后跟踪报告中状态口径不一，以实时为准）。
- [ ] 已修复项：回归测试通过后关闭，附可追溯证据。
- [ ] 未修复项：推动修复或明确后续计划 + 审批，标注原因（如「暂缓：需 schema 迁移」）。
- [ ] 特别确认：**PROD-026（dashboard 慢）= 本次性能优化项**，rc41 缓存达标后即关闭。
- [ ] 更新《P2/P3 整改跟踪表》。
- [ ] 输出《P2/P3 整改执行进展报告》。

---

## 5. 阶段4：长期跟踪机制与首次月度健康检查

- [ ] 建立月度健康检查清单：核心链路冒烟 / 核心接口响应时间 / 数据一致性抽查 / 系统资源使用 / 用户反馈汇总。
- [ ] 建立季度回顾模板：整改进度 / 运行趋势 / 新问题清单 / 下季度重点。
- [ ] 执行首次月度健康检查（覆盖上述清单）。
- [ ] 输出《首次月度健康检查报告》+《长期跟踪机制说明文档》。

---

## 6. 阶段5：项目收尾与最终交付

- [ ] 汇总各阶段产出，形成《EWOH 性能优化收尾与剩余整改阶段总报告》。
- [ ] 整理最终交付物清单（路径+状态）：各报告、跟踪表、检查清单、SOP。
- [ ] 确认 P0/P1 保持关闭、P2/P3 有明确后续计划。
- [ ] 运维交接要点：
  - **部署链路**：仓库根 rsync → `docker build -f .deploy/runtime/Dockerfile.api.ecs` → compose `sed` 改 tag → `up -d --no-deps api`（跳过 migrate，DB 已迁移）。
  - **回滚**：保留上一版本镜像（当前 rc41 / 回滚 rc40），异常即 `sed` 回退重拉。
  - **磁盘清理节奏**：每次构建后清 dangling + 取代的旧 rc 镜像 + 孤儿 overlay + `/opt/ewoh/build` + 日志；**保留 node:22-alpine 构建基**。
  - **凭据管理**：`scripts/ecs-exec.sh` 含明文 ECS root 口令，已 gitignore；建议改用 SSH 密钥并轮换口令。

---

## 运维备注（执行方留痕）

- ECS：121.43.230.202，SSH 私钥 `/Volumes/Extra/CodeProj/EWOH/.deploy/ssh/ewoh-aliyun`，前端 `http://121.43.230.202:3000`。
- 测试凭证（仅本地 curl 实测，不落库）：admin / 取自 ECS `/opt/ewoh/.env` 的 bootstrap 口令。
- 重建前置：ECS `/opt/ewoh/build` 每次清理后需重新 rsync 仓库根；**勿中途杀 docker 构建**（会留孤儿 overlay 层）。
- 孤儿层精准清理法：`docker image inspect $(docker images -q)` + `docker inspect $(docker ps -qa)` 提取
  `GraphDriver.Data` 路径中的 overlay2 层 ID，与 `/var/lib/docker/overlay2` 目录比对，`rm -rf` 不在集合内且非 `l` 的目录。
- 本次磁盘清理释放约 3GB（dangling 1.24G + rc39 1.15G + 2 孤儿层 + build 90M + 日志），43%→35%。
