# 飞书 sidecar 审计与契约（feishu-sidecar-runtime）

> 审计范围：`ewoh-feishu-app/`（Node + express + better-sqlite3 的飞书旁路 sidecar）。
> 审计日期：2026-08-10（P2 收尾，Task 10）。
> 结论标注：**FIXED**（本次已修复）/ **VERIFIED**（已有实现，走读/测试确认）/ **DOCUMENTED**（仅文档化，不改代码）。
> 关联：`docs/decisions/OPEN-DECISIONS.md`（lark-cli 异步化已于 2026-08-10 关闭为 RESOLVED，本文件只引用不修改）。

## 一、审计结论总表

| # | 检查项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | SQLite 多实例边界 | **DOCUMENTED** | 单实例为设计契约，不迁移 PG；见 README「七、部署与运行时契约」与本文件第二节 |
| 2 | webhook/sync 分页 | **FIXED** | `pollFeishuEventStatusChanges` 补 offset 分页循环（PAGE_SIZE=100、MAX_PAGES=10 守卫）；其余列表端点均为有界窗口（见第三节约分页明细） |
| 3 | 遥测批量写入 | **VERIFIED** | `sync.js` `syncAllToFeishu` 遥测一次批量 100 条（`baseRecordBatchCreate`），`flushTelemetry` 5s 缓冲批量；失败保留重试（M2 已测） |
| 4 | 队列压力（无界排队） | **FIXED** | 新增 `FEISHU_CLI_MAX_QUEUE`（默认 200）：`acquireCliSlot` 排队超限立即 reject，`larkCli` 转 `{ok:false, error:'lark-cli queue full ...'}`；不计入熔断、不启动子进程；新增 `test/queue-limit.test.js` |
| 5 | API 凭据暴露 | **VERIFIED + FIXED（一处不一致）** | env 优先已存在（`FEISHU_BASE_TOKEN` 优先于配置，`baseRecordCreate/Update/Search/BatchCreate`）；**修复**：轮询路径 `pollFeishuEventStatusChanges` 原先直接读 `cfg.base_token`，现统一走 `feishu.resolveBaseToken()`（env 优先）；base_token 经 `--base-token` argv 传入属 lark-cli CLI 契约（argv 仅本进程可见，见第四节） |
| 6 | 审计完整性 | **VERIFIED（有已知缺口）** | `audit_log` 表 + 写路径：webhook 验签成功/失败（`security.auditWebhook`）、事件创建/处置/关闭（`events.js` 3 处 `insertAudit`）；**缺口（DOCUMENTED）**：dedup 命中与飞书侧同步动作不写审计 |
| 7 | 优雅关停（排空在途 lark-cli） | **FIXED** | `shutdown` 增加 `await feishu.waitForCliIdle(2000)`（信号量在途计数 + 有界轮询）；附带修复信号量槽位交接计数漂移（见第五节）；1.5s 兜底强制退出保留 |
| 8 | 跨重启幂等 | **VERIFIED** | `webhook_dedup` 表 `UNIQUE(event_id, action_type)` 落盘持久化，`tryAcquireWebhookDedup` 命中返回 `duplicated:true`；处置失败删除记录允许重试 |
| 9 | 重试 jitter/backoff | **FIXED** | 见第六节：`FEISHU_CLI_MAX_RETRIES`（默认 3）+ 指数退避 500ms×2^attempt + 全抖动 + 失败分类；新增 `test/feishu-retry.test.js` |

## 二、SQLite 多实例边界（DOCUMENTED）

- **现状**：`better-sqlite3` 文件库（WAL + `busy_timeout=5000`），进程内同步 API，无网络协议层。schema/seed 由 `initDatabase` 幂等执行；`:memory:` 仅测试用。
- **单实例契约**：关键状态均在进程内存——遥测 buffer（`sync.js` `telemetryBuffer`）、事件状态轮询无游标（每次全量分页扫描）、lark-cli 信号量（`activeCliCalls`/`cliWaitQueue`）与熔断状态（`breakerOpenUntil`）。两实例共享文件无法共享这些状态。
- **两实例共享同一文件时的行为**（已走读确认，非故障注入实测）：
  1. 写锁竞争：`busy_timeout` 5s 兜底，超时抛 `SQLITE_BUSY`；DB 写异常当前不重试，写请求直接失败；
  2. 定时全量同步（30s）与遥测 flush（5s）会重复写入/互相覆盖飞书多维表格侧数据；
  3. 同一 webhook 回调同刻到达两实例：`webhook_dedup` 唯一约束保证一方成功、另一方 `duplicated:true`（不重复处置），但 `tryAcquireWebhookDedup` 对 `UNIQUE` 冲突外的竞态（如双方同时读 events 后写状态）无跨进程串行化保证。
- **为什么不迁移 PostgreSQL**：本应用是监督平台的旁路 sidecar——无事务性账本需求、无多写者场景、无跨进程一致性要求；迁移 PG 引入连接管理/迁移/凭据面，超出 P2 收尾范围。若未来出现多实例/高可用硬需求，正确演进路径是先把 webhook 处置与状态写抽为独立服务 + 分布式锁，再谈水平扩展。

## 三、分页明细（FIXED / VERIFIED）

| 端点/调用 | 分页方式 | 结论 |
|-----------|----------|------|
| `sync.js` `pollFeishuEventStatusChanges` | **FIXED**：`+record-search` 补 `--offset` 翻页（PAGE_SIZE=100，MAX_PAGES=10 守卫，不足一页即末页） | 修复前仅拉取前 100 条 handled/closed 记录，超出的永不回写 |
| `syncAllToFeishu` 设备 | `SELECT * FROM devices` 全量（设备为小表，预置 3 台） | VERIFIED：有界 |
| `syncAllToFeishu` 事件 | `ORDER BY created_at DESC LIMIT 50` 最近 50 条 | VERIFIED：有界窗口（设计语义） |
| `syncAllToFeishu` 遥测 | `ORDER BY ts DESC LIMIT 100` 一次批量 | VERIFIED：有界 |
| `baseRecordSearch` | `--limit`（调用方显式传，默认 10） | VERIFIED：单次有界 |
| `listTelemetry` / `listAudit` / `listEvents` | SQL `LIMIT ? OFFSET ?`（API 层 limit/offset） | VERIFIED：支持分页 |

## 四、凭据面（VERIFIED + 一处 FIXED）

- `FEISHU_BASE_TOKEN` 环境变量优先于 `feishu-config.json` 的 `base_token`：**已确认**（`baseRecordCreate/Update/Search/BatchCreate` 均 env 优先；`test/base-token.test.js` 覆盖）。
- **FIXED 不一致点**：`pollFeishuEventStatusChanges` 原先直接 `cfg.base_token`（忽略 env）→ 统一走 `feishu.resolveBaseToken()`。
- **argv 暴露说明**：base_token 经 lark-cli `--base-token <token>` argv 传入，这是 lark-cli CLI 的契约（当前版本 `+record-search` 等命令不支持环境变量直读 token，README 已有此说明）。缓解措施：env 注入避免凭据落入配置文件；argv 仅本进程可见（`ps` 同用户可见，属已接受残余风险，lark-cli 后续支持 env 直读后可消除）。本审计**不虚构**「base_token 不经过 argv」的说法，如实记录。
- 其余凭据（`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY`）仅经 env 读取，不落盘、不进 argv。

## 五、优雅关停（FIXED）

- 原实现：SIGINT/SIGTERM → 停模拟器/定时器/轮询 → flush 遥测 → 关 HTTP → 关 DB → 1.5s 兜底退出。**未等待在途 lark-cli 子进程**，退出时会打断进行中的飞书调用。
- 修复：`feishu.js` 新增 `waitForCliIdle(timeoutMs=2000)`（轮询信号量在途计数 `activeCliCalls` 与排队数 `cliWaitQueue.length`，50ms 间隔，有界）；`index.js` `shutdown` 在 flush 后调用 `await feishu.waitForCliIdle(2000)`，超时仍由 1.5s 兜底强制退出。
- 顺带修复信号量计数漂移：`releaseCliSlot` 唤醒等待者时原实现不 +1，`activeCliCalls` 随完成数漂移为负（导致 ① `waitForCliIdle` 排空判断失效——计数非正时误判"已排空"；② 后期到达的调用在计数漂移为负后可绕过并发上限）。现改为唤醒时槽位交接 +1，计数恒等于在途子进程数；并发上限/熔断语义不变（回归：`test/lark-cli-async.test.js` 并发峰值 ≤4 通过）。

## 六、重试策略（FIXED）

### 策略参数
- 最大重试次数：`FEISHU_CLI_MAX_RETRIES`（默认 3），即最多 1+3=4 次调用。
- 退避：指数退避 `base 500ms × 2^attempt`（attempt=0,1,2 → 500ms/1s/2s），**全抖动**：实际延迟 = `Math.floor(Math.random() * backoff)`（0..backoff 均匀，stdlib 仅 `Math.random`）。
- 身份策略：首次 user；重试身份交替 bot/user（第 1 次重试即 bot，兼容原「user→bot 单次兜底」语义）。
- 仅**可重试失败**触发重试；业务错误立即返回（fail-fast）。

### 失败分类（`isRetryableError`，导出供测试）
可重试：
- 进程级：超时（`lark-cli timeout (>20s)`）、启动失败（ENOENT/EACCES/EPERM/EPIPE）、输出超限（ENOBUFS 文案）；
- 网络类：ECONNRESET / ECONNREFUSED / ETIMEDOUT / ENETUNREACH / EAI_AGAIN / EAGAIN / rate limit / "network" 等关键词；
- 结构化错误码：HTTP 408/425/429/500/502/503/504；
- 无法归类的未知失败（保守重试，有界）。

不可重试（业务错误）：
- CLI 结构化错误 `type` ∈ validation / authorization / auth / permission / scope / not_found / config / business（实测 lark-cli 1.0.68 错误信封：`{ ok:false, error:{ type, subtype, code, message } }`，如授权 `type:'authorization', code:99991672`、参数 `type:'validation'`）；
- 关键词：invalid token / permission denied / unauthorized / forbidden / access denied / not found / 无权限 / 缺少权限 等；
- 非重试 HTTP 码（400~499 中除 408/425/429）、飞书 9999xxxx 业务码（按 message 判定，默认不重试）；
- 队列已满（`queue full`）与熔断中（`circuit breaker open`）——重试无意义，立即返回。

### 与熔断/并发的交互
- 每次实际启动子进程的失败才计入熔断计数（队列拒绝不计数）。
- 熔断打开期间重试立即停止（`circuit breaker open` 判定为不可重试）。

## 七、测试覆盖（全部通过）

```bash
cd ewoh-feishu-app && npm test
# 54 通过 / 0 失败（含既有 49 + 新增 5）
```

- 新增 `test/feishu-retry.test.js`：可重试失败触发重试（身份 user→bot→user、恰好 3 次调用）、业务错误不重试（恰好 1 次）、maxRetries 边界（1+2=3 次）、失败分类单元断言（可重试/不可重试各 7+ 例）；延迟注入 `__test.setRetryDelayFn` 保持测试快速。
- 新增 `test/queue-limit.test.js`：MAX_CONCURRENT=1 + MAX_QUEUE=2 下 4 并发 → 1 个被立即拒绝（`queue full`）、3 个成功、拒绝项不启动子进程、不计入熔断、结束后队列/并发归零。
- 既有测试全绿：`lark-cli-async`（并发峰值 ≤4、20s 超时、熔断、user→bot 兜底）、`base-token`、`sync-m2`、`security/auth/db/integration`。

## 八、已知缺口（DOCUMENTED，不在本次范围）

1. **审计缺口**：dedup 命中（幂等返回）与飞书侧同步动作不写 `audit_log`；如需完整溯源可补写（README 八 已记录）。
2. **argv 暴露**：base_token 仍经 `--base-token` argv 传入（lark-cli CLI 契约限制），env 直读需 lark-cli 侧支持。
3. **DB 写不重试**：`SQLITE_BUSY`（多进程竞争）当前直接失败，单实例契约下不预期发生。
4. **轮询 MAX_PAGES=10**：单轮最多回写 1000 条 handled/closed；超限记录下一轮 60s 轮询补（事件表体量远低于此，风险可忽略）。
