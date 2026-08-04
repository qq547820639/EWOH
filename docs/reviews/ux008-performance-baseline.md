# UX-008 性能工程 — 性能基线报告

> 项目：EWOH 工厂具身智能操作系统
> 报告日期：2026-08-04
> 范围：本报告记录 UX-008「性能工程」优化前后的可重复基准数据，并给出性能预算表。
> 原则：**只记录实测数据，不得伪造；无法实测的项明确标注"待真实环境/待真实浏览器"**。
> 实测环境：Node.js v26.5.1 / macOS（darwin）。脚本：`ewoh-spark-app/scripts/perf-bench.mjs`、`perf-budget.mjs`。

---

## 1. 性能预算表（UX-008，10 维度）

预算定义于 `client/src/lib/perfBudget.ts`（前端单测）与 `scripts/perf-budget.mjs`（CI 判定），两者语义一致。
判定规则：`实测 ≤ 上限 + 容差` 为 PASS；无实测数据为 pending。

| 类别 | 预算项 | 上限 | 容差 | 实测 | 状态 | 说明 |
|------|--------|------|------|------|------|------|
| 首屏资源 | JS 首屏体积 gzip | 420kb | 40kb | — | pending | 需真实构建产物 |
| 路由切换 | 切换至可交互 | 300ms | 80ms | — | pending | 需真实浏览器 |
| 大表格 | 5000 行首屏渲染 | 500ms | 100ms | — | pending | 需真实浏览器 |
| Work Graph | 3000 节点布局 | 450ms | 80ms | 10.472ms | **PASS** | node 实测 |
| 世界回放 | 单帧渲染 | 16.7ms | 3ms | — | pending | 需真实浏览器 |
| 离线队列 | flush 100 条 | 200ms | 50ms | 19.994ms | **PASS** | node 实测 |
| 图片处理 | 附件处理 | 300ms | 80ms | — | pending | 需真实浏览器 |
| API | p95 响应 | 800ms | 200ms | — | pending | 需真实服务/环境 |
| 慢查询 | 慢查询耗时 | 1000ms | 200ms | — | pending | 需真实数据库 |
| 低端平板 | 单帧预算 | 50ms | 10ms | — | pending | 需真实设备 |

汇总：10 项，PASS 2（graph layout / offline queue），pending 8（待真实浏览器/环境）。

---

## 2. 优化前 vs 优化后（node 可实测项）

### 2.1 Work Graph 布局（`buildGraphLayout`，纯函数）

`buildGraphLayout` 为纯函数，逻辑未改动（UX-002 已建立基线）。本次在大规模下新增 3000 节点实测。

| 规模 | 优化前基线（UX-002，2026-08-03）median | 本次实测（2026-08-04）median | 预算上限 |
|------|------|------|------|
| 500 节点 | 1.005ms | 1.115ms | — |
| 1000 节点 | 6.338ms | 1.870ms | — |
| 2000 节点 | 3.208ms | 5.177ms | — |
| 3000 节点 | 未测 | **10.472ms** | 450ms |

说明：布局函数本身未变，数值差异为机器负载/调度噪声；3000 节点布局 10.472ms 远低于 450ms 预算上限，**PASS**。
渲染层优化已在 UX-002 完成（`WINDOW_THRESHOLD = 300` 时画布窗口化，只渲染视口内节点）；本次新增侧边栏节点列表渐进式加载（每批 50 项，见 `WorkGraphPanel.tsx`）。

### 2.2 移动端离线队列 flush（`flushPendingQueue`，纯逻辑）

| 项 | 优化前 | 优化后 | 预算上限 |
|----|--------|--------|----------|
| 100 条待同步动作 flush | 未做独立基线 | **19.994ms**（5 次采样中位数，min 18.513 / max 24.641） | 200ms |

说明：逻辑未改动（UX-003 已实现 IndexedDB 持久化），本次建立独立可重复基线，**PASS**。

### 2.3 渐进式列表（`progressiveSlice`，纯逻辑）

| 项 | 优化后实测 |
|----|-----------|
| 100,000 项数组分片（每次取 50） | 200 次采样 median 0ms，max 0.058ms |

说明：`progressiveSlice` 为 O(1) 切片，代价可忽略；作为"按需渲染"的底层原语，供证据抽屉等大列表增量渲染使用。

### 2.4 虚拟列表窗口计算（`computeVirtualRange`，纯函数）

`client/src/lib/virtualList.ts` 新增。固定行高 + overscan 的窗口计算，数学上保证大表格只渲染可视区行数。

| 场景 | 一次性渲染（优化前） | 虚拟化渲染（优化后） |
|------|------|------|
| 5000 行表格（行高 40px，视口 400px） | 5000 行 DOM | ~26 行（可视 10 + overscan 8×2） |
| 5000 行表格 DOM 节点数 | 5000 | ~26（**减少 >99%**） |

说明：DOM 节点数降低可精确换算；**首屏渲染耗时（ms）需真实浏览器测量**，见第 3 节。

---

## 3. 无法实测项（标注"待真实浏览器/待真实环境"）

| 维度 | 现状 | 状态 |
|------|------|------|
| 首屏资源 | 已用 `React.lazy` 按路由分包；本次新增路由预取（`lib/routePrefetch.ts`，hover/focus 命中预取表时提前 `import()` 页面模块） | gzip 体积：**待真实构建产物** |
| 路由切换 | lazy 按需加载 + 路由预取 | 切换耗时：**待真实浏览器** |
| 大表格 | 已为 Agent/资源表接入虚拟滚动（`AgentsPanel.tsx`/`ResourcesPanel.tsx`），证据抽屉接入渐进式加载（`EvidencePanel.tsx`） | 首屏渲染耗时：**待真实浏览器** |
| Work Graph 帧率 | 画布窗口化 + 侧边栏渐进式加载 | 滚动/缩放帧率：**待真实浏览器** |
| 世界回放 | 现有回放实现 | 帧率：**待真实浏览器** |
| 图片处理 | 已有附件压缩/DataURL 转换 | 耗时：**待真实浏览器** |
| API p95 / 慢查询 | 已有 `scripts/perf-smoke.js`（HTTP 压测可测 p95），数据库慢查询需真实库 | p95：**待真实服务**；慢查询：**待真实数据库** |
| 低端工业平板 | 现有技术栈 | 表现：**待真实设备** |

---

## 4. 采用的优化技术（对现有实现的增强）

| 技术 | 实现 | 代码位置 |
|------|------|----------|
| 虚拟列表 | 新增 `useVirtualList` + `computeVirtualRange`，接入 Agent/资源大表格（占位行 + sticky 表头） | `client/src/lib/virtualList.ts`、`AgentsPanel.tsx`、`ResourcesPanel.tsx` |
| 渐进式列表（按需渲染） | 证据抽屉、Work Graph 侧边栏节点列表分批加载 | `EvidencePanel.tsx`、`WorkGraphPanel.tsx`（复用 `lib/progressiveList.ts`） |
| 路由预取 | 侧边导航 hover/focus 预取大页面模块 | `lib/routePrefetch.ts`、`components/Layout.tsx` |
| 按需加载 | `React.lazy` 路由分包（已有，保留） | `app.tsx` |
| 缓存 | `@tanstack/react-query` staleTime/refetchOnWindowFocus=false（已有，保留） | `lib/AppContainer.tsx` |
| 大图渲染 | Work Graph 画布窗口化（UX-002 已有，保留）+ 新增侧边栏渐进式加载 | `WorkGraphPanel.tsx` |
| 离线持久化 | IndexedDB（UX-003 已有，保留） | `lib/offlineDb.ts` |

---

## 5. 结论

- 已建立 10 维度性能预算（`perfBudget.ts` + `perf-budget.mjs`），可被 CI 调用；`perf-bench.mjs` 产出可重复的纯逻辑基准 JSON 到 `output/perf-bench.json`。
- node 可实测项（Work Graph 3000 节点布局 10.472ms、离线队列 flush 100 条 19.994ms）均远低于预算，**PASS**。
- 8 项浏览器/环境相关维度（首屏体积、路由切换、大表格渲染、世界回放、图片、API p95、慢查询、低端平板）**待真实浏览器/真实环境**，需在真实设备与生产环境补测后回填本报告。
- 单测与类型检查通过：`perfBudget.test.ts`、`virtualList.test.ts` 通过；`tsc --noEmit` 通过。