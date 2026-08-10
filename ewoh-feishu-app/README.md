# EWOH 飞书侧车应用（ewoh-feishu-app）

EWOH 外骨骼作业监督平台 — 飞书版全栈应用。**v1.1.0 生产级加固**：API 统一鉴权、SQLite 落盘持久化、webhook 业务幂等、签名协议修复、规则单一事实源、同步去重。

## 一、功能概览

- **本地监督 API**：设备/遥测/事件/规则/审计的 REST 端点（`/api/*`）
- **飞书告警闭环**：风险事件触发 → 群聊卡片推送 → 卡片按钮处置（确认/解决/上报）→ 状态回写
- **多维表格同步**：设备/事件/遥测 30s 全量同步 + 事件状态 60s 轮询回写
- **设备模拟器**：3 台虚拟外骨骼设备（默认关闭，需显式开启）
- **班次报告**：一键生成飞书文档格式班次报告

## 二、快速开始

### 2.1 环境要求

| 组件 | 要求 |
|------|------|
| Node.js | ≥ 18（推荐 ≥ 20） |
| lark-cli | 仅飞书集成需要（`LARK_CLI` 可执行文件，需 `lark-cli auth login` 授权） |

### 2.2 安装与启动

```bash
cd ewoh-feishu-app
npm ci                      # 安装依赖（express / better-sqlite3 / cors）

# 最小启动（无飞书配置，仅本地 API + 模拟器可选）
FEISHU_API_TOKEN='change-me' node server/index.js

# 完整启动（带飞书集成，见 2.3 配置）
cp feishu-config.example.json feishu-config.json   # 填入真实 Base/chat 凭据
FEISHU_API_TOKEN='change-me' \
FEISHU_VERIFICATION_TOKEN='<飞书验签 token>' \
node server/index.js
```

启动后：

```
[EWOH] 后端服务已启动: http://localhost:3000
[EWOH] API 状态: http://localhost:3000/api/status
```

### 2.3 环境变量（v1.1.0 新增项已标注）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `FEISHU_API_TOKEN` | **生产必填** | 空 | **v1.1.0** API 统一鉴权 token。写操作（POST/PUT/PATCH/DELETE）必须携带 `Authorization: Bearer <token>` 或 `X-API-Key: <token>`；**未配置时写操作一律拒绝（fail-closed，503）** |
| `FEISHU_REQUIRE_AUTH_FOR_READS` | 否 | `false` | **v1.1.0** 设为 `true` 时读操作（GET）也强制鉴权；缺省读操作放行（监督平台展示语义） |
| `EWOH_DB_PATH` | 否 | `data/ewoh-feishu.db` | **v1.1.0** SQLite 数据库路径。默认文件库（WAL + busy_timeout）；`:memory:` 仅测试用 |
| `FEISHU_VERIFICATION_TOKEN` | webhook 写操作必填 | 空 | 卡片回调验签 token；缺失 → webhook 写操作 fail-closed |
| `FEISHU_ENCRYPT_KEY` | 否 | 空 | 飞书加密密钥；配置后强制 HMAC 签名校验（**v1.1.0 修复**：签名时间戳按飞书协议使用秒级字符串） |
| `FEISHU_WEBHOOK_TOLERANCE_SEC` | 否 | `300` | webhook 时间戳容忍窗口（秒） |
| `FEISHU_SIMULATOR_ENABLED` | 否 | `false` | 设备模拟器开关；`NODE_ENV=production` 下需 `ALLOW_SIMULATOR_IN_PRODUCTION=true` 双开关 |
| `FEISHU_CORS_ORIGINS` | 否 | 本地源 | CORS 白名单（逗号分隔），禁止 `*` |
| `FEISHU_BASE_TOKEN` | 生产建议 | 空 | **C1 修复** 多维表格 base_token，生产环境应通过环境变量注入（服务端优先读取），避免凭据落入配置文件与命令行参数（lark-cli 暂不支持 env 直读时，argv 暴露问题依赖 lark-cli 后续支持，本项为缓解措施；配置文件的 `base_token` 字段保留为回退） |
| `PORT` | 否 | `3000` | 服务端口 |
| `LARK_CLI` | 飞书集成 | `lark-cli` | lark-cli 可执行文件路径 |
| `FEISHU_CLI_MAX_RETRIES` | 否 | `3` | **P2-10** lark-cli 可重试失败的最大重试次数（指数退避 base 500ms × 2^attempt + 全抖动）；业务错误（权限/参数/资源不存在等）不重试 |
| `FEISHU_CLI_MAX_QUEUE` | 否 | `200` | **P2-10** lark-cli 并发排队上限；排队任务超过上限立即拒绝（`lark-cli queue full`），防止无界队列增长 |

## 三、测试

```bash
npm test                 # 全部测试（node --test，无第三方测试依赖）
npm run test:unit        # 单元测试（security / auth / db）
npm run test:integration # 端到端集成测试（真实 HTTP server + 临时 SQLite）
```

覆盖矩阵：

| 测试文件 | 覆盖 |
|----------|------|
| `test/security.test.js` | webhook 验签（token/timestamp/HMAC/重放）+ **v1.1.0 秒级签名时间戳协议** |
| `test/auth.test.js` | API 鉴权中间件（写 fail-closed / Bearer+X-API-Key / 常量时间比较 / 读放行与收紧） |
| `test/db.test.js` | 文件库 WAL + 持久化重开、webhook_dedup 幂等、状态转换边界、规则 DB 加载 |
| `test/integration.test.js` | 端到端：鉴权链路、卡片处置成功/幂等命中/closed 冲突 409/未知动作 400 |
| `test/lark-cli-async.test.js` | lark-cli 异步化：并发上限/20s 超时/熔断/user→bot 兜底重试 |
| `test/base-token.test.js` | FEISHU_BASE_TOKEN 环境变量优先 + 空 token fail（不传空参数） |
| `test/sync-m2.test.js` | 遥测批量 flush：失败保留重试 / 成功清空 / 空 buffer 不调用 |
| `test/feishu-retry.test.js` | **P2-10** 有界重试：退避注入/业务错误不重试/最大次数边界/失败分类 |
| `test/queue-limit.test.js` | **P2-10** 队列上限：超限立即拒绝、不计入熔断统计 |

## 四、API 速查

| 端点 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/api/status` | GET | 读放行 | 系统状态统计 |
| `/api/devices` `/api/devices/:id` | GET | 读放行 | 设备列表/详情 |
| `/api/devices/:id/health` | GET | 读放行 | 设备健康（含失联判定） |
| `/api/telemetry*` | GET | 读放行 | 遥测列表/最新帧 |
| `/api/events` `/api/events/:id` | GET | 读放行 | 事件列表/详情 |
| `/api/events/:id/handle` | POST | **写必鉴权** | 事件处置（acknowledge/resolve/escalate/comment） |
| `/api/rules` | GET | 读放行 | 规则列表（DB 事实源） |
| `/api/audit` | GET | 读放行 | 审计日志 |
| `/api/feishu/report` | GET | 读放行 | 生成班次报告 |
| `/webhook/card` | POST | 飞书验签 | 卡片按钮回调（**业务幂等**，见下文） |

## 五、v1.1.0 加固内容（设计决策摘要）

| 决策 | 问题 | 方案 |
|------|------|------|
| **D1 API 统一鉴权** | v1.0 `/api` 全站无鉴权，任何人可改事件状态 | 新增 `server/auth.js`：写操作 fail-closed（未配置 token → 503，token 错误 → 401）；Bearer/X-API-Key 双格式；`timingSafeEqual` 常量时间比较；读操作默认放行、可配置收紧 |
| **D2 SQLite 落盘持久化** | v1.0 用 `:memory:`，进程退出数据全丢，与「30s 全量同步 + 飞书回写」矛盾 | 默认文件库 `data/ewoh-feishu.db`（WAL + busy_timeout + 自动建目录）；`:memory:` 保留给测试/显式配置 |
| **D3 webhook 业务幂等** | 同一事件重复推送（不同 event_id 信封/网络重试）会重复执行处置 | 新增 `webhook_dedup` 表，`(event_id, action_type)` 唯一约束；重复投递返回 `{duplicated:true}` 不重复改状态；处置失败删除记录允许重试 |
| **D4 签名时间戳协议修复** | HMAC source 用毫秒时间戳，飞书标准为秒级字符串，配置 encrypt_key 时签名永远不匹配 | `extractSignatureTimestamp` 输出秒级字符串；`body.timestamp` 秒字符串不再 ×1000 |
| **D5 规则单一事实源** | `rules.js` 与 `db.js` 双份硬编码规则配置，易漂移 | 规则引擎从 DB `rules` 表加载（含阈值/持续门槛/冷却），支持运行时调参；常量降级为 DB 空时的兜底默认 |
| **D6 同步去重与批量** | `syncAllToFeishu` 对设备/事件逐条 create 造成重复记录、遥测高频 API | 设备/事件走 search+upsert 去重；遥测走批量 batch-create（一次 API 调用） |
| **D7 启动不阻塞** | feishu-config.json 存在时 lark-cli 同步调用阻塞 `listen`（无授权环境卡死） | 飞书集成延迟到 HTTP 就绪后（setImmediate）后台初始化，API 始终可用 |

## 六、运行方式（生产建议）

```bash
NODE_ENV=production \
  PORT=3000 \
  FEISHU_API_TOKEN='<32+ 字符强随机>' \
  FEISHU_REQUIRE_AUTH_FOR_READS=true \
  FEISHU_VERIFICATION_TOKEN='<飞书验签>' \
  FEISHU_ENCRYPT_KEY='<飞书加密密钥>' \
  EWOH_DB_PATH='/var/lib/ewoh/feishu.db' \
  FEISHU_SIMULATOR_ENABLED=false \
  node server/index.js
```

建议：
- `FEISHU_API_TOKEN` 生产必配，且 ≥ 32 字符强随机；写操作未配置时服务拒绝一切写请求（fail-closed），宁可不写不可裸奔
- `EWOH_DB_PATH` 指向持久化卷（Docker volume / systemd 数据目录），定期备份 `feishu.db`
- `FEISHU_SIMULATOR_ENABLED` 生产保持关闭（真机数据通过 `/api` 或飞书侧写入）
- 前置反向代理（nginx/Traefik）时设 `FEISHU_CORS_ORIGINS` 为实际前端源

## 七、部署与运行时契约（Deployment & Runtime Contract）

本应用（飞书 sidecar）以**单实例**为部署边界。横向扩容为多实例共享同一 SQLite 文件**不被支持**，请勿在生产这么做。

| 契约项 | 约定 |
|--------|------|
| 实例模型 | **单实例 only**。数据层为 better-sqlite3 文件库（WAL + `busy_timeout` 5000，进程内同步 API，无网络协议层）。关键状态（遥测 buffer、事件状态轮询进度、lark-cli 信号量/熔断）都在进程内存中，跨进程无法共享 |
| 为什么不迁移 PostgreSQL | 本应用是监督平台的**旁路 sidecar**：无事务性账本、无多写者、无跨进程一致性要求；PG 会引入连接管理/迁移/凭据面，超出 P2 收尾范围。若未来出现多实例/高可用硬需求，正确演进是先抽 webhook 处置与状态写为独立服务 + 分布式锁，而不是把整个 sidecar 搬上 PG |
| 两实例共享文件的后果 | 只读多开基本可用（WAL 支持多读者）；一旦两实例同时写：`busy_timeout` 5s 兜底，超时抛 `SQLITE_BUSY`（DB 写异常当前不重试，写请求直接失败）；30s 全量同步与 5s 遥测 flush 会重复/互相覆盖飞书侧数据；`webhook_dedup` 唯一约束仅保证同刻并发回调中一方成功，另一方报错 |
| 重启安全（幂等） | `webhook_dedup` 表 `UNIQUE(event_id, action_type)` 落盘持久化 → 重启后同一事件同一动作的重复投递仍命中幂等（`duplicated:true`），不重复处置；处置失败会删除幂等记录允许重试 |
| 优雅关停 | SIGINT/SIGTERM → 停模拟器 → 停全量同步定时器/事件状态轮询 → flush 遥测缓冲 → **等待在途 lark-cli 子进程排空（有界 2s，`feishu.waitForCliIdle`）** → 关闭 HTTP → 关闭 DB；另有 1.5s 兜底强制退出 |
| lark-cli 调用模型 | 全部**异步**（`execFile`，非 `spawnSync`）：20s 硬超时（SIGTERM 回收）、16MB 输出上限、并发上限 4（手写信号量）、熔断（连续失败 ≥5 次暂停 30s）、有界重试（`FEISHU_CLI_MAX_RETRIES`，指数退避 + 全抖动，业务错误不重试）、队列上限（`FEISHU_CLI_MAX_QUEUE`）。任何单次 lark-cli 慢调用不再阻塞事件循环 |
| 凭据面 | `FEISHU_BASE_TOKEN` 环境变量优先，回退 `feishu-config.json` 的 `base_token`；base_token 经 lark-cli `--base-token` argv 传入（CLI 契约限制，argv 仅本进程可见），env 注入避免凭据落入配置文件。详见运行时审计文档 |

> 各项审计结论与证据见 `docs/operations/feishu-sidecar-runtime.md`；lark-cli 异步化关闭记录见 `docs/decisions/OPEN-DECISIONS.md`（2026-08-10）。

## 八、已知限制与后续优化

- **多实例部署**：单实例边界为设计契约（见「七、部署与运行时契约」），暂不支持横向扩展；如需多实例请先评审独立化 + 分布式锁演进路径
- **lark-cli 异步化（已解决）**：`feishu.js` 已由 `spawnSync` 改为异步 `execFile`（20s 超时 + SIGTERM 回收），并发上限/熔断/有界重试/队列上限齐备，单次慢调用不再阻塞事件循环（原"同步调用阻塞"问题已消除，见 OPEN-DECISIONS.md 2026-08-10 关闭记录）
- **签名依赖 create_time**：飞书事件订阅信封 `header.create_time` 为 ISO 字符串（已兼容）；若飞书改用纯秒字段需同步适配（已有 `body.timestamp` 兜底）
- **规则运行时调参**：已支持（改 DB config 即生效），但未提供 HTTP 写接口更新规则——如需开放请加 `/api/rules/:id` PUT（需鉴权）
- **遥测批量上限**：`syncAllToFeishu` 一次批量 100 条（lark-cli `+record-batch-create` 单次上限 200），量大时按 100/批循环分片
- **审计扩展**：dedup 命中（幂等返回）与飞书侧同步动作当前不写 audit_log，仅 webhook 验签与事件处置写审计——如需完整溯源可后续补写

## 九、目录结构

```
ewoh-feishu-app/
├── server/
│   ├── index.js        # 入口：Express 装配 + webhook 卡片回调（幂等）
│   ├── auth.js         # v1.1.0 API 统一鉴权中间件（D1）
│   ├── db.js           # SQLite 初始化/CRUD + webhook_dedup 幂等表（D2/D3）
│   ├── api.js          # /api REST 路由
│   ├── events.js       # 事件 CRUD + 处置（状态转换边界校验）
│   ├── rules.js        # 规则引擎（DB 事实源加载，D5）
│   ├── security.js     # webhook 验签（token/timestamp/HMAC/重放，D4）
│   ├── sync.js         # 多维表格同步（upsert/批量，D6）
│   ├── feishu.js       # lark-cli 封装（卡片/Base/审批/文档）
│   └── simulator.js    # 设备模拟器
├── test/               # node:test 测试（security/auth/db/integration）
├── public/             # 前端静态页
├── data/               # SQLite 数据文件（自动创建）
├── feishu-config.example.json
└── package.json
```
