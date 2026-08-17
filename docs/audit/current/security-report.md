# Security Report — 二轮审计安全类修复与残留风险

> 生成时间：2026-08-18
> 数据来源：`parts/fixlog-security.jsonl`（5 项专批）、`parts/fixlog-p1-closeout.jsonl`、`parts/fixlog-edge-scripts.jsonl`、`parts/fixlog-nz.jsonl`、`parts/fixlog-ops.jsonl`、`parts/fixlog-ctrl.jsonl`、`parts/fixlog-srv-client.jsonl`、`findings.jsonl`（FSH/EDM/SCR/ECO/SNZ 系 FIXED 项）、`p2p3-dispositions.md`；门禁结果为本机复跑（见 `test-report.md`）。

---

## 1. 安全类修复专批（fixlog-security.jsonl，5 项）

| ID | 级别 | 缺陷 | 修复 | 验证（fixlog 记录） |
|---|---|---|---|---|
| R2-SCR-005 | P2 | postgres-logical-backup 消费外部备份 manifest 时表名/列名直拼 SQL（被篡改备份可注入任意 SQL） | 标识符白名单校验（`^[a-zA-Z_][a-zA-Z0-9_]*$` 且必须存在于目标库 information_schema 已知集合），非法即抛错退出 fail-closed | node --check 通过 |
| R2-EDM-02 | P2 | ark_vision SSRF：urlopen 二次解析 + 重定向可跳内网 | getaddrinfo 校验全公网后**固定 IP 直连**（自定义 Pinned HTTP(S)Connection，Host/SNI/证书校验仍用原域名）；禁用自动重定向改手动逐跳复检（每跳同一公网校验+固定 IP），跳数上限 3，超限/任一跳非法 fail-closed | `pytest tests/test_r2_ark_vision_ssrf.py` 8 passed（固定 IP 内网拒/重定向跳内网拒/超跳数拒/成功路径）+ 既有 SSRF 回归 3 passed 未削弱 |
| R2-EDM-03 | P2 | 边缘 static/index.html 8 处 innerHTML 插值 sink（存储型 HTML/JS 注入） | 审计点名的 8 处及同类 sink（srcTag、回放 rowHtml、任务推荐、派工列表、demoSteps、下拉 option）全部统一包裹 esc() | script 段 node --check 通过 + edge_platform/tests 全量回归 |
| R2-FSH-002 | P2 | 飞书侧车 GET /api/* 读端点无鉴权（业务/PII 数据匿名可读） | 读端点与写端点同一 fail-closed 鉴权（FEISHU_API_TOKEN + timingSafeEqual + 失败计数限流，未配置 token 即 503）；豁免清单为空并注释理由；仅 FEISHU_REQUIRE_AUTH_FOR_READS=false 显式放宽且仍施加 IP 级读限流（默认 600/窗口）；前端 GET 同步携带 Bearer | node --test 86/86 通过（含 19 个 auth 用例 + fail-closed/放行集成用例） |
| R2-EDM-06 | P2 | collection.start_session consent_id 可为空（知情同意门禁可绕过） | 强制非空非空白字符串（缺失/None/空白 ValueError fail-closed）；同库存在 governance consent_record 时交叉校验授权记录存在且 status=active（revoked/不存在即拒绝） | `pytest tests/test_r2_collection_consent.py` 5 passed + test_inference.py 74 passed |

## 2. 其他安全相关 FIXED 项（FSH/EDM/SCR/ECO/SNZ/CC 系）

| ID | 缺陷→修复 | 验证 |
|---|---|---|
| R2-EDM-01（P1） | Sparkplug 时间戳 time.strftime %f 畸形（'...fZ'）→ datetime 毫秒格式化（帧时间语义恢复） | fixlog-p1-closeout；本轮全量回归 |
| R2-ECO-001（P1） | 边缘 exo unbind 归属判定信任客户端自报 body.endedBy（CWE-284 身份断言）→ 只信任 token 会话身份（_session_actor_person），body 仅作记录 | fixlog-p1-closeout |
| R2-SNZ-006（P1） | SMTP 邮件头注入（title 用户可控→Bcc/头拆分）→ sanitizeHeaderValue（[\r\n]+ 折叠单空格）覆盖 subject/from/to 与 DATA 行级 CR/LF 剥离 | email-transport.spec（恶感 title + 全头部无 CRLF 断言） |
| R2-CC1-1（P2） | tiptap Attachment renderHTML 未消毒 href（javascript: 链接可写入保存内容）→ 序列化消毒 | fixlog-srv-client 批次登记 |
| R2-SCR-001/002/004/007/009 | 脚本面：generate-standalone-ddl require 写副作用收口；pilot-readiness 硬编码版本动态解析；canary-deploy 掉线不再伪造 0 0 1（err=1 触发回滚）；audit-env-inventory 目录排除错配；audit-repo-facts error 级 finding 不可被 warning 豁免吞掉 | 各 node --check / bash -n / 行为验证（fixlog-edge-scripts） |
| R2-EDM-04/05 | opcua/sparkplug/webhook 队列满静默丢帧→计数+周期告警；collection.add_label fail-closed（ISO/end>=start/闭会话拒绝） | tests/test_connector_runtime.py 31 passed；79/74 passed |
| R2-ESC-005/006 | consent_denied_log 无界→deque(1000) 环形；规则引擎异常静默→logger.exception + rules_error_count 指标 | test_inference.py 74 passed |
| R2-FSH-003 | 60s 事件轮询轮次重叠→pollInFlight 互斥 | ewoh-feishu-app 86/86 |
| R2-INF-001 | CI 浮动版本守护白名单外扫描遗漏→补 ewoh-spark-app/scripts/ + 豁免登记制 | 注入 @latest 探针被拦截（GUARD_TRIP_OK） |
| R2-ESC-001 | cpsat objective 数值类型无约束（float 系数破坏字典序支配）→ int_coeff 整数化 | fixlog-p1-closeout |
| R2-SMI-008/010/011 | 恒定时间比较惯例补齐 / 委托层 actor 必传 fail-closed / global_admin 豁免分支纳入单一守卫 | control/scheduler spec（parts/fixlog-ctrl.jsonl） |

## 3. AuthN / AuthZ 面

### 3.1 角色收敛（@Roles）

- **learning @Roles 收敛（R2-SBZ-003，P1）**：approve/reject/rollback 加方法级 `@Roles(workshop_lead, global_admin)`（getAllAndOverride 覆盖类级 ANY_AUTHENTICATED）；propose/shadow 反馈腿保持全角色+人审下游——关闭 LRN-P2-3（arch-edge-agent 缺口）。
- **显式 @Roles 化（R2-SNZ-005/018）**：frontend-metrics ingest 补 ANY_AUTHENTICATED_ROLES（原 default-deny 下恒 403 死端点）；ModelController 类级补显式 @Roles('global_admin','device_ops') 与 FALLBACK 表对齐（授权声明不再与代码分离）。
- **mes 角色谓词（R2-SBZ-001，P1）**：assertWorkerStepAssignment 改用 roles 数组（原 role 单值恒空致 fail-open 死代码）+ spec 同步。

### 3.2 mobile 透传（R2-SAM-002/R2-SNZ-012，P1）

mobile scan/order 端点注入 @Req userContext 并全链透传（scan→scanOrder/getStep/getWorkOrder 带 actor）；mes orgCondition 的 undefined-actor 分支由"不过滤"收敛 requireOrgId fail-closed 400——worker/device_ops 持任意 orderId 读他租户工单的绕过面关闭（R2-SNZ-012 交叉登记终态）。

### 3.3 state-machine role 门禁

- CI 门禁：`make audit-regression-gates` 主线 9 `audit-state-machine-roles.js`（yaml↔TS 锁定表双向一致 TCK）本轮复跑通过。
- R2-SHR-004：agent-task 转移 role 约束缺省不 fail-closed（TS actorRole=undefined 旁路 + Python 无 role 参数）收敛——shared 契约修复（resolution_note："代码内含 R2 修复标记注释（本轮工作区）"）。
- R2-ESC-002/010：边缘调度 confirm/reject/execute 状态校验对齐契约转移表（详见 `refactor-report.md` §5）。

### 3.4 审批链（control 高危指令，P0）

R2-SMI-001（本轮唯一 P0_CRITICAL）：control 高危物理指令审批链接入 ApprovalPersistenceService（高危 → pending_approval，审批后方允许 sendCommand；revoked 终态写回；审计 risk:true）——INV-005 闸门落地。配套 R2-SMI-003（审批图服务端角色映射 + 发起人回避，杜绝客户端指定审批人/自批）与 R2-SMI-004（step/instance 双写同事务）。

### 3.5 Ingest/网关面

R2-SOP-004：IngestGuard per-key org 绑定（机器对机器网关复用单租户设计的 org 维度进入凭证层；key 比较全程 constant-time；越出绑定域 403 INGEST_ORG_MISMATCH）。

## 4. 安全门禁复跑结果（本机 2026-08-18）

| 门禁 | 结果 |
|---|---|
| `ruff check src/edge_platform`（make lint） | **All checks passed!**（exit 0） |
| `make truth-check` | 全绿（含 EVENT ENVELOPE AUDIT **24/24 passed**、GEN-CONTRACT-REGISTRIES OK、truth-manifest --check 无漂移） |
| `make audit-regression-gates` | 十条主线全部通过——含主线 2 边缘 GET 面鉴权矩阵（test_get_route_auth_matrix.py production 匿名 401）、主线 3 SSRF 出站面白名单比对（audit-ssrf-surface.js）、主线 4 前端 XSS/凭据 sink 扫描（audit-client-security-sinks.js） |
| `bandit -r src/edge_platform -ll`（make security） | **ENVIRONMENT_BLOCKED**：本机未安装 bandit（`bandit not found`）；CI security.yml 有 bandit 1.8.6 JSON 报告 + HIGH 门禁（bandit-gate.py + suppressions），本轮未在本机复跑，不转述数字 |

## 5. 残留风险（DISPOSITIONED 中安全相关低风险项，p2p3-dispositions.md）

| ID | 裁决码 | 残留内容 |
|---|---|---|
| R2-ECO-004 | DEFENSE_IN_DEPTH_ACCEPTED | 登录失败用户名枚举 timing 侧信道（PBKDF2 仅对存在用户名计算，缺等价耗时 dummy） |
| R2-CC2-004 | UI_POLISH_ACCEPTED | Timeline 审计 CSV 导出无电子表格公式注入防护 |
| R2-EDM-07..14 | DEFENSE_IN_DEPTH_ACCEPTED | 边缘域低风险纵深项（脱敏键 auth/bearer 变体漏脱敏、AAS value/valueType 一致性、_audit_log 无界、assert 做 fail-closed 门禁（-O 失效）、export_dataset version 路径穿越、event_time 直通无格式校验、summarize 乱序区间等） |
| R2-ESC-011..020 | DEFENSE_IN_DEPTH_ACCEPTED | 边缘调度低风险项（共享可变对象副作用、内存版本计数、规则注释误解析、registry 非原子写等） |
| R2-FSH-004..009 | DEFENSE_IN_DEPTH_ACCEPTED | 飞书侧车纵深项（search-then-create 并发、dedup 崩溃窗口、audit 无界、token 明文 localStorage + 回显转义、NAT 共享 IP 防爆破重置） |
| R2-SCR-008 | ENV_OR_CONFIG_ACCEPTED | EWOH_SCHEMA 未白名单校验即拼 psql -c（shell/SQL 双注入面，演练脚本面） |
| R2-INF-009 | ENV_OR_CONFIG_ACCEPTED | CI 二进制下载仅锁版本未校验 checksum/签名 |
| R2-INF-013 | ENV_OR_CONFIG_ACCEPTED | dev.js 端口号直拼 execSync 模板（shell 注入面，dev 工具面） |
| R2-MSC-004 | DOC_DRIFT_ACCEPTED | index.html 平台插值 {{{__platform__}}} 嵌 JS 单引号字符串可逃逸 |
| R2-ESC-009 | SYSTEMIC_REFACTOR_RULING | 申诉通道无持久化（无生产依赖方，见 `refactor-report.md` §11） |

**边界残留说明**：arch-edge-agent 底稿的 ECA-P1-1（Control 回执可伪造——回执需设备侧凭证/上行事件投影，属协议演进）与 ECA-P1-2（上行桥批量失效+缓冲无界，已文档化待修 data-flow.md:69）两项 P1 未在本轮 findings 中关闭，如实登记为残留（详见 `architecture-after.md` §4）。

## 6. 结论

安全面本轮以**注入三连收口**（SQL 标识符白名单 R2-SCR-005、SSRF 固定 IP R2-EDM-02、innerHTML XSS esc() R2-EDM-03）+ **鉴权 fail-closed 化**（飞书读端点 R2-FSH-002、consent 门禁 R2-EDM-06、mes/mobile 透传 R2-SAM-002）+ **审批链落地**（control P0 R2-SMI-001 三件套）为主线；AuthN/AuthZ 角色收敛覆盖 learning/mes/model/frontend-metrics 四处。可执行门禁（ruff/truth-check 24/24/十条主线含 GET 鉴权矩阵、SSRF 面、XSS sink）本机复跑全绿；bandit 因环境缺失按 ENVIRONMENT_BLOCKED 登记未转述；残留项均为裁决登记的低风险纵深项，无未处置高危。
