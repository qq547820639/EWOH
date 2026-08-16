# 全仓库逐行代码审计报告（2026-08-17）

> 审计类型：只读逐行审计（本轮不修复，发现项另行立项）
> 审计基线：HEAD `4871513ecfe23ae1c8ed933ff9bfc90ca8dc89d4`，分支 `main`（2026-08-17 01:14:38 +0800）
> 审计方式：9 个执行域 × 24 个只读审计子代理并行逐行阅读 + 主控对 Critical/代表样本抽样复核（24 项，全部实证）

## 1. 执行环境

- OS：Linux（远程沙箱）；Python 3.14.7；Node v24.1.0
- 审计起始时工作区状态：干净（仅 `.trae/specs/audit-full-repo-line-by-line/` 未跟踪；`.trae-html-share-packages/` 为审计前已存在的未跟踪目录，非本次产物）
- 上次全仓审计参照：`docs/audit/2026-08-08-full-repo-audit.md`

## 2. 范围与覆盖率登记表

| # | 域 | 路径 | 实测规模 | 逐行覆盖 | 发现数 |
|---|---|---|---|---|---|
| 1 | Python 边缘平台-核心 | `src/edge_platform/`（顶层+edge/auth/rbac/routes） | 57 文件 / ~8.9k 行 | 100%（无未读） | 52 |
| 2 | Python 边缘平台-调度推理 | `src/edge_platform/{scheduler,inference,policy,governance,runtime}` | 49 文件 / ~10.5k 行 | 100% | 25 |
| 3 | Python 边缘平台-领域契约 | `src/edge_platform/{contracts,world_model,connectors,spatial,aas,assistant,audit,backup,collection,monitoring,migrations,perception,scenario,scripts,twin,static}` | 62 文件 / ~17k 行 | 100% | 30 |
| 4 | Python 边缘平台-内嵌测试 | `src/edge_platform/tests/` | 56 文件 / ~13.2k 代码行 | 100% | 18 |
| 5 | NestJS-数据库层/入口/shared | `server/{database,common,modules/shared}` + 4 入口文件 | 35 文件 / ~4.7k 行 | 100% | 25 |
| 6 | NestJS-调度模块代码 | `server/modules/scheduler/`（非 spec） | 74 文件 / 27.0k 行 | 100%（37+37） | 118 |
| 7 | NestJS-调度内嵌测试 | `server/modules/scheduler/**/*.spec.ts` + `__tests__/` | 105 文件 / ~26.5k 行 | 100%（52+53） | 36 |
| 8 | NestJS-运营四模块 | `server/modules/{operations,work-orchestration,scale,ingest}` | 27 文件 / ~10.7k 行 | 100% | 31 |
| 9 | NestJS-业务模块组 | `server/modules/{mes,agent,files,gamification,learning,dashboard}` | 36 文件 / ~8.2k 行 | 100% | 62 |
| 10 | NestJS-小模块组 a–m | 18 个模块 | 69 文件 / ~7.7k 行 | 100% | 50 |
| 11 | NestJS-小模块组 n–z | 24 个模块 | 81 文件 / ~7.8k 行 | 100% | 48 |
| 12 | 前端 pages | `client/src/pages/` | 195 文件 / 42.9k 行 | 生产代码 100%；测试文件由第 17 项代理补齐 100% | 82 |
| 13 | 前端 components | `client/src/components/` | ~220 文件 / 23.2k 行 | 100%（113+110，边界重叠 3） | 83 |
| 14 | 前端 lib | `client/src/lib/` | 63 非测试文件 / ~10.5k 行 + 53 测试 | 100% | 48+（并入 17） |
| 15 | 前端 types | `client/src/types/` | 7 文件 / 20.7k 行 | 手写层 100%；`openapi.d.ts`（19.2k 行）为生成物：头部/全部 schemas 段/全部枚举与退化类型位点/313 条 path 计数比对，中段重复模板未逐行展开（如实声明） | 12 |
| 16 | 前端 api/hooks/scheduler/utils | `client/src/{api,hooks,scheduler,utils}` | 39 文件 / ~4.3k 行 | 100% | 33 |
| 17 | 前端补齐测试 | pages/CommandMap 35 测试 + lib 53 测试 | 88 文件 | 100% | （并入 12/14 章） |
| 18 | 共享契约层 | `ewoh-spark-app/shared/` | 31 生产文件 / 10.3k 行 + 12 spec 抽样 | 100% | 20 |
| 19 | 飞书应用 | `ewoh-feishu-app/` | 11 server + 11 test + 2 配置 / ~5.2k 行 | 100% | 21 |
| 20 | 数据库迁移 | `db/migrations/` + `db/contracts/schema-manifest.yaml` | 113 文件 / ~8.6k 行 | 100% | 54 |
| 21 | 数据库 seed/verify/runner | `db/{seed,verify,runner}` | 59 文件 / ~7.7k 行 | 100% | 10 |
| 22 | 构建与门禁脚本 | `scripts/` | 62 文件 / ~13.4k 行 | 100% | 43 |
| 23 | 工具 + release 抽查 | `tools/` + `release/ewoh-0.6.0-rc*` | 19 文件 / ~4.2k 行；release 抽查 | 100% / 抽查 | 17+7 |
| 24 | Python 顶层测试 | `tests/` | 37 文件 / ~5.1k 行 | 100% | 15 |
| 25 | 配置/契约核对 | `contracts/`、`openapi/`、`catalog/`、`security/`、`deploy/`、`.github/workflows/`、根配置、`ui/command-map/` | ~52 关键文件 | 逐项核对 | 10 |

**排除项**（按 spec 声明）：`node_modules`、`package-lock.json`、`ewoh-spark-app/output/`（生成产物）、`delivery/`（二进制交付物）、`release/` 打包副本（仅抽查一致性，见 REL-001~007）、`docs/`、`.trae/`。

## 3. 分级统计

| 域 | Critical | High | Medium | Low | 合计 |
|---|---|---|---|---|---|
| EDGE（src 生产） | 3 | 17 | 58 | 29 | 107 |
| EDT（src 内嵌测试） | 0 | 3 | 9 | 6 | 18 |
| NEST（server 生产） | 53 | 79 | 149 | 53 | 334 |
| NESP（scheduler 测试） | 0 | 2 | 21 | 13 | 36 |
| CLI（client） | 5 | 21 | 119 | 113 | 258 |
| SH（shared） | 1 | 4 | 5 | 10 | 20 |
| FS（feishu） | 0 | 0 | 9 | 12 | 21 |
| SQL（db） | 8 | 27 | 15 | 14 | 64 |
| SCR（scripts） | 4 | 4 | 23 | 12 | 43 |
| TOOL（tools） | 0 | 2 | 7 | 8 | 17 |
| REL（release 抽查） | 0 | 1 | 4 | 2 | 7 |
| TEST（tests） | 0 | 0 | 6 | 9 | 15 |
| CFG（配置核对） | 0 | 1 | 5 | 4 | 10 |
| **合计** | **74** | **161** | **430** | **285** | **950** |

## 4. Top 风险摘要（跨域主线）

1. **租户隔离应用层大面积缺失（NEST 域 53 条 Critical 的共同根因）**：`dashboard`、`mes`、`oee`、`world`、`world-cursor`、`gamification`、`scale`、`operations`、`erp`、`approval`、`scheduler`（world-state/resource-projection/scheduling-policy/scheduling-feedback/scheduler-query/outbox）等模块的读写路径普遍缺 `orgId` 谓词或写路径漏设 `org_id`，依赖 RLS 兜底；而 `standalone_025/056` 的 RLS policy 含 `OR org_id IS NULL` 放行分支（SQL-001/007），叠加 7 张 scheduler 表 `org_id` 可空（SQL-035）与 seed 缺 org_id（SQL-102），构成「应用层不过滤 + RLS 放行 NULL + 数据层可写 NULL」三层叠加的可利用跨租户读/写面。ADR-071~076「org 隔离已闭环」的声明与代码事实不符。
2. **边缘平台 HTTP 面鉴权覆盖不完整（EDGE-001）**：production 下 `do_GET` 仅对 `/api/audit`、`/api/telemetry/export` 做 RBAC，telemetry/devices/people/events/tasks/scheduling/world/status/metrics 等 GET 路径无认证即可读（EDGE-013/014/028~037 同簇）。
3. **SSRF 两处**：边缘 `/api/vision/understand` 接受用户控 `base_url`（EDGE-002）；云端 AI 模块转发用户 `api_key/base_url`（NEST-430）。
4. **前端 XSS 三处 + 凭据存储**：`Timeline.tsx`/`streamdown.tsx`/tiptap `link-edit-form` 均未校验 URL scheme（CLI-301/401/302）；refreshToken 存 localStorage（CLI-501）+ 离线加密 IV 退化用 `Math.random`（CLI-505）。
5. **全新库迁移链必然失败**：`standalone_008/009/011/014` 在 `017` CREATE TABLE 之前 ALTER 同批表（SQL-003~006），按编号顺序执行直接报错。
6. **门禁脚本自伤**：`audit-domain-contracts.js` 20+ 处 canonical ID 正则误写 `[^\\s]`（SCR-001），既拒合法 ID 又放行含空白 ID，削弱全部契约门禁；`standalone-ops-check.sh` 存在 SQL 注入（SCR-002）；`soak-load.js` queue-backlog 恒 ok:true（SCR-005）。
7. **事务/并发正确性系统性薄弱**：调度域 persistPlan 循环无外层事务（NEST-125/129）、约束落库与 replan 分离（NEST-128）、advisory lock TOCTOU（NEST-124）、check-then-insert 幂等竞态多处（NEST-013/127/147/161/220/633）；状态机转移普遍缺 CAS（NEST-627~630）。
8. **契约漂移三大源**：MES 状态机与 ADR-012 不一致（NEST-322/323）；TS↔Python parity 测试仅覆盖 cpsat（EDGE-211），maintenance `disposition`（EDGE-201/SH-002）、exo-session 身份校验宽松（SH-001）、envelope `schemaVersion` 未锁 const（SH-003）实际漂移；OpenAPI YAML 大量 `type:object` 无 `additionalProperties` 导致前端类型退化为 `Record<string, never>`（CLI-604~607，100+ 处）。
9. **状态机 role 约束未实现**：`agent-task.yaml`/`alert.yaml` 声明的 transition role 在 TS/Python 状态机函数中均未强制（SH-004/005），`workflow` 控制器甚至从请求体取 roles（NEST-610）。
10. **「演示/伪造数据」残留**：ContextBar 永久「演示 / 待接入真数据」标签（CLI-303）、HandoffsPanel 预填伪造 actor `AG-00`（CLI-201）、occupancy 缺省 0.5 且 WIP 由其派生（CLI-011/012）、AiDecision 硬编码 snapshot（CLI-001）。

## 5. 审计方法与复核

- 24 个子代理按域/字母序/规模切分，逐文件 `Read` 完整阅读（大文件分段），输出统一格式 `ID|级别|文件:行号|问题|证据|建议`。
- 主控复核：对 24 项 Critical（覆盖全部 12 个域与全部模式簇，占 Critical 总数 32%）逐一读源码/grep 实证，**24/24 成立，抽样误报率 0**（明细见 §7）。同簇 Critical（如 NEST-302~319 的 org 过滤缺失簇）以簇代表实证 + 模式 grep 佐证。
- 交叉印证：SQL 域代理独立证实 NEST-501（schema 缺 org_id）与 NEST-205（device 唯一约束单列）；NEST 代理证实 ADR 声明与代码事实的多处不符。

## 6. 逐域发现清单

> 格式：`编号|级别|文件:行号|问题|证据|建议`（本节各代码块即机器可读登记表，管道符分隔，可直接解析）。
> 级别缩写：C=Critical，H=High，M=Medium，L=Low。

### 6.1 EDGE-核心（EDGE-001~052）

```
EDGE-001|C|src/edge_platform/server.py:414-435|production 下绝大多数 GET 端点绕过认证|action_for_request 仅映射 /api/audit、/api/telemetry/export；其余 GET 路径 action=None 时跳过 RBAC，do_GET 不强制 token|为所有 GET 路径补 VIEW_* 动作或全局要求 Bearer token
EDGE-002|C|src/edge_platform/routes/inference.py:196-232|/api/vision/understand SSRF|api_key/base_url/model 接受请求体覆盖，无白名单，可令服务端向任意 URL 出站|禁止用户控 base_url，仅允许 Settings.ark_base_url
EDGE-003|C|src/edge_platform/edge/storage.py:402-451|exo_binding 系列方法缺失 self._lock|start/end/get/list_active_binding_for_exo/list_bindings 均未加 with self._lock，并发 bind 同 exo 可生成重复活跃绑定|补 with self._lock 并对 (exo_id,status='active') 加唯一约束
EDGE-004|H|src/edge_platform/edge/storage.py:340-350|query_telemetry 全表 SELECT 后 Python 过滤|SELECT * FROM telemetry WHERE device_id=? 拉全部行再 _in_window 过滤，未用 idx_telemetry_device_ts|改为 WHERE device_id=? AND ts BETWEEN ? LIMIT ? 走索引
EDGE-005|H|src/edge_platform/edge/storage.py:507-522|query_inference 同型全表扫描|SELECT * FROM inference WHERE device_id=? 后 Python 端 _in_window 过滤，idx_inference_device_ts 未被使用|同上改为 SQL 端时间窗 + LIMIT
EDGE-006|H|src/edge_platform/routes/scheduler.py:41-85|SSE 端点线程耗尽 DoS|while True 仅在 wfile.write 抛错时 break；ThreadingHTTPServer 无连接上限|加最大连接数/超时退出/订阅 TTL
EDGE-007|H|src/edge_platform/auth/identity.py:51-97|离线身份后端密码方案不安全|sha256(salt+password) 为快速哈希；硬编码弱口令 admin123/safety123/operator123|换 bcrypt/argon2，强制初始密码 + 首次登录改密
EDGE-008|H|src/edge_platform/routes/world.py:75-102|legacy POST /api/event/status 绕过 RBAC|action_for_request 仅匹配 /api/events/，/api/event/status 不匹配→任意已认证用户可改任意事件状态|废弃 legacy 端点或扩展匹配规则
EDGE-009|H|src/edge_platform/server.py:588|TLS 接入使用 ssl.wrap_socket|3.10 起 deprecated，未设 minimum_version，默认可协商 TLS 1.0/1.1|改用 SSLContext(PROTOCOL_TLS_SERVER)+minimum_version=TLSv1_2
EDGE-010|H|src/edge_platform/routes/scheduler.py:476-484|/api/scheduler/v2/solve 无超时与输入规模上限|cpsat_solver.solve 同步阻塞无 timeout，任意已认证用户可提交对抗性输入长期占线程|加 solver timeout、任务规模上限、独立线程池
EDGE-011|H|src/edge_platform/routes/exo.py:103-146|api_exo_unbind 无绑定归属校验|任意已认证用户传 bindingId/exoId 即可结束他人活跃绑定，无 ended_by 与原 binding.person_id 比对|校验 ended_by==target.person_id 或要求管理员角色
EDGE-012|H|src/edge_platform/routes/world.py:104-114|POST /api/reset 无 RBAC 动作|action_for_request 对 /api/reset 返回 None；viewer 等任意角色可触发 reset_demo|映射 MANAGE_DATA 动作或限定 admin
EDGE-013|H|src/edge_platform/routes/inference.py:127-161|GET /api/person/profile 无认证暴露 PII|返回 display_name/team/skills/consent_status/事件/指标；production 下无 token 即可读|要求 token 且映射 VIEW_PERSONNEL
EDGE-014|H|src/edge_platform/routes/world.py:34-35|GET /api/people 无认证暴露全量 PII|list_people 直返全员 display_name/team/skills_json/consent_status|同上，要求 token + 角色
EDGE-015|M|src/edge_platform/auth/session.py:53-98|_sessions/_fail_counts/_lock_until 无后台清理|仅当前 token 过期才清；长时运行字典无界增长|后台周期清理或 LRU 上限
EDGE-016|M|src/edge_platform/security.py:79-106|_RateLimiter._buckets 无过期/无上限|按 IP 累积 deque，从不淘汰非活跃 IP|加 TTL 清理或 LRU 上限
EDGE-017|M|src/edge_platform/routes/auth.py:67-97+auth/session.py:100-123|登录锁定仅按用户名|旋转用户名即可绕过 login_fail_lock；rate_limiter 60/min 对登录端点过松|加 per-IP 登录失败计数 + 登录端点独立更紧限流
EDGE-018|M|src/edge_platform/routes/health.py:168-180|GET /metrics 无认证|Prometheus exposition 暴露 db_counts/延迟/事件计数/low_battery|加 IP allowlist 或 token
EDGE-019|M|src/edge_platform/routes/health.py:62-131|GET /api/status 无认证|返回 services 健康/db_counts/ingest_chain/uplink 健康/model 版本等内部状态|要求 token
EDGE-020|M|src/edge_platform/routes/auth.py:154-177|GET /api/security/policy 无认证|披露 login_fail_lock 阈值/session_timeout/tls_enabled，便于攻击者画像|要求 token 或仅返回最小公开字段
EDGE-021|M|src/edge_platform/edge/storage.py:547-552|list_events 直接把用户 limit 传入 SQL|routes/world.py:40 int(h.arg("limit","100") or 100) 无上限，可传 1e9|服务层设 hard cap（如 1000）
EDGE-022|M|src/edge_platform/routes/scheduler.py:202-222|api_create_scheduling_request 不校验 task_ids 规模|payload.get("task_ids") or [] 无长度/元素校验|加 len 上限 + 元素合法性
EDGE-023|M|src/edge_platform/routes/scheduler.py:137-160|api_create_task 接受用户传入 task_id|_task_field("task_id") 后 INSERT OR REPLACE 覆盖既有任务|禁止客户端指定 task_id 或先 exists 检查
EDGE-024|M|src/edge_platform/routes/auth.py:100-132|api_auth_refresh 并发刷新竞态|同 token 并发两请求均可 verify 成功→各自 revoke+create，会话翻倍|加 lock 围绕 verify+revoke+create 原子段
EDGE-025|M|src/edge_platform/server.py:240-254|未命中 /api/* GET 回退 SPA|translate_path 对 /api/* 一律返回 STATIC_DIR/index.html，GET 200 HTML，与 POST 404 JSON 不一致|未命中 /api/* 时返回 404 JSON
EDGE-026|M|src/edge_platform/edge/storage.py:263-271|SQLite 文件按默认 umask 创建|含遥测/审计/绑定等敏感数据，umask=022 时 world-readable|open(db_path,'a',0o600) 或显式 chmod
EDGE-027|M|src/edge_platform/routes/auth.py:91-97|demo token 路径对任意 username 赋 admin 角色|非 production 下 username="x" 即得 role=admin|dev 模式也应映射到受限角色或要求预置账号
EDGE-028|M|src/edge_platform/routes/scheduler.py:99-108|GET /api/tasks/{id} 无认证|task_id 可枚举读取任务详情|要求 token + VIEW_TASKS（EDGE-001 具体表现）
EDGE-029|M|src/edge_platform/routes/scheduler.py:225-258|GET /api/scheduling/requests/{id}、/api/scheduling/plans/{id} 无认证|可枚举请求/方案详情（含 assignments_json）|要求 token
EDGE-030|M|src/edge_platform/routes/scheduler.py:237-382|GET /api/assignments、/api/scheduling/requests、/api/scheduling/plans 整表无认证|可拉全量派工/方案/请求列表|要求 token + 分页强制
EDGE-031|M|src/edge_platform/routes/inference.py:43-124|GET /api/inference、/api/inference/metrics 无认证|泄露推理结果与延迟统计|要求 token
EDGE-032|M|src/edge_platform/routes/inference.py:164-179|GET /api/models、/api/rules 无认证|泄露模型/规则注册表|要求 token
EDGE-033|M|src/edge_platform/routes/world.py:38-44|GET /api/events 无认证|泄露风险事件列表（含 person_id/severity/trigger）|要求 token
EDGE-034|M|src/edge_platform/routes/telemetry.py:19-58|GET /api/telemetry、/api/telemetry/series 无认证|泄露实时与历史遥测|要求 token
EDGE-035|M|src/edge_platform/routes/replay.py:29-89|GET /api/world/snapshot、/api/world/replay 无认证|泄露世界状态快照与因果事件流|要求 token
EDGE-036|M|src/edge_platform/routes/scheduler.py:33-38|GET /api/resources/state 无认证|泄露实时资源状态|要求 token
EDGE-037|M|src/edge_platform/routes/health.py:183-190|GET /api/scheduler/v2/solver/health 无认证|泄露 solver 可用性|要求 token
EDGE-038|M|src/edge_platform/routes/replay.py:40-129|POST /api/world/{entities,states,events,predictions} 仅认证不校验角色|任意已认证用户可写世界状态/事件/预测|映射 MANAGE_WORLD 动作
EDGE-039|M|src/edge_platform/routes/andon.py:57-119|POST /api/andon/raise 无 RBAC|任意已认证用户可批量开灯，仅受 60/min/IP 限流|映射 RAISE_ANDON 动作 + 速率限制
EDGE-040|M|src/edge_platform/routes/exo.py:58-100|api_exo_bind 无 RBAC + TOCTOU|route 检查 list_active_binding_for_exo 后调用 start_binding 之间存在窗口|加 lock 或 DB 唯一约束
EDGE-041|M|src/edge_platform/edge/bridge/event_uplink.py:159-172+metrics_uplink.py:157-173+edge_to_spark.py:282-300|X-Ingest-Key 经 HTTP 明文传输|未强制 https；中间人可嗅探 ingest_key|production 强制 https + mTLS 或 HMAC 签名
EDGE-042|M|src/edge_platform/edge/manager.py:305-324|_read_loop 持续异常无限循环|read_message 反复抛错仅 sleep 1s 重试，日志爆量、磁盘填满|加连续失败阈值后转 degraded + 退避
EDGE-043|M|src/edge_platform/edge/manager.py:317-324|insert_telemetry 失败静默丢帧|storage 写入异常仅 logger.exception，数据丢失无重试|加重试队列或落盘 dead-letter
EDGE-044|M|src/edge_platform/services.py:109-142|person_metrics N+1 查询|recommend 内对每个候选人员调用 person_metrics，每人一次 latest_telemetry + query_telemetry|批量预取 latest/query 一次复用
EDGE-045|M|src/edge_platform/routes/_util.py:14-15|OFFLINE_AFTER_SEC/EVIDENCE_WINDOW_SEC import 时求值|Settings.load().offline_after_sec 在模块加载时固化，force_reload 后失效|改为函数封装或运行时取值
EDGE-046|M|src/edge_platform/security.py:192-240|validate_input 为死代码|导出但无任何路由调用 _INJECTION_PATTERNS 校验|删除或在写路由统一接入
EDGE-047|M|src/edge_platform/routes/scheduler.py:478-484|route_solve 裸 except Exception 包装|仅返回 generic 500，丢失错误类型与上下文|区分 ValueError/Timeout 走 4xx，其余 500 并保留 code
EDGE-048|L|src/edge_platform/routes/inference.py:186-189|POST /api/query 无 RBAC|任意已认证用户可调用助手并获取真实事件/遥测引用|映射 QUERY_ASSISTANT 动作
EDGE-049|L|src/edge_platform/services.py:303-334|REFUSE_RULES 用裸子串匹配|同义词改写即可绕过|结合意图分类或正则强化，至少做词边界
EDGE-050|L|src/edge_platform/services.py:370-564|answer 多关键词命中按代码顺序取首分支|"在线设备最近事件"命中"在线"先返回，答非所问|优先级排序或要求多关键词去歧义
EDGE-051|L|src/edge_platform/services.py:578-638|evaluate_scenario 不校验数值上下界|people/roi 等可负或巨大|加 0≤roi≤5、people≥0 等边界
EDGE-052|L|src/edge_platform/routes/auth.py:147-151|api_me 在 production 仍尝试 _tokens 兜底|sm=None 时落 demo 分支，增加攻击面|production 下直接 503/401
```

### 6.2 EDGE-调度推理（EDGE-101~125）

```
EDGE-101|H|src/edge_platform/scheduler/scoring.py:29-34|ScheduleWeights 字段名与 TS 契约漂移|TS 用 w1_output/w5_move_distance，Py 用 w1_production/w5_travel_distance|统一为 TS 契约字段名或加映射层
EDGE-102|H|src/edge_platform/scheduler/models.py:31-36|Plan/Task 状态机与 TS scheduler.ts PlanStatus/AssignmentStatus 严重漂移|TS PlanStatus=draft/shadow/approved/dispatched/executing/completed/rejected/superseded；Py 用 plan.yaml 状态|两端对齐 plan.yaml/task.yaml canonical 状态
EDGE-103|H|src/edge_platform/inference/train.py:314-325|--register 自动 activate 模型，绕过 governance.ModelRegistry 生命周期|train.py 直接调 inference.ModelRegistry.activate，无 approver_id/shadow/canary|移除 --register 或强制走 governance 审批链
EDGE-104|H|src/edge_platform/scheduler/models.py:334-362|SchedulePlan.to_dict 丢失动态属性|frozen_assignments/executed_at/reject_reason/_reservations 动态设置但 to_dict 未序列化|补全 to_dict 字段或改用 dataclass 字段
EDGE-105|M|src/edge_platform/inference/fatigue.py:184-189|_assert_non_medical 用 assert，python -O 下安全不变量失效|assert report.is_medical is False 等|改为 if...raise AssertionError
EDGE-106|M|src/edge_platform/inference/dataset_split.py:101-106|no-leak 不变量用 assert，-O 下人员泄漏检测失效|assert not (s_train & s_val) 等 4 条|改为 if...raise ValueError
EDGE-107|M|src/edge_platform/inference/pipeline.py:294-299|consent 服务异常时 fail-open，隐私帧仍处理|except Exception: return True|fail-closed 或至少告警+计数
EDGE-108|M|src/edge_platform/inference/pipeline.py:442-467|契约校验失败仅 log 不阻断，docstring 称 fail-closed 实为 fail-open|violations 非空仍 insert_inference+publish|校验失败时标记降级或拒绝发布
EDGE-109|M|src/edge_platform/scheduler/scheduler_service.py:451-471|confirm 逐条创建预约，中途冲突异常无回滚|先创建并持久化的预约不会因后续冲突撤销|事务化或失败时反向释放已建预约
EDGE-110|M|src/edge_platform/scheduler/scheduler_service.py:549-574|execute 先创建/持久化 assignments 再 validate_plan_transition|验证失败时派工已落库泄露|先 validate 再创建 assignments
EDGE-111|M|src/edge_platform/scheduler/reservation.py:38-44|_overlaps 时间戳解析失败返回 False|malformed 时间戳静默放行重叠预约|解析失败时 raise 或视为冲突
EDGE-112|M|src/edge_platform/scheduler/optimizer.py:261-265|request_id 三元表达式对非 dict policy 恒返回空串|isinstance(policy,dict) 为 False 时走 else ""，丢弃对象型 policy.request_id|改用 getattr 优先 + dict.get 兜底
EDGE-113|M|src/edge_platform/scheduler/learning_loop.py:263-269|_find_candidate 按 candidate_id 查找但传入的是 confirmed_plan_id|plan_id 与 candidate_id 概念不同，预测候选查找恒失败|统一标识或改用 plan_id→candidate 映射
EDGE-114|M|src/edge_platform/scheduler/cpsat/worker.py:513|--host 默认 0.0.0.0 绑定全接口|求解器 worker 无网络隔离时暴露 8000 端口|默认 127.0.0.1，由部署显式开放
EDGE-115|M|src/edge_platform/scheduler/scheduler_service.py:167-198|reconcile_from_cloud 在 advisory 模式下删持久化 plan，未过 _assert_writable|advisory 模式应禁写，但此处直接 storage.delete_schedule_plan|补 _assert_writable 或文档化例外
EDGE-116|M|src/edge_platform/scheduler/repository.py:255-260|_get_reservation_raw 全表扫描查单条预约|每次 update_reservation 调 list_reservations() 线性遍历|storage 增加 get_reservation(id) 接口
EDGE-117|M|src/edge_platform/scheduler/scheduler_service.py:622-625|replan 过滤 executing_locked/locked 状态在 Task 状态机中不存在|TASK_TRANSITIONS 无此二值|删除死条件或补契约状态
EDGE-118|M|src/edge_platform/scheduler/resources.py:61-66|_next_version 自增 self._seq 但返回 per-resource ver+1，_seq 为死代码|self._seq += 1 从未被读取|移除 _seq 或改用全局序号
EDGE-119|M|src/edge_platform/scheduler/world_state.py:39-44|_safe_call TypeError 兜底调 fn(storage) 语义错误|把 storage 传给自身方法，可能抛未捕获 TypeError|删除 TypeError 兜底或改为仅返 default
EDGE-120|M|src/edge_platform/scheduler/__init__.py:13|docstring 称"不依赖 OR-tools"但 cpsat/ 子目录实现真实 CP-SAT|与 ADR-003/cpsat/worker.py 矛盾|更新 docstring
EDGE-121|L|src/edge_platform/scheduler/constraints.py:24|HEALTH_TABOO="HEALTH禁忌" 中文字符混入标识符常量|与其他英文常量不一致|统一为 "HEALTH_TABOO"
EDGE-122|L|src/edge_platform/scheduler/events.py:56|int(version or 1) 使 version=0 变 1|版本 0 在某些语义下有意义|改为 int(version) if version else 1
EDGE-123|L|src/edge_platform/scheduler/route_planner.py:162-164|EuclideanRoutePlanner 无目标坐标时用 (x+1,y+1) 占位|reachable=True 但目标为伪造坐标|标记 reachable=False 或拒绝生成
EDGE-124|L|src/edge_platform/scheduler/__init__.py:224-229|learning_loop import 置于 __all__ 之后|import 顺序与导出声明分离|移至 __all__ 之前
EDGE-125|L|src/edge_platform/governance/model_registry.py:259-272|promote_to_shadow 跳过 submit_for_review/approve_review|文档称兼容捷径，但削弱安全评审强制要求|标记 deprecated 或加审计告警
```

### 6.3 EDGE-领域契约（EDGE-201~230）

```
EDGE-201|H|src/edge_platform/contracts/maintenance.py:75-77|Python 校验拒绝 disposition 字段，TS maintenance.ts 无此检查，契约漂移|if "disposition" in record ... return ["unexpected_field"] 而 TS validateMaintenanceCondition 不校验|与 TS 对齐：移除该检查或同步加入
EDGE-202|H|src/edge_platform/connectors/manifests/exoskeleton-frame-1.0.0.json:21|sourceType enum 允许 controlled_test，但世界契约只允许 real/simulated/derived|enum 与 world.py SOURCE_TYPES 不一致|收敛 enum 与世界契约一致或显式映射
EDGE-203|M|src/edge_platform/world_model/contract_store.py:199|snapshotVersion 设为随机字符串 new_id("WS")，无单调性|"snapshotVersion": new_id("WS") 每次随机 ID|使用单调递增整数计数器
EDGE-204|M|src/edge_platform/backup/manager.py:106|_dump_tables 用 f-string 拼接表名到 SQL，若 key_tables 用户可控则 SQL 注入|f"SELECT * FROM {t}"|白名单校验表名或用 quote_identifier
EDGE-205|M|src/edge_platform/backup/manager.py:132-134|restore 可删除任意路径文件无白名单校验|if os.path.exists(db_path): os.remove(db_path); shutil.copyfile(...)|校验 db_path 在允许目录内
EDGE-206|M|src/edge_platform/scripts/replay_device.py:153|frame_file 直接拼接路径可路径穿越读任意文件|os.path.join(session_dir, frame.get("frame_file","")) 含 ../ 可逃逸|规范化路径并校验仍在 session_dir 内
EDGE-207|M|src/edge_platform/connectors/sparkplug.py:281|time.gmtime 对超大 timestamp_ms 抛 OverflowError 未捕获|payload.timestamp_ms/1000 后 gmtime 可能溢出|try/except 或校验范围
EDGE-208|M|src/edge_platform/connectors/webhook.py:35|getattr(hashlib, algorithm) 若非法返回 None，后续 hmac.new 抛 TypeError 未处理|默认 sha256 安全，但非法值会崩|白名单算法或 try/except
EDGE-209|M|src/edge_platform/perception/pose_fusion.py:243|degrade_on_camera_lost 非幂等，多次调用 confidence 重复折减|state.confidence = confidence_from_quality(DEGRADED, state.confidence) 每次乘 0.7|标记已降级或用原始 confidence 计算
EDGE-210|M|src/edge_platform/monitoring/collector.py:174,179|except Exception: open_event_count = 0 静默吞所有异常|storage 错误被吞|至少 log.warning 记录异常
EDGE-211|M|tests/test_ts_python_contract_parity.py:1-10|parity 测试仅覆盖 scheduler/cpsat 契约，未覆盖 world/maintenance/quality/reasoning_trace 等核心契约|测试名声称 TS/Python 契约 parity 但实际只 cpsat|扩展 parity 测试覆盖全部共享契约
EDGE-212|L|src/edge_platform/aas/codec.py:245-256|redact_aas 类型注解为 dict 但若传非 dict 会 AttributeError|for key, value in document.items() 若 document 是字符串|早返回非 dict 输入
EDGE-213|L|src/edge_platform/aas/codec.py:216-231|unpack_aasx 未防御 zip bomb|archive.read("aasx/aas.json") 可被超大压缩成员耗尽内存|限制解压大小
EDGE-214|L|src/edge_platform/collection/dataset.py:122|open(win_path,"rb").read() 文件句柄泄漏|未用 with 上下文管理器|改用 with 上下文
EDGE-215|L|src/edge_platform/collection/dataset.py:58|assert 做数据校验，-O 模式下被跳过|assert len(set(allp))==len(allp)==n|改用 if + raise
EDGE-216|L|src/edge_platform/scripts/record_raw_frames.py:175|open(self.index_path,"w").close() 文件句柄泄漏|未用 with|改用 with 上下文
EDGE-217|L|src/edge_platform/scripts/record_raw_frames.py:303|--host 默认 0.0.0.0 绑定所有接口|默认暴露 TCP 9001 到局域网|默认 127.0.0.1
EDGE-218|L|src/edge_platform/connectors/csvfile.py:155|queue 满时静默丢消息|except queue.Full: pass|至少 log.warning + 计数
EDGE-219|L|src/edge_platform/connectors/modbus.py:179|_enqueue_raw queue.Full 静默丢|except queue.Full: pass|log.warning + 计数
EDGE-220|L|src/edge_platform/perception/uwb_fusion.py:54|函数参数名 typo num_beaacons（多 a）|def estimate_uwb_confidence(num_beaacons, ...)|改名 num_beacons
EDGE-221|L|src/edge_platform/contracts/decision.py:219-237|approver 校验逻辑冗余（双重 dict 检查）|if needs_approver: if not isinstance(approver,dict) 之后又重复|合并简化
EDGE-222|L|src/edge_platform/contracts/outcome_annotation.py:62-65|int 值跳过 NaN/Inf 检查路径|isinstance(value,float) 才查 NaN，int 不进检查|对 int 也走安全路径或注释说明
EDGE-223|L|src/edge_platform/connectors/opcua.py:49-51|OPC UA nodeId 重复 identifier 静默后者覆盖|for part in parts: elif part.startswith("i="): identifier = part[2:]|检测重复并报错
EDGE-224|L|src/edge_platform/connectors/runtime.py:21-24,153|redact_config 仅匹配 password/secret/token/api_key/private_key/credential，遗漏 auth/bearer|SECRET_KEY_PATTERN 未含 auth|bearer|扩充模式
EDGE-225|L|src/edge_platform/static/index.html:142|esc() 不转义单引号|replace(/[&<>"]/g,...) 缺 '|加 ' 转义
EDGE-226|L|src/edge_platform/perception/vision_adapter.py:54|用 or 短路，若 hip=[0,0,0] 会回退到 hips|skeleton_json.get("hip") or skeleton_json.get("hips")|显式 None 检查
EDGE-227|L|src/edge_platform/contracts/reasoning_trace.py:163|evaluate_rules 生成的 conclusionId 用 decision: 前缀但 trace_id 不一定符合 VALUE_PATTERN|f"decision:{trace_id}-..."|校验 trace_id 形状或用 hash
EDGE-228|L|src/edge_platform/world_model/contract_store.py:177-191|snapshot 直接遍历 self._store._history 内部结构（破坏封装）|for group in self._store._history.values()|通过 StateStore 暴露 public iterator
EDGE-229|L|src/edge_platform/scenario/simulator.py:145|scorer.rank 异常静默吞|except Exception: pass|至少 log.warning
EDGE-230|L|src/edge_platform/contracts/state_machine_loader.py:87-94|parse_simple_yaml 仅支持内联 dict 格式，多行 dict 会抛 ValueError|elif line.startswith("- {") 仅识别内联|文档化限制或扩展解析器
```

### 6.4 EDT-边缘内嵌测试（EDT-001~018）

```
EDT-001|H|src/edge_platform/tests/test_task_assignment_sync.py:183|恒真断言掩盖非空校验意图|assertEqual(updated.actual_end, updated.actual_end) 注释称验"非空"实际恒真|改为 assertNotNull
EDT-002|H|src/edge_platform/tests/test_edge_security.py:223|内部异常脱敏测试未触达 500 路径|名为 test_internal_error_does_not_leak_exception_detail 实际用 invalid-token 触发 401|构造会抛 500 的路径并断言无 detail
EDT-003|H|src/edge_platform/tests/test_security_boundary.py:257|SQL 注入断言过弱无法区分注入与正常空答|仅断言 len(evidence)<=50 且无 error 键|增加正常查询返回非空 evidence 的对照断言
EDT-004|M|src/edge_platform/tests/test_server_routes_characterization.py:221|契约测试双解接受 200/409|assertIn(status,(200,409)) 同时接受成功与冲突|拆为 success 与 conflict 两个独立用例
EDT-005|M|src/edge_platform/tests/test_rbac_enforcement.py:147|匿名审计访问允许 401 或 403|assertIn(status,(401,403)) 状态码未钉死|明确期望 401 并钉死
EDT-006|M|src/edge_platform/tests/test_edge_security.py:186|production login 路径接受多种状态码|assertIn(status,(200,400))+条件分支断言|固定期望状态码
EDT-007|M|src/edge_platform/tests/test_event_uplink.py:99|失败计数路径未真正被测|test_post_failure_keeps_batch 名义测失败，但断言 failures==0 因直调不计|增加 loop 路径失败计数断言
EDT-008|M|src/edge_platform/tests/test_cpsat_worker_hardening.py:165,210|测试依赖 time.sleep(1.0/2.0) 触发超时|硬编码 sleep 在 CI 高负载下可能漂移|改用 mock 时钟或拉大预算裕度
EDT-009|M|src/edge_platform/tests/test_metrics_uplink.py:108|循环计数测试依赖 time.sleep(0.5)|assertGreaterEqual(batches,1) 在慢机可能未触发|改用 condition polling + 显式 flush
EDT-010|M|src/edge_platform/tests/test_event_uplink.py:87,117,129,153|多处 time.sleep(0.05) 轮询|异步行为用 sleep 轮询，CI 拥塞下偶发抖动|统一 _wait_until 抽象并加大 deadline
EDT-011|M|src/edge_platform/tests/test_adapter_supervisor.py:127|tearDown 静默吞所有异常|except Exception: pass|至少 log.warning
EDT-012|M|src/edge_platform/tests/test_security_boundary.py:218|production 语义下导出无 token 仍 200 的安全权衡未在 production mode 验证|fixture 为 development 模式|补 production 模式下匿名 export 期望用例
EDT-013|L|src/edge_platform/tests/test_backup.py:204|用 time.sleep(1.0) 区分备份时间戳|依赖 wall clock 分辨率|用 mock 时间或文件序号区分
EDT-014|L|test_security_boundary.py/test_api_endpoints.py/test_server_routes_characterization.py|_ServerFixture 在多个 TestCase 重复定义|三份近重复 fixture|抽到 tests/_fixtures.py 共享
EDT-015|L|src/edge_platform/tests/test_p0_acceptance.py:123,134,265,301,321|多处 datetime.now().astimezone() 写入审计时间戳|未固定时钟，跨时区跑测时间字符串不同|注入固定 clock fixture
EDT-016|L|src/edge_platform/tests/test_monitoring.py:154,280,291|time.sleep(0.01/0.0)+fake wfile.flush():pass|stub 隐藏真实 wfile.flush 语义|保留 stub 但加注释说明
EDT-017|L|src/edge_platform/tests/test_inference.py:33-99|FakeStorage/FakeBus 大量手写桩|与 stubs.Storage 重复实现|迁移到 stubs 共享实现
EDT-018|L|src/edge_platform/tests/test_multi_factory.py:261|CrossFactorySchedulerStub 状态断言为 "STUB"|V2.0 未实现的占位测试长期挂起|加 xfail 或 skip 标记显式声明
```

### 6.5 NEST-数据库层/入口/shared（NEST-501~525）

```
NEST-501|H|server/database/schema.ts:2045-2066|ewohAssignmentEvent Drizzle 表缺少 org_id 列|迁移 028 ADD COLUMN org_id varchar(255) 但 schema.ts 无 orgId 字段|补 orgId varchar 字段并加索引
NEST-502|H|server/database/schema.ts:519-541,928-948|ewohOrganization/ewohNotification 等 Drizzle orgId 类型与 RLS 函数 ewoh_org_visible(p_org_id uuid) 不匹配|多数表 orgId varchar(255) 但 RLS 函数参数为 uuid，隐式 cast 在非 UUID 值时抛错|统一 org_id 为 uuid 或改 RLS 函数签名
NEST-503|H|db/migrations/standalone_025_scheduler_rls.sql:57-70|scheduler RLS policy 允许 org_id IS NULL 行被所有租户可见且 WITH CHECK 允许写 NULL|policy org_id=COALESCE(...) OR org_id IS NULL 在 USING 与 WITH CHECK 中均放行 NULL|新 INSERT 不设 org_id 即跨租户泄漏；WITH CHECK 应拒绝 NULL
NEST-504|H|server/database/request-database-context.ts:27-34|DRIZZLE_DATABASE proxy 无事务时回落 rootDatabase（无 GUC/无 RLS）|this.storage.getStore() ?? this.rootDatabase 非 HTTP 路径直连根库|非 HTTP 消费者必须显式 runInTransaction 设置 GUC
NEST-505|M|server/modules/shared/org-context.interceptor.ts:84-101|SSE 端点与无 userContext 的请求跳过 GUC 事务|handlerIsSse 直通 next.handle()，不经 runInTransaction|确认 SSE handler 全部应用层 orgId 过滤
NEST-506|M|server/modules/shared/audit-chain.service.ts:25|AuditChainService chains 为内存 Map，未持久化|private readonly chains = new Map()，重启即丢|落库到 ewoh_audit_log 或标注仅供测试
NEST-507|M|server/app.module.ts:90-111|Legacy AppModule 缺 RateLimitGuard/MetricsInterceptor/TracingInterceptor|仅注册 AccessTokenGuard+RolesGuard|生产禁用 legacy 或补齐 guard/interceptor
NEST-508|M|server/modules/shared/redis.service.ts:70-92|Redis 不可用时限流回退内存，多实例下有效限额=max×实例数|memory fallback per-instance，无共享计数|共享存储或 Redis 故障时 fail-closed
NEST-509|M|server/database/request-database-context.ts:51-58|systemTransaction 绕过 GUC/RLS，allowlist 审计未覆盖|runInTransaction([]) 空设置，任何注入 RequestDatabaseContext 的服务可调用|扩展 root-db-allowlist 审计覆盖 systemTransaction 调用
NEST-510|M|server/common/pipes/validation.pipe.ts:45-50|ValidationPipe whitelist:false，未知属性透传|whitelist: false 不剥离非 DTO 字段，存在 mass assignment 风险|设 whitelist:true+forbidNonWhitelisted:true
NEST-511|M|server/modules/shared/org-scope.service.ts:97-136|OrgScopeService BFS 逐节点 loadChildren，宽层级 N+1 DB 调用|每节点一次 ewoh_find_org_children 调用，11000 节点=11000 次查询|批量加载子树或缓存全量
NEST-512|M|server/database/schema.ts:551,930,1361,2477|部分表 orgId 类型 uuid 与多数 varchar(255) 不一致|ewohSchedulerConfig/Notification/WorldSnapshot/AuditLog 用 uuid，其余 varchar|统一类型或显式 cast 策略
NEST-513|M|db/contracts/schema-manifest.yaml vs schema.ts|manifest 列出 73 张 managed 表但 Drizzle schema 缺约 20 张|ewoh_event_action/rule/subscription、ewoh_workstation*、ewoh_role/skill 等未定义|补齐 Drizzle schema 或标注未使用
NEST-514|M|server/standalone-main.ts:19-26,64-72|未使用 helmet，仅手工设 4 个安全头，缺 CSP/HSTS/X-Download-Options|applySecurityHeaders 只设 nosniff/DENY/no-referrer/X-XSS-Protection|引入 helmet 或补 CSP/HSTS
NEST-515|M|server/main.ts:11-37|bootstrapLegacy 无 CORS/安全头/trust proxy/body limit 配置|legacy 入口仅 useBodyParser 1mb|生产强制 standalone 或为 legacy 补齐
NEST-516|M|server/database/request-database-context.ts:65-66|EWOH_DB_STATEMENT_TIMEOUT_MS 默认 0（无超时）|Number(process.env.EWOH_DB_STATEMENT_TIMEOUT_MS || 0) 未设则无 statement timeout|生产设默认 30s 防慢查询占满连接池
NEST-517|L|server/database/schema.ts:67-69,83,107|escapeLiteral 仅转义单引号，sql.raw 拼接依赖 standard_conforming_strings=on|"'" + str.replace(/'/g, "''") + "'" 用于 userProfileArray/fileAttachmentArray|改用参数化或显式校验输入
NEST-518|L|server/modules/shared/db-idempotency.store.ts:7,33-49|DbIdempotencyStore 硬编码 DEFAULT_SCOPE|const DEFAULT_SCOPE = 'default' 跨 scope 同 key 会碰撞|接受 scope 参数
NEST-519|L|server/modules/shared/audit-chain.service.ts:29 vs schema.ts:2492|AuditChain 初始 prevHash='GENESIS' 与 DB default '0'.repeat(64) 不一致|内存链 GENESIS，DB 链 64 个零|统一初始值
NEST-520|L|server/modules/shared/org-scope.service.ts:85|OrgScopeService 缓存 per-instance，多实例失效不同步|private readonly cache = new Map 进程内缓存|用 Redis 或接受最终一致
NEST-521|L|server/database/schema.ts:2069-2090|ewohResourceReservation 缺 orgId 复合索引|其他表均有 idx_xxx_org_status，此表仅索引 resource/plan/task|补 idx_ewoh_resource_reservation_org
NEST-522|L|server/standalone-main.ts:57-99|未调用 app.disable('x-powered-by')|Express 默认暴露 X-Powered-By 头|显式 disable
NEST-523|L|server/modules/shared/rate-limit.guard.ts:19|/health 路径不匹配 /health/ 前缀|request.path?.startsWith('/health/') 漏 /health 无斜杠端点|改 startsWith('/health')
NEST-524|L|server/database/standalone.provider.ts:11-24|postgres 客户端未配置 SSL，依赖连接串参数|postgres(url, {...}) 无 ssl 选项|生产强制 sslmode=require
NEST-525|L|server/modules/shared/database-audit-sink.ts:10,18-33|DatabaseAuditSink db 类型为 any，丢失类型安全|@Inject(DRIZZLE_DATABASE) private readonly db?: any|用 PostgresJsDatabase 类型
```

### 6.6 NEST-调度模块代码上半（NEST-001~048）

```
NEST-001|L|scheduler/conflict-preview.service.ts:58|buildSnapshot(undefined as never) 绕过类型系统传 undefined|undefined as never 绕类型检查|改用 buildSnapshot(ctx) 透传租户上下文
NEST-002|M|scheduler/conflict-preview.service.ts:87|ctx 缺失时回退 primaryOrgId:'' SYSTEM_CTX|空 orgId 传入 loadForPlan 走 falsy 分支无 org 过滤|SYSTEM_CTX 应禁止用于约束加载，强制要求 ctx
NEST-003|M|scheduler/conflict.service.ts:193,198,236,270|findRowByConflictId 无 actor 时不带 org 过滤|acknowledge/resolve/suppress 跨租户匹配 conflictId|人工生命周期转移调用须强制传 actor
NEST-004|M|scheduler/constraint-loader.service.ts:50-55,81-86|orgId 为空串时 falsy 跳过 org 过滤|SYSTEM_CTX primaryOrgId:'' 导致无 org 过滤跨租户加载约束|空串应等同 null 显式拒绝或走不同分支
NEST-005|H|scheduler/candidate-engine.service.ts:379-380|riskMs 仅判 high 忽略 medium|heuristic 用 riskFactor() 处理 high+medium，candidate-engine 漏 medium 罚|candidate-engine computeScore 需对齐 riskFactor 语义
NEST-006|H|scheduler/candidate-engine.service.ts:385-395|computeScore 缺 changeoverMs|heuristic 传 changeCostMs+changeoverMs，candidate-engine 漏换型罚|候选评分须加 changeoverMs
NEST-007|H|scheduler/candidate-engine.service.ts:605-636|computeScore 无 stationId/queueLength 参数|heuristic 加 w.station*queueLength*waitMs 项，candidate-engine 漏工位排队成本|候选评分须含工位队列等待成本
NEST-008|M|scheduler/dispatch-coordinator.service.ts:84-89|dispatch 初始 select plan 无 org 过滤|事务前 SELECT 不带 GUC，依赖 RLS 兜底但时序有缺口|SELECT 应加 buildPlanOrgCondition 或移入事务
NEST-009|L|scheduler/dispatch-coordinator.service.ts:184,267|无 plannedStart 时用 Date.now()|每次 dispatch 重试 startMs 不同，预占时间漂移|用 plan 固定基准时间或快照 nowMs
NEST-010|M|scheduler/execution.service.ts:73-78|createFromPlan 存在性检查非原子|SELECT 后 INSERT 间并发可产生重复行|依赖 DB 唯一约束或 ON CONFLICT DO NOTHING
NEST-011|H|scheduler/execution.service.ts:111-114|update 无 org 校验|任意 assignmentId 可跨租户改 execution 状态/偏差|update 前须 eq(orgId) 校验
NEST-012|M|scheduler/execution.service.ts:209-216|getByAssignment 无 org 过滤|已知 assignmentId 可跨租户读 execution|加 org 条件或守卫
NEST-013|M|scheduler/outbox.service.ts:84-115|enqueueThrottled SELECT-then-UPDATE/INSERT 竞态|并发同 entityId 可双 INSERT 破坏节流|改用 upsert 或 SELECT FOR UPDATE
NEST-014|H|scheduler/outbox.service.ts:137-145|listSince 无 org 过滤|SSE replay 返回全租户事件，跨租户数据泄露|加 orgId 过滤条件
NEST-015|H|scheduler/outbox.service.ts:148-155|listLatest 无 org 过滤|同上，跨租户事件泄露|加 orgId 过滤
NEST-016|M|scheduler/outbox.service.ts:126-134|publishPending 无 org 过滤|标记全租户 pending 为 published，混租户副作用|按 org 作用域或加 org 参数
NEST-017|M|scheduler/outbox.service.ts:107-112|throttle 更新只改 payloadJson|opts(entityType/correlationId 等) 在更新路径丢失|更新时合并 opts 字段
NEST-018|M|scheduler/kpi.service.ts:50-52|orgId=null 时聚合全租户|listAll(null) 返回全租户 execution，conflict 无 actor|强制 orgId 非空或显式 ALL 语义
NEST-019|M|scheduler/kpi.service.ts:89|replanCount 回退 periodExec.length|用执行数冒充重排数，KPI 语义错误|回退应为 null 或 0
NEST-020|M|scheduler/impact-analyzer.ts:169-178|SAFETY_EVENT 按 zoneId 过滤候选|entityId 可能是 person/device 而非 zone，圈不中任务|SAFETY_EVENT 须按 person/device 维度过滤
NEST-021|M|scheduler/impact-propagation.ts:206-218|SAFETY_BLOCK 无条件扩散全部安全阻断资源|无关触发(如 ROUTE_BLOCKED)也纳入全部安全阻断任务|仅当 triggerType 相关时扩散
NEST-022|L|scheduler/impact-propagation.ts:141-146|maxAffectedTasks 截断静默丢任务|超限直接 return false 无日志|截断时 warn 留痕
NEST-023|L|scheduler/cp-sat-scheduling-solver.ts:318-324|malformed body 时 reachable=false|worker 已响应非 JSON 应为 FALLBACK 却标 UNAVAILABLE|malformed 路径设 reachable=true
NEST-024|M|scheduler/decision-ledger.ts:29-41|appendPlanDecisionRecords 无 org 校验|where(eq(planId)) 不带 org，跨租户可追加决策记录|加 org 条件或调用方守卫
NEST-025|H|scheduler/plan-compare.service.ts:123-124|churn 分子双重计数|added+removed+diffByTask(length 已含 added/removed) 导致 2*(A+R)+C|分子应仅用 diffByTask.length
NEST-026|L|scheduler/plan.service.ts:611-615|dispatchPlan 先查 isShadow 后租户守卫|跨租户 shadow 方案泄露存在性(SHADOW_PLAN_GUARD vs 404)|先 assertPlanTenantVisible 再查 isShadow
NEST-027|M|scheduler/plan.service.ts:687-697|loadEffectiveConstraints ctx 缺失回退 SYSTEM_CTX|空 orgId 走 falsy 无 org 过滤，跨租户约束加载|强制传 ctx 或拒绝空 orgId
NEST-028|H|scheduler/plan.service.ts:703-744|deactivateConstraint 无 org 校验|SELECT/NotFound 不带 org，跨租户可触发停用|SELECT 加 org 条件 + UPDATE 返回行数校验
NEST-029|H|scheduler/plan.service.ts:833-860|replan 插入全部 effectiveConstraints 含继承项|注释说仅落新请求项但代码未过滤，constraintId 冲突或重复行|过滤掉 c.id 已存在的继承约束
NEST-030|M|scheduler/plan.service.ts:895-937|comparePlans 调 getPlan 不传 actor|无租户校验，跨租户方案对比|getPlan 须传 ctx
NEST-031|H|scheduler/policy-activation.service.ts:232-247|active 行查找无 org 时不过滤|opts.orgId 缺失可选中他租户 ACTIVE 行并归档|强制 orgId 非空或显式 ALL 守卫
NEST-032|H|scheduler/policy-activation.service.ts:307-348|rollback 无 org 校验|任意 activationId 可跨租户回滚策略|加 org 条件 + 归属校验
NEST-033|M|scheduler/policy-activation.service.ts:374-382|requestDatabaseContextSafe 未用 ctx/GUC|db.transaction 无 RLS 上下文，策略写绕过租户隔离|注入 RequestDatabaseContext 并 buildGucSettings
NEST-034|L|scheduler/policy-activation.service.ts:213-219|抛裸 Error 非 HttpException|not found/already active 应 404/409 却返 500|改用 NotFoundException/ConflictException
NEST-035|H|scheduler/policy-replay.service.ts:374-403|solveSidePersist 丢弃 seed/ctx|void seed; void ctx; 不透传 solver，确定性 replay 保证失效|seed 须传入 SolverService.solve
NEST-036|M|scheduler/policy-replay.service.ts:60-66,192-202|latestSnapshotRow 无 org 过滤|取全租户最新快照做 replay，跨租户事实污染|按 ctx.primaryOrgId 过滤快照
NEST-037|M|scheduler/policy-replay.service.ts:320-333|getReplayRecord 无 org 校验|跨租户读 replay 记录|加 org 条件
NEST-038|L|scheduler/policy-replay.service.ts:209,213|抛裸 Error 非 HttpException|not found 返 500 而非 404|改用 NestJS 异常
NEST-039|H|scheduler/replan-preview.service.ts:79,197-208|loadBaselinePlan 不传 ctx 调 listActivePlans|listActivePlans 无 org 过滤，预览基线可能取自他租户|listActivePlans 须接 ctx 并加 org 条件
NEST-040|L|scheduler/replan-coordinator.service.ts:393-403|touchOrgState 注释说 LRU 实为 FIFO|oldest key 淘汰非最近最少使用|改 LRU 或修正注释
NEST-041|M|scheduler/replan-coordinator.service.ts:997-1042|aggregateReservationConflicts O(n²)|大预占集下全对扫描性能差|按 resourceType+resourceId 分组后组内扫描
NEST-042|M|scheduler/conflict.service.ts:796-812|loadAllRows 无 actor 时无 org 过滤|reconcile 调用 line 698 不传 actor，全租户行参与归并|reconcile 须传 actor 或加 org 条件
NEST-043|M|scheduler/prediction/shadow-evaluator.service.ts:348-370|listObservations orgKey='ALL' 时无 org 过滤|ctx 缺失返回全租户观察|强制 ctx 或默认拒绝
NEST-044|M|scheduler/prediction/shadow-evaluator.service.ts:433-441|pruneObservations 无 org 过滤|单租户调用清理全租户观察|加 org 作用域或限定系统调用
NEST-045|L|scheduler/prediction/shadow-evaluator.service.ts:316|硬编码 'deterministic-v1'|应用 DETERMINISTIC_MODEL_VERSION 常量|引用常量避免漂移
NEST-046|M|scheduler/prediction/duration-model-training.service.ts:218-222|hydrateFromRegistry 全表扫描后 JS 过滤|无 SQL org 过滤，大注册表性能差|SQL 层加 orgId 或 modelId 前缀过滤
NEST-047|L|scheduler/outbox.service.ts:43,execution.service.ts:79,policy-activation.service.ts:251|ID 用 Date.now()+Math.random()|非密码学随机，高并发碰撞风险|改 crypto.randomUUID()
NEST-048|L|scheduler/heuristic-scheduling-solver.ts:1110,candidate-engine.service.ts:378|loadPenalty 硬编码 60*1000|魔法数字无文档|提取常量并注释单位语义
```

### 6.7 NEST-调度模块代码下半（NEST-101~170）

```
NEST-101|C|scheduler/world-state.service.ts:170-202|collectState 全部 7 张表查询无 org 过滤|select().from(ewohProductionTask) 等无 where(orgId)|依赖 RLS 兜底，应补应用层 org 过滤
NEST-102|C|scheduler/resource-projection.service.ts:92-99,661-667|project/projectForSnapshot 无 org 过滤|db.select().from(ewohPersonnel) 无 where|同 NEST-101，需 ctx 透传与 org 过滤
NEST-103|C|scheduler/resource-reservation.service.ts:218-253|listActive/hasConflict 无 org 过滤|select 无 where orgId|跨租户预占暴露；加 org 过滤
NEST-104|C|scheduler/scheduling-policy.service.ts:305-308,407-410|savePolicy/activate 跨租户 deactivate 所有 active|update set active=false where active=true 无 org|加 org 过滤，按租户隔离激活
NEST-105|C|scheduler/scheduling-policy.service.ts:459-466|findActiveRow 无 org 过滤|where(active=true) orderBy desc 无 orgId|getActivePolicy 返回他租户策略
NEST-106|C|scheduler/scheduler-query.service.ts:218-219|listRuns activePlanRows 无 org 过滤|inArray(status,...) 无 orgId 条件|活跃方案跨租户聚合；补 actor 过滤
NEST-107|C|scheduler/scheduler-query.service.ts:675,1051|buildConflicts 用 getCurrentWorldState() 无 ctx|worldStateSnapshotService.getCurrentWorldState() 无 ctx|冲突列表跨租户；emitNewConflicts 推 null orgId
NEST-108|C|scheduler/scheduling-feedback.service.ts:480-512|list/deriveKpis 缺 orgId 时全表扫描|orgId? await db.select().from(...) 无 where|无认证调用→跨租户 KPI 暴露
NEST-109|C|scheduler/scheduling-context.service.ts:49|getUnifiedResourceState 不传 ctx|resourceProjectionService.getUnifiedResourceState() 无 ctx|context.resources 跨租户；应传 ctx 过滤
NEST-110|H|scheduler/scheduler-query.service.ts:109-114,244-261|getPlans/getAudit/getActivePlans 仅 actor 存在时过滤|if (actor) conditions.push(or(isNull,eq))|无 actor 路径跨租户；强制 actor 必传
NEST-111|H|scheduler/scheduler.controller.ts:333-336,419-421,431-433|getSnapshot/getTaskCandidates/calculateRoute 不传 userContext|getSnapshot() 无 actor 参数|controller 应注入 @Req userContext 并透传
NEST-112|H|scheduler/scheduler.controller.ts:793,826-834,889-899|previewConflictAction/listReplays/rollbackPolicy 缺 userContext 或取 query orgId|orgId ?? null 来自 query 参数|query orgId 欺骗路径，须改为认证上下文
NEST-113|H|scheduler/scheduler.controller.ts:591-597|SSE filter 无认证时放行全部事件|!viewerOrgId || event.orgId == null|无认证订阅者收到全租户事件
NEST-114|H|scheduler/scheduler-stream.service.ts:196-216|poll 推送前无 org 过滤|subject.next(toEvent(e)) 直接推|subject 订阅者跨租户；按 viewerOrg 过滤
NEST-115|H|scheduler/shadow-policy.service.ts:54-58,88-92,158-162|setStatus/generateShadowPlan/guardShadowPlan 无 org 校验|where(eq(configVersion)) 无 orgId|跨租户改策略状态/读 plan；补 assertTenantVisible
NEST-116|H|scheduler/travel-cost.service.ts:190-207,228-237|getCachedMatrix/persistMatrix 无 org 过滤|where(eq(taskId),eq(snapshotVersion))|taskId 跨租户碰撞误用缓存；加 org 维度
NEST-117|H|scheduler/scheduling-feedback.service.ts:207-216|recordAcceptance 按 planId 更新无 org 过滤|update where eq(planId)|无 ctx 时跨租户改 accepted；加 orgId 过滤
NEST-118|H|scheduler/routing.service.ts:75-88,143,253|loadGraph actor 缺省时无 org 过滤|calculateRouteBetween 内 this.loadGraph() 不传 actor|跨租户路由图；调用处透传 actor
NEST-119|H|scheduler/task-scheduling.bridge.ts:12,28-31|actor 缺失走 system ctx，注释"安全"误导|toOrgContext(undefined).primaryOrgId=''|无 actor 触发跨租户重排；要求 actor 必传
NEST-120|H|scheduler/scheduling-policy.service.ts:663-676|activationState 拒绝 RULE_BASED/MILP|仅 OFF/SHADOW/CANARY/PRODUCTION 通过|契约含 RULE_BASED/MILP；补全枚举
NEST-121|H|scheduler/scheduler-event-application.service.ts:311-316|recordTaskActuals 无条件返回 matched:true|return { ok:true, matched:true }|契约 matched 字段失真；按实际匹配返回
NEST-122|H|scheduler/task-dag.ts:40-56|cycle 处理致自指入结果集|descendants(A) 返回 {B,A} 含 A 自身|reach.size 多算 1；剔除 id 自身
NEST-123|H|scheduler/world-state.service.ts:374|lockedAssignments 过滤含非契约状态 'in_progress'|['executing','dispatched','in_progress']|task.yaml 无 in_progress；改用契约状态
NEST-124|H|scheduler/replan-coordinator.service.ts:263-296,212-252|advisory lock 释放后才做状态检查（TOCTOU）|tryAcquireCrossInstanceGuard 事务结束即释放锁|锁窗口外可并发通过；将状态读改入锁事务内
NEST-125|H|scheduler/replan-coordinator.service.ts:684-686,715-727|persistPlan 循环 + run 状态更新分离事务|for plan of plans await persistPlan 无外层事务|plan 2 失败时 plan 1 已落库；包统一事务
NEST-126|H|scheduler/resource-reservation.service.ts:90-97|station advisory lock 错误被静默吞|catch {} 无日志|生产锁失败时并发超卖；至少 logger.warn
NEST-127|H|scheduler/scheduling-feedback.service.ts:144-155|recordBaseline check-then-insert 非原子|select existing 后 insert 无 upsert|并发同 assignment 重复行；改 ON CONFLICT upsert
NEST-128|H|scheduler/scheduler-plan-application.service.ts:510-551,565-570|约束落库与 replan 非同事务|persist constraints 后 planService.replan 单独调用|约束已落但 replan 失败→脏状态；统一事务
NEST-129|H|scheduler/scheduler-run-orchestrator.service.ts:152-156|persistPlan 循环外置事务|for plan of plans await persistPlan 无外层事务|部分 plan 失败导致半持久化；包统一事务
NEST-130|M|scheduler/replan-coordinator.service.ts:658-681|suppression 路径 run 标 succeeded 但返回 run:null|update set status='succeeded' planIds=[] 后 return run:null|状态/响应不一致；返回 run 真实状态
NEST-131|M|scheduler/resource-reservation.service.ts:115|reservationId 仅 4 字符随机后缀|RSV-${Date.now()}-${randomSuffix(4)}|同毫秒 1/1.7M 碰撞；改 UUID
NEST-132|M|scheduler/route-cost-memo.ts:82-86|缓存 rejected Promise 不淘汰|cache.set(key, p) 失败也常驻|瞬时失败毒化缓存；失败时 evict
NEST-133|M|scheduler/routing.service.ts:174,253|refreshEdgeFactors/loadGraph 每次 calculateRouteBetween 调用|await this.refreshEdgeFactors() 每次拉 policy|N+1 DB；缓存 policy
NEST-134|M|scheduler/routing.service.ts:394|A* open.includes O(n) 查询|if (!open.includes(to)) open.push(to)|大图 O(n²)；用 Set 加速
NEST-135|M|scheduler/routing.service.ts:195|graphVersion 恒 null|graphVersion: null 返回 Route|丢失版本追溯；填 snapshot.worldVersion
NEST-136|M|scheduler/rule-based-scheduling-solver.ts:103-106,164|bookedTimeSlots 等数组 O(n) 扫描|bookedTimeSlots.push 后线性扫|大规模任务 O(n²)；改 Map 索引
NEST-137|M|scheduler/scheduler-event-application.service.ts:112-130,289-306|outbox enqueue fire-and-forget 不 await|Promise.resolve(...enqueue).catch|审计事件可能丢失；关键事件 await
NEST-138|M|scheduler/scheduler-metrics.service.ts:17,24,73-80|counters/gauges Map 无界增长 + planId 标签注入|counters.set(`...{plan_id="${planId}"}`)|内存泄漏 + Prometheus 标签注入；用 prom-client
NEST-139|M|scheduler/scheduler-metrics.controller.ts:29-33|/metrics 端点无认证|@Get() metrics() 无 guard|任何人可抓取；加 AuthGuard
NEST-140|M|scheduler/scheduler-run-orchestrator.service.ts:119-122|profileSuffix 筛选可能空 plans|plans.filter(p => p.planId === suffix)|筛选失败→succeeded+planIds=[]；显式 INFEASIBLE
NEST-141|M|scheduler/scheduler-stream.service.ts:200|POLL_BATCH=500 上限丢事件|listLatest(POLL_BATCH) 仅最新 500|突发>500 时旧事件丢失；用 sinceSequence 增量
NEST-142|M|scheduler/scheduling-objective-evaluator.service.ts:109|无效日期 assignment 静默跳过|if (!isFinite(startMs||endMs)) continue|指标少计无告警；至少 logger.warn
NEST-143|M|scheduler/solver.service.ts:138-221|solveVariants 三次全量 solve|for profile of profiles await this.solve|3× 求解耗时；并行或缓存
NEST-144|M|scheduler/solver.service.ts:280-283|feasible 判定不校验 assignment 合法性|assignments.length >= schedulable.length|违例仍标 feasible；加 violation==0 校验
NEST-145|M|scheduler/solver.service.ts:702-708|toSchedulingConstraints 不安全 as|c as unknown as SchedulingConstraint|类型逃逸；改 runtime 校验
NEST-146|M|scheduler/trigger.service.ts:58,124|无 actor 时 orgKey='ALL' + orgId=null|ctx.primaryOrgId || 'ALL' → run.orgId=null|跨租户触发去重共享；强制 actor
NEST-147|M|scheduler/trigger.service.ts:95-103|check-then-insert 幂等竞态|select existing 后 insert 无锁|并发同 triggerKey 双插入；用 ON CONFLICT DO NOTHING
NEST-148|M|scheduler/world-state.service.ts:599-600|worldVersion 数值累加可能溢出|1000 + versionSum + reservationList.length|大实体集精度损失；改 string hash
NEST-149|M|scheduler/world-state.service.ts:776-787,790-797|entityVersion djb2 32-bit 哈希碰撞|hash(JSON.stringify(obj)) 32-bit|不同状态误判 fresh；用 SHA-256
NEST-150|M|scheduler/world-state.service.ts:800-814|reservationsEqual 按索引比较|a.every((ra,i) => rb=b[i])|顺序变化误判 stale；改 Set 比较
NEST-151|M|scheduler/world-state.service.ts:416-417|safety event 无 deviceId 时静默跳过|reasons.push('no deviceId') 仅 warn|safety 事件被忽略；显式 safetyForbiddenZones 推导
NEST-152|M|scheduler/replan-preview.service.ts:197-208|loadBaselinePlan 不传 ctx|listActivePlans() 无 actor|基线方案跨租户；传 ctx 过滤
NEST-153|M|scheduler/replan-preview.service.ts:156-163|unchangedAssignmentCount 公式可疑|max(0, movable+frozen-changed-added-removed)|added/removed 与 movable 集合不交；改 set 运算
NEST-154|M|scheduler/resource-projection.service.ts:818-819|capacity=0 被当作 null|typeof se.capacity==='number' && se.capacity>0 ? : null|真 0 容量被误为未知；保留 0
NEST-155|M|scheduler/resource-projection.service.ts:887,891-892|toCoordinateFromDevice ?? 0 兜底坐标|lat: d.locationLat ?? 0|违背"禁止 0,0 伪坐标"；用捕获值
NEST-156|M|scheduler/scheduler-plan-application.service.ts:361-363|executionService.createFromPlan 失败仅 warn|catch (err) { logger.warn }|dispatch 成功但无 Execution 跟踪；返回警告字段
NEST-157|M|scheduler/scheduler-plan-application.service.ts:514-538|约束 orgId 用空串兜底为 null|orgId: ctx.primaryOrgId || null|无 actor 时变全局约束；强制 actor
NEST-158|M|scheduler/scheduler-query.service.ts:1115-1121|hash djb2 32-bit conflictId 碰撞|h = ((h<<5)+h+char) | 0|不同 seed 同 id 合并冲突；用 SHA-256
NEST-159|M|scheduler/scheduler-query.service.ts:698-731,954-978|buildConflicts O(n²) + stale_plan N+1|嵌套 for i,j + 逐 plan isPlanStale 调用|大规模慢；批量化 + 索引
NEST-160|M|scheduler/scheduling-feedback.service.ts:264-277|recordActuals update 无 orgId 过滤|update where and(...conditions)|跨租户改反馈行；加 orgId
NEST-161|M|scheduler/travel-cost.service.ts:226-272|persistMatrix check-then-insert 竞态|select existing 后 insert/update 无锁|并发双插入；用 ON CONFLICT upsert
NEST-162|M|scheduler/travel-cost.service.ts:157-178,318-335|buildEligibilityMatrix/computeMatrix 顺序 estimate|for task for person await estimate|O(tasks×persons) 慢；并行化
NEST-163|M|scheduler/travel-cost.service.ts:503-505|forbiddenZone 用 zoneId 比对 stationId|f.zoneId === task.stationId|不同 ID 空间；移除 stationId 比较
NEST-164|M|scheduler/travel-cost.service.ts:312-315|parseMatrixRow matrixId split('-') 脆|parts = row.matrixId.split('-')|taskId 含 '-' 时错位；改独立列
NEST-165|M|scheduler/scheduling-policy.service.ts:480-488|computeNextVersion 跨租户取 max+1|select orderBy desc configVersion limit 1|两租户同 version 碰撞；按 org 范围
NEST-166|M|scheduler/priority-engine.ts:314-317|rank 排序未稳定 tie-break|sort((a,b) => a.score - b.score) 无次键|同分时 rank 非确定性；加 taskId 次键
NEST-167|M|scheduler/replan-coordinator.service.ts:638|horizonMinutes 硬编码 480|horizonMinutes: 480|魔数；读 config.horizonMinutes
NEST-168|L|scheduler/task-lifecycle.ts:59|isTerminal 含非契约 'done'|['completed','cancelled','done']|task.yaml 仅 completed/cancelled；契约漂移
NEST-169|L|scheduler/rule-based-scheduling-solver.ts:253|hardConstraints 硬编码字符串|['skill-match',...]|未从 IR 派生；改 constraintIR 透传
NEST-170|L|scheduler/world-state.service.ts:704-737|deriveSafetyCritical/ProductionImpact 魔法字符串|criticalTypes.some(k => t.includes(k))|应入策略配置
```

### 6.8 NESP-调度内嵌测试（NESP-001~119）

```
NESP-001|H|scheduler/__tests__/batch6-safety-dispatch.spec.ts:70-74|弱断言：dispatch 失败仍通过|catch err 后仅断言 not.toContain('SAFETY_BLOCK_DISPATCH')，其余错误均放行|改为断言 dispatch 成功完成或显式断言无异常
NESP-002|H|scheduler/__tests__/batch10-shadow-eval.spec.ts:83|mock 掉被测服务自身方法导致恒过|comparePolicyVersion 被 spy 替换到实例上，断言仅验证 spy 被调用|注入真实 PlanCompareService 或额外断言对比产物字段
NESP-003|M|scheduler/__tests__/conflict-query-readonly.spec.ts:174|恒真断言无任何校验力|expect(res.conflicts.length).toBeGreaterThanOrEqual(0) 恒真|删除或改为 toBe(before)
NESP-004|M|scheduler/__tests__/candidates.spec.ts:106|弱断言：未验证 NotFound 契约|rejects.toThrow() 不区分异常类型|改为 rejects.toBeInstanceOf(NotFoundException)
NESP-005|M|scheduler/__tests__/conflict-lifecycle.spec.ts:277|真实时钟 setTimeout 脆弱|await new Promise(r=>setTimeout(r,5))|使用 jest.useFakeTimers() 或注入可控时钟
NESP-006|M|scheduler/__tests__/conflict-lifecycle.spec.ts:279|手动改行绕过时间过期逻辑|直接赋值 suppressUntil=new Date(now-1000) 模拟过期|用 fake timers 推进时间验证自然过期
NESP-007|M|scheduler/__tests__/prediction-provider.spec.ts:160|脆弱的正则结构断言|not.toMatch(/db|insert|update/i) 检查构造函数源码字符串|改为行为断言：注入 DB spy
NESP-008|M|scheduler/__tests__/outbox-throttled.spec.ts:98|where 硬编码 false 使测试桩与真实契约漂移|whereFilter=()=>false 使查询永不命中，恒走 insert 路径|模拟真实 WHERE 四条件过滤
NESP-009|M|scheduler/__tests__/golden-scheduler-scenarios.spec.ts:134-137|golden 更新模式静默返回无断言|UPDATE_GOLDEN_RESULTS=1 时 writeFileSync 后直接 return|更新模式下仍执行基本结构断言后再写
NESP-010|M|scheduler/__tests__/concurrency.spec.ts:60-71|mock CAS 未测真实 DB 级并发|Promise.allSettled 测 mock 控制的 CAS，非真实行锁|增加集成测试覆盖真实 DB 行锁或标注为单元级
NESP-011|M|scheduler/__tests__/conflicts.spec.ts:254-255|实时时钟依赖导致脆弱|reservation_expiring 用 Date.now()±偏移构造时间窗|注入固定 nowMs 或 jest.useFakeTimers
NESP-012|M|scheduler/__tests__/benchmark-scheduler.spec.ts:14,24-41|真实子进程 180s 超时 CI 脆弱|execFileSync 运行 benchmark 脚本，jest.setTimeout(180000)|标记 @slow 或移至独立 CI 作业
NESP-013|M|scheduler/__tests__/dispatch-integration.spec.ts:46-50 等|事务回滚路径无测试|runInTransaction mock 仅执行 cb()，无回滚场景|增加 cb 内抛错的事务回滚测试
NESP-014|L|scheduler/__tests__/policy-version.spec.ts:39-58|drizzle queryChunks 解析脆弱且 5 文件重复|matchesEq 解析 drizzle 内部 SQL 结构|抽取共享 test helper
NESP-015|L|scheduler/__tests__/overrides.spec.ts:39-141 + override-cas.spec.ts:37-122|重复 makeScheduler 工厂|两文件近乎相同的 setup 代码（~85 行）|抽取到 dispatch-test-harness 共享
NESP-016|L|scheduler/__tests__/golden-scheduler-workflow.spec.ts:259|手动删除 state.plans 规避 fake-db 限制|state.plans.delete(planId) 绕过 select 忽略 where 的缺陷|增强 fake-db where 实现或注明已知限制
NESP-017|L|scheduler/__tests__/batch6-event-cascade.spec.ts:16-24|fake select where 为 no-op|makeSelect 的 where/orderBy/limit 恒返回 q 自身，忽略所有过滤条件|实现基本 where 过滤或注明 fake-db 限制
NESP-101|M|scheduler/__tests__/replan-guard-failclosed.spec.ts:106,217-225|minimumReplanIntervalMs=5ms 计时脆弱|3 次同步 await 间距可能>5ms 导致 suppression 不触发|改用 replan-storm 的 60_000ms 大窗口模式
NESP-102|M|scheduler/__tests__/replan-multi-instance.spec.ts:103,186-199|同 5ms 计时脆弱 + 跨实例 gate 依赖 Promise 序|r1/r2/r3 间距假设<5ms|同 NESP-101
NESP-103|M|scheduler/__tests__/replan-multi-instance.spec.ts:207-219|fake db 用调用序奇偶区分 cooldown/dedup 查询|selectNo % 2 === 1 判定查询类型|改按 SQL 文本特征或显式标记查询身份
NESP-104|M|scheduler/__tests__/duration-model-training.service.spec.ts:39-50|matches() 用字符串前缀启发式匹配 org 值|v.startsWith('org') && !v.includes('_') 识别 org|按列名/绑定列身份匹配，不靠值前缀猜
NESP-105|M|scheduler/prediction/__tests__/shadow-evaluator-persistence.spec.ts:30-58|collectSqlTokens 按构造器名解析 drizzle AST|依赖 'SQL'/'Name'/'Param'/'PgVarchar' 内部构造器名|改用 drizzle toSQL() 或显式列名断言
NESP-106|M|scheduler/__tests__/scheduler-facade-characterization.spec.ts:469|metricsJson 断言含 solverStatus: undefined 死断言|toMatchObject({ solverStatus: undefined }) 中 undefined 字段被 Jest 跳过|移除 undefined 字段或改断言真实指标键
NESP-107|M|scheduler/__tests__/scheduler-facade-characterization.spec.ts:786-791|测试名承诺"静默跳过"但缺反向断言|dispatchPlanV2 noExecution 用例未断言 createFromPlan 未被调用|补 expect(...).not.toHaveBeenCalled()
NESP-108|M|scheduler/__tests__/scheduler-facade-characterization.spec.ts:707-724|getTaskCandidates 回退路径 eligible 断言等价测 mock|mock eligibilityService.check 恒返回 {eligible:true}|至少一组 eligible=false 候选验证拒派通路
NESP-109|M|scheduler/__tests__/scheduler-feedback-actuals-controller.spec.ts:83-100|声称测"缺匹配键→400"实则循环 mock|recordTaskActuals mock 被设为 reject(BadRequestException)，断言即 mock echo|真实 SchedulerService 调用或删除该用例
NESP-110|M|scheduler/__tests__/scheduler-facade-characterization.spec.ts:905-911|listConflicts 委托用例 mock 直接 echo|conflictService.listConflicts mock 返回空对象，断言 res 与之全等|断言委托参数 + 至少一条真实冲突字段映射
NESP-111|L|scheduler/__tests__/solver-contract-parity.spec.ts:297-314|测试名"可安全断言为 TS 类型"误导|运行时 TS 类型已擦除，实际仅做 typeof/包含抽查|改名为"结构抽查"以免误读
NESP-112|L|scheduler/__tests__/replan-preview.service.spec.ts:157-170|preview Delta 字段仅断言 toHaveProperty 存在|13 个 Delta 字段全用 toHaveProperty 检查键存在|补关键 Delta 数值断言（latenessDelta 等）
NESP-113|L|scheduler/__tests__/replan-kpi.spec.ts:103-108|stability 字段用 'x' in obj 断言键存在|仅键存在，不验值类型/缺省值|结合 typeof 与缺省 null 断言
NESP-114|L|scheduler/__tests__/shadow-plan-guard.spec.ts:64-90|approvePlan 同一调用重复两次以分别断言类与正则|两次 await expect(...).rejects 各调一次 approvePlan|单次调用 + and + regex 组合断言
NESP-115|L|scheduler/__tests__/world-state-derive.spec.ts:61-200|projectFromRows ~140 行复刻投影逻辑|测试态代码与 ResourceProjectionService 生产逻辑双写漂移风险|抽公共 fixture 工厂或直接构造最小投影输出
NESP-116|L|scheduler/__tests__/rls-org-filter.audit.spec.ts:144|org 过滤判定靠方法文本 includes('orgId'/'org_id')|注释或未使用变量含 orgId 字样即可误判通过（测试已自陈假阴性）|补运行时 SQL EXPLAIN 断言为强兜底
NESP-117|L|scheduler/__tests__/task-lifecycle.spec.ts:1-67|状态分类仅枚举硬编码字符串|无 source-of-truth 绑定|从 TaskLifecycle 导出常量集合并绑定测试
NESP-118|L|scheduler/__tests__/scheduler-facade-characterization.spec.ts:765-768,892-901|STALE_PLAN 用例仅断言 ConflictException 类未验原因|rejects.toThrow(ConflictException) 不区分 STALE_PLAN|补 toMatch(/STALE_PLAN/) 原因校验
NESP-119|L|scheduler/__tests__/trigger-entity-cooldown.spec.ts:50-66|fake db 用 vals.length>=3 启发式区分 cooldown/dedup 查询|查询参数数量变化即误分类|按绑定列名或 SQL 模板判别
```

### 6.9 NEST-运营四模块（NEST-201~231）

```
NEST-201|C|operations/operations.service.ts:208-248|readConfig/listConfigs/writeConfig 无 org_id 显式过滤|writeConfig insert 不设 orgId 仅靠 GUC 默认；readConfig/listConfigs 仅按 configKey LIKE 无 org 谓词|所有 list/transition 显式加 eq(orgId) 并在 insert 显式传 orgId
NEST-202|C|scale/scale.service.ts:210-215,334-339,462-468,499-505,563-569,853-858,807-814|listTemplates/listProfiles/listAssetPackages/listConnectors/listScenarioPacks/listMappings/listFactoryDifferences 无 org 过滤|select() 无 where(orgId)，跨租户全量返回|所有 list 查询加 eq(orgId, actor.primaryOrgId)
NEST-203|C|scale/scale.service.ts:816-851|resolveFactoryDifference 仅按 configKey 查询/更新无 org 过滤|eq(configKey) 跨租户可解析他租户 diff|where 加 eq(orgId) 并校验 row.orgId===actor.primaryOrgId
NEST-204|C|ingest/sensor-ingest.service.ts:80-122,127-198,201-235|ingestCamera/ingestSpatialScan/ingestLocation 不设 orgId|insert ewoh_world_state/ewoh_spatial_entity 无 orgId 字段；orgId 默认 null=legacy 全可见|controller 透传 userContext.primaryOrgId 并在 insert 设 orgId
NEST-205|C|ingest/ingest.service.ts:272-282,1030-1063 + schema.ts:991-1043|ewohDevice 唯一约束仅 deviceId 非 (orgId,deviceId)|onConflictDoUpdate target=deviceId 跨租户设备同 ID 互相覆盖|唯一约束改 (org_id,device_id) 或 insert 显式带 orgId 并加 RLS
NEST-206|H|ingest/ingest.service.ts:453-556|ingestEventBatch dedup 行先于 event 提交，event 写失败时 dedup 已落账永久阻断重放|dedupInserted=true 后 event insert 抛错仅 log+rejected，dedup 不回滚不进死信|event 写失败时回滚 dedup 行或落死信允许重放
NEST-207|H|operations/role-workbench.service.ts:762-868|LIST_SOURCES mapRow 用 snake_case row.step_id/schedule_task_id 等，drizzle 返回 camelCase|mySteps/delayedOrders/abnormalDevices/pendingInspections 列表 API 字段全 undefined|mapRow 改用 row.stepId/row.scheduleTaskId/row.entityId 等 camelCase
NEST-208|H|operations/workbench-export.service.ts:299-311 + workbench-export-state.ts:32-43|retryExportTask 校验 canTransition(status,'running') 却 set status='queued'|状态机 failed→queued/expired→queued 未声明；assertTransition 未调用，silent 违约|状态机补 failed/expired→queued 或 retry 改 set 'running' 经 claim 流转
NEST-209|H|operations/operations.service.ts:414-452,515-559,653-696|transitionAsset/transitionMaintenanceTask/transitionTool 读-改-写无乐观锁|readConfig→parse→mutate→writeConfig 无 version 谓词，并发转移丢失 history|writeConfig 加 version 乐观锁或 SELECT FOR UPDATE
NEST-210|H|ingest/ingest.controller.ts:85-91,106-112,114-120|ingestCamera/ingestSpatialScan/ingestLocation 不透传 userContext|controller 拿到 request 但不传 orgId，service 写入无租户归属|controller 传 request.userContext?.primaryOrgId 给 service
NEST-211|M|ingest/ingest.guard.ts:30-31,103-121|限流器 in-memory Map 按 IP 单实例|多实例部署有效限额=N×100 req/min|改 Redis 滑窗或网关层统一限流
NEST-212|M|operations/operations.controller.ts:125,131,156,184,216,245,261,277|@Body() body: Record<string,never> 后 as never 绕过 DTO 校验|类型与实际不符，缺字段延迟到 service 抛错|改用 class-validator DTO + ValidationPipe
NEST-213|M|operations/operations.controller.ts:304-314|actorOf 回退 userId='anonymous'/primaryOrgId='org-unknown'|OrgContext 缺失时审计为 anonymous，orgId='org-unknown' 写入污染|缺 context 时 401 而非回退占位
NEST-214|M|ingest/ingest.service.ts:249|批量路径 detectFaultTransition 不 await（fire-and-forget）|promise 未 catch 兜底|改 void this.detectFaultTransition(...).catch(err=>logger.warn)
NEST-215|M|ingest/ingest.service.ts:881-934|ingestMes 写失败返回 accepted=false 但 HTTP 200|客户端需 inspect body 才知失败|写失败抛 5xx 或返回 422
NEST-216|M|operations/workbench-export.service.ts:211-245|advance/complete/fail 在 task 未找到时跳过 assertTransition 仍调 store.update|对不存在 taskId 静默 no-op|task 未找到时 throw NotFoundException
NEST-217|M|scale/scale.service.ts:1027-1036,1067-1076|fleetUpgrade/fleetRollback 逐条 UPDATE 循环|N+1 写，fleet 大时事务长持锁|改单条 UPDATE ... WHERE profileId IN (...) 或批量 set
NEST-218|M|scale/scale.service.ts:807-814|listFactoryDifferences 用 like('diff.%') 无 org 过滤无分页|前缀 wildcard 全表扫描，跨租户暴露|加 eq(orgId) + LIMIT + 分页
NEST-219|M|scale/scale.service.ts:1234-1235|generateSupportBundle 调 this.tracingService?.list(20) 两次|两次调用间 traces 变化导致 traceCount 与 traces 数组不一致|缓存单次结果复用
NEST-220|M|work-orchestration/domain-persistence.service.ts:320-336|setIdempotencyAndCreate 并发竞态：两个事务均 getIdempotencyOn=undefined 后都跑 creator|onConflictDoNothing 仅合并 idempotency 行，creator 副作用双写|creator 前 SELECT FOR UPDATE 或预插 idempotency 占位行
NEST-221|M|work-orchestration/work-orchestration.service.ts:269-272,295-298|getItems/getEvidence limit 未传时 slice(offset) 无界返回|全量内存过滤+返回，大 graph 时 OOM/慢响应|limit 缺省时强制 clamp 到 MAX(如 200)
NEST-222|M|work-orchestration/work-orchestration.controller.ts:154-159|recoverExpired 用 primaryOrgId ?? 'default'|无 org 上下文时回收 'default' org 锁，跨租户误回收|无 orgId 时 400 拒绝
NEST-223|M|work-orchestration/work-orchestration.service.ts:692,737,762|acquireResourceDurable/releaseResourceDurable/renewResourceLock 用 primaryOrgId ?? 'default'|缺 ctx 时锁挂在 'default' org，跨租户共享|无 ctx 时 400 拒绝
NEST-224|M|ingest/ingest.service.ts:1195-1202|computeRawRef 含 record_id ?? ''，多帧同 device+event_time+battery+load 且 record_id 缺失时 raw_ref 碰撞|第二帧被静默 skip 当重复|raw_ref 不含 record_id 或必填 record_id
NEST-225|L|operations/dangerous-action.ts:103-128|buildCompensation switch 含 default 不可达分支|DangerousActionKind 已穷举|移除 default 或改 exhaustive check
NEST-226|L|operations/operations.service.ts:330-345|parseEfficiencyEntry fallback completedAt=nowIso()|configValue 缺 completedAt 时回退当前时间，语义误导|fallback 用 null 或 row.updatedAt
NEST-227|L|operations/role-workbench.service.ts:191-207|guarded() catch all 转 source_unavailable|错误仅 log 不抛，dashboard 静默退化掩盖真实故障|增加 metrics 计数器告警
NEST-228|L|ingest/__tests__/ingest-fault-transition.spec.ts:1-35|spec 仅测 isFaultTransition 纯函数|未覆盖 detectFaultTransition DB 查询路径、fireDeviceOfflineReplan 调用|补 DB mock 集成测试与 replan 触发断言
NEST-229|L|scale/scale.service.ts:1117-1171,1266-1349|sanitizeProfile/sanitizeTemplate/sanitizeAsset/validateSiteReadiness/ensureConnectorInstalled 等部分为死代码|validateSiteReadiness/ensureConnectorInstalled 无 controller 调用|确认是否公共 API 否则删除
NEST-230|L|operations/workbench-export.service.ts:276|cancelExportTask 返回 (await store.get(id)) as WorkbenchExportTask|update 后重读若被并发删除则 undefined 强转 TypeError|重读 undefined 时 throw
NEST-231|L|scale/compatibility.ts:61-66|matchesCoreRange 空 range 返回 true|未约束版本视为兼容，可能掩盖核心版本不匹配|未约束时显式标记 unconstrained
```

### 6.10 NEST-业务模块组（NEST-301~362）

```
NEST-301|C|mes/mes.service.ts:198-204|listWorkOrders 仅按 source='mes' 过滤，无 orgId 过滤|where(eq(source,'mes')) 无 org 守卫，跨租户工单可见|加 orgId 过滤或显式 RLS 断言
NEST-302|C|mes/mes.service.ts:237-256|createWorkOrder 写 ewohScheduleTask 未设置 orgId|task 行无 orgId 字段，落库为 NULL=全局可见|注入 actor.primaryOrgId
NEST-303|C|mes/mes.service.ts:330-340|getTrace 加载全部 quality 事件再内存过滤|select().from(ewohEvent).where(eq(eventType,'quality')) 无界+跨租户|改用 workOrderId/orgId 数据库过滤
NEST-304|C|mes/mes.service.ts:782-948|listSops/listQualitySchemes/getSop/getQualityScheme 无 orgId 过滤|ewohAssetPackage 查询无租户守卫|加 orgId 条件
NEST-305|C|agent/agent.service.ts:450-454|resolveApproval 仅按 approvalId 查询，无 orgId 守卫|where(eq(approvalId,approvalId)) 跨租户可解析|按 (orgId,approvalId) 查询
NEST-306|C|files/file.service.ts:78-83|list() 调 driver.list() 取全量再内存过滤|S3/Local 驱动返回所有 org 的 meta|驱动层接受 orgId 过滤
NEST-307|C|files/storage/s3-storage.driver.ts:125-149|S3 list() 对每个 meta key 单独 GetObject|N+1 查询+全量加载跨租户 meta 入内存|用 ListObjectsV2 + 批量读
NEST-308|C|gamification/gamification.service.ts:636-639|brainCache/brainEnhancing 为实例变量，跨 org 共享|LLM 增强结果被所有租户读取|按 orgId 分桶缓存
NEST-309|C|gamification/gamification.service.ts:783-912|buildRuleSuggestions/enrichBrain 查询 telemetry/event/device 无 orgId 过滤|跨租户聚合数据进建议|所有聚合加 orgId
NEST-310|C|gamification/gamification.service.ts:154-184|allocateResources 更新 ewohSpatialEntity 无 org 守卫|where(eq(entityId,alloc.entityId)) 可改他租户实体|加 orgId 条件
NEST-311|C|gamification/gamification.service.ts:560-618|sendExoFeedback 无设备 org 校验，事件无 orgId|跨租户可向他租户设备注入反馈|校验 device.orgId + 事件写 orgId
NEST-312|C|dashboard/dashboard.service.ts:46-90|getOverview 聚合 device/event/telemetry 无 orgId 过滤|全租户计数|加 orgId 条件
NEST-313|C|dashboard/dashboard.service.ts:92-130|getEnvironmentSummary 无 orgId 过滤|select distinct on (sensor_id) 跨租户|加 orgId 过滤
NEST-314|C|dashboard/dashboard.service.ts:132-294|getDevices/searchDevices/buildDeviceConditions 无 orgId 条件|设备查询跨租户|加 orgId 条件
NEST-315|C|dashboard/dashboard.service.ts:323-398|getEvents/getEventStats 无 orgId 过滤|事件跨租户可见|加 orgId 条件
NEST-316|C|dashboard/dashboard.service.ts:400-456|getTelemetry/getWorkers 无 orgId 过滤|遥测/人员跨租户|加 orgId 条件
NEST-317|C|dashboard/dashboard.service.ts:458-522|handleEvent 无 org 校验，任意租户可处理他租户事件|where(eq(eventId,eventId)) 无 org|校验 event.orgId
NEST-318|C|dashboard/dashboard.service.ts:524-620|createDevice/updateDevice 无 org 过滤，orgId 可 NULL|update where(eq(deviceId)) 跨租户改|加 orgId 条件+守卫
NEST-319|C|dashboard/dashboard.service.ts:678-788|bindDevice/unbindDevice 无 org 校验|可改他租户 spatial_entity 绑定|加 orgId 守卫
NEST-320|H|mes/mes.service.ts:279-291|writeScheduleOrder 插 task+steps 非事务|steps 失败留孤儿 task|包 db.transaction
NEST-321|H|mes/mes.service.ts:1135-1162|qualityInspection step 更新+event 插入非事务|部分失败致状态不一致|包事务
NEST-322|H|mes/mes.service.ts:60-94|nextWorkOrderStatus/nextStepStatus 硬编码，未引用 agent-task.yaml|状态机与契约脱钩，漂移无门禁|从 yaml 加载或共享函数
NEST-323|H|mes/mes.service.ts:60-73|MES 工单状态 draft/released/in_progress 与 ADR-012 workorder 契约 created/scheduled/in_progress 不一致|契约漂移|对齐 ADR-012 或显式标注 alias
NEST-324|H|agent/agent-orchestrator.service.ts:91-106|createTask 并发预算检查 TOCTOU|两并发 createTask 同时过预算检查|用 SELECT FOR UPDATE 或唯一约束
NEST-325|H|agent/agent-orchestrator.service.ts:70-89|依赖环检测 BFS 每节点一次查询|N+1 查询，大图慢|批量 IN 查询
NEST-326|H|agent/agent-orchestrator.service.ts:240-258|listTasks 无分页|select().from(ewohAgentTask).where(eq(orgId)) 无 limit|加分页
NEST-327|H|agent/agent.service.ts:573-609|executeAuthorized（审批后执行）未包 withTimeout|审批后命令无超时强制|包 withTimeout
NEST-328|H|agent/agent.service.ts:683-693|withTimeout 不取消底层 promise|超时后 DB 写仍可能完成→未处理 rejection|加 AbortSignal 或文档化
NEST-329|H|agent/agent.service.ts:301-304|stepsUsed 来自客户端 payload，可传 0 绕过|input.payload?.stepsUsed ?? 0 用户可控|服务端累计计数
NEST-330|H|gamification/gamification.service.ts:249,264,427,441,519,575|orgId 回退 NULL，NULL 行被所有租户可见|actor?.primaryOrgId ?? null + attachPlanIds or(isNull(orgId))|强制要求 actor
NEST-331|H|dashboard/dashboard.service.ts:548|createDevice orgId 回退 NULL|actor?.primaryOrgId ?? null 全局可见|强制 actor 或拒绝
NEST-332|H|learning/outcome-annotation.service.ts:58-82|create 幂等检查 TOCTOU，无 23505 处理|两并发同 annotationId 第二个抛 500|catch 唯一键冲突回读
NEST-333|H|learning/learning.service.spec.ts:75-94|fake DB 对 ewohAiSuggestion/ewohEvent/ewohSchedulingFeedback 的 where 子句被忽略|聚合表总是返回硬编码行，org 过滤未测|fake 须尊重 where 条件
NEST-334|H|files/file.service.ts:152-160|assertScanned 仅阻 pending/infected，undefined 放行|scanStatus?: ScanStatus 可选，旧记录 fail-open|缺省视为 pending
NEST-335|M|mes/mes.service.ts:259,436,562,647,694,771,909,963|audit orgId 回退空字符串|actor?.primaryOrgId ?? ''|统一为 actor 必填或 null
NEST-336|M|mes/mes.service.ts:618-636|forceResolveStep 吞所有非 ConflictException 错误|note=error.message 但 applied=false，调用方不知失败原因|非冲突错误应抛出
NEST-337|M|files/file.service.ts:109-121|markScanned 重写整个文件内容以更新 meta|读 20MB 写 20MB 仅改 scanStatus|驱动层支持 meta 独立更新
NEST-338|M|files/file.controller.ts:113-123|download 用 res.send(buffer) 全内存|20MB×并发可 OOM|改用 stream
NEST-339|M|files/storage/local-storage.driver.ts:9-13|save 先写 content 再写 meta，非原子|meta 失败留孤儿 content|事务或先 meta 后 content
NEST-340|M|files/storage/local-storage.driver.ts:65-71|path(id)/metaPath(id) 未在驱动层校验 id|依赖上游 isValidUuid，驱动直接调用不安全|驱动层加 UUID 校验
NEST-341|M|agent/agent.service.ts:274-282|审批创建后 notifyApprovalPending 失败仅 warn|通知旁路但无重试|文档化或加 outbox
NEST-342|M|learning/learning-proposal.service.ts:109-137|shadow 更新无 CAS(where status=current)|两并发 shadow 可能重复覆写|加 status CAS
NEST-343|M|learning/learning-proposal.service.ts:140-238|approve/reject/rollback 无 CAS|TOCTOU，并发重复解析|加 status CAS
NEST-344|M|learning/learning-proposal.service.ts:103-104,170,203,236|recordEvent 与状态更新非事务|事件失败状态已改|包事务或 outbox
NEST-345|M|learning/learning.service.ts:117-136|evaluate insert+recordEvent 非事务|事件失败评估已落库|包事务
NEST-346|M|dashboard/dashboard.service.ts:632-651|getDeviceBindings 层级遍历 N+1|每层一次查询|递归 CTE 或批量
NEST-347|M|dashboard/dashboard.service.ts:323-331|getEvents limit 无上限|parseInt(limit) 可传 1e9|Math.min(limit,500)
NEST-348|M|dashboard/dashboard.service.ts:400-407|getTelemetry limit 无上限|同上|加上限
NEST-349|M|dashboard/dashboard.controller.ts:40-44|parseInt(batteryMin/Max) 无 NaN 校验|parseInt('abc')=NaN→gte(col,NaN) 行为未定义|用 ParseIntPipe
NEST-350|M|dashboard/device-contract.controller.ts:1-44|与 dashboard.controller 设备端点重复|两套路由同服务|合并或文档化职责
NEST-351|M|gamification/gamification.service.ts:52-100|getRole 从 env 读取，全实例单角色|所有用户看到同一角色|从 userContext 读
NEST-352|M|gamification/gamification.service.ts:191|skillMatch 硬编码 0.8|// 暂无技能数据，默认 0.8 误导|返回 null 或显式 unknown
NEST-353|M|gamification/gamification.service.ts:1019-1024|randomSuffix 用 Math.random|ID 后缀非密码学安全|用 randomUUID
NEST-354|M|files/file.service.spec.ts:144-160|测试名"rejects forged duplicate from another org"但实际用 userA(同 org)|未真正测跨 org 幂等拒绝|加 orgB 调用断言
NEST-355|M|learning/outcome-annotation.service.spec.ts|未测空 orgId 拒绝路径|service 88-90/105-107 的 BadRequest 未覆盖|补 orgId='' 用例
NEST-356|L|mes/mes.service.ts:96-117|sanitizeExceptionAttachments 未限附件数|可存任意长度数组|加上限
NEST-357|L|files/file.controller.ts:44-56|maxUploadBytes 在装饰器求值一次，运行时改 env 无效|而 allowedMimeTypes 每请求读|统一为启动时或都运行时
NEST-358|L|files/storage/storage-driver.factory.ts:11-27|REQUIRE_OBJECT_STORAGE 非 true 时静默回退本地|prod 误配可能用本地存储|prod 强制 true
NEST-359|L|agent/agent-metrics.service.ts:17|counters 为内存 Map，重启丢失|指标旁路但无持久化|接 metrics-export
NEST-360|L|gamification/gamification.service.ts:264,441,519|audit orgId 行缩进异常|orgId: 行无缩进|格式化
NEST-361|L|dashboard/dashboard.service.ts:496|handleEvent audit orgId 回退空字符串|actor?.primaryOrgId ?? ''|统一 null
NEST-362|L|agent/agent-orchestrator.service.ts:188|transition 用 (row.taskJson ?? {taskId}) 兜底|终态事件 taskJson 缺失时 subject 不完整|创建时校验 taskJson 非空
```

### 6.11 NEST-小模块组 a–m（NEST-401~450）

```
NEST-401|C|approval/approval-persistence.service.ts:155|createApproval 未写 org_id|insert ewohEvent 无 orgId，_actor 参数未使用|写入 actor.primaryOrgId
NEST-402|C|approval/approval-persistence.service.ts:192|getApproval 无租户隔离|where 仅 eventId+eventType，无 orgId 条件|加 orgId 过滤或 assertTenantVisible
NEST-403|C|approval/approval-persistence.service.ts:228|stepAction 无租户+角色校验|getApproval 无 org 检查，未校验 step.role 与 actor|加 org 守卫+step 角色匹配
NEST-404|C|approval/approval.controller.ts:64|bypass 缺 high_privilege_admin 校验|approval.yaml 要求 high_privilege_admin，fallback 仅 workshop_lead/safety_admin|显式 @Roles 或角色断言
NEST-405|C|approval/approval.controller.ts:74|cancel 缺 initiator 校验|approval.yaml 要求 role:initiator，任意 workshop_lead 可取消|校验 actor 为发起人
NEST-406|C|erp/erp.service.ts:91|receiveOrder 插入未设 org_id|insert 无 orgId 字段，actor 仅用于审计|写 orgId=actor.primaryOrgId
NEST-407|C|erp/erp.service.ts:129|listOrders 无租户过滤|where 仅 eventCode，跨租户返回全部 ERP 订单|加 orgId 条件
NEST-408|C|erp/erp.service.ts:160|receiveOutbound 未设 org_id|同 NEST-406，outbound 亦无 orgId|写 orgId
NEST-409|H|alert/alert.service.ts:59|transitionAlert 传 actor.role 恒 undefined|AccessTokenGuard 只设 roles 数组未设 role 单值|改用 actor.roles 派生
NEST-410|H|alert/alert.service.ts:59|safety_admin reopen 永久失效|roleSatisfies('safety_admin',undefined)=false，违反 alert.yaml closed→reopened|同 NEST-409 修复
NEST-411|H|model/model.service.ts:54|listModels/getModel/registerModel 无 org 隔离|无 orgId 过滤，registerModel 未设 orgId|加 orgId 过滤与写入
NEST-412|H|mobile/mobile.service.ts:60|listWorkbench 可查任意 personId|仅校验 actor.orgId，未校验 caller==personId（水平越权）|校验调用者身份或授权
NEST-413|H|ai/ai.controller.ts:29|dispatcher 可改全局 AI API key|@Roles 含 dispatcher，saveConfig 写全局哨兵 org 凭据|限制为 global_admin
NEST-414|H|ai/ark.service.ts:142|saveConfig 无审计|AI 配置(含密钥/base_url)变更未 appendAuditLog|加 audit log
NEST-415|H|approval/approval-persistence.service.ts:373|bypass 审计未标 high_risk|approval.yaml 要求 audit:high_risk，未传 risk:true|audit 调用加 risk:true
NEST-416|H|metrics/metrics.service.ts:25|requests Map 用原始 path 作 key|404 路径无界基数→内存耗尽 DoS（若 interceptor 激活）|用路由模板并限基数
NEST-417|M|auth/auth.service.ts:79|login 时序差致用户枚举|用户不存在立即返回，错密码走 bcrypt.compare|恒定时间或伪 compare
NEST-418|M|auth/auth.service.ts:148|access token 不可吊销|verifyToken 仅验签，登出只删 refresh，停用用户 8h 内仍可用|加黑名单或缩短 TTL
NEST-419|M|auth/auth.service.ts:178|JWT 过期参数 as never 绕类型|expiresIn 强转 never，畸形值签名时才抛错|校验格式或用类型安全封装
NEST-420|M|aas/aas.service.ts:137|importAsset 未写 orgId|insert 无 orgId，onConflict target 含 orgId 但插入省略|写 orgId
NEST-421|M|aas/aas.service.ts:167|listAssets/getAsset 无 org 过滤|跨租户读取全部 AAS 资产|加 orgId 过滤
NEST-422|M|ai/ai.service.ts:316|getSuggestion/getPlan 无 org 过滤|where 仅 suggestionId/plan id|加 orgId 条件
NEST-423|M|control/control.controller.ts:35|receipt 端点未传 actor|receiveReceipt 无 actor，应用层无租户守卫|传 userContext 并 assertTenantVisible
NEST-424|M|control/control.service.ts:315|revoke 允许 partial_success|control.yaml revoke 仅 non_executing/gateway_not_executed|收紧状态白名单
NEST-425|M|control/control.service.ts:205|attemptNo 读改写竞态|filter.length+1 非原子，并发可重复 attemptNo|加唯一约束或 DB 序列
NEST-426|M|erp/erp.service.ts:222|ackOutbound 读改写 evidenceJson|attempts 读后写无乐观锁，TOCTOU|加 status CAS 条件
NEST-427|M|metrics/metrics.controller.ts:15|/metrics @Public 泄露运营数据|未认证暴露请求量/DB 状态/工厂元数据|加鉴权或 IP 白名单
NEST-428|M|app.module.ts:90|MetricsInterceptor 未注册全局|providers 有但未 APP_INTERCEPTOR，/metrics 返回零值|注册 APP_INTERCEPTOR 或删死代码
NEST-429|M|metrics/metrics.interceptor.ts:29|error 路径 statusCode 未更新|tap error 时 response.statusCode 仍 200|异常过滤器后记录
NEST-430|M|ai/ai.controller.ts:96|visionUnderstand 转发用户 api_key/base_url|可注入恶意 base_url，image_url 无校验(SSRF)|剥离凭据覆盖或服务端固定
NEST-431|M|exo/exo-config.service.ts:316|recordEvent 吞事件失败|try/catch 仅 warn，审计事件丢失而主事实已提交|事务内事件或 outbox
NEST-432|M|exo/exo-config.controller.ts:60|currentOrgId 返回空串非抛错|与 exo-session 不一致，靠 service 兜底|统一抛 BadRequestException
NEST-433|M|alert/alert.service.ts:41|listAlerts/getAlert 无 org 过滤|依赖 RLS，应用层无 orgId 条件|加 orgId 过滤
NEST-434|M|knowledge/knowledge.service.ts:12|哨兵 org UUID 不一致|PLATFORM_SHARED_ORG_ID 与 ark GLOBAL_ORG_SENTINEL 不同|统一全局哨兵常量
NEST-435|M|identity/identity.service.ts:134|registerMapping 并发竞态|supersede+insert 无 23505 处理，并发会 500|加 23505 catch 回读
NEST-436|M|maintenance/maintenance.service.ts:134|transitionCondition 无乐观锁|where 无 status 条件，并发可重复建工单|加 status CAS
NEST-437|M|health/health.controller.ts:29|/ready @Public 暴露 DB 状态|未认证可探活 DB 并触发查询|限制访问或仅返回 live
NEST-438|L|auth/me.controller.ts:7|MeController 重复 AuthController.me|/api/me 与 /api/auth/me 重复|合并去重
NEST-439|L|ai/ark.service.ts:160|saveConfig updatedBy 硬编码|写死 'system-admin'，无操作者归属|用 actor.userId
NEST-440|L|approval/approval.service.ts:46|ApprovalService 内存版死代码|exported 但未接 HTTP，无 org/角色校验|删除或标 @deprecated
NEST-441|L|maintenance/maintenance.service.ts:64|subjectKind 派生脆弱|indexOf(':') 无冒号返回 -1，slice(0,-1)|用 split 并校验
NEST-442|L|ai/ai.service.ts:410|collectSystemContext 空 catch|遥测/事件/任务采集失败被静默吞|至少 logger.warn
NEST-443|L|ai/replan-guard-status.service.ts:26|recordDegradation 不可恢复|降级后永久 degraded 直到重启|加恢复机制或 TTL
NEST-444|L|mobile/mobile.service.ts:70|raw SQL org 过滤写法可疑|${table}.org_id = val::uuid 非惯用，可能生成非法 SQL|改用 eq(column, val)
NEST-445|L|erp/erp.service.ts:300|findByEvidence 插值 key|sql 模板 ${key} 作 jsonb 键名，当前硬编码但脆弱|白名单校验 key
NEST-446|M|model/model.service.spec.ts|transitionStatus 状态机未测|无 candidate→reviewing→shadow→active→retired 断言|补状态机用例
NEST-447|M|identity/identity.service.spec.ts:26|租户隔离未真正断言|fake where 返回全部行，未按 orgId 过滤|fake 按 orgId 过滤
NEST-448|M|maintenance/maintenance.service.spec.ts:26|租户隔离未断言|fake where 返回全部行，listConditions 未验跨租户|fake 按 orgId 过滤
NEST-449|L|ai/ai.service.spec.ts|多处未测|createPlan/chatWithContext/getSuggestion/getPlan/vision 未覆盖|补用例
NEST-450|L|ai/ark.service.spec.ts|saveConfig 审计缺失未测|无 appendAuditLog 断言（印证 NEST-414）|补审计断言
```

### 6.12 NEST-小模块组 n–z（NEST-601~648）

```
NEST-601|C|oee/oee.service.ts:213-222|calculateOee 质量查询无 deviceId/orgId 过滤|qualityRows 仅按 eventType+时间范围查全设备全租户|质量事件查询加 deviceId+orgId 条件
NEST-602|C|oee/oee.service.ts:166-180|recordDeviceStatus 插入 ewohEvent 未设 orgId|insert values 无 orgId 字段，auditLog orgId 回退空串|insert 携带 actor.primaryOrgId
NEST-603|C|oee/oee.service.ts:275-302|openAndon 插入事件未设 orgId|ewohEvent.insert values 无 orgId，跨租户可见|insert 携带 orgId
NEST-604|C|oee/oee.service.ts:193-203,327-334|listDeviceStatus/listAndons 无 orgId 过滤且无分页|仅按 eventType 过滤，跨租户返回全部行|加 orgId 条件 + LIMIT
NEST-605|C|world/world.service.ts:49-151|getCurrentState 全部查询无 orgId 过滤|spatialEntity+worldState+event 均无租户条件|加 orgId 过滤
NEST-606|C|world/world.service.ts:185-364|getReplay 五张表查询均无 orgId 过滤|worldState/event/task/step/binding 跨租户|加 orgId 条件
NEST-607|C|world/world.service.ts:410-479|createReplayItem 查源事件无 orgId 且插入无 orgId|select by eventId only; insert 无 orgId|加 orgId 过滤+写入
NEST-608|C|world-cursor/world-cursor.controller.ts:4-26|WorldCursorController 无 @Roles 装饰器|任何认证用户可取 snapshot/delta（跨租户）|加 Roles 限制
NEST-609|C|world-cursor/world-cursor.service.ts:108-215|getSnapshot/getDelta 无 orgId 过滤|snapshot 含全租户 entities，delta 跨租户|加 orgId 作用域
NEST-610|C|workflow/workflow.controller.ts:17-29,49-56|advance/advanceInstance 的 roles 从请求体传入|body.roles 而非 userContext.roles，越权绕过|roles 取自服务端 userContext
NEST-611|C|task/task.controller.ts:1-36|TaskController 无 @Roles 装饰器|任何认证用户可创建/转移任务|加 Roles 限制
NEST-612|C|task/task.service.ts:165-184|listTasks/getTask 无 orgId 过滤|select 全表无租户条件|加 orgId 条件
NEST-613|H|system/system.controller.ts:61-78|evaluateFeatureFlags 的 context 取自请求体|body.context.orgId/roles 可伪造，跨租户评估|context 取自 userContext
NEST-614|H|system/system.service.ts:59-87|listConfigs/getConfig 无 orgId 过滤|select 全表配置（跨租户）|加 orgId 条件
NEST-615|H|system/system.service.ts:6|maskSensitiveConfig 正则漏下划线变体|apikey 匹配但 api_key 不匹配，敏感值泄露|正则加 [_-]? 可选分隔
NEST-616|H|observability/frontend-metrics.service.ts:104-115|rateLimit 窗口过期后 windowStart 未更新|now-windowStart>=windowMs 恒真，每次 clear→限流失效|过期时重置 windowStart
NEST-617|H|resource/resource.controller.ts:1-46|ResourceController 无 @Roles 装饰器|任何认证用户可创建预占/发放/释放|加 Roles 限制
NEST-618|H|simulator/simulator.controller.ts:1-22|SimulatorController 无 @Roles 装饰器|任何认证用户可 start/stop 仿真器|加 Roles 限制
NEST-619|H|simulator/simulator.service.ts:129-148|手动 start() 绕过 EWOH_SIMULATOR_ENABLED 检查|仅查 DISABLED，未查 ENABLED，HTTP 可直接启动|start() 也检查 ENABLED
NEST-620|H|notification/email-transport.ts:152-158|邮件头注入：title 含 CRLF 可注入 Bcc 等|headerLines 直接拼接 message.subject，无 CRLF 过滤|过滤/拒绝含 \r\n 的字段
NEST-621|H|rule-engine/rule-engine.service.ts:193-212|tryFire 插入 ewohEvent 未设 orgId|insert values 无 orgId 字段|insert 携带 orgId
NEST-622|H|spatial/spatial.service.ts:15-130|getEntities/getTopology/getHierarchy 无 orgId 过滤|全部 select 无租户条件|加 orgId 条件
NEST-623|H|timeline/timeline.service.ts:21-50|getTimelineEvents 无 orgId 过滤且 limit 无上限|仅 status 过滤，parseInt 无 Math.min 上限|加 orgId + limit 上限
NEST-624|H|tracing/tracing.service.ts:117-165|getTrace 三面缝合无 orgId 过滤|spans/events/audit 均按 traceId 跨租户查|加 orgId 条件
NEST-625|H|workflow/workflow-instance.service.ts:108-175|list/advance 无 orgId 过滤|select by configKey only，跨租户可见+可操作|加 orgId 条件
NEST-626|H|shared/alert-state-machine.ts:36-41|handler 角色判定对 null 放行|roleSatisfies('handler',undefined)=true，fail-open|缺省应 fail-closed
NEST-627|M|quality/quality.service.ts:131-134|transitionFinding 更新无 CAS on status|WHERE 仅 eq(id)，无 eq(status)，并发竞态|加 eq(status,current.status)
NEST-628|M|workorder/workorder.service.ts:170-173|transitionWorkOrder 更新无 CAS on status|WHERE 仅 eq(orgId,id)，无 eq(status)|加 eq(status,current.status)
NEST-629|M|reliability/dead-letter.service.ts:139-144|requeue 先执行 handler 后更新状态|handler 成功但 update 失败→重复重放|先 CAS 更新再执行 handler
NEST-630|M|reliability/dead-letter.service.ts:168-171|discard 更新无 CAS on status|WHERE 仅 eq(orgId,id)，无 eq(status)|加 eq(status,current.status)
NEST-631|M|resource/resource.service.ts:94-155|createPreorder 可用量检查仅进程内锁|withResourceLock 不跨实例，多实例可超卖预占|DB 级条件 insert 或 SELECT FOR UPDATE
NEST-632|M|resource/resource.service.ts:240-326|release 无状态机校验|consumed/released 状态均可 release，重复返还|检查 status ∈ {pending,issued}
NEST-633|M|simulation/simulation.service.ts:67-75|run 幂等检查存在 TOCTOU 竞态|select 后 insert 间窗口，无 onConflict|加 onConflictDoNothing+回读
NEST-634|M|oee/oee.service.ts:99-107|computeOee performance 缺输出/理想率时默认 1|hasOutputQty 或 hasIdealRate 缺失→performance=1 掩盖问题|缺失时 performance=null 或告警
NEST-635|M|policy/policy.service.ts:118-125|evaluate 未匹配时 decision 默认 allow|deny 策略未匹配→allow，fail-open|根据 effect 语义明确默认决策
NEST-636|M|onboarding/onboarding.service.ts:87,103|开发 token 硬编码且 NODE_ENV 未设时生效|dev token='ewoh-demo-2026'，NODE_ENV≠production 即可用|删除硬编码 dev token
NEST-637|M|organization/organization.service.ts:199-222|listPersonnel 无分页|select 全表仅 orderBy，无 LIMIT|加分页
NEST-638|M|world-cursor/world-cursor.service.ts:108-172|getSnapshot 每次调用创建新 snapshot 行|写读膨胀 snapshot 表|仅当有 delta 时才新建
NEST-639|M|world-cursor/world-cursor.controller.ts:14-16|delta limit 无上限|parseInt(limit) 无 Math.min，可传极大值|加 Math.min(limit,1000)
NEST-640|M|world/world.service.ts:49-56|getCurrentState events 查询 limit(20) 无 orgId|recentEvents 跨租户可见|加 orgId 过滤
NEST-641|M|parameters/parameters.service.ts:176-185,249-256|readParameter/list 无 orgId 过滤|select by configKey only，跨租户可读|加 orgId 条件
NEST-642|M|system/system.service.ts:89-120|setConfig insert 未设 orgId 但冲突目标含 orgId|onConflictDoUpdate target=[orgId,configKey] 但 values 无 orgId|insert 携带 orgId
NEST-643|L|notification/channel-dispatcher.service.ts:191-198|dispatcher 未传 deviceId 给 buildLarkMessage|notification 对象无 deviceId 字段，渲染永远缺设备号|补 deviceId 字段
NEST-644|L|rule-engine/rule-engine.service.ts:257-268|genEventId 用 Math.random 非密码学安全|同秒+同后缀碰撞风险|用 randomUUID
NEST-645|L|simulator/simulator.service.ts:648-659|genEventId 用 Math.random 非密码学安全|同上|用 randomUUID
NEST-646|L|parameters/parameters.service.ts:119|pattern 校验用 new RegExp(userInput)|管理员可设 ReDoS 模式|限制 pattern 复杂度或超时
NEST-647|L|workorder/workorder.service.ts:78|subjectKind 推导 indexOf(':')=-1 时 slice(0,-1)|无冒号身份截掉末字符|检查 indexOf 结果
NEST-648|L|world vs world-cursor|世界状态双数据源未收敛|world 读 spatialEntity+worldState，world-cursor 读 snapshot+deltaLog|按 ADR 收敛到单一事实源
```

### 6.13 CLI-前端 pages 前 1/3（CLI-001~041）

```
CLI-001|M|client/src/pages/AiDecision/AiDecision.tsx:18-23|硬编码 snapshot 传 AI API|snapshot:{version:1,from:1h前,to:now,records:60} 硬编码传 createSuggestion|改用真实数据或显式 demo 标记
CLI-002|M|client/src/pages/ApprovalConsole/ApprovalConsole.tsx:80-91|markRead/retryPush 缺 onError|两 mutation 仅 onSuccess，错误静默吞|补 onError toast
CLI-003|L|client/src/pages/CommandCenter/commandCenterLogic.ts:45|toLocaleString 时区隐式|new Date(createdAt).toLocaleString() 依赖浏览器时区|统一时区口径
CLI-004|H|client/src/pages/CommandMap/CommandMapShell.tsx:250-1353|巨型文件 1355 行|CommandMapShell 编排所有状态/查询/回调/URL/面板|拆分查询层/URL 镜像/面板编排
CLI-005|M|client/src/pages/CommandMap/CommandMapShell.tsx:588-598|focusEventEntity 吞错误|getEvents(50).then(...).catch(()=>{}) 空 catch|补 toast 或日志
CLI-006|L|client/src/pages/CommandMap/CommandMapShell.tsx:593-595|entityId.includes(deviceId) 子串匹配|e.entityId.includes(evt.deviceId) 易误匹配 EXO-1/EXO-10|改精确匹配
CLI-007|M|client/src/pages/CommandMap/CommandMapShell.tsx:686-703|as SchedulingConflict 类型断言|手工拼对象 as SchedulingConflict，createdAt: detectedAt ?? '' 空串|直接用 vmItem 或显式构造
CLI-008|L|client/src/pages/CommandMap/CommandMapShell.tsx:789-792|fullscreen 吞错误|requestFullscreen().then(...).catch(()=>{}) 静默|至少记日志
CLI-009|L|client/src/pages/CommandMap/CommandMapShell.tsx:350|worldState 2 秒高频轮询|refetchInterval:2000 无降级|视情况调高或 SSE 替代
CLI-010|H|client/src/pages/CommandMap/FactoryMap.tsx:1-1314|巨型文件 1314 行|FactoryMap 单文件渲染所有图层+视口+culling|拆分图层/视口/culling
CLI-011|M|client/src/pages/CommandMap/FactoryMap.tsx:329,934|occupancy 缺省 0.5 伪造|aState?.occupancy ?? 0.5 / wsState?.occupancy ?? 0.5 默认中间值|缺省显式 unknown
CLI-012|M|client/src/pages/CommandMap/FactoryMap.tsx:935|WIP 数由 occupancy 派生|wip=Math.round(occupancy*10) 显示为 WIP 数量，实为伪造|改后端真实 WIP 字段
CLI-013|L|client/src/pages/CommandMap/EntityDetail.tsx:202|confidence 未防 NaN|(entity.confidence*100).toFixed(1) 未防空|加空值兜底
CLI-014|L|client/src/pages/CommandMap/EntityDetail.tsx:298,314,340,361|列表 key={i} 索引|reasons/alternatives/factors 用 index 作 key|用稳定 id
CLI-015|L|client/src/pages/CommandMap/entityDetailData.ts:70,94|event.title.includes(name) 子串匹配|关联事件用标题子串匹配易误关联|用 eventId/deviceId 精确匹配
CLI-016|L|client/src/pages/CommandMap/layers/PlanCompareLayer.tsx:41-42|死代码|const priority: PlanCompareMode[]=[]; void priority;|删除
CLI-017|M|client/src/pages/CommandMap/panels/ConflictCenterPanel.tsx:322|用户错误暴露 FEISHU_API_TOKEN|错误文案"请检查 FEISHU_API_TOKEN 配置"暴露后端 token 体系|改通用错误提示
CLI-018|L|client/src/pages/CommandMap/panels/ConflictPreviewPanel.tsx:73|resolvePreviewAction 重复调用|一行内调 resolvePreviewAction(conflict) 两次|缓存到变量
CLI-019|L|client/src/pages/CommandMap/panels/ConflictPreviewPanel.tsx:250-253|剩余冲突仅显示 3 条|slice(0,3) 但 count 显示全量|加"等 N 条"或可展开
CLI-020|H|client/src/pages/CommandMap/panels/IntelligenceLayers.tsx:232-234|运算符优先级 bug|a ?? b != null ? String(b) : null 解析为 (a ?? (b!=null)) ? String(b) : null，actualStart 被丢弃，渲染"undefined"|加括号 a ?? (b != null ? String(b) : null)
CLI-021|M|client/src/pages/CommandMap/panels/IntelligenceWorkspace.tsx:43|operator 默认 'admin'|getCurrentOperator() ?? 'admin' 硬编码管理员身份|缺省拒绝或显式登录
CLI-022|L|client/src/pages/CommandMap/panels/IntelligenceWorkspace.tsx:220|createdAt.slice 未防空|a.createdAt.slice(0,19) 假设非空|加 null 检查
CLI-023|L|client/src/pages/CommandMap/panels/IntelligenceWorkspace.tsx:95|reason 硬编码审计|reason:'intelligence-workspace activation' 写审计|收集用户 reason
CLI-024|M|client/src/pages/CommandMap/panels/DecisionCockpit.tsx:247|冲突确认 reason 硬编码|reason:'决策驾驶舱确认处置' 不收集用户输入|与 ConflictCenter 一致收集 reason
CLI-025|M|client/src/pages/CommandMap/panels/EventCenterPanel.tsx:189-200|async 函数无取消机制|loadReplayContext 异步，组件卸载后 setState 可能警告|加 AbortController 或 mounted 标志
CLI-026|L|client/src/pages/CommandMap/panels/OverridePanel.tsx:515|Dialog 关闭 previewLoading 残留|onOpenChange 仅 setPreview(null)，previewLoading 未清|重置所有 preview 状态
CLI-027|H|client/src/pages/CommandMap/panels/SchedulePanel.tsx:1-1351|巨型文件 1351 行|SchedulePanel 单文件含方案/审批/重排/对比/Dialog 全部逻辑|拆分对话框/列表/详情
CLI-028|M|client/src/pages/CommandMap/panels/SchedulePanel.tsx:537,549,585|多处 onError 吞错误细节|reject/dispatch/compare onError 仅 toast 通用文案|透传 err.message
CLI-029|L|client/src/pages/CommandMap/panels/SchedulePanel.tsx:654|confirmReplan 缺 reason|replanMutation.mutate({plan,lockedConstraints:[]}) 未传 reason|补 reason 字段
CLI-030|M|client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx:474-484,598-610|废弃 allocateMutation 仍 UI 可触发|@deprecated 路径与正式 replanMutation 并存于 UI|移除废弃按钮或隔离
CLI-031|M|client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx:602|targetType 类型谎言|v.targetType as 'person' | 'device' 实际值为 'workstation'|修正类型或字段值
CLI-032|L|client/src/pages/CommandMap/panels/TaskIntelligencePanel.tsx:49-50|etaSeconds/distanceMeters 未防空|{c.etaSeconds}s / {c.distanceMeters}m 未 null 检查|加 ?? '—'
CLI-033|L|client/src/pages/CommandMap/panels/PlanDiffDrawer.tsx:145|reasons key={i} 索引|列表用 index 作 key|用稳定 id
CLI-034|L|client/src/pages/CommandMap/panels/RejectedCandidateExplain.tsx:36|rejected key={i} 索引|列表用 index 作 key|用稳定 id
CLI-035|L|client/src/pages/CommandMap/panels/SchedulePanel.tsx:923,1334|reasons/assignmentDelta key={i}|多处索引 key|用稳定 id
CLI-036|L|client/src/pages/CommandMap/layers/SchedulerLayers.tsx:437-445|ReplanChangeLayer 重复查找逻辑|st 已查过，IIFE 内重复 s.tasks.find + s.stations.find|简化为复用 st
CLI-037|L|client/src/pages/CommandMap/layers/SchedulerLayers.tsx:102|设备 name 用 d.id|name: d.id 设备名直接用 id|用真实 name 字段
CLI-038|L|client/src/pages/CommandMap/CommandMapShell.tsx:1308-1318|帮助对话框无焦点陷阱|div onKeyDown 仅 Escape，Tab 焦点可逃出|加 focus trap
CLI-039|L|client/src/pages/CommandMap/panels/BrainPanel.tsx:81|confidence NaN 未防|Math.round(suggestion.confidence*100) 未防空|加 Number.isFinite 检查
CLI-040|L|client/src/pages/CommandMap/panels/BrainPanel.tsx:282|suggestions key 含索引|key={`${s.title}-${i}`} 用 index|用 suggestion 稳定 id
CLI-041|L|client/src/pages/CommandMap/panels/IntelligenceLayers.tsx:155,305|多处 key={i}/{j} 索引|conflicts/reasons 用 index 作 key|用稳定 id
```

### 6.14 CLI-前端 pages 中 1/3（CLI-101~112）

```
CLI-101|M|client/src/pages/DataAssets/DataAssets.tsx:52-64|addAas mutation 缺 onError|JSON.parse(aasSubmodels) 抛错或后端 4xx 时无 toast|补充 onError toast
CLI-102|M|client/src/pages/DataAssets/DataAssets.tsx:65-68|fetchSemantics mutation 缺 onError|语义查询失败静默无反馈|补充 onError toast
CLI-103|H|client/src/pages/DecisionHistory/DecisionHistoryConsole.tsx:31-40,133-143|加载更多分页替换而非累加|useQuery offset 变更后 query.data 仅含当前页，按钮文案"已显示 X/Y"误导，前页丢失|改 useInfiniteQuery 或本地 items 累加
CLI-104|M|client/src/pages/Devices/Devices.tsx:100-104|batteryData 未 useMemo|配合 refetchInterval:30000 每次重渲重算 map|用 useMemo 包裹
CLI-105|M|client/src/pages/MobileWorkbench/MobileWorkbench.tsx:698-700|stepError 共享 mutation.error|transitionMutation.error 是全局最新错误，多 step 失败时 A 卡片显示 B 的错误|failedMutation 内同时缓存 error 对象
CLI-106|M|client/src/pages/CommandMap/panels/TimelinePanel.tsx:64-67|now/minTime 空依赖冻结|Date.now() 仅 mount 取值，长时间挂载后新事件超出时间窗不显示|加定时器或依赖 replayTime 周期更新
CLI-107|L|client/src/pages/CommandMap/panels/WorkbenchPanel.tsx:218|avgLoad 未做空值保护|overview 存在但 avgLoad 缺失时显示 "NaN%"|改为 null 检查
CLI-108|L|client/src/pages/Devices/Devices.tsx:269|Cell key={index}|用数组索引作 key 反模式|改用 entry.name
CLI-109|L|client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx:289,695,734|Number(e.target.value) || 0/1|输入非数字或 0 静默回退无校验|添加显式校验或 disabled 条件
CLI-110|L|client/src/pages/MobileWorkbench/MobileWorkbench.tsx|巨型文件 788 行|单文件接近 1000 行阈值，含 9 个 useState + 3 mutation + 离线/扫码/草稿恢复多职责|拆分 useMobileScanner/useMobileException hook
CLI-111|L|client/src/pages/Forbidden/Forbidden.tsx:9-12|handleLogout 无错误处理|revokeSession 抛错时仍 navigate('/login')|try/catch + 错误 toast
CLI-112|L|client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx:127|setNodes(data.nodes ?? nodes) 回退|后端返回 nodes:null 时静默用本地 nodes|显式判空并 toast 提示
```

### 6.15 CLI-前端 pages 后 1/3（CLI-201~229）

```
CLI-201|H|client/src/pages/WorkOrchestration/HandoffsPanel.tsx:15|handoffFrom 默认值 'AG-00' 为伪造 actor ID|useState('AG-00') 预填来源 Agent，未改即提交冒充真实数据|默认空串并强制输入
CLI-202|H|client/src/pages/MobileWorkbench/useOfflineWorkbench.ts:546-575|离线/API 失败时 conflict 项仍被删除|toast 提示重试后立即 db.pendingActions.delete，本地/服务端状态分歧且无法重试|离线或 catch 中 return 不删除
CLI-203|M|client/src/pages/Operations/Operations.tsx:148,670-683|completeResult 共享 state 跨任务串值|完成结果输入框值全表共享，A 任务输入残留到 B 任务提交|按 taskId 维护 map 或行内 uncontrolled
CLI-204|M|client/src/pages/Operations/Operations.tsx:234-353|9 个 mutation 缺 onError 静默吞错|addAsset/addTask/addTool/saveWorkCenter/addEfficiency 等均无 onError|各 mutation 加 onError toast
CLI-205|M|client/src/pages/RoleWorkbench/RoleWorkbench.tsx:272-282|maybeDownload 未校验 URL 协议|anchor.href = url 直取服务端 task.downloadUrl，可能 javascript:|校验 url.startsWith('http') 再赋值
CLI-206|M|client/src/pages/RoleWorkbench/RoleWorkbench.tsx:158-160,223-253|listWorkbenchViews 重复请求|refreshViews 与 view 应用 effect 同时触发，role 切换双发|合并到单一 effect 或基于 query cache
CLI-207|M|client/src/pages/RoleWorkbench/WorkbenchList.tsx:515-525|加载更多跳页时 loaded 不更新|useEffect 仅在 dataPage===1 或 prevPage+1 时更新 loaded|跳页时清空并按 dataPage 重置 prevPageRef
CLI-208|M|client/src/pages/Scale/Scale.tsx:593|升级环选项硬编码|['dev','integration','shadow','pilot','small','full'] 写死前端|由后端 fleetStatus.ringCounts 派生
CLI-209|M|client/src/pages/Scale/Scale.tsx:89,108,125,144,154,176,192,206,214|9 个 mutation 缺 onError|onboarding/registerDiff/installScenario/uninstallScenario 等|加 onError toast
CLI-210|M|client/src/pages/System/System.tsx:745-747|configValue 原始 JSON 直显未脱敏|<pre>{JSON.stringify(row.configValue)}</pre>，页面头承诺脱敏未实现|由 api/system 层 mask 敏感字段
CLI-211|M|client/src/pages/System/System.tsx:103,127,145,157,161,165|6 个 mutation 缺 onError|evaluate/addParameter/changeParameter/approveParam 等|加 onError toast
CLI-212|M|client/src/pages/WorkOrchestration/GitSyncPanel.tsx:167|CI_LABEL[ci.status] 对未知 status 抛 TypeError|直接索引 .icon，status 异常时崩溃|加 fallback ?? CI_LABEL.unknown
CLI-213|M|client/src/pages/WorkOrchestration/SiteReadinessWizard.tsx:166-174|runProbe 无 try/finally|probe 抛错时 setProbing(false) 不执行，按钮永久 loading|包 try/finally
CLI-214|M|client/src/pages/WorkOrchestration/GatesPanel.tsx:145,207|reason 字段未传后端 + 批量 mutation 缺 onError|TODO 表明 reason 仅 UI；batchDecisionMutation 无 onError|推动后端补字段；加 onError
CLI-215|M|client/src/pages/WorkOrchestration/HandoffsPanel.tsx:31-54|handoff mutation 缺 onError|两个 mutation 仅 onSuccess toast|加 onError toast
CLI-216|M|client/src/pages/WorkOrchestration/ResourcesPanel.tsx:31-51|lock/release mutation 缺 onError|失败静默|加 onError toast
CLI-217|M|client/src/pages/MobileWorkbench/useOfflineWorkbench.ts:434-507|flushSelected 未处理 authRequired|retryPending/batchRetry 走 flushSelected，401 时未 setAuthPaused|统一判 result.authRequired
CLI-218|M|client/src/pages/WorkOrchestration/graphLayout.ts:118-122|processed.includes 检查 O(n²)|每项线性扫描数组，大图性能退化|改用 Set.has
CLI-219|L|client/src/pages/Operations/Operations.tsx:54-55|formatTime 使用本地时区|toLocaleString 取客户端时区，跨时区显示不一|用 timeZone:'UTC' 或服务端带 Z
CLI-220|L|client/src/pages/Personnel/Personnel.tsx:100|riskLabel fallback 掩盖异常值|未定义 riskLevel 返回 undefined 渲染为空|显式 default 标签
CLI-221|L|client/src/pages/RoleWorkbench/RoleWorkbench.tsx:79-81|searchParamsRef useEffect 无依赖数组|每次渲染都执行 ref 写入|加 [searchParams] 依赖
CLI-222|L|client/src/pages/Scheduling/Scheduling.tsx:297-308|mutationError 聚合丢失并发错误|5 个 mutation 取首个显示|改用最近一次或聚合
CLI-223|L|client/src/pages/Simulation/SimulationConsole.tsx:95-98|空 snapshotVersion 静默当作 0|Number('')===0 通过整数校验|显式校验非空字符串
CLI-224|L|client/src/pages/System/System.tsx:73-74|硬编码 AI Base URL 与模型|默认值写死前端|由后端 /api/ai/config 派生
CLI-225|L|client/src/pages/WorkOrchestration/AgentsPanel.tsx:40-43|useMemo 内不可读类型体操|infer K,V 条件类型表达式|简化为 Map<string, AgentMetrics>
CLI-226|L|client/src/pages/WorkOrchestration/WorkGraphPanel.tsx:411-425|saveView localStorage 无 try/catch|私有模式或配额满时抛错未捕获|包 try/catch 静默
CLI-227|L|client/src/pages/WorkOrchestration/overviewModel.ts:180|risk.status.toLowerCase 未判空|类型为 string，运行时若 null 直接抛|加 ?? '' 防御
CLI-228|L|client/src/pages/stateCoverage.test.ts:110|测试硬编码 toast 文案|字符串硬编入断言，文案微调即破坏测试|改为 grep 模式或抽常量
CLI-229|L|client/src/pages/Operations/Operations.tsx:276|'workbench complete' note 硬编码|transitionMaintenanceTask 的 note 写死|由表单或 i18n 注入
```

### 6.16 CLI-前端 components 上半（CLI-301~350）

```
CLI-301|C|client/src/components/Timeline.tsx:312-316|evidence.url 未校验 scheme 直接渲染为 href，javascript: 可触发 XSS|<a href={e.url} target="_blank" rel="noreferrer">查看</a>|增加 http(s)/mailto 白名单校验
CLI-302|C|client/src/components/business-ui/tiptap-editor/components/link-edit-form.tsx:80,85|applyLink 不校验 href scheme，可注入 javascript: 链接|marks:[{type:'link',attrs:{href:hrefTrimmed}}] setLink({href:hrefTrimmed})|显式过滤 javascript:/data: 等危险协议
CLI-303|H|client/src/components/app-shell/ContextBar.tsx:30|永久硬编码展示「演示 / 待接入真数据」标签|<span>演示 / 待接入真数据</span>|根据真实数据接入状态动态控制
CLI-304|H|client/src/components/DangerousActionDialog.tsx:93|phase !== 'confirm' 中 'confirm' 不在 DangerousPhase 类型中（实际为 'confirming'），条件恒真|disabled={busy||previewing||(phase!=='confirm'&&phase!=='confirming'&&!failed)}|改为 (phase!=='confirming' && !failed)
CLI-305|H|client/src/components/ErrorState.tsx:163,167|parsed.message/recommendedAction 未经 sanitize 直接渲染，可能向用户暴露原始堆栈/JSON|<p>{parsed.message}</p> {parsed.recommendedAction}|复用 AppErrorState.sanitizeUserText 清洗
CLI-306|M|client/src/components/AlertToast.tsx:147|setExpanded updater 内调用 setUnread 副作用，StrictMode 下可能执行两次|setExpanded((prev)=>{...setUnread(new Set());...})|副作用移至 useEffect
CLI-307|M|client/src/components/AlertToast.tsx:42|L3 告警 3s 轮询过激，加重后端压力|refetchInterval: POLL_INTERVAL_MS /* 3000 */|提升至 10-15s 或事件驱动
CLI-308|M|client/src/components/Timeline.tsx:162-176|copyId 主路径写入 id，回退路径写入 tl:${id}，行为分裂|writeText(id) vs ta.value=tl:${id}|两路径统一写入 tl:${id}
CLI-309|M|client/src/components/Timeline.tsx:172|使用已废弃 document.execCommand('copy')|document.execCommand('copy')|仅保留 clipboard API 并提示失败
CLI-310|M|client/src/components/AppErrorState.tsx:118|使用已废弃 document.execCommand('copy')|同上|同上
CLI-311|M|client/src/components/ErrorState.tsx:92|使用已废弃 document.execCommand('copy')|同上|同上
CLI-312|M|client/src/components/app-shell/useOfflineSnapshot.ts:24|catch 静默吞错，仅设置兜底快照无日志|catch { setSnapshot({...}) }|添加 logger.error 记录
CLI-313|M|client/src/components/app-shell/useOfflineSnapshot.ts:35-44|online/offline 切换仅更新 online 字段，不刷新 pendingCount|onOnline=()=>setSnapshot((s)=>({...s,online:true}))|重新读取 IndexedDB
CLI-314|M|client/src/components/entity-combobox/use-fetch-data.tsx:33-57|fetchData 无 AbortController，连续搜索可能竞态|const result=await fetchFn(search); setData(result?.items)|引入请求序号或 AbortSignal
CLI-315|M|client/src/components/api/users/service.ts:27|listUsersByIds 静默过滤非数字 ID|userIds.filter((id)=>!isNaN(Number(id)))|返回过滤结果或显式报错
CLI-316|M|client/src/components/api/files/service.ts:12|uploadFile 无文件大小/类型校验|async function uploadFile(file:File)|增加 size/MIME 白名单
CLI-317|M|client/src/components/tiptap-editor/components/image-upload-toolbar-button.tsx:22|handleFileChange async 未 try/catch|const ok=editor.chain().focus().insertImages([file]).run()|包 try/catch 并 toast
CLI-318|M|client/src/components/tiptap-editor/components/attachment-toolbar-button.tsx:28|handleFileChange async 未 try/catch|editor.chain().focus().insertAttachments(Array.from(files)).run()|同上
CLI-319|M|client/src/components/entity-combobox/entity-combobox.tsx:4|使用 radix-ui/internal 私有路径，跨版本可能破坏|import { useControllableState } from 'radix-ui/internal'|改用 @radix-ui/react-use-controllable-state
CLI-320|M|client/src/components/OnboardingQuickStart.tsx:65|render 中同步读 localStorage，外部变更不触发重渲染|const prefs=readOnboarding(userId)|改为 useState + storage 事件监听
CLI-321|M|client/src/components/chat-select/use-chat-value.ts:102|console.error 在生产打印错误可能泄露内部信息|console.error('Failed to resolve chat IDs:', error)|改用 logger 并脱敏
CLI-322|M|client/src/components/app-shell/PendingInbox.tsx:14-16|注释承认演示入口但 UI 不区分演示与真实|其余为演示入口 注释|为演示入口加视觉标识
CLI-323|M|client/src/components/entity-combobox/search-trigger.tsx:85|maxTagCount='responsive' 未实现却暴露类型|// TODO: responsive 模式需要根据容器宽度计算|实现或从类型中移除
CLI-324|M|client/src/components/Layout.tsx:50|handleLogout 不处理 revokeSession 失败|await revokeSession(); navigate('/login',{replace:true})|try/catch，失败仍允许本地登出
CLI-325|M|client/src/components/form/select-field.tsx:147|SelectItem 使用空字符串 value，Radix Select 不允许|<SelectItem disabled value={''}>暂无选项</SelectItem>|改用占位符如 '__empty__'
CLI-326|M|client/src/components/app-shell/AiAssistant.tsx:60|error.message 直接拼接到用户消息|content:`⚠️ ${error instanceof Error ? error.message : '请求失败'}`|脱敏后展示
CLI-327|M|client/src/components/AlertToast.tsx:24-33|timeAgo 使用 dayjs 本地时区格式化|dayjs(dateStr).format('HH:mm:ss')|显式时区或 UTC ISO
CLI-328|M|client/src/components/QueryState.tsx:91|updatedAt toLocaleTimeString 浏览器本地时区|new Date(updatedAt).toLocaleTimeString('zh-CN',{hour12:false})|显式 timeZone:'Asia/Shanghai'
CLI-329|M|client/src/components/Timeline.tsx:53-56|formatTime toLocaleString 浏览器本地时区|d.toLocaleString('zh-CN',{hour12:false})|同上
CLI-330|M|client/src/components/AlertToast.tsx:68|toastedRef 持久累积 eventId 不清理，长时运行内存增长|useRef<Set<string>>(new Set()) 仅 add 不 delete|窗口外清理或限制大小
CLI-331|L|client/src/components/entity-combobox/context.tsx:7|createContext 使用 any 丢失类型安全|createContext<any|undefined>(undefined)|改为泛型 Provider
CLI-332|L|client/src/components/form/form.tsx:9-24|AppFieldExtendedReactFormApi 使用 14 个 any 类型参数|<any,any,any,...>|封装具体泛型
CLI-333|L|client/src/components/entity-combobox/base-combobox-trigger.tsx:167-248|renderTag 与默认分支大量重复代码|两分支几乎相同的 slice/map 逻辑|抽取共享渲染函数
CLI-334|L|client/src/components/entity-combobox/base-combobox-loading.tsx:9|接受 text 参数但未使用|text?:string 函数体内未引用|移除或使用
CLI-335|L|client/src/components/entity-combobox/popover-wrapper.tsx:100,107|多处 as any 类型转换|renderTrigger={renderTrigger as any}|补全泛型类型
CLI-336|L|client/src/components/DataFreshnessBadge.tsx:16-25|FRESHNESS_STATUS_CLASSES 硬编码 emerald/amber/orange/red/purple/blue|'bg-emerald-500/20 text-emerald-400 ...'|改用设计令牌
CLI-337|L|client/src/components/DataSourceBadge.tsx:12-19|DATA_SOURCE_CLASSES 硬编码 bg-blue-100 等|real:'bg-blue-100 text-blue-700 border-blue-200'|改用设计令牌
CLI-338|L|client/src/components/DataStates.tsx:22-46|HEALTH_PRESENTATION 硬编码 amber/orange/sky|partial:{containerClass:'border-amber-200 bg-amber-50'}|改用设计令牌
CLI-339|L|client/src/components/ErrorState.tsx:40-74|KIND_PRESENTATION 硬编码 amber/yellow/sky/red|permission:'border-amber-200 bg-amber-50'|改用设计令牌
CLI-340|L|client/src/components/AlertToast.tsx:166|硬编码 HSL/RGB 颜色绕过设计令牌|bg-[hsl(0_60%_12%)]/95 border-red-500/40|改用 tailwind 主题令牌
CLI-341|L|client/src/components/Layout.tsx:55|大量硬编码 HSL 颜色|bg-[hsl(220_14%_96%)]、bg-[hsl(221_83%_53%)]|抽取到 tokens.css
CLI-342|L|client/src/components/AppErrorState.tsx:205|硬编码 border-red-200 bg-red-50 text-red-600|className="... border-red-200 bg-red-50 p-4 ..."|改用设计令牌
CLI-343|L|client/src/components/DataCredibility.tsx:30|大量硬编码 HSL 颜色|border-[hsl(220_14%_89%)] text-[hsl(218_10%_42%)]|改用设计令牌
CLI-344|L|client/src/components/PermissionState.tsx:52|硬编码 amber 颜色|border-amber-200 bg-amber-50 text-amber-600|改用设计令牌
CLI-345|L|client/src/components/OfflineState.tsx:25|硬编码 sky 颜色|border-sky-200 bg-sky-50 text-sky-600|改用设计令牌
CLI-346|L|client/src/components/entity-combobox/size-variants.tsx:249|硬编码 HEX 颜色|bg-[#E8E8E9] dark:bg-[#3D3E3E]|改用设计令牌
CLI-347|L|client/src/components/tiptap-editor/components/color-highlight-toolbar-button.tsx:22-47|TEXT_COLORS 混合 var(--color-*) 与硬编码 tailwind 类|{value:'var(--color-red-600)',className:'bg-red-600'}|统一使用 CSS 变量
CLI-348|L|client/src/components/department-select/icon-department.tsx:15|SVG 内硬编码 HEX 颜色|<rect width="20" height="20" rx="10" fill="#1456F0" />|使用 currentColor 或令牌
CLI-349|L|client/src/components/form/field-layout.tsx:42|硬编码 text-red-500|<span className="text-red-500">|改用 text-destructive 等令牌
CLI-350|L|client/src/components/Timeline.tsx:26-50|SOURCE_STYLES 与 severityClass 硬编码颜色|'bg-violet-500/15 text-violet-300 ...'|改用设计令牌
```

### 6.17 CLI-前端 components 下半（CLI-401~433）

```
CLI-401|C|client/src/components/ui/streamdown.tsx:55|markdown 链接 href 未校验 scheme，可触发 javascript: XSS|a: ({href}) => <a href={href} target=_blank> 直传 href|校验仅允许 http/https/mailto/tel，拒绝 javascript:/data:
CLI-402|H|client/src/components/business-ui/tiptap-editor/extensions/attachment.tsx:215|a.href=downloadUrl 未校验 scheme，URL 来自编辑器节点 attrs|a.href = downloadUrl; a.click() 配合 withDownloadParam 不挡 javascript:|校验 url.protocol 仅 http/https，blob: 单独放行
CLI-403|H|client/src/components/business-ui/tiptap-editor/extensions/attachment.tsx:229|window.open(effectiveUrl) 未校验 URL scheme|window.open(effectiveUrl, '_blank') src 来自 attrs.url 可被粘贴 HTML 注入|同上协议白名单校验
CLI-404|H|client/src/components/business-ui/user-profile/user-external-script.ts:42|动态创建 script.src 接受外部 src 未校验|script.src = src + setAttribute 任意 attributes|要求调用方传入受信白名单或增加 origin 校验
CLI-405|M|client/src/components/business-ui/user-profile/user-profile.tsx:63|nonceStr 用 Math.random() 非密码学安全，用于飞书 jsapi 签名|Math.floor(Math.random() * characters.length)|改用 crypto.getRandomValues 生成 nonce
CLI-406|M|client/src/components/business-ui/user-profile/user-profile.tsx:185|JSON.parse(error.message) 未 try/catch，非 JSON 时抛未处理异常|const errorMessage = JSON.parse(error.message)|包裹 try/catch 并 logger 记录原文
CLI-407|M|client/src/components/business-ui/user-profile/user-profile.tsx:201-207|第三方 CDN 脚本无 SRI 完整性校验|useExternalScript('https://lf3-cdn-tos.bytegoofy.com/.../h5-js-sdk-1.2.21.js')|添加 SRI 哈希或自托管
CLI-408|M|client/src/components/business-ui/user-profile/user-profile.tsx:301|redirectURL 来自 API 响应直接 location.replace 未校验|globalThis.location.replace(redirectURL)|校验为同源相对路径或白名单 origin
CLI-409|M|client/src/components/business-ui/user-profile/user-external-script.ts:28|CSS 选择器字符串插值可被注入|document.querySelector(`script[src="${src}"]`)|用 CSS.escape 或 attribute filter 比对
CLI-410|M|client/src/components/ui/carousel.tsx:99-104|reInit 监听未在 cleanup 中移除，事件句柄泄漏|api.on("reInit", onSelect) 但 cleanup 只 off("select")|cleanup 中增加 api?.off("reInit", onSelect)
CLI-411|M|client/src/components/ui/sidebar.tsx:86|cookie 未设置 Secure/SameSite 属性|document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=...`|加 SameSite=Lax；HTTPS 部署时加 Secure
CLI-412|M|client/src/components/ui/image.tsx:53-55|SRC_ALLOWLIST 用 includes 子串匹配可被绕过|originSrc.includes(item) 可被 evil.com/?/runtime/api/v1/storage/object/ 绕过|改用 new URL 解析后比对 pathname 前缀
CLI-413|M|client/src/components/ui/calendar.tsx:39-40,193|toLocaleString("default") 依赖宿主环境语言|date.toLocaleString("default", {month:"short"})|显式指定 "zh-CN" 或固定格式
CLI-414|M|client/src/components/ui/chart.tsx:83-101|dangerouslySetInnerHTML 注入 CSS 含外部 color/key 值|<style dangerouslySetInnerHTML={{__html: `...--color-${key}: ${color};`}}>|校验 color 为合法 CSS 颜色字符串，校验 id 不含元字符
CLI-415|M|client/src/components/business-ui/user-select/utils.tsx:113|getAppId 用正则从 path 提取未校验返回值|path.match(/\/app\/([^/]+)/)[1] 直接返回|校验返回值格式
CLI-416|M|client/src/components/business-ui/user-profile/user-profile.tsx:6|SHA1 已知弱哈希用于 jsapi_ticket 签名|import SHA1 from 'crypto-js/sha1'|飞书 jsapi 规范要求 SHA1，添加注释说明约束
CLI-417|M|client/src/components/business-ui/user-select/user-select.tsx:272|catch {} 吞错误只 toast 通用文案，无日志|catch { toast.error('外部用户添加失败'); }|增加 logger.error 记录 error 上下文
CLI-418|L|client/src/components/business-ui/types/user.ts:72|department?: Department | any 使用 any 削弱类型|department?: Department | any; 等价 any|移除 any，定义联合类型
CLI-419|L|client/src/components/business-ui/user-display/utils.ts:11,28|多处 as any 类型断言绕过类型检查|userInfo: (UserInfo & {avatar?: any}) | any 及 as any|用具体类型替换 any
CLI-420|L|client/src/components/business-ui/user-select/utils.tsx:54,76,167,180|多处 as any 类型断言|department: userInfo.department as any 等|修正 UserInfo 类型定义避免 any
CLI-421|L|client/src/components/business-ui/utils/user.ts:24|normalizeUser 内部 input as any|const data = input as any;|严格类型化 UserInput 联合
CLI-422|L|client/src/components/business-ui/user-select/user-select.tsx:207,216,261,264|onChange 强制 cast 为 (value:unknown)=>void 多处|(onChange as (value: unknown) => void)(externalValue)|用函数重载代替 cast
CLI-423|L|client/src/components/business-ui/user-select/use-user-value.ts:148,150|u.raw! 非空断言可能 NPE|u.raw! 假设 raw 一定存在|显式判空回退到 createUnknownUser
CLI-424|L|client/src/components/business-ui/user-display/overflow-tooltip-text.tsx:83|硬编码颜色 bg-[rgb(31,35,41)] 绕过设计令牌|className="bg-[rgb(31,35,41)] text-white ring-0"|改用 bg-foreground 等 token
CLI-425|L|client/src/components/business-ui/user-display/user-display.tsx:84,91|硬编码 rgba 颜色和阴影值|hover:bg-[rgba(31,35,41,0.15)] 和 shadow rgba(31,35,41,...)|用 token bg-muted/accent
CLI-426|L|client/src/components/business-ui/user-profile/user-profile.tsx:340,345|硬编码 bg-blue-500/20 text-blue-900 绕过令牌|bg-blue-500/20 ... text-blue-900 外部用户标签|用 info token 语义化
CLI-427|L|client/src/components/business-ui/user-select/user-item.tsx:25,78|硬编码 bg-blue-500/20 与 bg-black/40|bg-blue-500/20 text-blue-900 和 bg-black/40|用 token info/muted
CLI-428|L|client/src/components/ui/image.tsx:131,171|硬编码 from-gray-50/20 to-gray-200/20|'bg-linear-to-b from-gray-50/20 to-gray-200/20'|用 token bg-muted/50
CLI-429|L|client/src/components/ui/slider.tsx:80|bg-white 硬编码滑块 thumb|border-primary ... bg-white shadow-sm|改用 bg-background
CLI-430|L|client/src/components/business-ui/user-profile/user-profile.tsx:255-257|死代码：注释掉的 Button 重试块|{/* <Button variant="outline" className="border-red-500..." */}|删除注释代码
CLI-431|L|client/src/components/ui/icons/file-wiki-word-colorful-icon.tsx:6-26|SVG 同一 path 重复定义 4 次|document 背景 path d="M3 3C3..." 出现 4 次|删除冗余 path 元素
CLI-432|L|client/src/components/business-ui/user-profile/user-profile.tsx:201|变量名拼写错误 larkSdkURl|const larkSdkURl = '...'|改为 larkSdkUrl
CLI-433|L|client/src/components/business-ui/{user-display,user-profile,user-select}/*|路径别名不一致使用 @client/src/ 而非 @/|from '@client/src/components/business-ui/...' 多处|统一为 @/ 别名
```

### 6.18 CLI-前端 lib（CLI-501~548）

```
CLI-501|C|client/src/lib/auth.ts:31-34,78-80|refreshToken 存 localStorage|setTokens 把 access+refresh 都写入 localStorage；XSS 可窃取 refresh 长期凭证|refresh 改 httpOnly cookie，access 放内存
CLI-502|H|client/src/lib/offlineCrypto.ts:176-196|rotate 中途崩溃丢数据|keyPromise 先换新 key 再 reencrypt；崩在中间则旧密文与新内存 key 不匹配|原子换 key：reencrypt 成功后再换 keyPromise
CLI-503|H|client/src/lib/offlineLeader.ts:171-229|leaseMs 未强制执行|lastSeen 仅更新从不用于驱逐失联 leader；leader 崩溃后其它 tab 永远不重新选举|onMessage 中加 lastSeen 超时检查
CLI-504|H|client/src/lib/offlineDb.ts:121-149|createStore 写事务过早 resolve|put 请求 onsuccess 即 resolve，未等 tx.oncomplete；事务回滚后调用方以为成功|readwrite 改用 tx.oncomplete resolve
CLI-505|C|client/src/lib/offlineCrypto.ts:74-84|IV 退化用 Math.random|crypto.getRandomValues 不可用时 fallback 用 Math.random 生成 AES-GCM IV|不可用时直接抛错或拒绝加密
CLI-506|M|client/src/lib/auth.ts:17-29,45-68|JWT 解码无签名校验|decodeJwtPayload 仅 atob+JSON.parse；篡改 localStorage 可注入 roles 绕过前端权限 UI|前端角色仅用于 UI；权限以服务端校验为准
CLI-507|M|client/src/lib/http.ts:56-64|redirectToLogin 不保留 return path|登录后跳默认页而非原路径|拼接 ?redirect= 并在登录后恢复
CLI-508|M|client/src/lib/http.ts:104-122|axiosForBackend 返回 {data:any}|类型签名丢类型安全|改泛型 <T> 返回 {data:T}
CLI-509|M|client/src/lib/offlineDb.ts:378-416|迁移重试产生孤儿附件|migratePendingActionsFromLocalStorage 中途失败未设 flag；重跑时 createId 新 attachmentId，旧附件残留|迁移前按 action.id 查重或整批原子化
CLI-510|M|client/src/lib/offlineQueue.ts:104-106|appendPendingAction 用 Math.random 生成 id|未用 crypto.randomUUID；快速连续入队可能碰撞|统一用 offlineDb.createId()
CLI-511|M|client/src/lib/offlineQueue.ts:74-93,236|flushPendingQueue O(n²)|每条 markPendingAction 都 readPendingActions 全量 JSON.parse+stringify|改用 IndexedDB 或单次读+内存更新
CLI-512|M|client/src/lib/observability.ts:301-356|flush 并发可重复 POST|buffer.slice() 后两路并发 POST 同一批|加 inFlight 守卫或互斥锁
CLI-513|M|client/src/lib/observability.ts:380-396|pagehide 回退 axios 被截断|safeBeaconFlush 失败回退 flush() 走 axios；页面卸载时 in-flight POST 被中断|仅用 sendBeacon；失败则 stageForReplay
CLI-514|M|client/src/lib/swRegistration.ts:163-165|safeUpdate 无激活超时|postMessage(SKIP_WAITING) 后未等 controllerchange 即返回 applied:true|加超时监听 controllerchange
CLI-515|M|client/src/lib/sessionSecurity.ts:119-158,168-192|initSessionSecurity 多次调用互害|closeLogoutChannel 关单例 channel；二次 init 的监听者被孤立|引用计数或返回不关 channel 的 cleanup
CLI-516|M|client/src/lib/sessionSecurity.ts:142-150|broadcastLogout 触发本地监听|postMessage 后又直接遍历 listeners；本 tab 双重登出处理|本地调用方做幂等或广播时不调本地 listeners
CLI-517|M|client/src/lib/dangerousModel.ts:71-90|createDangerIdempotencyKey 用 32-bit FNV|FNV-1a 32 位 hash 空间小；同 action+target 不同时刻易碰撞|改用 crypto.randomUUID 或 SHA-256
CLI-518|M|client/src/lib/gitSync.ts:301-317|createIdempotencyKey 同样 32-bit FNV|同 CLI-517；写操作幂等键碰撞导致合法操作被去重拒绝|改用 crypto.randomUUID
CLI-519|M|client/src/lib/draftStore.ts:50-57|clearStep 非原子|逐条 delete；中途崩溃留下部分草稿|用 IDB 单事务批量删除
CLI-520|M|client/src/lib/attachmentDataUrl.ts:10-19|dataUrlToBlob 无校验|无逗号时 base64=undefined，atob('undefined') 静默产生垃圾 Blob|校验 split 长度与 base64 合法性
CLI-521|M|client/src/lib/navigation.ts:190-199|hasRoleAccess 空 roles 放行|allowedRoles 为空时直接 true；配置漏写 roles 即公开访问|空 roles 视为拒绝
CLI-522|M|client/src/lib/offlineDb.ts:475|flushOfflineQueue 并发 index 共享|groupIndex 跨 worker 共享；worker 调度不均可能饥饿|注释已说明，建议加轮转取组
CLI-523|M|client/src/lib/offlineDb.ts:593-605|blobToDataUrl fallback 返回空 data URL|FileReader 缺失时返回 data:type;base64,（无数据）；导出快照静默丢内容|不可用时抛错或跳过导出
CLI-524|M|client/src/lib/offlineCrypto.ts:144-153|ensureKey 异步竞态|keyPromise 为 null 时多次并发 ensureKey 会各自 generateKey 产生不同 key|用 Promise 缓存或锁
CLI-525|M|client/src/lib/resumableUpload.ts:78-85|checksum fallback FNV-1a 32-bit|WebCrypto 不可用时退化非密码学 hash；完整性校验形同虚设|不可用时拒绝上传或仅警告
CLI-526|M|client/src/lib/swCache.ts:131-136|hasContentHash 阈值过严|要求 hash ≥8 字符；6 位 hash 的产物被误判为 document 走 network-first|下调到 6 或匹配更宽松
CLI-527|M|client/src/lib/designTokens.ts:12-33|TS token 与 CSS 变量无单一来源|HSL 字符串硬编码；tokens.css 改动后漂移无校验|生成脚本从 CSS 抽取或反之
CLI-528|M|client/src/lib/offlineDb.ts:155-179|onupgradeneeded 不做数据迁移|仅 createObjectStore 不迁移旧数据|结合 storageController.runMigrations 在 upgradeneeded 内执行
CLI-529|M|client/src/lib/useDangerousConfirm.ts:52-85|confirm 闭包依赖 state.idempotencyKey|useCallback deps 仅 idempotencyKey；React 18 批处理下极快点击可能拿到旧 null|用 ref 持有最新 idempotencyKey
CLI-530|M|client/src/lib/timelineModel.ts:140-172|buildCorrelationChain O(n²)|每节点全量扫描 events；大时间线（>1k）卡顿|建 correlationId/causationId 索引 Map
CLI-531|M|client/src/lib/offlineQueue.ts:47-72|normalizePendingAction 字段不校验|仅校验 type/orderId/stepId/status；body/attachment 等字段直接透传 spread|白名单字段拷贝
CLI-532|M|client/src/lib/gitSync.ts:134-149|detectConflicts 推荐策略粗糙|server 非 null 即推荐 server；忽略 local 更新的场景|加时间戳/版本比较
CLI-533|M|client/src/lib/swRegistration.ts:178-204|注册失败静默吞错|register().then(_, ()=>{}) 不打 metric 也不通知 UI|catch 内 reportSwMetric('register.failed') 并日志
CLI-534|L|client/src/lib/offlineDb.ts:224-242|generateIdempotencyKey 名不副实|用 createId() 生成，每次不同；实为 trace ID 不是幂等键|重命名为 generateTraceKey 或真做幂等
CLI-535|L|client/src/lib/feedback.ts:52-79|beep 每次 new AudioContext|未复用；高频调用可能触及浏览器 context 上限|单例 AudioContext
CLI-536|L|client/src/lib/scanner.ts:36-71|playBeep 同上|同 feedback.ts|同上
CLI-537|L|client/src/lib/AppContainer.tsx:4-12|queryClient 模块级单例|测试多实例共享缓存污染；gcTime 默认 5min 偏长|按 app 创建或测试中 reset
CLI-538|L|client/src/lib/i18n.ts:34-39|interpolate 对象值转 [object Object]|String(vars[key]) 直接转|非原始值跳过或 JSON.stringify
CLI-539|L|client/src/lib/siteReadinessMapping.ts:213-237|parseImportText 无大小限制|JSON.parse 大字符串可能 DoS|限制输入长度
CLI-540|L|client/src/lib/offlineConflict.ts:76-104|diffValues 不处理 Date/Map/Set|按对象枚举键 diff；Date 等被当对象|加类型分派
CLI-541|L|client/src/lib/offlineDb.ts:244-256|backoffDelay 上限 10s 但 retryAfterMs 60s|Retry-After 优先且上限更高；注释未说明差异|注释说明
CLI-542|L|client/src/lib/resumableUpload.ts:108-110|createUploadId 分隔符 ::|idempotencyKey 含 :: 时歧义|用更安全的分隔或 hash
CLI-543|L|client/src/lib/designTokens.ts:61-63|riskToken 三元表达式难读|state ?? 'unknown' 重复求值|简化为 riskTokens[state ?? 'unknown'] ?? riskTokens.unknown
CLI-544|L|client/src/lib/requestCorrelation.ts:14|lastContext 模块级可变|非并发安全；测试间状态泄漏|测试 reset 或返回快照
CLI-545|L|client/src/lib/offlineSettings.ts:23-34|getDeviceId localStorage 清空即换 ID|清缓存后设置孤立|可接受，文档化
CLI-546|L|client/src/lib/swCache.ts:267-290|evictionCandidates 全排序 O(n log n)|大缓存排序开销|用堆或分桶
CLI-547|L|client/src/lib/siteReadinessBackend.ts:19-29|runBackendMappingDryRun 返回 unknown|调用方必须断言；契约不安全|泛型 <T> 或导出响应类型
CLI-548|L|client/src/lib/siteReadinessProbe.ts:120-138|probeBackendConnectivity 用裸 fetch|不走 axiosForBackend；无 trace/超时|统一走 http 或加 AbortController 超时
```

### 6.19 CLI-前端 types（CLI-601~612）

```
CLI-601|H|client/src/types/ewoh.ts:1-8|EWOH_ROLES 缺 'viewer' 角色|服务端 ANY_AUTHENTICATED_ROLES 含 viewer（roles.decorator.ts:7-15），e2e 返回 viewer|加入 'viewer' 并抽单一权威源
CLI-602|H|client/src/types/ewoh.ts:12-19|EWOH_ROLE_LABELS 缺 'viewer' 标签|Record<EwohRole,string> 仅 6 键；Layout.tsx:102 / PermissionState.tsx:21 直接索引，viewer 用户得到 undefined|补 viewer:'只读访客' 并对齐
CLI-603|H|client/src/types/openapi.d.ts:16612-16613（源 openapi/ewoh.yaml:13061）|alert.status 描述含 'handled'（不在 alert.yaml）且漏 'reopened'|shared/alert-state-machine.ts ALERT_STATES=open/acknowledged/processing/closed/reopened|修正描述并改 status 为字面量联合枚举
CLI-604|M|client/src/types/openapi.d.ts:15761|CursorPage.items 退化为 Record<string, never>[]|YAML items.items={type:object} 无 additionalProperties|YAML 显式 additionalProperties:true 或声明 items 泛型
CLI-605|M|client/src/types/openapi.d.ts:18598|MesForceResolveRequest.payload 类型 Record<string, never>|YAML payload={type:object} 无 additionalProperties，TS 拒绝带属性对象|YAML 显式 additionalProperties:true
CLI-606|M|client/src/types/openapi.d.ts 多处|100+ 处 schema 字段退化为 Record<string, never>|YAML type:object 无 additionalProperties 时生成器输出空对象类型|全量审计 YAML type:object 用法并显式声明
CLI-607|M|client/src/types/work-orchestration.d.ts:1108-1196|WorkGraph/WorkItem/WorkEdge 等 14 个类型退化为 {[key:string]:unknown}|YAML 声明 required 字段但无 properties，TS 丢失必填字段约束|YAML 显式声明 properties
CLI-608|L|client/src/types/common.ts:11-17|IUserProfile 死类型且形状与 UserContext 契约不一致|全仓 0 引用；字段 user_id/email/name/avatar/status 与契约完全不同|删除并改用 openapi.d.ts 的 UserContext
CLI-609|L|client/src/types/common.ts:4-7|IUserStatus 死枚举（数值 active=1/inactive=2，无契约来源）|仅供 IUserProfile.status 使用，IUserProfile 本身 0 引用|随 IUserProfile 一并删除
CLI-610|L|client/src/types/common.ts:24-27|IFileAttachment 死类型且形状与 FileUpload 契约不一致|全仓 0 引用；字段 bucket_id/file_path 与契约完全不同|删除并改用 FileUpload 契约
CLI-611|L|client/src/types/common.ts:28-33|Window 全局增强 userId/token/csrfToken 死代码|全仓 window.userId/token/csrfToken 搜索 0 匹配|删除该 declare global
CLI-612|L|client/src/types/global.d.ts:34-37|*.json 模块声明为 any|tsconfig 未启用 resolveJsonModule，所有 JSON 导入静默退化为 any|启用 resolveJsonModule 并移除该声明
```

### 6.20 CLI-前端 api/hooks/补齐测试（CLI-701~733）

```
CLI-701|H|client/src/lib/auth.ts:31-34|accessToken/refreshToken 存 localStorage|XSS 可读 localStorage 直接窃长期凭据|改 httpOnly+SameSite cookie 或内存+sessionStorage
CLI-702|H|client/src/lib/auth.ts:17-29|JWT 客户端解码无签名/exp 校验|decodeJwtPayload 仅 atob 不验签不验过期|前端只读不授权；过期由后端 401 兜底
CLI-703|M|client/src/hooks/useSchedulerStream.ts:289-295|batcher 重新启用时不重建|batcherRef 仅 null 初始化，dispose 后不重置|enabled true→false→true 后事件被丢弃；dispose 后置 null
CLI-704|M|client/src/hooks/useSchedulerStream.ts:419-431|SSE 失败计数器缺超时重置|consecutiveErrors 仅首条数据到达才归零|长时间间歇失败累积切轮询；按时间窗衰减
CLI-705|M|client/src/lib/http.ts:86-89|isAuthCall 用字符串包含判定|url.includes('/api/auth/login') 对子串误判|/api/auth/login-callback 会被当 auth 调用；改路径相等
CLI-706|M|client/src/lib/http.ts:99|refresh 后 token 可能为空仍发头|Bearer ${getAccessToken() ?? ''} 竞争下返回 null|空 token 触发 401 死循环；无 token 直接 reject
CLI-707|M|client/src/api/scheduler.ts:76,127,137,149,162,176,208,225,238,325,337,350,363,410,422,511,522,533,545,562|路径参数未 encodeURIComponent|${planId}/${conflictId}/${version} 多处直拼|统一 encodeURIComponent
CLI-708|M|client/src/api/mobile.ts:80|action 未编码拼 URL query|?action=${action} action 为 string 类型|action 含 & 或 = 破坏 URL；改 params 传参
CLI-709|M|client/src/api/alerts.ts:19|eventId 未编码拼 URL|/api/alerts/${eventId}/state|同上；改 encodeURIComponent
CLI-710|M|client/src/api/approvals.ts:69,78,92|approvalId/stepId 未编码拼 URL|/api/approvals/${approvalId}/steps/${stepId}/state|同上
CLI-711|M|client/src/api/models.ts:21|id 未编码拼 URL|/api/models/${id}/state|同上
CLI-712|M|client/src/api/world.ts:14|eventId 未编码拼 URL|/api/world/events/chain/${eventId}|同上
CLI-713|M|client/src/api/files.ts:56-75|uploadFiles 串行 await 注释误导|注释称 no partial server writes，实际已上传文件保留在服务器|注释与行为不一致；改并行或注释更正
CLI-714|M|client/src/api/dashboard.ts:78|getEvents limit 无上限保护|limit=50 默认值，调用方可传 999999 拖垮后端|加 Math.min(limit, MAX_LIMIT)
CLI-715|M|client/src/hooks/queryKeys.ts:20-23,27-32|部分全局 key 缺 orgId 隔离|spatialEntities/worldState/overview/replaySnapshots 不含 orgId|多租户切换可能命中旧租户缓存；按 orgId 分片
CLI-716|M|client/src/pages/CommandMap/hooks/useCommandMapController.test.tsx:197-206|activePlan 测试恒真弱断言|ctl 为旧 renderToString 快照，selectPlan 后 SSR 不重渲染|断言实为 SSR 限制，未验证派生逻辑
CLI-717|M|client/src/lib/http.ts:31|axios headers 类型谎言|(config.headers as Record<string, string>).Authorization 强转|AxiosHeaders 类型被绕过；改 AxiosHeaders.set
CLI-718|L|client/src/lib/http.ts:104-122|axiosForBackend 泛型 T 被忽略|签名 Promise<{data:any}>，调用方传 T 无效|files.ts:40 误用；移除泛型或返回 T
CLI-719|L|client/src/api/scheduler.ts:31|fetchDecisionHistory 类型断言|params: {...params} as Record<string, unknown>|改显式字段映射
CLI-720|L|client/src/api/tracing.ts:17|limit 未编码且无范围校验|/api/observability/traces?limit=${limit}|NaN/Infinity 拼出非法 URL；String+范围校验
CLI-721|L|client/src/api/ai.ts:50-64,79-86|api_key 经前端转发后端|visionUnderstand/saveAiConfig 接收 api_key|前端代码/日志可能记录；确认脱敏请求体
CLI-722|L|client/src/api/files.ts:40|泛型参数无效|axiosForBackend<FileRecord & {requestId?: string}> T 被忽略|移除或修正签名
CLI-723|L|client/src/pages/CommandMap/perf/commandMapPerf.test.tsx:96|console.error 被静默|console.error = () => undefined 包裹 renderToString|掩盖 React 渲染错误噪音；改过滤特定警告
CLI-724|L|client/src/pages/CommandMap/panels/decision-cockpit-render-only.test.ts:13-98|regex 断言模块不 import 判定逻辑|fs.readFileSync + 正则匹配 import 路径|动态 import/字符串拼接可绕过；改为依赖图静态分析
CLI-725|L|client/src/lib/swRegistration.test.ts:78-92|defineProperty navigator 未 afterEach 恢复|Object.defineProperty(globalThis,'navigator',...)|测试间全局污染；afterEach 加 delete
CLI-726|L|client/src/lib/leakAudit.test.ts:141|it 内 useFakeTimers 未配对恢复|jest.useFakeTimers() 在 disposeAll 测试内未 useRealTimers|影响后续测试定时器；改 beforeEach/afterEach
CLI-727|L|client/src/lib/appContext.test.ts:49|硬编码 APP_VERSION 断言|expect(APP_VERSION).toBe('0.6.0-rc4')|版本升级即失败；改读取运行时常量
CLI-728|L|client/src/lib/observability.test.ts:226-238|org 隔离只查 top-level keys|keys = Object.keys(received)，未检查 metrics 内 tag|metrics.tags.orgId 仍可能泄漏；递归扫描
CLI-729|L|client/src/pages/CommandMap/queryState.test.ts:37-45|retryAll 未覆盖 isError=false 项|只断言 isError=true 的 refetch 被调用|未验证 false 项是否被跳过；补否定用例
CLI-730|L|client/src/pages/CommandMap/replay.test.ts:31-45|findNearestSnapshot 边界覆盖不足|未测时间戳在范围外/单元素快照|补 out-of-range 用例
CLI-731|L|client/src/api/operations.ts:148,183,215|action 拼接 URL query 未编码|?action=${action} action 为字面量联合|受控字面量，运行时安全；改 params 更稳
CLI-732|L|client/src/lib/auth.ts:45-68|getAuthUser fallback 解 JWT 取 roles|localStorage 损坏时从 JWT 解码 roles|XSS 可注入 roles；后端必须独立授权
CLI-733|L|client/src/pages/CommandMap/entityColors.test.ts:10-12|fixture 用 as never 绕过类型|{...} as const as never|测试 fixture 类型安全降级；改正确类型
```

### 6.21 SH-共享契约层（SH-001~020）

```
SH-001|C|ewoh-spark-app/shared/exo-session.ts:34-40|exoId/personId 校验用 regex 替代 isCanonicalIdentity，TS 放行 Python 拒绝的 ID|TS regex /^[a-z][a-z0-9_]*:[^\s]+$/ 不限 value 字符集；Python 用 is_canonical_identity（限 [A-Za-z0-9._~@-]）|改用 isCanonicalIdentity 与 startsWith('device:') 双重判定
SH-002|H|ewoh-spark-app/shared/maintenance.ts:42-62|validateMaintenanceCondition 缺 Python 的 disposition 字段拒绝规则|Python 显式 if "disposition" in record: return ["unexpected_field"]，TS 无此检查|补 if (r.disposition !== undefined) return ['unexpected_field']
SH-003|H|ewoh-spark-app/shared/event-envelope.ts:59|schemaVersion 未与 JSON Schema const '1.0.0' 强校验|envelope.schema.json schemaVersion.const='1.0.0'，TS 仅校验非空字符串；Python 同样缺陷|TS/Python 都补 if (e.schemaVersion !== '1.0.0') return ['bad_schema_version']
SH-004|H|ewoh-spark-app/shared/alert-state-machine.ts:36-41|roleSatisfies('handler', undefined)=true 缺省放行|注释称"与 authenticated 处置语义兼容"，但 alert.yaml role=handler 语义为特定处置角色|移除 actorRole == null || 分支或调用方强制 actor 非空
SH-005|H|ewoh-spark-app/shared/agent-task.ts:90-96 + alert-state-machine.ts:50-60|状态转移函数忽略 YAML 声明的 role 约束|agent-task.yaml/alert.yaml 每条 transition 都带 role，TS/Python transitionAllowed 只校验 (from,to)|新增 actorRole 参数并复用 roleSatisfies 机制
SH-006|M|ewoh-spark-app/shared/reasoning-trace.ts:198-230|evaluateReasoningRules 未按 subjectId 去重，可产生重复 conclusionId|Python evaluate_rules 先 by_kind 去重；TS 直接迭代 facts|评估前 const bySubject = new Map(facts.map(...)) 去重
SH-007|M|ewoh-spark-app/shared/world-contract.ts:148-153|validateWorldSnapshot 命中首条 state 错误即返回，Python 收集全部错误|TS if (errors.length > 0) return [errors[0]] 中断|改为收集所有错误码后再返回
SH-008|M|ewoh-spark-app/shared/decision.ts:129-131|isNonEmptyStringList 命名误导：实际允许空数组|Array.isArray(value) && value.every(...)，空数组 every() 返回 true|重命名 isStringList 或显式加 length > 0
SH-009|M|ewoh-spark-app/shared/learning-evaluation.ts:56|metricValue 校验拒绝 NaN，Python 接受 NaN|TS Number.isNaN(value) 返回 bad_metric_value；Python isinstance 通过 NaN 不报错|Python 端补 not math.isfinite(value)（推荐 TS 更严格语义）
SH-010|M|ewoh-spark-app/shared/api.interface.ts:1039,1059,1067|TimelineEvent 字段保留 | string 逃生舱|source/permissionVisibility/riskLevel 用 Type | string，与"收敛为封闭注册表"注释矛盾|移除 | string 改封闭枚举（riskLevel 还缺 'critical'）
SH-011|L|ewoh-spark-app/shared/entity-model.ts:93-95|version 拒绝 boolean True，Python 接受 True|TS typeof version !== 'number' 拒 true；Python isinstance(True,int)=True|Python 端补 isinstance(version, bool) 排除
SH-012|L|ewoh-spark-app/shared/world-contract.ts:145|entityVersions value 拒 boolean，Python 接受|同 SH-011|Python 端补 bool 排除
SH-013|L|ewoh-spark-app/shared/exo-config.ts:151-154|effectiveFrom=null 归 bad_effective_from，Python 归 missing_field|TS r.effectiveFrom === undefined 才返 missing_field|统一 null/undefined 同语义
SH-014|L|ewoh-spark-app/shared/location.ts:70-72|WGS84 x/y 同时缺失时 TS 返 2 条 bad_coordinate，Python 返 1 条|Python if x is None or y is None: return ["bad_coordinate"] 即返|统一早返
SH-015|L|ewoh-spark-app/shared/event-catalog.ts:6 + event_catalog.py:5|注释称"64 类"实际 65 类|两文件 comment 都写"64 类"，实际各 65 个事件类型|更新注释
SH-016|L|ewoh-spark-app/shared/api.interface.ts:1067|TimelineEvent.riskLevel 内联枚举缺 'critical'|仅 'low'|'medium'|'high'|string，risk 契约 RISK_SEVERITY_LADDER 含 critical|补 'critical' 并移除 |string
SH-017|L|ewoh-spark-app/shared/simulation-run.ts:210|evaluateCapacity 使用 ! 非空断言，浮点精度边界风险|normalized.find(...)! 若失配则运行时 crash|改用显式判空 + 显式错误
SH-018|L|ewoh-spark-app/shared/agent-task.spec.ts:81-88|状态机 spec 缺 in_progress→cancelled 测试|yaml 与实现都支持该转移|补 transitionAllowed('in_progress','cancelled') 断言
SH-019|L|ewoh-spark-app/shared/agent-manifest.spec.ts:72-89|spec 缺 safety_autonomy_forbidden 与 level_risk_conflict+L3 覆盖|仅测 safety_role_write_forbidden 与 critical+L2|补对应断言
SH-020|L|ewoh-spark-app/shared/workorder.ts:76-81|catch DomainContractError 后按 code 精确过滤并 re-throw|TS 仅 unknown_severity re-throw；Python 一律返 unknown_severity|TS 语义更严，保留并文档化
```

### 6.22 FS-飞书应用（FS-001~021）

```
FS-001|M|ewoh-feishu-app/server/security.js:151-167|签名未覆盖请求体且算法疑似不符飞书协议|HMAC(ts+nonce+key)无body；飞书为SHA256(ts+nonce+key+body)需核实|对照飞书文档改算法并纳入 raw body
FS-002|M|ewoh-feishu-app/server/security.js:153|未配encrypt_key时签名校验fail-open|if(!encryptKey)return true 直接放行，仅剩token+timestamp|生产强制配encrypt_key或显式降级
FS-003|L|ewoh-feishu-app/server/security.js:184|verification token非常量时间比较|headerToken!==expectedToken，与auth.js timingSafeEqual不一致|改用crypto.timingSafeEqual
FS-004|M|ewoh-feishu-app/server/index.js:178-195|webhook not-found路径泄露dedup记录|if(!event)return 前已acquire dedup未回滚，重试误报duplicated|not-found分支deleteWebhookDedup回滚
FS-005|M|ewoh-feishu-app/server/index.js:160,256+security.js:89-99|重放保护键不一致致in-memory重放失效|extractEventId查header.event_id，markReplayHandled传value.event_id|统一重放键(均用header.event_id)
FS-006|M|ewoh-feishu-app/server/feishu.js:416-423|时区口径不一致|内部UTC ISO，fmtDateTime用getHours()本地时区写飞书Base|统一UTC或显式指定目标时区
FS-007|M|ewoh-feishu-app/server/index.js:70-98|缺helmet/安全头/自定义错误处理|仅cors+json+static|加helmet、disable x-powered-by、错误中间件
FS-008|M|ewoh-feishu-app/server/sync.js:373-481|全量同步无并发锁，30s可能重叠运行|50事件串行search+update，setInterval不等，重叠竞态|加运行中互斥标志或改批量upsert
FS-009|M|ewoh-feishu-app/test/integration.test.js:40-100|webhook handler重复实现且与index.js分歧|复制简化版缺createApproval/markReplayHandled/updateCard|抽取index.js handler供测试复用
FS-010|M|ewoh-feishu-app/server/auth.js+server/index.js|API鉴权端点无限流/暴力破解防护|apiAuth仅safeEqual，无限流中间件|对/api写与/webhook加IP+token失败限流
FS-011|L|ewoh-feishu-app/server/index.js:262,229|/webhook/card错误回传e.message|res.status(500).json({error:e.message})泄露内部异常|对外通用文案，详情仅日志
FS-012|L|ewoh-feishu-app/server/health.js:73-79|/health/ready免鉴权暴露内部错误串|detail含lastSyncError/lastFeishuError/reason|探针仅返回状态位
FS-013|L|ewoh-feishu-app/server/security.js:220|审计IP取自X-Forwarded-For可伪造|ip:req.headers['x-forwarded-for']，未配trust proxy|配trust proxy后用req.ip
FS-014|L|ewoh-feishu-app/server/index.js:87-94|CORS allowedHeaders未含Authorization/X-API-Key|allowedHeaders仅Content-Type/X-Lark-Signature，auth.js读authorization/x-api-key|增加Authorization、X-API-Key
FS-015|L|ewoh-feishu-app/server/feishu.js:630,642,670|base_token经argv暴露于进程表|--base-token <token>传execFile，ps可见|lark-cli支持stdin/env注入后改用
FS-016|L|ewoh-feishu-app/server/feishu.js:637-639,662-663|baseRecordUpdate/BatchCreate未复用resolveBaseToken|重复env||cfg.base_token，凭证逻辑双份|统一调用resolveBaseToken()
FS-017|L|ewoh-feishu-app/server/rules.js:17-38+server/db.js:119-156|DEFAULT_RULES与SEED_RULES重复|两份规则阈值分别维护|单一事实源，派生或删其一
FS-018|L|ewoh-feishu-app/test/security.test.js:178-219|simulator/CORS测试内联重写未测真实函数|测试用局部变量重演env判断，未require index.js|导出并直接测simulatorEnabled/resolveCorsOrigins
FS-019|L|ewoh-feishu-app/server/rules.js:175-187|evidence回写非原子读-改-写|getEvent→改evidence→UPDATE非事务，并发可覆盖message_id|用单条UPDATE或事务回写
FS-020|L|ewoh-feishu-app/server/db.js:282-285,304-313|N+1查询|getLatestTelemetryAll逐设备查询；getRuleByCode全表扫后JS过滤|GROUP BY子查询；rules加event_code列
FS-021|L|ewoh-feishu-app/server/sync.js:271|轮询用larkCli无重试，与同步路径larkCliRetry不一致|await feishu.larkCli单次，瞬时失败整页中止|统一重试策略或文档化
```

### 6.23 SQL-数据库迁移（SQL-001~054）

```
SQL-001|C|db/migrations/standalone_025_scheduler_rls.sql:90-101,112-124,134-147,157-170,180-193,203-216,226-239|scheduler 8 表 RLS policy 含 OR org_id IS NULL 放行|7 表 org_id 可空(006/010/017/023/025)，NULL 行对所有租户可见可写|移除 NULL 分支或对 NULL 行加 global_admin 门控
SQL-002|C|db/migrations/standalone_025_scheduler_rls.rollback.sql:14-32|回滚仅 DROP POLICY 不 DISABLE RLS，8 表留 RLS-enabled 无 policy|PG 语义:RLS 启用+无 policy=全拒，非注释所称"无过滤"|回滚追加 ALTER TABLE ... DISABLE ROW LEVEL SECURITY
SQL-003|C|db/migrations/standalone_008_phase2_realtime.sql:12-13|ALTER ewoh_outbox ADD COLUMN 在 017 CREATE TABLE 之前，全新库 008 直接失败|008 行 12 ALTER 不存在表，017 行 50 才 CREATE|008 前置 017 或合并入 017
SQL-004|C|db/migrations/standalone_009_reservation_conflict.sql:26|ALTER ewoh_resource_reservation 在 017 CREATE 之前|009 引用未创建表(017 行 25 才 CREATE)|009 前置 017
SQL-005|C|db/migrations/standalone_014_policy_weights.sql:14|ALTER ewoh_scheduling_policy 在 017 CREATE 之前|014 引用未创建表(017 行 70 才 CREATE)|014 前置 017
SQL-006|C|db/migrations/standalone_011_outbox_sequence.sql:17|ALTER ewoh_outbox.sequence SET DEFAULT 在 017 CREATE 之前|011 引用未创建表/列|011 前置 017
SQL-007|C|db/migrations/standalone_056_route_org_isolation.sql:39-71|route_node/route_edge policy 未指定 TO role，默认 TO PUBLIC|CREATE POLICY ... FOR ALL USING(...) 无 TO 子句=PUBLIC 含 anon|显式 TO service_role 收紧
SQL-008|C|db/migrations/standalone_056_route_org_isolation.rollback.sql:8-15|回滚不 DISABLE RLS，两表留 RLS-enabled 无 policy|同 SQL-002，全拒访问|追加 DISABLE ROW LEVEL SECURITY
SQL-009|H|db/migrations/standalone_005_workbench_prod.sql:88-105,122-150|saved_views/workbench_export_tasks 无 RLS，organization_id 非空但无行级隔离|两表对 service_role 全 DML，跨租户读写|补 RLS policy + UNIQUE(org,...)
SQL-010|H|db/migrations/standalone_029_prediction_shadow_observation.sql:31-50|prediction_shadow_observation 无 RLS，org_id 可空|跨租户观测数据泄漏|补 RLS 或显式 GLOBAL_SHARED 标注
SQL-011|H|db/migrations/standalone_031_snapshot_version_counter.sql:23-28|ewoh_snapshot_version_counter 无 org_id 无 RLS|按 day 全局计数器，跨租户版本号争用|如设计为全局，manifest 显式登记
SQL-012|H|db/migrations/standalone_004_ewoh_domain.sql:13-58,69-145|6 张域表(locks/handoffs/git_sync/evidence/replication/idempotency)无 RLS|manifest 标 special，但 locks/replication 有 org_id 仍无隔离|补 RLS 或文档化 GLOBAL_SHARED
SQL-013|H|db/migrations/standalone_006_scheduling.sql:22-34|ewoh_scheduling_run UNIQUE(run_id) 缺 org_id|manifest business_key=[org_id,run_id]，跨租户同 run_id 冲突|改 UNIQUE(org_id,run_id)
SQL-014|H|db/migrations/standalone_006_scheduling.sql:60-80|ewoh_scheduling_plan_assignment UNIQUE(assignment_id) 缺 org_id|跨租户同 assignment_id 冲突|改 UNIQUE(org_id,assignment_id)
SQL-015|H|db/migrations/standalone_006_scheduling.sql:94-105|ewoh_scheduling_constraint UNIQUE(constraint_id) 缺 org_id|跨租户冲突|改 UNIQUE(org_id,constraint_id)
SQL-016|H|db/migrations/standalone_006_scheduling.sql:117-123|ewoh_world_state_snapshot UNIQUE(snapshot_version)，无 org_id 列|manifest business_key=[org_id,snapshot_id]|补 org_id 列 + 复合唯一
SQL-017|H|db/migrations/standalone_006_scheduling.sql:130-160|ewoh_route_node/edge UNIQUE(node_id/edge_id) 缺 org_id|056 补 org_id 列但未补唯一键|改 UNIQUE(org_id,node_id)/(org_id,edge_id)
SQL-018|H|db/migrations/standalone_006_scheduling.sql:173-187|ewoh_assignment_event UNIQUE(event_id) 缺 org_id|manifest business_key=[org_id,event_id]|改 UNIQUE(org_id,event_id)
SQL-019|H|db/migrations/standalone_017_scheduling_tables_fix.sql:50-63|ewoh_outbox UNIQUE(event_id) 缺 org_id|manifest business_key=[org_id,outbox_id]|改 UNIQUE(org_id,event_id)
SQL-020|H|db/migrations/standalone_010_scheduling_feedback.sql:19-51|ewoh_scheduling_feedback UNIQUE(feedback_id) 缺 org_id，org_id 可空|manifest NOT NULL+[org_id,feedback_id]|NOT NULL + UNIQUE(org_id,feedback_id)
SQL-021|H|db/migrations/standalone_013_conflict_lifecycle.sql:14-39|ewoh_scheduling_conflict UNIQUE(conflict_id) 缺 org_id，org_id 可空|manifest NOT NULL+[org_id,conflict_id]|NOT NULL + UNIQUE(org_id,conflict_id)
SQL-022|H|db/migrations/standalone_015_route_cost_matrix.sql:13-25|ewoh_route_cost_matrix UNIQUE(matrix_id) 缺 org_id，org_id 可空|manifest NOT NULL+[org_id,matrix_id]|NOT NULL + UNIQUE(org_id,matrix_id)
SQL-023|H|db/migrations/standalone_018_execution_feedback.sql:11-56|ewoh_scheduling_execution UNIQUE(execution_id,assignment_id) 缺 org_id|manifest business_key=[org_id,execution_id]|改 UNIQUE(org_id,*)
SQL-024|H|db/migrations/standalone_019_kpi_replay.sql:12-49|ewoh_scheduling_kpi/policy_replay UNIQUE(kpi_id/replay_id) 缺 org_id|manifest business_key=[org_id,...]|改 UNIQUE(org_id,*)
SQL-025|H|db/migrations/standalone_020_policy_lifecycle.sql:33-46|ewoh_policy_activation UNIQUE(activation_id) 缺 org_id，org_id 可空|manifest NULLABLE 但 business_key=[org_id,activation_id]|UNIQUE(org_id,activation_id)
SQL-026|H|db/migrations/standalone_020_policy_lifecycle.sql:29-31|uq_ewoh_scheduling_policy_org_active WHERE status='ACTIVE'，org_id 可空|PG NULL 不等:多 org_id=NULL ACTIVE 行可共存|COALESCE(org_id,sentinel) 或 NOT NULL
SQL-027|H|db/migrations/standalone_019_kpi_replay.sql:23-24|uq_ewoh_scheduling_kpi_org_period(org_id,period_start,period_end)，org_id 可空|NULL 不等致多 NULL 行共存，去重失效|COALESCE 或 NOT NULL
SQL-028|H|db/contracts/schema-manifest.yaml:607-765|ewoh_agent_approval 列于 additional_hardened_existing_tables status=altered|实际 standalone_049 CREATE TABLE 全新，分类漂移|移入 managed_tables status=new
SQL-029|H|db/contracts/schema-manifest.yaml:561-567|ewoh_learning_proposal status=altered|实际 standalone_045 CREATE TABLE 全新|改 status=new
SQL-030|H|db/contracts/schema-manifest.yaml|saved_views/workbench_export_tasks/prediction_shadow_observation/ewoh_snapshot_version_counter 4 表迁移创建但 manifest 完全缺失|契约三方对账失败|补入 manifest
SQL-031|H|db/contracts/schema-manifest.yaml:10-12 vs 34,38|header managed_count=73/physical_create_count=76，但 NO-13c(051) 注 73->74，NO-13o(054) 注 74/77|header 与 notes 计数不一致|同步 header
SQL-032|H|db/contracts/schema-manifest.yaml:43|口径说明 managed_count=65/core=59，与 header 73 / 最新 notes 68 冲突|Round 39 注释未随 037-051 更新|更新或删除 stale 注释
SQL-033|H|db/migrations/standalone_039_knowledge_entry.sql:192-213|ewoh_knowledge_entry 新 policy 仅 TO service_role，authenticated 读权限被删|001 原 ewoh_org_select TO authenticated DROP 后无替代，authenticated 全拒|补 authenticated SELECT policy 或文档化
SQL-034|H|db/migrations/standalone_042_trace_span.sql:69,73|trace_span RLS 调 ewoh_org_visible(org_id::uuid)，但 org_id 列为 varchar(255)|非 UUID 字符串运行时抛 invalid input syntax|改 org_id uuid 或比较 ::text
SQL-035|H|db/migrations/standalone_006_scheduling.sql:22-34,60-80,173-187|ewoh_scheduling_run/plan_assignment/assignment_event org_id varchar(255) 可空，manifest 标 NOT NULL|7 表 NULL 行经 SQL-001 policy 跨租户泄漏|ALTER COLUMN SET NOT NULL + backfill
SQL-036|M|db/migrations/001_ewoh_managed_tables.sql:1-8|legacy 001 标 DEPRECATED 但仍随仓库分发|误执行风险|移出 migrations 目录或加 .disabled 后缀
SQL-037|M|db/migrations/001_ewoh_managed_tables.sql vs standalone_001_schema.sql|两套基线迁移角色命名不同(workspace_aadknm4yzbyds vs anon/authenticated/service_role)|双轨 auth 模型，误混用致权限丢失|统一或显式标注不可混用
SQL-038|M|db/migrations/standalone_001_schema.rollback.sql:6-63|回滚对 18 张"altered existing"表执行 DROP TABLE CASCADE|破坏既有数据(ewoh_device/event/personnel 等)|改为 DROP COLUMN additive 列
SQL-039|M|db/migrations/standalone_003_runtime_role.rollback.sql:3|DROP ROLE IF EXISTS ewoh_api 在 ewoh_api 仍持对象时失败|非幂等|先转移所有权再 DROP ROLE
SQL-040|M|db/migrations/standalone_005_workbench_prod.rollback.sql:12-17|回滚 DROP COLUMN org_id 于 6 张源表，破坏既有 RLS policy|001 RLS policy 引用 org_id，删列后 policy 失效|先 DROP POLICY 再 DROP COLUMN
SQL-041|M|db/migrations/standalone_026_route_cost_matrix_full_key.rollback.sql:8-9|回滚不 DROP route_graph_version/candidate_set_hash 列|rollback 后应用层仍写，索引已删致约束缺口|同步 DROP COLUMN 或文档化保留理由
SQL-042|M|db/migrations/standalone_028_assignment_event_tenancy.rollback.sql:20-27|回滚删触发器/函数/索引，但保留 org_id 列|列成为惰性血缘列，verify 断言可能误判|文档化或同步删列
SQL-043|M|db/migrations/standalone_039_knowledge_entry.sql:94|base_id DROP NOT NULL|破坏与 ewoh_knowledge_base 引用语义|回滚 backfill entry_id，但运行期 NULL base_id 无约束
SQL-044|M|db/migrations/standalone_023_scheduler_incremental.sql:91|scheduler_constraint_org_isolation 读 app.primary_org_id|与 025 修复的 app.current_org_id 不一致，023 单独执行时 GUC 名错误|023 已被 025 覆盖，但单跑 023 仍坏
SQL-045|M|db/migrations/standalone_001_schema.sql:1565-1674|每条 REVOKE 重复列 authenticated 两次|FROM anon, authenticated, authenticated|去重为单次 authenticated
SQL-046|M|db/migrations/standalone_024_scheduler_outbox_notify.sql:18-23|notify_scheduler_outbox 函数未 GRANT EXECUTE|触发器调用不需显式 GRANT，但 SECURITY DEFINER 暴露面未文档化|显式 REVOKE FROM PUBLIC + GRANT TO service_role
SQL-047|M|db/migrations/standalone_039_knowledge_entry.rollback.sql:14-16|回滚不可逆:status 值域收敛为 {draft,verified,superseded}|遗留 status 值(如 published)丢失|文档化数据损失
SQL-048|L|db/migrations/standalone_001_schema.sql:1534-1542|RLS 启用列表漏 ewoh_world_snapshot/world_delta_log/system_config/audit_log|特殊 policy 在 1545-1562 单独补，但循环列表注释称"全部"|注释与代码漂移
SQL-049|L|db/contracts/schema-manifest.yaml:43|口径说明中英混杂 + 多版本计数(51/52/55/59/65)|可读性差，易误读|统一为单段最新计数
SQL-050|L|db/migrations/standalone_006_scheduling.sql:130-160|ewoh_route_node/edge 创建时无 org_id，056 后补|manifest business_key=[org_id,node_id] 为事后声明|补列后应同步更新唯一约束(见 SQL-017)
SQL-051|L|db/migrations/standalone_002_users.sql:22-28|ewoh_user RLS 启用但无 policy，REVOKE ALL|设计为全拒(经 SECURITY DEFINER 函数访问)，但未文档化|补注释说明设计意图
SQL-052|L|db/migrations/standalone_011_outbox_sequence.sql:20-24|setval 用 SELECT MAX(sequence)，大表全表扫描|一次性运维可接受，但缺索引 idx_ewoh_outbox_sequence(021 后补)|无
SQL-053|L|db/migrations/standalone_039_knowledge_entry.sql:54-65|ADD COLUMN IF NOT EXISTS 链式多列，部分 NOT NULL DEFAULT 部分无|新行依赖 DEFAULT，旧行 NULL 后续 UPDATE backfill|无
SQL-054|L|db/migrations/standalone_056_route_org_isolation.sql:39-54|policy 与 025 逐字对齐(注释声称)，但 025 含 TO service_role，056 漏写|代码与注释漂移|补 TO service_role
```

### 6.24 SQL-数据库 seed/verify/runner（SQL-101~110）

```
SQL-101|L|db/contracts/schema-manifest.yaml:10|managed_count=73 与实际 managed_tables 条目 74 不一致|顶部 managed_count:73，实际列表 74 项|同步顶部 managed_count 为 74
SQL-102|M|db/seed/standalone_006_scheduling_seed.sql:29-90,234-244|route_node/route_edge/scheduling_constraint seed 未提供 org_id 列|INSERT 列表无 org_id；056/023 后表有 org_id 列，seed 行 org_id=NULL，RLS 启用后 NULL 存量行全租户可见|demo seed 补 org_id 或注释说明仅限 superuser 演示
SQL-103|M|db/verify/|5 个迁移无对应 verify 脚本|002_ewoh_users/standalone_002_users/standalone_003_runtime_role/standalone_007_scheduling_persistence/standalone_008_phase2_realtime 均无 verify|为这 5 个迁移补充 verify 脚本
SQL-104|M|db/verify/001_verify.sql:3 + standalone_001_verify.sql:3|expected(name) 列表硬编码 68 项，不从 manifest 派生|verify SQL 静态 68 项 vs runner 动态 coreManagedTableCountFromManifest()；manifest 删表时 count 匹配但表丢失被掩盖|verify SQL 的 expected 列表从 manifest 派生或加 CI 对账
SQL-105|L|db/runner/run_migrations.js:1376-1378|expected 字典隐式期望未列出 key 为 0|filter 用 expected[key]||0，未列出的列默认期望 0|显式列出所有 14 个返回列的期望值
SQL-106|L|db/verify/standalone_001_verify.sql:55|grantee IN ('authenticated','authenticated') 重复|字符串重复，疑为 typo|修正为两个不同角色名或单值
SQL-107|L|db/runner/run_migrations.js:599-1214,583|50+ verify if 分支高度重复 + verify 命令列表手动维护 5 处同步|每个 verify handler 结构相同；新增 verify 需同步 FILES/EXECUTE_COMMANDS/第583行列表/which映射/handler|抽象为表驱动（command→{file,expectedFields,assertion}）
SQL-108|L|db/seed/002_default_admin.sql:9 + standalone_002_admin.sql:9|ORDER BY _created_at LIMIT 1 非确定性选择 org|多 org 行时 admin 绑定哪个 org 未定义|改用 ORDER BY id 或显式指定默认 org_id
SQL-109|L|db/runner/run_migrations.js:488-494|coreManagedTableCountFromManifest fallback 硬编码 51|实际核心表 68；manifest 解析失败时 fallback 51，verify 期望 51 而 SQL 返回 68，误报失败|fallback 更新为 68 或解析失败直接报错
SQL-110|L|db/seed/002_default_admin.sql:9-13 + standalone_002_admin.sql:9-13|ON CONFLICT (username) DO NOTHING 静默跳过已存在用户|若运维重跑 seed 轮换密码，同名用户不会更新 password_hash|文档说明改密需先 DELETE 或改用 ON CONFLICT DO UPDATE
```

### 6.25 SCR-构建与门禁脚本（SCR-001~043）

```
SCR-001|C|scripts/audit-domain-contracts.js:389 等 20+ 处|canonical ID 正则 [^\\s] 误写为字面反斜杠+s，接受空白、拒绝 's'|/^[a-z][a-z0-9_]*:[^\\s]+$/（389/419/442/478/510/1419/1442/1515/1520/1530/1537/1558/1587/1592/1593/1637/1643/1645/1649）|改为 [^\s]（单反斜杠）
SCR-002|C|scripts/standalone-ops-check.sh:28-29|EWOH_OPS_RESTORE_DB 拼入 sql.unsafe，可 SQL 注入 drop/create database|sql.unsafe('drop database if exists "' + db + '"')|改用 identifier 转义或白名单校验
SCR-003|C|scripts/e2e-db-verify.mjs:9,11,18,21|硬编码开发者机器绝对路径，CI 不可运行|/Users/panhao/.workbuddy/...、/Volumes/Extra/CodeProj/EWOH|改用相对路径或 env
SCR-004|C|scripts/e2e-db-verify-022.mjs:9,15,21|同上，硬编码开发者机器路径|/Users/panhao/.workbuddy/...、/Volumes/Extra/CodeProj/EWOH|改用相对路径或 env
SCR-005|H|scripts/soak-load.js:165|queue-backlog 门禁恒 ok:true（假成功）|results.push({ id: 'queue-backlog', ok: true, ... })|加 inserted/claimed/succeeded 断言
SCR-006|H|scripts/container-image-gate.sh:66|硬编码 /tmp/trivy 路径；预装 trivy 时跳过下载导致命令未找到|if /tmp/trivy image ... 但 if ! command -v trivy 跳过下载|用 TRIVY_BIN 变量统一
SCR-007|H|scripts/canary-deploy.sh:111|post-rollback 业务态校验退化为 /health/ready（export-tasks 失败被吞）||| echo "note: export-tasks endpoint 未命中..."|保留业务态断言或 BLOCKED
SCR-008|H|scripts/truth-feature-status.js:308-313|README 缺能力状态表时 ok=true（rows.length===0 分支）|tableFound || rows.length === 0 但 detail 说"需添加"|缺失应 FAIL
SCR-009|M|scripts/standalone-check.sh:48-55|E2E/browser 在 env 未设时静默 SKIP 仍报 PASSED|echo "...skipping..." 后继续|至少记 BLOCKED
SCR-010|M|scripts/truth-manifest.js:195-201|--check 缺失 manifest 时自动生成 baseline 并 exit 0|if (!fs.existsSync(outPath)) { ...exit(0); }|缺失应 exit 非 0
SCR-011|M|scripts/truth-manifest.js:204-213|--check 不比较 gates 数组，只比 5 个 volatile key|drift 列表不含 gates|把 gates 状态纳入比较
SCR-012|M|scripts/collect-repo-facts.js:251|liveOpenapi 拼接 controller/controller（应为 controller/spec）|`${openapi.controller}/${openapi.controller}`|第二项改为 openapi.spec
SCR-013|M|scripts/audit-repo-facts.js:359 + collect-repo-facts.js:231|硬编码 release/ewoh-0.6.0-rc4/ 路径|readYamlSafe(..., 'release/ewoh-0.6.0-rc4/...')|按 version.json 动态解析
SCR-014|M|scripts/canary-deploy.sh:61-70|无 /metrics 时 p95 恒 0，p95 阈值被禁用|fallback echo "0 0 1"|无 /metrics 时 BLOCKED
SCR-015|M|scripts/canary-deploy.sh:94|helm rollback 硬编码 revision 1|helm rollback "$RELEASE" 1|动态解析上一 revision
SCR-016|M|scripts/verify-helm-runtime.sh:36,96-101|WORKER_ENABLED 默认 false，worker 部署不校验|WORKER_ENABLED="${WORKER_ENABLED:-false}" + echo skip|CI 强制 true
SCR-017|M|scripts/bandit-gate.py:101|path 子串匹配可能过宽抑制（如 src/foo.py 匹配 tests/src/foo.py）|path_sub in str(finding.filename)|改用精确路径或正则
SCR-018|M|scripts/bandit-gate.py:120-123|仅门禁 HIGH；MEDIUM/LOW 不阻断|high_findings = [r for r in results if ... == "HIGH"]|按需扩展到 CRITICAL
SCR-019|M|scripts/truth-feature-status.js:211-219|implemented=false 文档提及降级 WARN 不 FAIL|check(..., true, ..., 'WARN')|保留 FAIL 或显式 exemption
SCR-020|M|scripts/truth-feature-status.js:627-636|--skip-openapi 自动 ok:true（信任另一 CI 步骤）|check(checks, 'openapi_no_drift', true, '跳过...')|跳过时记 BLOCKED
SCR-021|M|scripts/truth-feature-status.js:566-583|productionEnabled=true 时 canonical 声称检查自动通过|check(..., true, 'productionEnabled=true：跳过...')|仍应校验一致性
SCR-022|M|scripts/generate-ddl-package.js:1822-1826|无 main 守卫，require 即写 5 个文件|模块顶层直接 writeOutput(...)|包入 if (require.main === module)
SCR-023|M|scripts/standalone-postgres-check.sh:88-115|回滚清单手工硬编码 22 个迁移名，新增迁移需手改|# 032/034/.../056 由独立 apply 创建|从 runner 自动派生
SCR-024|M|scripts/scale-release-review.js:75|硬编码 166 路由阈值|manifest.documentedControllerOperations >= 166|从 manifest 派生
SCR-025|M|scripts/e2e-db-verify.mjs:22|硬编码 Miaoda schema 名|const SCHEMA = 'workspace_aadknm4yzbyds';|用 env 或 public
SCR-026|M|scripts/generate-ddl-package.js:11-15|role 名硬编码 Miaoda token|anon_workspace_aadknm4yzbyds 等|用占位符由下游替换
SCR-027|M|scripts/package-release.sh:56-62|cp ... || true 吞掉缺失文件错误|cp "${ROOT_DIR}/README.md" ... 2>/dev/null || true|缺失应 fail
SCR-028|M|scripts/audit-repo-facts.js:457-462|semantic exemptions 可抑制真实冲突且无过期校验|exemptions: Object.keys(readJsonSafe(...))|加 expiresAt/owner/reason
SCR-029|M|scripts/container-image-gate.sh:62-65|Trivy 下载无 checksum 验证，可被 MITM|curl -sSL -o /tmp/trivy.tar.gz ...|加 SHA256 校验
SCR-030|M|scripts/verify-rc-upgrade.mjs:451,456|硬编码列数/授权数（2/2/4/1）等魔法数字|Number(solver.plan_nullable) === 2 等|从 schema 派生
SCR-031|M|scripts/verify-helm-runtime.sh:32|IMAGE_TAG_UPGRADE 默认 0.6.0-rc5 可能不存在|IMAGE_TAG_UPGRADE="${IMAGE_TAG_UPGRADE:-0.6.0-rc5}"|CI 必须显式设置
SCR-032|L|scripts/deployment-tck.js:21-26 + scenario-tck.js:21-30|catch 吞错误详情，只记脚本名|failures.push(step.script) 无 stderr|打印 error.stderr 尾部
SCR-033|L|scripts/pilot-soak.sh:26|step() 把 stdout/stderr 重定向到 /dev/null，失败无细节|"$@" >/dev/null 2>&1|失败时打印 tail
SCR-034|L|scripts/pilot-soak.sh:52-59|ruff lint 仅 WARN 不阻断（已知存量债）|echo "WARN ... 不阻断 soak"|待存量清理后收紧
SCR-035|L|scripts/bandit-gate.py:96|无 ruleId 的 suppression 静默跳过|if not rule_id: continue|记 warning
SCR-036|L|scripts/truth-manifest.js:47-59|gate-results 文件解析失败静默跳过|catch { /* skip unparseable */ }|记 warning
SCR-037|L|scripts/audit-env-inventory.js:120-123|未覆盖 const { X } = process.env 等解构模式|matchers 仅含 process.env.X 等|扩展 matcher
SCR-038|L|scripts/audit-repo-facts.js:503|死变量 manifestDetailHasOpenapi|const manifestDetailHasOpenapi = true;|删除
SCR-039|L|scripts/reconcile-identity-legacy.mjs:124|用 .replace 做 ${} 模板替换，脆弱|'...${planned.length}...'.replace(...)|用 JSON.stringify
SCR-040|L|scripts/canary-deploy.sh:111|硬编码 orgA 用于业务态 curl|-H "X-Org-Id: orgA"|从 env 读取
SCR-041|L|scripts/audit-domain-contracts.js:781-796,921-928|execFileSync 把 JSON.stringify 结果拼入 python -c 字符串|"...JSON.stringify(...)." 拼接|改用 stdin 传 JSON
SCR-042|L|scripts/collect-repo-facts.js:199-210|workGraph 失败时回退到 state.json 旧值（可能过期）|catch { ... readJsonSafe('state.json') }|回退时记 WARN
SCR-043|L|scripts/audit-repo-facts.js:374-376|version 一致性用 JSON.stringify(...).includes(version) 子串匹配|JSON.stringify(stateFactsJson).includes(version)|按字段精确比对
```

### 6.26 TOOL/REL-工具与 release 抽查（TOOL-001~017、REL-001~007）

```
TOOL-001|H|tools/semantic-rules/lib/rules.js:899-913|no-self-exemption 授权检测失效|decisions 仅 D-编号，text.includes('exempt') 永不匹配，authorized 永空|parseDecisions 提取决策正文搜索授权词
TOOL-002|H|tools/semantic-rules/index.js:54-55 + lib/engine.js:182-188|CLI --exempt 可豁免 no-self-exemption 元规则|--exempt 直接 push 不过滤，可同时豁免守卫与 high-risk 规则绕过 strict|CLI --exempt 仅接受 warning 级，no-self-exemption 硬编码不可豁免
TOOL-003|M|tools/gate-engine/index.js:51-56|人工决策直接采纳无 approver 校验|human.decision==='approved' 直接置 approved，不校验 approver 身份|校验 approver 字段与上游 RBAC 一致
TOOL-004|M|tools/work-indexer/index.js:164-166 + work-console/index.js:181-187|evidenceMeta.complete 容忍 'unknown' 占位符|verifier 默认 'unknown'，complete 只查非空|complete 应排除 'unknown' 字面量
TOOL-005|M|tools/factory-replication/index.js:57|differencesResolvedRate 缺省默认 1 通过|(report.differencesResolvedRate ?? 1) >= 0.8 缺省即过|缺省判失败或要求显式声明
TOOL-006|M|tools/git-sync/index.js:125-183|liveApply 无 missing 上限与回滚|for(missing) POST 无批量上限，awaitFetch 抛错中断已创建 issue 不回滚|加 --max-create 与部分失败容错
TOOL-007|M|tools/semantic-rules/exemptions.json + lib/rules.js:566-596|pilot-env-fingerprint 豁免使环境漂移不失败 strict|warning 级 + exemptions 豁免，strict unexempted=0 通过|pilot 强绑定时升级 error 或不豁免
TOOL-008|M|tools/work-indexer/index.js:154,177|git 不可用时证据 stale 检测失效|codeHead='' 时 staleByCommit=false，证据未标 stale|git 不可用标记 'unknown' 而非 false
TOOL-009|M|tools/semantic-rules/lib/rules.js:547|counts-generative 硬编码 51/57 表数|/51\s+managed...57\s+physical/ 字面量校验|从 schema-manifest 动态读取
TOOL-010|L|tools/work-indexer/index.js:9-21|DEFAULT_PATHS 缺 agent-threads.md|列表无 agent-threads.md 但 .codex/artifacts 实际存在|补 agent-threads.md 或强制 artifact-paths.json
TOOL-011|L|tools/gate-engine/index.js:43|calculate 第三参数 artifactsDir 死参数|函数签名含 artifactsDir 但内部未引用|移除未用参数或实际使用
TOOL-012|L|tools/gate-engine/index.js:57-63|gateId 数字提取与 title 正则过宽|Number(gateId.replace(/[^0-9]/g,''))>=10 || /production|acceptance|closeout/i|显式 /^G(\d+)$/ 匹配
TOOL-013|L|tools/work-indexer/index.js:23-36 + lib/engine.js:25-38|findArtifactsDir 向上找 ../..|candidates 含 cwd/../.. /.codex/artifacts 可能误用上层|仅 EWOH_WORK_ARTIFACTS_DIR 未设置时回退 cwd
TOOL-014|L|tools/factory-replication/site-readiness.js:10|requiredPassed 死代码|变量仅返回字段未参与 ready 判定|标注用途或移除
TOOL-015|L|tools/handoff-service/index.js:54|module.exports 空对象|module.exports = {}; 无函数导出|导出 parseHandoffs 供复用
TOOL-016|L|tools/work-console/index.js:52-63|阻塞传播 O(N^2) while|while(changed){for(items)...} 大图低效|改用拓扑排序
TOOL-017|L|tools/work-console/index.js:141-150 vs gate-engine/index.js:32-41|loadHumanDecisions 重复实现|两处相同 JSON.parse 逻辑|抽到共享模块
REL-001|H|release/ewoh-0.6.0-rc4/Makefile vs /workspace/Makefile|副本缺失 8 个 contract/truth targets|rc4 缺 production-smoke/contract-identity/contract-domain/contract-golden/scheduler-golden/contract-envelope/truth-check 且 run 描述不同|重新打包同步主树 Makefile
REL-002|M|release/ewoh-0.6.0-rc4/pyproject.toml:21 + requirements-dev.txt:6|副本未固定 bandit 版本|rc4 bandit vs 主树 bandit==1.8.6|重新打包同步版本固定
REL-003|M|release/ewoh-0.6.0-rc4/CHANGELOG.md vs /workspace/CHANGELOG.md:6|副本缺顶部 [Unreleased] 段|rc4 直接从 [0.6.0-rc4] 开始，主树顶部新增 [Unreleased]|重新打包或同步 CHANGELOG
REL-004|M|release/ewoh-0.6.0-rc4/SHA256SUMS.txt|无 GPG/PGP 签名|1202 行校验和但无 .asc 签名文件，自身未列入，单向完整性|补 GPG 签名或外部哈希发布
REL-005|M|release/ewoh-spark-sbom.cyclonedx.json|SBOM 仅覆盖 npm 依赖|CycloneDX 仅含 ewoh-spark-app，未追踪 Python 端开发依赖|生成合并 SBOM 含 Python 依赖
REL-006|L|release/ewoh-0.6.0-rc1/rc3/pyproject.toml|rc1-rc4 残留同一未固定 bandit|所有 rc 副本 pyproject.toml 均 bandit 未固定|历史快照可接受，0.6.0 final 修正
REL-007|L|release/ewoh-0.6.0-rc4/RELEASE-README.md|未文档化 SHA256SUMS 校验步骤|RELEASE-README 仅含 build/db/run，无校验和验证流程|补 sha256sum -c 步骤
```

### 6.27 TEST-Python 顶层测试（TEST-001~015）

```
TEST-001|L|tests/test_ny_exo_a1_contract.py:509-510|恒真断言测试 stdlib 而非 SUT|assertTrue(math.isnan(float("nan")));assertTrue(math.isinf(float("inf"))) 与适配器无关|删除或改为对 adapter 输出再断言
TEST-002|M|tests/test_production_assembly.py:130|真实时钟依赖 time.sleep(0.3)|pipeline.handle_telemetry 后 sleep 0.3s 等异步发布，CI 慢机易 flake|改用 threading.Event/polling 超时等待
TEST-003|M|tests/test_production_assembly.py:136-139|弱断言 len(received)>=1|只断言收到至少 1 条 inference，不校验消息内容/字段|断言消息结构（eventType/payload 字段）
TEST-004|L|tests/test_connector_runtime.py:434-438|测试名声称 constant_time 但未测时序|仅 assertTrue/assertFalse 校验正确性，未验证 hmac.compare_digest 使用|重命名或加计时断言；实现已用 compare_digest
TEST-005|M|tests/test_decision_contract.py:35-38|docstring 声称 schema 交叉核对，实际仅查 len==N|test_registries_shape 只断言 DECISION_KINDS/STATUSES/AUTHORITIES 计数|加载 decision.schema.json 逐项比对
TEST-006|M|tests/test_capability_contract.py:34-38|同 TEST-005：声称 schema 核对仅查计数|test_registries_shape 只断言 CAPABILITY_KINDS==5/PROVIDER_TYPES==7|加载 capability.schema.json 比对
TEST-007|M|tests/test_exo_config_contract.py:34-39|同 TEST-005：声称 schema 核对仅查计数|test_registries_shape 只断言 6 个 len==N|加载 exo-config.schema.json 比对
TEST-008|M|tests/（全局）|7 个 contract test-vectors.json 未被 Python 测试消费|agent/agent_task/entity/intelligence/knowledge/reasoning-result/workorder 向量仅 JS audit 脚本仲裁|为这 7 域增加 Python parametrize 向量测试
TEST-009|L|tests/edge/test_cpsat_solver.py:154-155|冗余恒真断言|if resp.solverStatus=="INFEASIBLE": assertEqual(resp.solverStatus,"INFEASIBLE")|删除 assertEqual，保留后续断言
TEST-010|L|tests/test_golden_contract_scenarios.py:344-348|golden 场景未参数化，首失败即停|test_scenario 单函数遍历全部 scenarios/cases|改 pytest.mark.parametrize 隔离
TEST-011|L|tests/test_cpsat_worker_contract.py:77-90|测试名与分支逻辑误导|test_solve_empty_request_returns_unavailable_when_no_ortools 在 ortools 可用时仍执行并断言宽松集合|拆分为两个测试或重命名
TEST-012|L|tests/test_world_contract.py:64-65|假设恰好一条 current 记录|current=[r for r in records if r["validTo"] is None]; assert current[0]["version"]|先 assert len(current)==1 再取下标
TEST-013|L|tests/test_cpsat_worker_contract.py:78-82|请求体含未契约字段 horizonEndMs|request 含 "horizonEndMs":0 但契约用 horizonMinutes（默认 480）|改为 horizonMinutes 或显式断言未知字段被忽略
TEST-014|L|tests/test_reasoning_trace_contract.py:58-60|硬编码中文模板字符串脆弱|assert "负荷 0.9" in explanation; "电量 12%"; "40 分钟" 绑定文案|以断言 ruleId+severity 为主
TEST-015|L|tests/test_cpsat_worker_contract.py:28-31|_free_port 存在 TOCTOU 端口竞争|bind→close→httpd.bind 之间端口可能被占|可接受（localhost 单进程）；或直接 bind((127.0.0.1,0))
```

### 6.28 CFG-配置/契约核对（CFG-001~010）

```
CFG-001|H|deploy/docker-compose.yml:107|postgres 密码缺省为 CHANGE_ME|POSTGRES_PASSWORD: ${EWOH_DB_PASSWORD:-CHANGE_ME} 密码可缺省回落|改为 ${EWOH_DB_PASSWORD:?必须设置} 强制注入
CFG-002|M|deploy/docker-compose.yml:49|引用不存在的根 Dockerfile|dockerfile: Dockerfile # 占位，待落地；根目录无 Dockerfile|删除遗留 compose 或修正 dockerfile 路径
CFG-003|M|deploy/docker-compose.yml:70,85,90|adapter/inference 为 sleep 占位且三服务无 healthcheck|command: ["python","-c","print(...);time.sleep(3600)"]|补 healthcheck 或移除占位服务
CFG-004|M|pyproject.toml:5 vs version.json:2|版本口径漂移：pyproject=0.6.0 vs version.json=0.6.0-rc4|version="0.6.0" 与 "0.6.0-rc4" 不一致|对齐为 0.6.0-rc4 或纳入 truth-gate 校验
CFG-005|M|contracts/policy/deploy-gate.rego:7|checks_passed>=3 仅校验数量不校验具体检查项|input.checks_passed >= 3 无 check-id 维度|改为按命名必检项逐项校验
CFG-006|M|security/access-matrix.yaml:67 vs mobile/mobile.controller.ts:17|矩阵称 worker 仅 /api/me，但 mobile/operations 控制器含 worker|@Roles(...,'worker') on /api/mobile/workbench|对齐矩阵或移除 worker 角色授权
CFG-007|L|contracts/artifact-schemas/README.md:29 vs release-manifest.schema.json:56|README 称所有 schema additionalProperties:false，但 evidence 子对象未约束|"evidence":{"type":"object"} 无 additionalProperties:false|限定 README 措辞或补约束
CFG-008|L|security/gitleaks-baseline.json:10|明文密钥值留存于基线文件|Secret: WQmbbeplMaGffVsjtW0cTgAMn5c 明文登记|确认已轮换；考虑仅保留指纹不存明文
CFG-009|L|ui/command-map/event-center.js:332,entity-panel.js:189,340,365|innerHTML 赋值未全部经 CM.esc 转义|host.innerHTML=html 多处动态拼接|改用 textContent 或统一 esc
CFG-010|L|deploy/docker-compose.yml:50|遗留 compose 镜像标签 0.6.0 与当前 0.6.0-rc4 不一致|image: ewoh-api:0.6.0|同步为 0.6.0-rc4 或随 release 升级
```

## 7. 主控抽样复核记录

24 项 Critical（覆盖全部 12 个域、全部 Critical 模式簇，占 Critical 总数 74 的 32%）经主控直接读源码/grep 实证，**24/24 成立，0 误报**：

| 发现 | 复核方式 | 结论 |
|---|---|---|
| EDGE-001 | Read server.py:400-445 | 成立：`action=None` 时 GET 直接派发，无 token 强制 |
| EDGE-002 | Read routes/inference.py:190-233 | 成立：`base_url/api_key/model` 请求体可覆盖并外呼 |
| EDGE-003 | Read edge/storage.py:398-452 | 成立：exo_binding 方法无 `self._lock`、无唯一约束 |
| NEST-101 | Read world-state.service.ts:165-210 | 成立：7 表 select() 无 orgId |
| NEST-104 | Read scheduling-policy.service.ts:300-318 | 成立：`where(eq(active,true))` 无 org |
| NEST-113 | Read scheduler.controller.ts:588-601 | 成立：`!viewerOrgId \|\|` 无认证放行全部 |
| NEST-201 | Read operations.service.ts:206-248 | 成立：insert 无 orgId、read/list 无 org 谓词 |
| NEST-205 | Read ingest.service.ts:268-285 | 成立：`onConflictDoUpdate target: ewohDevice.deviceId` 单列 |
| NEST-301 | Read mes.service.ts:196-207 | 成立：仅 `where(eq(source,'mes'))` |
| NEST-312 | Read dashboard.service.ts:44-90 | 成立：device/event/telemetry 聚合无 orgId |
| NEST-401 | Read approval-persistence.service.ts:148-166 | 成立：insert ewohEvent 无 orgId 字段 |
| NEST-406 | Read erp.service.ts:86-99 | 成立：insert ewohEvent 无 orgId |
| NEST-601 | Read oee.service.ts:210-226 | 成立：quality 查询仅 eventType+时间窗 |
| NEST-605 | Read world.service.ts:47-64 | 成立：四查询均无 orgId |
| NEST-610 | Read workflow.controller.ts:14-43 | 成立：`body.roles` 直传 advance |
| CLI-301 | Read Timeline.tsx:307-317 | 成立：`href={e.url}` 无 scheme 校验 |
| CLI-401 | Read streamdown.tsx:50-61 | 成立：`href={href}` 直传 |
| CLI-501 | Read lib/auth.ts:26-38 | 成立：refreshToken 写 localStorage |
| SH-001 | Read exo-session.ts:30-43 | 成立：宽松 regex 替代 isCanonicalIdentity |
| SQL-001 | Grep standalone_025（10 处 `OR org_id IS NULL`） | 成立 |
| SQL-003/004 | Grep 008:12 ALTER + 017:50 CREATE | 成立：顺序倒置 |
| SCR-001 | Grep audit-domain-contracts.js（6 处 `[^\\s]+` 实证，代理报告 20+ 处同型） | 成立 |
| SCR-002 | Grep standalone-ops-check.sh:28-29 `sql.unsafe('...'+db)` | 成立 |
| NEST-202/203/204/302~319/402~408/602~612 | 同簇模式（缺 orgId 谓词/写入）由上列 14 个独立模块实证 + 簇代表抽样 | 簇成立 |

未发现需要降级或撤销的发现。两处历史"已修复"声明（edge auth fail-closed、rate_limiter 接入）经 HEAD 验证为真，未列入发现。

## 8. 整体结论

1. **租户隔离是当前最大系统性风险**：74 条 Critical 中 53 条集中在 NestJS 域的 org 过滤缺失/写入缺 org_id，且与 SQL 域的 RLS NULL 放行（SQL-001/007）、可空 org_id 列（SQL-035）、seed 缺 org_id（SQL-102）形成三层叠加。ADR-071~076 的"隔离闭环"声明仅在 HTTP 主路径的 GUC 事务内近似成立，非事务路径、SSE、后台任务与大量业务模块读路径均可绕过。**建议作为第一优先级修复主题单独立项**（模式统一：controller 强制透传 userContext → service 全部读写加 `orgId` 谓词 → 新写入显式携带 orgId → RLS 去除 NULL 放行 → 唯一约束补 org 维度）。
2. **边缘平台与前端各有一个"面"级问题**：边缘 HTTP GET 面基本无认证（EDGE-001 及 10+ 同簇）；前端有 3 处 XSS sink + 凭据/加密原语弱化（CLI-301/302/401/501/505）。
3. **数据库层存在"全新库不可安装"级别的迁移顺序缺陷**（SQL-003~006）与 manifest 三方对账漂移（SQL-028~032、NEST-501/513），说明"迁移可从零重建"缺少 CI 门禁。
4. **门禁脚本自伤**：SCR-001 正则 bug 使 20+ 处契约校验双向失真；多处"假成功路径"（SCR-005/008/010）削弱 truth-gate 可信度。
5. **测试体系总体可信**（golden/contract 双执行器、无 skip 失控、无大面积恒真），但 fake-db 忽略 where、mock echo、5ms 时钟脆弱三类问题会让 org 隔离等关键回归静默通过。
6. **工程真实性问题收敛但未清零**：演示标签、伪造 actor、派生 WIP、硬编码 snapshot 等残留需在下一轮 UX 真实性收敛中清理。

**审计结论（不改码、只裁决）**：仓库整体工程框架与治理机制（契约门禁、truth-gate、golden TCK、ADR 体系）设计水准较高且多数真实落地，但在租户隔离、迁移完整性、边缘接入面鉴权三个维度存在与既有声明不符的系统性缺口，建议按 Critical → High 顺序组织 remediation spec 分批修复，并在修复后为本报告 §4 十条主线各补一条自动化门禁防回归。

## 附录：机器可读登记表说明

§6.1–§6.28 各代码块即机器可读发现登记表，格式为管道符分隔：`编号|级别|文件:行号|问题|证据|建议`；级别枚举 C/H/M/L。解析示例：`grep -E '^\w+-[0-9]+\|C\|' docs/audit/2026-08-17-line-by-line-audit.md` 可提取全部 74 条 Critical。










