# EWOH 全仓系统性代码审计报告

**日期**：2026-08-19 03:55
**范围**：全仓 ~22 万行（server 73K / client 97K / shared 10K / Python 边缘 38K / 120 个迁移）
**方法**：6 域并行深审 + 今日 8 类实锤 bug 模式作探针全仓扫描（非字面逐行——22 万行逐行不现实，等效方案：同类问题全仓扫 + 高风险路径精读，行号均经实际读码核对）
**结论**：**88 项发现（14 P0 / 39 P1 / 35 P2）**，含 3 组交叉验证确认的系统性风险

---

## 一、整体印象（主观评价先行）

这个代码库**功能层质量高于预期**：错误处理、react-query 用法、SSE 韧性、枚举 CHECK 守护（86 个约束、60 个 union 类型基本对齐）普遍到位；今日修的 bug 无同类复发。**但有三个系统性病灶**，解释了"为什么修了这么多轮还在冒"：

1. **"改一半"综合症**——修复存在明显断层：`persistCount` 声明未接线、`::uuid` cast 漏改两处、`event_version` 只热修 DB 未修代码/schema/迁移、`'normal'` 只修了类型未修 3 处运行时逻辑、Date 校验范式修了一处未推广。**每次修复都留了残尾，残尾就是下一轮 bug**。
2. **暗色画布上的隐形设计**——颜色从未建立"深底最小亮度"标准：#334155/#64748b 级暗色成片存在（路线层、BaseLayer、状态文字），加上**大小写失配**（OFFLINE 显示绿色）和**枚举双词汇**（'high' vs 'L2'），显示层"看起来坏了"的问题会持续冒。
3. **请求事务外 = RLS 盲区**——架构是"请求级事务 + RLS（GUC）"，但一切事务外路径（fire-and-forget、后台定时器、SSE 后异步）GUC 丢失后**静默读空**（不报错、数据悄悄变空）——这是生产上最难发现的一类，已发现 3 处。

---

## 二、P0 清单（14 项，按修复优先级分组）

### A 组：影响当前演示正确性（最先修）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 1 | `MapViewport.tsx:176-179` | **叠加层 SVG 不在 TransformWrapper 内**：底图缩放/平移时叠加层不动 → 系统性错位（viewBox 数值修了、容器没修——"开图层没变化"的最后一块拼图） | overlay 移入 FactoryMap 的 TransformComponent 内 |
| 2 | `MapViewport.tsx:170 + SchedulerLayers.tsx pointOf` | **叠加层坐标源仍是 snapshot（旧布局 150-585）**，viewBox 已改 spatial（62-720）→ 叠加标记整体偏移 | 坐标源统一（叠加层改用 spatial 坐标） |
| 3 | `routing.service.ts:580-585` | **'normal' 边被 edgeCost 当 blocked 计价（成本×2）**→ 路由系统性选错路（类型修了、运行时没修；与调度域 agent 交叉确认） | `['open','normal'].includes(status) ? 1 : ...` |
| 4 | `scheduling-context.service.ts:123-125` | degradedRouteCount 把全部 'normal' 边算降级 → 前端恒显示"全部路由降级"误报 | 同上修法 |
| 5 | `world-state.service.ts:939-944` | **reservationsEqual 无 null 防御**（mapsEqual 同款崩溃模式的漏修残留）→ 存量快照缺 reservations 键时冲突/审批 500 | `a ?? []` 同款防御 |
| 6 | `entityColors.ts:120-142` | **resourceStatusColor 只匹配小写，后端是大写（'OFFLINE'）**→ 离线设备显示绿色（颜色与文字自相矛盾） | switch 前 toLowerCase |

### B 组：数据正确性 / 安全语义

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 7 | `world-state.service.ts:497` 等 | **severity 双词汇失配**：ingest 写 canonical（'critical'/'high'）、OEE/world 写 legacy（'L1'-'L3'）；安全封锁只认 legacy、优先级加权只认 canonical → **ingest 上报的 critical 安全事件不触发 safetyBlockedPersonIds/DeviceIds**（建议按 P0 处理） | 写入侧统一 canonical + 两处消费侧同步 |
| 8 | `database-audit-sink.ts:22` | 审计写入 `::uuid` 强制 cast 残留 → 非 UUID org 触发 22P02，业务写路径 500+回滚 | 参数改 text 或写入前校验 |
| 9 | `schema.ts:1422,1444` | org_id uuid vs varchar 双类型分裂（world 快照/增量表）→ 非 UUID org 静默 404 | 列迁 varchar 或入口 UUID 校验 |

### C 组：新环境地雷（当前生产不炸，重建库必炸）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 10 | `scheduler-run-orchestrator.service.ts:80` + `schema.ts:2242` + 迁移 017 | **event_version 三处未修**（代码 Date.now() + schema integer + 迁移 int4；仅生产 DB 热修了 bigint）→ 新环境手动调度必 500 | 三处同修（schema bigint + 迁移 + 代码改秒级/序号） |
| 11 | 全部 120 个迁移 | **0 条 GRANT ON SEQUENCE**（outbox 序列事故的修复未沉淀进迁移链）→ 新环境首次入队必 500 | 011/017 补 GRANT |
| 12 | `SchedulerLayers.tsx:425-438` | changed-by-replan 图层永久空（replanPreview 恒 undefined，MapViewportProps 缺字段）——"假开关" | 透传 replanPreview 或删开关 |

### D 组：显示/安全

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 13 | `SchedulerLayers.tsx:61` + `Simulation/simulationConsoleLogic.ts:15` + `DecisionHistory/decisionHistoryLogic.ts:42` | BaseLayer 工位底座隐形（#334155）+双重渲染；Simulation/DecisionHistory 状态文字深色不可见（2.5:1 对比度） | 提亮/换令牌 |
| 14 | `edge_platform/auth/identity.py:60-64` | 硬编码默认凭据（admin/admin123 等）无强制置换机制，production 照常生效 | production 强制环境变量口令，未配置拒绝启动 |

---

## 三、P1 摘要（39 项，按域）

### 调度后端（7）
- collectState 7 表全量无 LIMIT（event 29,405 行每次轮询全表进内存）
- 审批链路一次 approvePlan 落 2 行快照（buildSnapshot 写路径滥用）
- execution createFromPlan 循环逐条 INSERT（N+1）
- conflicts 每次全量 derive（detail 也跑全量推导）
- travel-cost O(tasks×persons) 次全图加载（600 次/请求）
- 设备坐标 lat/lng 与笛卡尔混载（依赖写入方显式打 WGS84 标）

### 非调度后端（6）
- **persistCount 声明未接线** → 环形缓冲填满后每请求全表扫 trace_span（20 万行）
- **telemetry 缺 (org_id, ts) 索引** → 仪表盘/AI 上下文/游戏化轮询三处 Seq Scan
- MES/ERP/OEE 日期输入无 Invalid Date 校验（稳定 500）
- world-cursor 读改写无锁（并发撞唯一约束 500）
- **gamification fire-and-forget 在事务外（GUC 丢失）→ LLM 增强静默读空**
- **通知后台派发器经 root 句柄查询 → RLS 下通知推送可能整体静默失效**（需验证）

### 指挥地图（8）
- routes 双 queryKey 双缓存（断线恢复后两处路线图版本不一致）
- 执行偏差徽标 `?? 0` 画到世界原点
- execution-deviation 图层未选方案恒空（无引导提示）
- AvailabilityLayer 把 dataQuality=undefined 全画红圈（满屏误报）
- 不可用设备 #64748b 低对比隐形；PlanCompare UnchangedMarker 同款
- data_quality 模式 confidence 缺失画红色（应灰色 unknown）

### 其他前端（8）
- **深色残留量化：全站 1324 处违规 / 162 处未放行（lint 门禁必红）/ 44 文件 561 处硬编码**（含 lint 盲区 index.tsx、hsl221 批准色相漏网、WorkGraphPanel 因果图整套浅色 SVG）
- ErrorBoundary 崩溃页整体硬编码浅色
- 主按钮 bg-slate-800 未用 bg-primary（7 处）
- AiDecision 暗绿文字透明底对比不足

### 契约对齐（3）+ 边缘平台（7）
- route_edge.status 无 CHECK + 强制 cast 透传（'nomal' 拼写错误可直达前端）
- schema vs 迁移列宽漂移（ai_suggestion）、org_id 类型学漂移
- 边缘：毒信封永久阻塞队头（无 dead-letter）、OPC-UA 队列满首次触发即 AttributeError 崩溃、离线缓冲无上限 O(n²) 落盘、世界状态非原子写、ark_vision 重定向转发 Authorization、POST 写路径 RBAC fail-open

---

## 四、P2 概览（35 项）

execution update() 返回未判空、分页 total 语义错误、replan planId 嵌套增长、冲突循环写放大、反馈 advisory lock N+1、ai JSON.parse 无防御、auth 每请求查库、metrics 201 计为 200、Operations 数字输入空串静默传 0、登录裸错误未脱敏、AI 流式无 AbortSignal、SSE error 后不 break、深色语义色 519 处技术债、边缘平台 stats 竞态/畸形 JSON 吞 400/限流器无锁/BATCH_SIZE 死代码/print 格式串误用等。

---

## 五、正面结论（已验证无问题，给信心的部分）

- **枚举守护基本健全**：86 个 CHECK 约束、60 个 union 类型中绝大部分完全对齐（maintenance/quality/workorder/simulation/agent 全套一致）
- **SSE 层韧性完善**：useSchedulerStream 清理完备、单例 Provider 已收敛双连接、降级轮询齐全
- **已知 bug 模式无复发**：双追加状态、react-query 反模式、useEffect 泄漏、幂等键构造、mapsEqual 防御、SSE 拦截器特判——均已闭环
- **边缘平台整改质量高**：磁盘队列语义正确（at-least-once + 幂等去重）、SSRF 防护扎实、session 锁完整

---

## 六、修复路线建议

**第一批（演示前必修，~2-3 小时）**：A 组 6 项——叠加层容器/坐标源（1+2）、normal 计价（3+4）、reservationsEqual（5）、大小写（6）。全部是小改动，一次重建打包。

**第二批（数据/安全正确性，~2 小时）**：B 组 severity 统一（7）、审计 cast（8）、GUC 盲区验证+修复（gamification/通知）。

**第三批（新环境地雷，~1 小时）**：C 组——event_version 三处同修、迁移补 GRANT、schema/迁移漂移收口。**不做的话换环境部署必复发。**

**第四批（体验收尾）**：深色残留 162 处未放行（先恢复 lint 门禁绿）→ 519 处技术债分批 → 边缘平台 dead-letter/凭据强制置换。

**防复发建议**：① 建议加两道 CI 门禁：`lint-design-tokens`（已有，先修红）+ "深底最小亮度"检查；② 枚举大小写归一工具函数（toLowerCase 入口）；③ "修复完成定义"检查表：类型✓运行时✓schema✓迁移✓四处全改才叫修完。
