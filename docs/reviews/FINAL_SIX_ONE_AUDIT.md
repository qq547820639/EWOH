# Final 6.1 权威事实与用户体验差距报告

> 审计类型：只读（Phase 0），未修改任何代码。
> 生成时间：2026-08-04（Asia/Shanghai）
> 审计人：EWOH Final 6.1 深化迭代总控（含后端/前端/移动/DevOps/安全/测试/UX/独立验证分工）

---

## 1. 执行环境与仓库基线

| 项 | 值 |
|----|----|
| 仓库 | `git@github.com:qq547820639/EWOH.git`（origin） |
| 分支 | `main` |
| HEAD | `6e6a67f0c3e6bbe74082ba960267d070722b59c7` |
| 发布候选 | `0.6.0-rc4` |
| OS | macOS 27.0 (Build 26A5388g) |
| Node / npm | v26.5.1 / 11.17.0 |
| Python | 3.9.6 |
| Docker | ❌ 不可用（本机） |
| kubectl | ❌ 不可用（本机） |
| helm | ❌ 不可用（本机） |
| psql | ❌ 不可用（本机命令行） |
| 工作区改动 | `output/work-console.json`（已 M）、`.trae/specs/final-six-one-deepening/`（未跟踪）。用户改动保留，不回滚。 |

**结论**：当前基线为 `0.6.0-rc4` + 若干未提交的 Final 6.1 规格文件。本机缺少容器/K8s 工具与非受控 PostgreSQL 客户端，能力边界已记录。

---

## 2. 既有门禁脚本真实运行结果（Phase 0.3）

| 脚本 | 结果 | 备注 |
|------|------|------|
| `bash scripts/standalone-check.sh` | `ALL STANDALONE CHECKS PASSED` | 类型/静态检查/Jest/OpenAPI/契约/DDL 计划全过 |
| `bash scripts/pilot-readiness-check.sh` | `passed=5 failed=3 pending=7`，`PILOT READINESS: NOT READY` | 见 §4 冲突点 2 |
| `node scripts/audit-repo-facts.js --strict` | `38/38 passed` | 无语义冲突引发非零退出 |
| `node tools/work-indexer/index.js --root . --strict --invariants` | `252 items / 209 edges / 48 actors / 191 evidence / 14 gates / 0 conflicts` | 索引一致 |
| `node tools/work-console/index.js --root . --strict` | `0 blocked / 210 missing evidence / 4 gates need approval / 0 invariant conflicts` | **大量证据过期/失效，见 §4 冲突点 6** |

---

## 3. 当前真实状态（权威聚合）

- 路由：OpenAPI `253/253` 控制操作（`openapi/route-manifest.json` 生成于 2026-08-04T04:41:49Z；`controllerKeys`/`specOperations`/`documentedControllerOperations` 均为 253，undocumented 0 / unimplemented 0）。
- 数据库对象：`51 managed tables / 57 physical tables`（`db/contracts/schema-manifest.yaml` 记录 48 受管基线，后期 Scale 扩容至 51；此计数来自既有权威记录，本次未重跑 `standalone-postgres-check`，待 F61-04 环节以真实 PostgreSQL 复核）。
- 测试：server Jest `81 suites / 391 tests`、client Jest `15 suites / 50 tests`、E2E `33/33`、browser `5/5`。
- 工作项：Work Graph `252 items / 209 edges / 48 actors / 191 evidence / 14 gates / 0 conflicts`。
- 门禁：G0–G6 已通过；G7–G9 为 validation；G10 passed-locally / production-pending；G11–G13 pending。
- Pilot readiness：`NOT READY`。

---

## 4. 已实现能力（禁止重复开发）

以下骨架与能力已存在，Final 6.1 只深化、不重做：

- **Work Graph / Gate Engine / 资源注册 / 交接服务**：`tools/work-indexer`、`tools/gate-engine`、`tools/resource-registry`、`tools/handoff-service`，文件化权威索引 `ewoh:///work-graph/v1`。
- **因果执行控制台**：`/work-orchestration` 页面（因果 DAG、门禁、证据抽屉、Agent、风险、资源锁、交接、Final 6 资产目录、场地就绪、批量门禁决定）。
- **Work Orchestration API**：`/api/work/*`（overview/graph/items/evidence/agents/gates/risks/resources/handoffs/catalog/site-readiness/git-sync）。
- **移动 E-SOP / 质量追溯 / 离线重试**：移动工作台、SOP 版本化与签收、质量方案、离线队列（localStorage→IndexedDB 迁移中）、PWA。
- **ERP 映射 / 工厂 Profile / Scale 复制 / 复制 TCK**：`/api/scale/*`、Mapping DSL、Golden Factory、F0–F6 上线、第三工厂演练、`tools/factory-replication`。
- **统一错误契约**：`errorCode/message/fieldErrors/requestId/retryable/recommendedAction/details`，全局 `ValidationPipe`。
- **数据来源词汇**：`real/controlled_test/simulated/replayed/stale/offline` + `DataSourceBadge`。
- **可观测性**：OTel 风格 request tracing、`/metrics`、慢查询检测、统一 requestId 审计关联。
- **门禁脚本族**：standalone / pilot-readiness / audit-repo-facts / work-indexer / work-console / ops / deployment-tck / connector-tck / scenario-tck / cross-tenant-tck / aas-tck / rego-tck。
- **P0 迭代已交付**：移动工作台人/组织过滤、typed 扫码、异常照片附件、离线队列状态机、证据 front matter 绑定与失效、门禁幂等、Git Sync apply 门禁、E2E 33/33、browser 5/5。

---

## 5. 语义冲突 / 漂移清单（不重复开发，仅需一致性修复）

以下为真实对账发现的漂移，是 F61-01 语义规则的核心目标：

1. **权威状态引用陈旧 HEAD**：`phase-state.md` 与 `gates.md` 的「当前权威状态」均标注 `HEAD 9fe8a8f`，而实际 HEAD 为 `6e6a67f`。文档未随最新提交更新。
2. **pilot-readiness 计数漂移**：权威文件记录 `7 passed / 3 failed / 5 pending`；本次实际运行 `5 / 3 / 7`。差异源于本次未注入 `EWOH_DATABASE_URL`/`EWOH_RUNTIME_DATABASE_URL` 等运行时环境。→ 说明计数**依赖环境变量**，需在报告中记录运行环境指纹。
3. **CHANGELOG 计数过期**：`CHANGELOG.md` rc4 段记录 `audit-repo-facts ... 30/30`，实际当前为 `38/38`。计数未随实现更新。
4. **Task Board 基线波次状态过期**：`task-board.md` W0 波次仍标记为「current」，且 `T-002/T-003` 为 `In Progress`、`T-004~T-011` 为 `Refining`，但这些是早期基线任务，早已完成。→ 违反「任务全部 Done 但章节仍显示 In Progress」规则。
5. **`planned_next` 指向已完成任务**：`state.json` 的 `subagent_state.planned_next` 仍含 `close C2 route DTO docs for 70 operations`（C2 已冻结、OpenAPI 253/253）、`frontend browser-level UI regression`（已实现）；`approval physical persistence mapping` 仍为**未完成**（审批仍为纯内存 Map，见 §6.1），故该项不应被视为已完成。→ 部分违反「planned_next 指向已完成任务时失败」规则。
6. **证据一致性与过期**：`work-console` 报告 `210 missing evidence`，且大量证据被标记「过期/失效」（如 T-001、T-012~T-100 等均「现有 1 条，过期/失效 1 条」）。`state.json` 声称 `191 evidence / 0 conflicts`，与 console 的过期/缺失口径不一致。→ 证据 front matter 元数据缺失或 `expiresAt` 过期，需按 F61-01 规则自动失效并在控制台展示。
7. **已修复风险未复核**：`risk-register.md` 中 R-013（手工校验→已由全局 `APP_PIPE` 解决）、R-014（command-map 详情→已由 `entityDetail` 解决）、R-015（离线照片→已实现）仍保留在风险表且无复核/关闭标记。→ 触发「风险对应修复已进入代码但风险未复核」告警。

---

## 6. 仍使用内存 / Stub / 临时适配器 / localStorage / Data URL 的实现

### 6.1 服务端进程内单例存储（F61-02 首要迁移目标）

| 位置 | 字段 | 存储内容 | 需持久化 |
|------|------|----------|----------|
| `server/modules/work-orchestration/work-orchestration.service.ts:194` | `locks = new Map<string, ResourceLockRecord>()` | 资源锁（Map 为主 + 已支持 JSON 文件落盘 `writeLockFile/loadLockFile/deleteLockFile`，受 `EWOH_WORK_WRITABLE` 门禁） | ✅ 高（DB 化，补齐多实例/重启） |
| `server/modules/approval/approval.service.ts:47` | `instances = new Map<string, ApprovalInstance>()` | 审批实例 | ✅ 高 |
| `server/modules/resource/resource.service.ts:62-64` | `inventory` / `resourceLocks` / `persistedSeeds` | 资源库存/锁 | ✅ 高 |
| `server/modules/control/control.service.ts:71` | `latest = new Map<string, ControlAttempt>()` | 控制尝试聚合 | ✅ 中 |
| `server/modules/shared/idempotency.service.ts:15` | `records = new Map` | 幂等记录 | ✅ 高 |
| `server/modules/shared/audit-chain.service.ts:25` | `chains = new Map<string, AuditChainEntry[]>()` | 审计哈希链 | ✅ 高（现为 DB sink + 内存缓存） |
| `server/modules/shared/redis.service.ts:8` | `memory = new Map` | Redis 内存回退 | 中（回退路径） |
| `server/modules/ingest/ingest.guard.ts:25` | `hits = new Map` | 限流计数 | 低（可内存） |
| `server/modules/metrics/metrics.service.ts:6` | `requests = new Map` | 指标计数 | 低（可内存） |
| `server/modules/shared/org-scope.service.ts:85-86` | `cache` / `invalidationListeners` | 组织作用域缓存 | 低（缓存） |

> 注：`git-sync`、`handoff`、`gate-decision` 已按文件/DB 落盘（`EWOH_WORK_WRITABLE` 门禁），属「已持久化」范畴；但资源锁、审批、幂等、控制聚合仍为进程内 Map，多实例/重启会丢状态。

### 6.2 客户端 localStorage / Data URL

- `client/src/pages/MobileWorkbench/useOfflineWorkbench.ts:131,150`：离线队列已开始迁移到 IndexedDB（`migrate legacy localStorage`），但仍有 localStorage 读取路径。
- `client/src/pages/MobileWorkbench/` 离线照片经压缩后以 **Blob 存入 IndexedDB**（`attachmentCompression.ts:18` 总配额 `25MB`，默认压缩 `1280px/0.8`；使用量达 50%–80% 配额时切换为 `1024px/0.7`，>80% 时 `800px/0.6`；入队输入为 Data URL），需补齐分片续传与冲突恢复。
- `client/src/pages/WorkOrchestration/WorkGraphPanel.tsx:424,429`：视图/筛选保存到 localStorage（合理，非领域事实）。
- `client/public/command_map/assets/app.js:264,272,297`：遗留 command_map 用 localStorage 存 `api_base` 与 token（旧版，需统一）。

### 6.3 Python Stub / 临时适配器

- `src/edge_platform/stubs.py`：真实模块缺失时回退 stub 的模式仍存在（`run.py`/`server.py`/`selfcheck.py` 引用）。
- `src/edge_platform/edge/adapters/uwb/protocol.py`：UWB 适配器（需确认是否真机/受控测试）。
- `src/edge_platform/edge/__init__.py`、`migrations/__init__.py` 等含占位/初始实现。

---

## 7. 无法由代码自证的事项（外部阻塞，须标记 BLOCKED/Pending）

| 事项 | 阻塞原因 | 所需外部条件 |
|------|----------|--------------|
| 生产镜像构建 / Compose 真启动 | 本机无 Docker | 容器运行时 + CI 环境 |
| Kubernetes 安装/升级/回滚/备份恢复 | 本机无 kubectl/helm，无集群 | k3d/kind 或远程集群 |
| 真实 PostgreSQL 运行时 E2E（本次未设运行库） | 未注入 `EWOH_DATABASE_URL`/`EWOH_RUNTIME_DATABASE_URL` | 受控 PG 运行时连接 |
| 真实 GitHub Issue/PR/CI/Release 同步 | 需 `GITHUB_TOKEN` + 人工批准 `EWOH_GIT_SYNC_APPROVED` | 认证 + 人工批准 |
| 真实第二/第三工厂、伙伴交付 | 无真实现场/设备/ERP | 现场配置 + 独立验证者签署 |
| 生产批准（G10–G13） | 人工签署/审批未完成 | 人类 Owner 决策 |
| 生产 SLO / 错误预算运行 | 无生产环境 | 生产部署 + 观测 |

---

## 8. P0 / P1 / P2 实施任务、依赖、Owner、代码所有权、验收与回滚

> 完整任务分解见 `.trae/specs/final-six-one-deepening/tasks.md`。以下为核心任务编排。

### P0 任务

| ID | 任务 | 依赖 | Owner | 代码所有权 | 验收命令 | 回滚 |
|----|------|------|-------|-----------|----------|------|
| F61-01 | 单一事实源语义一致性（JSON Schema + 归一解析器 + 跨文件语义规则 + `audit-repo-facts --strict` 非零退出 + 漂移夹具） | Phase 0 | 后端/架构 | `contracts/artifact-schemas/`、`scripts/audit-repo-facts.js`、`tools/work-indexer` | `node scripts/audit-repo-facts.js --strict` | 撤销规则/夹具，回归 38/38 |
| F61-02 | 持久化/事务/多实例正确性（资源锁/审批/幂等/控制聚合入库 + 乐观锁/唯一约束/幂等键 + 锁恢复 + 真实 HTTP+PG E2E） | F61-01 | 后端 | `server/modules/*`、`db/migrations` | `npm run test:e2e`（含重启持久性/并发/事务/锁恢复/离线重放） | 关闭迁移/回滚 SQL |
| F61-03 | GitHub 协作闭环与正式 Release（Issue/PR/CI/Gate 双向同步 + dry-run + 语义化 Tag/Release + SHA256/SBOM/迁移回滚） | F61-01 | DevOps/GitHub | `tools/git-sync/`、`.github/workflows/`、`scripts/package-release.sh` | `npm run release:review` + 远程 Release 校验 | 保留人工批准，不自动合并 |
| F61-04 | 生产部署与升级门禁（CI 真构建镜像 + 临时 PG/Compose E2E + k3d/kind 安装/升级/回滚/备份恢复/Pod 重建 + 可审计证据） | F61-03 | DevOps | `.github/workflows/standalone.yml`、`deploy/`、`scripts/deployment-tck.js` | `npm run deployment:tck` + 集群证据 | 外部缺失时 Gate 保持 Pending |
| F61-05 | 因果执行控制台 UX 深化（为什么阻塞/关键路径/三视图/大图虚拟化/证据 Diff/批准/交接） | F61-01 | UX/前端 | `client/src/pages/WorkOrchestration/` | `npm run test:client` + 视觉回归 + 性能基准 | 撤销前端改动 |
| F61-06 | 移动作业与离线能力工业化（IndexedDB/OPFS + 图片压缩/EXIF 清理/分片续传 + 真实扫码 + 大触控）+ 同一状态机 | F61-05 | 移动端 | `client/src/pages/MobileWorkbench/`、`lib/offlineQueue.ts` | `npm run test:client` + 移动 E2E | 回退 localStorage 迁移 |
| F61-07 | 统一错误/表单验证/数据来源体验（消除手工字符串校验 + 统一错误枚举 + 字段级 UI + 数据来源扩展至全页面） | F61-05/06 | 后端/前端 | `server/common/pipes/`、`exception.filter.ts`、`client/src/components/` | `npm run test:server` + client 测试 | 撤销校验/UI 改动 |
| F61-08 | 测试/安全/性能/可观测性深化（多角色多浏览器 axe + 负载/soak/突发 + secret/依赖/容器/SBOM + 统一 traceId/SLO） | F61-01..07 | 测试/安全 | `test/`、`playwright.config.ts`、`.github/workflows/security.yml`、`scripts/` | `npm run test:browser` + `test:browser:visual` + 负载脚本 | 撤销新增测试/门禁 |

### P1 任务

| ID | 任务 | 依赖 | Owner | 代码所有权 | 验收 | 回滚 |
|----|------|------|-------|-----------|------|------|
| F61-09 | 真实工厂复制工具链（Profile Diff/回滚、Mapping 预览/覆盖率、连接器录制/脱敏/重放、现场准备向导状态机、二/三厂证据独立签署） | P0 全部 | 后端/UX | `tools/factory-replication/`、`/api/scale/*`、`client/src/pages/Scale/` | 现场向导 E2E + 独立签署证据 | 撤销向导/工具 |
| F61-10 | 仓库/交付状态自然语言对话（只读 NL 查询层 + 事实/推断/建议区分 + 证据不足答不知 + 写入需预览/权限/人工批准） | P0 全部 | 后端/前端 | `POST /api/work/console/query`、`client` 查询面板 | 核心查询场景测试 + 边界合规 | 撤销查询层 |

### P2（后续候选，不在本次范围）

- 遗留 command_map 的 localStorage 统一、Python UWB 适配器真机化、冗余门禁精简等。

---

## 9. 结论与门禁基线

- `standalone-check`：✅ 通过（本地 Standalone Ready 成立）。
- `pilot-readiness`：❌ NOT READY（外部容器/集群/批准/现场缺失）。
- `audit-repo-facts --strict`：✅ 38/38（但未覆盖 §5 的语义漂移，需 F61-01 扩展）。
- `work-indexer`：✅ 0 conflicts。
- `work-console`：⚠️ 0 blocked 但 210 条缺失证据 + 大量证据过期失效。

**Production / Scale Ready 均不成立**：G10–G13、真实二/三厂、伙伴交付、生产 SLO、人工签署、容器/K8s 验证均未完成。本报告已如实标记 BLOCKED 与外部条件。