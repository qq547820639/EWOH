# [remediate-audit-2026-08-17] 逐行审计 950 项发现全量整改 Spec

## Why

2026-08-17 全仓库逐行审计（`docs/audit/2026-08-17-line-by-line-audit.md`，基线 4871513）产出 950 条经实证的发现（74 Critical / 161 High / 430 Medium / 285 Low），集中暴露三条系统性主线：**租户隔离三层叠加缺口**（应用层无 org 谓词 + RLS 放行 NULL + 列可空/唯一约束缺 org 维度，53 条 Critical 同根因）、**边缘平台 HTTP GET 面无认证**（EDGE-001 及 10+ 同簇）、**全新库迁移链必然失败**（SQL-003~006 顺序倒置）。本规格对全部发现做**终态化处理**：修复或明确裁决，不保留悬挂项，并为审计 §4 十条主线各补一条自动化防回归门禁。

## What Changes

按文件域划分 12 个修复工作流（与 tasks.md 任务一一对应），全部 C/H/M/L 发现按「修复」或「裁决不改（记录理由）」两种终态收敛：

- **W1 数据库层（SQL-001~110 + NEST-501~525）**：RLS 去除 `OR org_id IS NULL` 放行与 `TO PUBLIC` 收紧（SQL-001/007）；回滚脚本补 `DISABLE ROW LEVEL SECURITY`（SQL-002/008）；迁移链顺序修复使全新库可安装（SQL-003~006）；13+ 张调度表唯一约束补 org 维度、org_id 收紧 NOT NULL（SQL-013~027/035）；schema-manifest 三方对账修正与 verify 脚本补齐（SQL-028~032/101~109、NEST-501/512/513）；seed 补 org_id（SQL-102）。
- **W2 NestJS 调度模块（NEST-001~170 + NESP）**：scheduler 全部读写路径补 org 过滤/ctx 透传（NEST-101~119、001~004 等）；事务原子性与 TOCTOU 修复（NEST-124~129、013/127/147/161）；候选评分对齐 heuristic 语义（NEST-005~007）；SSE 无认证放行收敛（NEST-113/114）；ID/哈希密码学化（NEST-047/131/158/149）；NESP 测试加固（fake-db 尊重 where、弱断言、5ms 时钟）。
- **W3 NestJS 运营四模块 + 业务模块 a–m（NEST-201~231、401~450）**：operations/scale/ingest/work-orchestration 及 approval/erp/alert/model/ai 等模块 org 谓词 + 写入 orgId；role-workbench snake_case 字段修复（NEST-207）；设备唯一约束 (org_id,device_id) 配套（NEST-205，与 W1 联动）；CRLF 邮件头注入（NEST-620）；bypass/cancel 角色校验（NEST-404/405）。
- **W4 NestJS 业务模块 n–z + mes/dashboard 组（NEST-301~362、601~648）**：dashboard/mes/oee/world/world-cursor/gamification/task/workflow/system 等全部 org 过滤；workflow roles 改服务端取值（NEST-610）；控制器补 @Roles（NEST-608/611/617/618）；状态转移 CAS（NEST-627~630）；MES 状态机对齐 ADR-012（NEST-322/323）。
- **W5 边缘平台（EDGE-001~230 + EDT）**：production 下 GET 面强制 Bearer/RBAC（EDGE-001 及 013/014/028~037）；SSRF 收敛（EDGE-002）；exo_binding 补锁 + 唯一约束（EDGE-003）；查询走索引（EDGE-004/005）；离线密码哈希升级（EDGE-007）；调度/推理/契约域正确性（EDGE-101~230）；EDT 测试加固。
- **W6 共享契约层 + 跨端契约漂移（SH-001~020 + EDGE-101/102/201/202、NEST-322/323、openapi YAML）**：exo-session 用 isCanonicalIdentity（SH-001）；schemaVersion 锁 const（SH-003）；状态机 transition 增 actorRole 强制 role 约束（SH-004/005）并接入 TS/Python；TS↔Python parity 差异逐项对齐（SH-006~014、EDGE-201）；openapi.yaml `type:object` 补 `additionalProperties`（CLI-604~607 源头）并重新生成 openapi.d.ts。
- **W7 前端安全（CLI-301/302/401~405/501/505/506、701/702、705~717）**：URL scheme 白名单（XSS 三处 sink 及 attachment 下载）；refreshToken 迁出 localStorage；IV/Math.random 密码学化（含 CLI-405/510/517/518）；API 层路径参数统一 encodeURIComponent。
- **W8 前端 pages 批量（CLI-001~229、601~612）**：演示/伪造数据清理（AiDecision snapshot、HandoffsPanel AG-00、occupancy 0.5/WIP 派生、ContextBar 演示标签）；约 40 处 mutation 补 onError；分页累加（CLI-103）；运算符优先级 bug（CLI-020）；角色注册表补 viewer（CLI-601/602）；巨型文件拆分（CLI-004/010/027，限最小安全拆分：提取 hook/子面板，不重写业务逻辑）。
- **W9 前端 components + lib 批量（CLI-306~350、406~433、502~548、703~733）**：execCommand('copy') 移除；时区统一 Asia/Shanghai 显式；离线栈正确性（offlineDb 事务 resolve、offlineCrypto 原子换 key、offlineLeader lease 驱逐、observability flush 并发守卫）；设计令牌收敛（lint:design-tokens 门禁已存在，按其规则批量替换硬编码色）。
- **W10 飞书应用（FS-001~021）**：签名算法与 raw body（对照飞书协议核实后修正）；fail-open 收敛；时区统一；CORS 头补齐；重放键统一。
- **W11 构建与门禁脚本 + 工具（SCR-001~043 + TOOL-001~017）**：`[^\s]` 正则修复（SCR-001，20+ 处）；ops-check SQL 注入（SCR-002）；假成功路径收敛（SCR-005/008/010/020）；硬编码路径/阈值参数化（SCR-003/004/013/024/025/026）；Trivy checksum（SCR-029）；semantic-rules 自豁免失效（TOOL-001/002）。
- **W12 配置/Release/Python 测试（CFG-001~010 + REL + TEST）**：compose 密码强制注入（CFG-001）；版本口径对齐（CFG-004）；access-matrix 对齐（CFG-006）；REL 按裁决处理；TEST 弱断言/恒真修复。
- **W13 防回归门禁（新增）**：审计 §4 十条主线各补一条自动化检查（租户 org 谓词静态扫描、边缘 GET 面鉴权清单、URL scheme sink 扫描、迁移链全新库重建冒烟、门禁脚本自测、事务边界清单、契约 parity 全覆盖、状态机 role 约束 TCK、演示残留 grep、fake-db where 语义测试），纳入 Makefile/truth 体系。
- **W14 全量验证与交付**：pytest 全量、`tsc -b --force` 0 错误、Jest 全量（server + client）、`openapi:no-drift`、contract-* 门禁、truth-check；修复引入的回归；完成后直接提交并推送 `origin/main`。

**BREAKING 标注**：无对外 API 契约破坏。行为收敛（安全必需）：边缘未认证 GET 由 200→401、XSS 危险 scheme 由渲染→拒绝、RLS NULL 行由全租户可见→不可见（需 org 数据回填后生效）。

## Impact

- 影响规格：租户隔离（ADR-071~076 声明与本规格对齐）、边缘安全边界、共享契约 parity、调度事务语义、truth-gate 门禁集。
- 影响代码：`db/`（新增 standalone_057+ 迁移与 manifest/verify/seed）、`ewoh-spark-app/server/`（database + 全部 modules）、`src/edge_platform/`、`ewoh-spark-app/shared/`、`openapi/ewoh.yaml` + `client/src/types/openapi.d.ts`（再生成）、`ewoh-spark-app/client/src/`、`ewoh-feishu-app/`、`scripts/`、`tools/`、`deploy/`、`contracts/`、`security/`。
- 不改动：`release/` 历史 rc 快照（仅裁决）、`docs/`（本 spec 目录与审计报告外）、生成产物目录。

## 边界（不可违反）

1. **迁移兼容**：不重命名/删除既有迁移文件；新增 `standalone_057_*` 及后续修复迁移；SQL-003~006 顺序问题以「既有文件幂等化（ALTER ... IF EXISTS 守卫）+ 017 补齐最终列」方式修复，保证全新库按编号顺序执行全绿且已应用环境重跑不产生变更。
2. **org 数据回填**：org_id 收紧 NOT NULL 前必须先 backfill（seed/默认 org），避免既有行升级失败；无法判定的存量行回填默认 org 并记录。
3. **契约冻结层**：`contracts/state-machines/*.yaml` 为事实源；TS/Python 状态机函数签名扩展（如 transitionAllowed 增可选 actorRole）保持向后兼容（缺省 undefined 时行为=现状，由调用方强制传值）。
4. **测试不得削弱**：修 NESP/EDT 弱断言时只允许增强（拆双解、钉死状态码、补对照断言），不允许为通过而放宽。
5. **巨文件拆分最小化**：只做机械提取（hook/子组件/纯函数模块），不改业务语义，不追求完整重构。
6. 全部改动须通过：Python pytest 全量、`tsc -b --force`、Jest 全量、`openapi:no-drift`、`make contract-*` 门禁族、truth-check。
7. 不修复项必须给出终态裁决并记录于本 spec「已裁决项」章节，不留「后续建议」。

## ADDED Requirements

### Requirement: 租户隔离应用层谓词全覆盖
系统 SHALL 在全部 NestJS 模块读写路径应用 org 谓词（读加 `eq(orgId)` 或强制 ctx，写显式携带 orgId），并在 RLS 层消除 `org_id IS NULL` 放行分支，使 ADR-071~076「org 隔离闭环」声明与代码事实一致。

#### Scenario: 跨租户读写被拒
- **WHEN** 租户 A 的已认证用户以任意业务 ID（planId/conflictId/deviceId/eventId/approvalId…）访问租户 B 的资源
- **THEN** 返回 404/403，不返回数据、不产生写入。

#### Scenario: 新写入必有归属
- **WHEN** 任意模块经 HTTP 写入 ewoh_event/ewoh_schedule_task/world_state/scheduling_* 等业务表
- **THEN** 行的 org_id = 认证上下文 primaryOrgId，非 NULL。

#### Scenario: RLS 不再放行 NULL
- **WHEN** scheduler 8 表与 route_node/route_edge 的 RLS policy 评估 org_id IS NULL 的行
- **THEN** USING 与 WITH CHECK 均拒绝（global_admin 例外路径显式声明）。

### Requirement: 边缘平台 HTTP 面默认认证
系统 SHALL 使 production 模式下全部 `/api/*` GET 端点要求 Bearer token 并映射 VIEW_* 动作，未映射路径默认拒绝。

#### Scenario: 匿名枚举被拒
- **WHEN** 无 token 请求 `/api/tasks/{id}`、`/api/people`、`/api/telemetry` 等
- **THEN** 返回 401，不返回业务数据。

### Requirement: 前端凭据与注入面收敛
系统 SHALL 消除三类 XSS sink（URL scheme 白名单）、将 refreshToken 迁出 localStorage、密码学 IV/ID 替换 Math.random。

#### Scenario: 危险链接被拒
- **WHEN** 渲染 `javascript:`/`data:` 协议的 evidence.url、markdown 链接、tiptap link
- **THEN** 拒绝渲染为可点击链接（降级纯文本）。

### Requirement: 全新库迁移链可安装
系统 SHALL 保证按编号顺序在空库执行全部迁移成功，且回滚脚本可逆。

#### Scenario: 空库安装
- **WHEN** 全新 PostgreSQL 实例顺序执行 db/migrations/standalone_001~057+
- **THEN** 全部成功，verify 断言通过，无表不存在错误。

### Requirement: 门禁脚本不自伤
系统 SHALL 修复 audit-domain-contracts.js 正则（`[^\s]`）与全部假成功路径，使 truth-gate 的 ok 结论可信。

#### Scenario: 契约 ID 校验有效
- **WHEN** canonical ID 含空白字符
- **THEN** audit-domain-contracts.js 判 FAIL；合法含 `s` 的 ID 判 PASS。

### Requirement: 十条主线防回归门禁
系统 SHALL 为审计 §4 十条主线各提供至少一条自动化检查并接入既有 Makefile/truth 体系。

#### Scenario: 防回归生效
- **WHEN** 新代码引入无 org 过滤的跨租户查询、未认证 GET 路由、危险 URL sink、迁移链断裂
- **THEN** 对应门禁在 CI 失败。

### Requirement: 共享契约 parity 全覆盖
系统 SHALL 使 TS↔Python parity 测试覆盖全部共享契约（不止 cpsat），并对已证漂移项（maintenance disposition、schemaVersion、exo-session 身份、NaN/bool 语义）双向对齐。

#### Scenario: 漂移即红
- **WHEN** 任一共享契约 TS 与 Python 校验语义不一致
- **THEN** parity 测试失败。

## MODIFIED Requirements

### Requirement: 状态机转移校验（扩展）
`transitionAllowed` 增加 optional `actorRole` 参数，调用方（workflow/alert/agent-task 控制器与服务）强制传服务端角色；`roleSatisfies` 对 undefined 收敛为 fail-closed（SH-004 语义修正，调用方已强制传值故无放行回归）。

### Requirement: MES 工单状态机（对齐）
`nextWorkOrderStatus` 与 ADR-012/agent-task.yaml 对齐（或显式 alias 映射并加契约测试），消除硬编码漂移（NEST-322/323）。

### Requirement: 调度候选评分（对齐）
candidate-engine computeScore 补 medium risk 罚、changeoverMs、station 队列等待成本，与 heuristic riskFactor 语义一致（NEST-005~007）。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项；演示/伪造数据展示（occupancy 0.5、WIP 派生、AG-00 预填、硬编码 snapshot、演示标签）按 CLI-001/011/012/201/303 修复为真实数据或显式 unknown，属行为修正而非需求移除。
**Migration**: 无。

## 已裁决项（终态，不保留「后续建议」）

- **REL-001~007（release rc 副本漂移）**：历史快照不重新打包；bandit 版本固定、CHANGELOG [Unreleased]、Makefile targets、SHA256SUMS 校验步骤、合并 SBOM、GPG 签名等动作在 0.6.0 final 打包时执行，本规格仅修主树对应源头（pyproject bandit 固定、RELEASE-README 校验步骤）。
- **SQL-036/037（legacy 001 迁移双轨）**：保留 `001_ewoh_managed_tables.sql` 原位（DEPRECATED 头已声明），在文件头追加「禁止与 standalone_* 混用」显式警告，不做物理移动（避免下游引用断裂）。
- **SQL-051/048（ewoh_user 全拒 RLS、循环列表注释）**：按设计保留，补注释文档化设计意图。
- **NEST-648（world vs world-cursor 双数据源）**：维持 2026-08-04 已有裁决（world-cursor 保留原生 SQL 游标协议），仅补文档注释声明边界。
- **SH-020（TS 严格 re-throw 语义）**：保留 TS 更严语义，补注释文档化差异（Python 侧不改）。
- **CLI-545（清缓存换 deviceId）**：按设计可接受，补注释。
- **TEST-015（_free_port TOCTOU）**：localhost 单进程可接受，保留。
- **EDGE-120/124（docstring/import 顺序）**：随 W5 一并修正，不单列。
- **巨型文件拆分（CLI-004/010/027/110）**：本规格仅做最小机械拆分（提取 hooks/子面板），完整重构另行立项。
- **NEST-507/515（legacy 入口）**：保留 legacy 入口但补齐 guard/interceptor 至可用最小集，并在 README 标注生产应使用 standalone 入口。
