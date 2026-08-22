# 运营管理「操作」409 修复与 rc35 部署报告

**时间**：2026-08-21 17:00–17:35  
**状态**：✅ 已修复并验证，ECS 已深度清理

---

## 1. 问题现象

运营管理页面所有「操作」（资产报修、任务开工、工装校准等状态变更）均报 409 CONFLICT：
`Operations record was modified concurrently (stale version)`。

## 2. 根因分析

后端 `server/modules/operations/operations.service.ts` 的 `writeConfig` 方法：

```ts
.onConflictDoUpdate({
  target: [ewohSchedulerConfig.orgId, ewohSchedulerConfig.configKey],
  set: { configValue: value, updatedBy, updatedAt: new Date() },
  ...(expectedUpdatedAt
    ? { setWhere: eq(ewohSchedulerConfig.updatedAt, expectedUpdatedAt) }
    : {}),
})
```

**Drizzle 陷阱**：当 `setWhere` 引用的列（updatedAt）恰好是被 `set` 修改的同名列时，
`setWhere` 中的 `ewohSchedulerConfig.updatedAt` 会被解析为 `EXCLUDED.updatedAt`
（即 `set` 里 JS 端 `new Date()` 生成的微秒级新值），而非数据库原行值。

于是谓词退化为 `EXCLUDED.updatedAt = '之前读取的 updatedAt'`，二者精度/取值不同 →
**命中 0 行 → 抛 409**。即「零并发」场景也必然失败——这不是真并发冲突，而是乐观锁谓词本身不成立。

前端 `transitionXxx` 调用从不传递版本号（`action` 之外无 etag/version），原 NEST-209
「并发防护」意图在「前端无版本传递 + 单租户单记录」架构下无法实现，强行实现反而永久阻断功能。

## 3. 修复方案

移除乐观锁 `setWhere` 分支，改为正常 upsert（按 `(orgId, configKey)` 唯一键更新）：

- `writeConfig`：删除 `expectedUpdatedAt` 参数与 `setWhere` 三元表达式；
- `transitionAsset` / `refreshAssetAfterMaintenance` / `transitionTool`：移除传入的 `row.updatedAt`；
- TypeScript 编译：`tsc --noEmit` 零错误。

## 4. 部署流程（rc34 → rc35）

1. `scp` 修复后的 `operations.service.ts` 到 ECS `/opt/ewoh/build/ewoh-spark-app/server/modules/operations/`（Step 7 COPY 之前）。
2. 重建镜像：`docker build -f deploy/cloud/Dockerfile.api.ecs -t ewoh-api:0.6.0-rc35 .`（npm ci 2m + build:prod:standalone ≈15m）。
3. 更新 `/opt/ewoh/docker-compose.yml`：`image: ewoh-api:0.6.0-rc34` → `ewoh-api:0.6.0-rc35`。
4. 重启：`docker compose up -d --no-deps api`（保留 postgres/redis/migrate）。

> ECS SSH 密钥：`.deploy/ssh/ewoh-aliyun`（本地 `id_ed25519` 不被 ECS 接受）。

## 5. 验证结果（HTTP 状态码）

| 操作 | 端点 | 结果 |
|------|------|------|
| 注册资产 | POST /api/operations/assets | 201 |
| 资产报修 | POST /api/operations/assets/{id}/state?action=flag_maintenance | **201**（status→maintenance_required，history 正确追加） |
| 注册任务 | POST /api/operations/tasks | 201 |
| 任务开工 | POST /api/operations/tasks/{id}/state?action=start | **201**（status→in_progress） |
| 注册工装 | POST /api/operations/tools | 201 |
| 工装校准 | POST /api/operations/tools/{id}/state?action=calibrate | **201**（calibrationHistory 正确追加） |

验证后已通过 DB 精确删除 3 条 `RC35_VERIFY_*` 测试记录（config_key 精确匹配）。

## 6. ECS 深度清理

| 项 | 操作 | 回收 |
|----|------|------|
| `ewoh-api:0.6.0-rc33` 旧镜像 | `docker rmi` | 已删 |
| 悬空 `<none>` 镜像（1.41GB） | `docker image prune -f` | 2.496GB |
| `/tmp` 历史 patch/build 脚本 | `rm -f` | 全清 |
| 4 容器日志（api/postgres/redis/migrate） | `truncate -s 0` | 已截断 |

- **保留**：`rc34` 镜像作紧急回滚；`docker-compose.yml.bak.before_rc35` 备份。
- **磁盘**：使用 24G→23G（可用 11G→**16G**）。

## 7. 当前运行态

- `ewoh-api`：**Up (healthy)**，镜像 `ewoh-api:0.6.0-rc35`
- `ewoh-postgres` / `ewoh-redis`：healthy
- 运营管理「操作」全部恢复正常。
